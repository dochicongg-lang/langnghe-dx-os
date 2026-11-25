// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Làng Nghề Số contributors
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { generateEdgeKeypair, signReading, verifyReading } = require("../iot-signing");
const mqtt = require("../mqtt-protocol");
const { buildEvidence } = require("../iot");
const { validateEdgeTelemetry } = require("../../iot-mqtt-bridge/bridge");

test("Ed25519 biên: ký và xác thực bản ghi cảm biến; phát hiện sửa giá trị hoặc thời gian", () => {
  const { publicKeyHex, privateSeedHex } = generateEdgeKeypair();
  const sample = { deviceId: "kiln-01", metric: "temperature", value: 1152.5, unit: "°C", timestamp: "2026-11-25T10:00:00.000Z" };
  const sig = signReading(sample, privateSeedHex);
  assert.equal(sig.length, 128);
  assert.equal(verifyReading(sample, publicKeyHex, sig), true);
  assert.equal(verifyReading({ ...sample, value: 1152.6 }, publicKeyHex, sig), false);
  assert.equal(verifyReading({ ...sample, deviceId: "kiln-02" }, publicKeyHex, sig), false);
});

test("MQTT 3.1.1 codec: đóng gói và giải mã CONNECT, SUBSCRIBE, PUBLISH qua bộ đệm bị cắt mảnh", () => {
  const cPkt = mqtt.buildConnectPacket({ clientId: "esp32-01", keepAliveSec: 30 });
  const subPkt = mqtt.buildSubscribePacket(7, "dxos/iot/+/telemetry", 1);
  const pubPkt = mqtt.buildPublishPacket("dxos/iot/kiln-01/telemetry", '{"value":1100}', { qos: 1, packetId: 9 });
  const connAck = Buffer.from([0x20, 0x02, 0x00, 0x00]);
  const subAck = Buffer.from([0x90, 0x03, 0x00, 0x07, 0x01]);

  // Cắt dòng byte giữa chừng để kiểm tra tính an toàn stream
  const stream = Buffer.concat([connAck, subAck, pubPkt]);
  const half1 = mqtt.parsePackets(stream.subarray(0, 8));
  assert.equal(half1.packets.length, 1);
  assert.equal(half1.packets[0].type, "connack");

  const full = mqtt.parsePackets(Buffer.concat([half1.rest, stream.subarray(8)]));
  assert.equal(full.packets.length, 2);
  assert.equal(full.packets[0].type, "suback");
  assert.equal(full.packets[1].type, "publish");
  assert.equal(full.packets[1].topic, "dxos/iot/kiln-01/telemetry");
  assert.equal(full.packets[1].packetId, 9);
  assert.equal(full.packets[1].payload.toString("utf8"), '{"value":1100}');
  assert.ok(cPkt.length > 10 && subPkt.length > 10);
});

test("iot-mqtt-bridge validateEdgeTelemetry: chấp nhận gói tin có chữ ký Ed25519 hợp lệ, chặn gói giả mạo", () => {
  const { publicKeyHex, privateSeedHex } = generateEdgeKeypair();
  const devices = new Map([["kiln-01", { gateway: "dxos-iot", publicKey: publicKeyHex, requireSignature: true }]]);
  const raw = { deviceId: "kiln-01", metric: "temperature", value: 980, unit: "°C", timestamp: "2026-11-25T10:05:00.000Z" };
  const signed = { ...raw, sig: signReading(raw, privateSeedHex) };

  const okRes = validateEdgeTelemetry("dxos/iot/kiln-01/telemetry", Buffer.from(JSON.stringify(signed)), devices);
  assert.equal(okRes.ok, true);
  assert.equal(okRes.reading.value, 980);

  const tampered = validateEdgeTelemetry("dxos/iot/kiln-01/telemetry", Buffer.from(JSON.stringify({ ...signed, value: 1200 })), devices);
  assert.deepEqual(tampered, { ok: false, reason: "bad-ed25519-signature" });

  const unsigned = validateEdgeTelemetry("dxos/iot/kiln-01/telemetry", Buffer.from(JSON.stringify(raw)), devices);
  assert.deepEqual(unsigned, { ok: false, reason: "missing-required-signature" });
});

test("buildEvidence: đối chiếu chữ ký Ed25519 trong kho MinIO, gắn cờ bad-signature khi có mẫu giả mạo", async () => {
  const { publicKeyHex, privateSeedHex } = generateEdgeKeypair();
  const base = Date.parse("2026-11-12T15:00:00Z");
  const key = "iot/service-account-gw1/2026-11-12/2026-11-12T15-05-00-000Z.ndjson";
  const mkSigned = (sec, val) => {
    const r = { deviceId: "kiln-01", deviceName: "Lò 1", metric: "temperature", value: val, unit: "°C", timestamp: new Date(base + sec * 1000).toISOString() };
    return JSON.stringify({ ...r, sig: signReading(r, privateSeedHex) });
  };
  const forgedLine = JSON.stringify({
    deviceId: "kiln-01",
    metric: "temperature",
    value: 1399,
    unit: "°C",
    timestamp: new Date(base + 15_000).toISOString(),
    sig: "ab".repeat(64),
  });
  const body = [mkSigned(10, 1120), forgedLine, mkSigned(20, 1140), mkSigned(30, 1150)].join("\n");
  const s3 = {
    listVersions: async () => [{ key, versionId: "v1", lastModified: base + 35_000, isDeleteMarker: false }],
    getObject: async () => body,
  };
  const ev = await buildEvidence({ deviceId: "kiln-01", from: base, to: base + 40_000 }, s3, "gw1", { min: 0, max: 1400, publicKey: publicKeyHex, requireSignature: true });
  assert.equal(ev.max, 1150); // mẫu giả 1399 đã bị loại
  assert.equal(ev.quality.signedSamples, 3);
  assert.equal(ev.quality.badSignatures, 1);
  assert.ok(ev.quality.flags.includes("bad-signature"));
});
