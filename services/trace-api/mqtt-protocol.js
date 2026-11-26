// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Làng Nghề Số contributors
"use strict";
/**
 * Bộ mã hóa / giải mã gói tin giao thức MQTT 3.1.1 tối giản thuần Node.js (`node:net` / `node:events`).
 * Phục vụ cầu nối thu nhận cảm biến biên (`iot-mqtt-bridge`) và trình mô phỏng ESP32 mà không kéo theo thư viện ngoài.
 * Hỗ trợ: CONNECT, CONNACK, PUBLISH (QoS 0/1), PUBACK, SUBSCRIBE, SUBACK, PINGREQ, PINGRESP, DISCONNECT.
 */
const net = require("node:net");
const { EventEmitter } = require("node:events");

function encodeRemainingLength(n) {
  const bytes = [];
  let x = n;
  do {
    let b = x % 128;
    x = Math.floor(x / 128);
    if (x > 0) b |= 0x80;
    bytes.push(b);
  } while (x > 0);
  return Buffer.from(bytes);
}

function decodeRemainingLength(buf, offset = 1) {
  let multiplier = 1;
  let value = 0;
  let i = offset;
  while (i < buf.length) {
    const b = buf[i++];
    value += (b & 127) * multiplier;
    if ((b & 128) === 0) return { value, bytesUsed: i - offset };
    multiplier *= 128;
    if (multiplier > 128 * 128 * 128) throw new Error("MQTT Remaining Length vượt giới hạn");
  }
  return null; // chưa nhận đủ byte
}

function encodeUtf8(str) {
  const b = Buffer.from(String(str), "utf8");
  const len = Buffer.alloc(2);
  len.writeUInt16BE(b.length, 0);
  return Buffer.concat([len, b]);
}

function buildConnectPacket({ clientId = "dxos-client", keepAliveSec = 30, username, password } = {}) {
  const protoName = encodeUtf8("MQTT");
  const protoLevel = Buffer.from([4]); // MQTT 3.1.1
  let flags = 0x02; // Clean Session
  const parts = [encodeUtf8(clientId)];
  if (username) {
    flags |= 0x80;
    parts.push(encodeUtf8(username));
    if (password) {
      flags |= 0x40;
      parts.push(encodeUtf8(password));
    }
  }
  const keepAlive = Buffer.alloc(2);
  keepAlive.writeUInt16BE(keepAliveSec, 0);
  const body = Buffer.concat([protoName, protoLevel, Buffer.from([flags]), keepAlive, ...parts]);
  return Buffer.concat([Buffer.from([0x10]), encodeRemainingLength(body.length), body]);
}

function buildSubscribePacket(packetId, topicFilter, qos = 0) {
  const pid = Buffer.alloc(2);
  pid.writeUInt16BE(packetId, 0);
  const body = Buffer.concat([pid, encodeUtf8(topicFilter), Buffer.from([qos & 0x03])]);
  return Buffer.concat([Buffer.from([0x82]), encodeRemainingLength(body.length), body]);
}

function buildPublishPacket(topic, payload, { qos = 0, packetId = 1, retain = false } = {}) {
  const t = encodeUtf8(topic);
  const p = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), "utf8");
  const pid = qos > 0 ? Buffer.from([(packetId >> 8) & 0xff, packetId & 0xff]) : Buffer.alloc(0);
  const body = Buffer.concat([t, pid, p]);
  const header = 0x30 | ((qos & 0x03) << 1) | (retain ? 0x01 : 0);
  return Buffer.concat([Buffer.from([header]), encodeRemainingLength(body.length), body]);
}

function buildPubAckPacket(packetId) {
  return Buffer.from([0x40, 0x02, (packetId >> 8) & 0xff, packetId & 0xff]);
}

const PINGREQ_PACKET = Buffer.from([0xc0, 0x00]);
const DISCONNECT_PACKET = Buffer.from([0xe0, 0x00]);

/** Tách các gói tin hoàn chỉnh từ bộ đệm TCP stream; trả `{ packets, rest }`. */
function parsePackets(buffer) {
  const packets = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (buffer.length - offset < 2) break;
    const header = buffer[offset];
    const type = header >> 4;
    const flags = header & 0x0f;
    const rem = decodeRemainingLength(buffer, offset + 1);
    if (!rem) break;
    const totalLen = 1 + rem.bytesUsed + rem.value;
    if (buffer.length - offset < totalLen) break;
    const body = buffer.subarray(offset + 1 + rem.bytesUsed, offset + totalLen);
    offset += totalLen;

    if (type === 2) {
      packets.push({ type: "connack", returnCode: body[1] ?? 255 });
    } else if (type === 3) {
      const qos = (flags >> 1) & 0x03;
      const topicLen = body.readUInt16BE(0);
      const topic = body.subarray(2, 2 + topicLen).toString("utf8");
      let pPos = 2 + topicLen;
      let packetId = null;
      if (qos > 0) {
        packetId = body.readUInt16BE(pPos);
        pPos += 2;
      }
      const payload = body.subarray(pPos);
      packets.push({ type: "publish", qos, packetId, topic, payload });
    } else if (type === 4) {
      packets.push({ type: "puback", packetId: body.readUInt16BE(0) });
    } else if (type === 9) {
      packets.push({ type: "suback", packetId: body.readUInt16BE(0), granted: body[2] });
    } else if (type === 13) {
      packets.push({ type: "pingresp" });
    } else {
      packets.push({ type: `raw_${type}`, body });
    }
  }
  return { packets, rest: buffer.subarray(offset) };
}

/** Kết nối tới MQTT broker (Eclipse Mosquitto), hỗ trợ subscribe và publish. */
function connectMqtt({ host = "127.0.0.1", port = 1883, clientId, keepAliveSec = 25, username, password, createConnection = net.createConnection } = {}) {
  const emitter = new EventEmitter();
  const sock = createConnection({ host, port });
  let rx = Buffer.alloc(0);
  let nextId = 1;
  let pingTimer = null;

  sock.on("connect", () => {
    sock.write(buildConnectPacket({ clientId: clientId ?? `dxos-${process.pid}-${Math.random().toString(16).slice(2, 8)}`, keepAliveSec, username, password }));
  });

  sock.on("data", (chunk) => {
    try {
      rx = Buffer.concat([rx, chunk]);
      const parsed = parsePackets(rx);
      rx = parsed.rest;
      for (const pkt of parsed.packets) {
        if (pkt.type === "connack") {
          if (pkt.returnCode !== 0) emitter.emit("error", new Error(`MQTT CONNACK từ chối mã ${pkt.returnCode}`));
          else {
            if (keepAliveSec > 0) pingTimer = setInterval(() => sock.writable && sock.write(PINGREQ_PACKET), keepAliveSec * 1000).unref();
            emitter.emit("connect");
          }
        } else if (pkt.type === "publish") {
          if (pkt.qos === 1 && pkt.packetId !== null) sock.write(buildPubAckPacket(pkt.packetId));
          emitter.emit("message", pkt.topic, pkt.payload);
        } else {
          emitter.emit(pkt.type, pkt);
        }
      }
    } catch (e) {
      emitter.emit("error", e);
    }
  });

  sock.on("error", (err) => emitter.emit("error", err));
  sock.on("close", () => {
    if (pingTimer) clearInterval(pingTimer);
    emitter.emit("close");
  });

  return Object.assign(emitter, {
    subscribe(topicFilter, qos = 0) {
      const id = (nextId++ & 0x7fff) || 1;
      sock.write(buildSubscribePacket(id, topicFilter, qos));
      return id;
    },
    publish(topic, payload, opts = {}) {
      const id = (nextId++ & 0x7fff) || 1;
      sock.write(buildPublishPacket(topic, payload, { ...opts, packetId: id }));
      return id;
    },
    end() {
      if (pingTimer) clearInterval(pingTimer);
      if (sock.writable) sock.write(DISCONNECT_PACKET);
      sock.end();
    },
  });
}

module.exports = {
  encodeRemainingLength,
  decodeRemainingLength,
  buildConnectPacket,
  buildSubscribePacket,
  buildPublishPacket,
  buildPubAckPacket,
  parsePackets,
  connectMqtt,
};
