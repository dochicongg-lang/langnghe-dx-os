// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Làng Nghề Số contributors
"use strict";
/**
 * Dịch vụ cầu nối IoT biên (`iot-mqtt-bridge`):
 *   - Lắng nghe gói tin cảm biến từ broker MQTT (`dxos/iot/+/telemetry`).
 *   - Đối chiếu thiết bị trong `config/iot-devices.json` và xác thực chữ ký số Ed25519 ngay tại biên
 *     (chặn sớm gói tin giả mạo trước khi chạm kho lưu trữ).
 *   - Gom lô NDJSON và ghi vào kho Object Lock WORM (`dxos-iot`) thông qua Keycloak Service Account + MinIO OIDC STS
 *     (giữ nguyên mô hình phân quyền Zero-Trust `iot-writer`: chỉ ghi được vào `iot/service-account-<gateway>/`).
 */
const path = require("node:path");
const { loadDevices } = require("../trace-api/devices");
const { verifyReading } = require("../trace-api/iot-signing");
const { connectMqtt } = require("../trace-api/mqtt-protocol");
const { createS3Client, folderOf } = require("../trace-api/iot");

const TOPIC_RE = /^dxos\/iot\/([A-Za-z0-9][A-Za-z0-9_-]{0,59})\/telemetry$/;

/**
 * Kiểm tra tính hợp lệ và xác thực chữ ký số Ed25519 của một bản tin MQTT.
 * Hàm thuần để kiểm thử đơn vị trực tiếp. Trả `{ ok: true, reading }` hoặc `{ ok: false, reason }`.
 */
function validateEdgeTelemetry(topic, payloadBuf, devicesMap) {
  const m = TOPIC_RE.exec(String(topic ?? ""));
  if (!m) return { ok: false, reason: "invalid-topic" };
  const topicDeviceId = m[1];
  let data;
  try {
    data = JSON.parse(Buffer.isBuffer(payloadBuf) ? payloadBuf.toString("utf8") : String(payloadBuf));
  } catch {
    return { ok: false, reason: "invalid-json" };
  }
  const deviceId = typeof data?.deviceId === "string" ? data.deviceId.trim() : topicDeviceId;
  if (deviceId !== topicDeviceId) return { ok: false, reason: "device-topic-mismatch" };
  const devCfg = devicesMap.get(deviceId);
  if (!devCfg) return { ok: false, reason: "unregistered-device" };
  if (!Number.isFinite(data?.value) || Number.isNaN(Date.parse(data?.timestamp ?? ""))) {
    return { ok: false, reason: "invalid-reading-fields" };
  }
  const reading = {
    deviceId,
    deviceName: typeof data.deviceName === "string" && data.deviceName.trim() ? data.deviceName.trim() : deviceId,
    metric: typeof data.metric === "string" && data.metric.trim() ? data.metric.trim() : "temperature",
    value: Number(data.value),
    unit: typeof data.unit === "string" ? data.unit : "°C",
    timestamp: new Date(data.timestamp).toISOString(),
  };

  if (devCfg.publicKey) {
    if (typeof data.sig === "string" && data.sig) {
      if (!verifyReading(reading, devCfg.publicKey, data.sig)) {
        return { ok: false, reason: "bad-ed25519-signature" };
      }
      reading.sig = data.sig.toLowerCase();
    } else if (devCfg.requireSignature) {
      return { ok: false, reason: "missing-required-signature" };
    }
  } else if (typeof data.sig === "string" && /^[0-9a-fA-F]{128}$/.test(data.sig)) {
    reading.sig = data.sig.toLowerCase();
  }

  return { ok: true, gateway: devCfg.gateway, reading };
}

/** Đổi client_credentials của Keycloak lấy thông tin đăng nhập tạm STS của MinIO (role `iot-writer`). */
async function acquireIotStsClient({ kcUrl, realm, clientId, clientSecret, s3Endpoint, bucket }) {
  const tokRes = await fetch(`${kcUrl}/realms/${realm}/protocol/openid-connect/token`, {
    method: "POST",
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!tokRes.ok) throw new Error(`Keycloak trả ${tokRes.status} khi xin token gateway IoT`);
  const { access_token: jwt } = await tokRes.json();

  const stsRes = await fetch(`${s3Endpoint}/?Action=AssumeRoleWithWebIdentity&Version=2011-06-15&DurationSeconds=900&WebIdentityToken=${encodeURIComponent(jwt)}`, {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
  });
  const xml = await stsRes.text();
  if (!stsRes.ok) throw new Error(`MinIO STS trả ${stsRes.status}: ${xml.slice(0, 160)}`);
  const tag = (t) => new RegExp(`<${t}>([^<]+)</${t}>`).exec(xml)?.[1];
  const accessKey = tag("AccessKeyId");
  const secretKey = tag("SecretAccessKey");
  const sessionToken = tag("SessionToken");
  if (!accessKey || !secretKey) throw new Error("Phản hồi STS thiếu AccessKeyId/SecretAccessKey");
  return { accessKey, secretKey, sessionToken, s3Endpoint, bucket };
}

/** Ghi đối tượng NDJSON lên MinIO bằng thông tin tạm STS (có kèm X-Amz-Security-Token). */
async function putStsNdjson({ s3Endpoint, bucket, accessKey, secretKey, sessionToken }, key, bodyBuffer) {
  const crypto = require("node:crypto");
  const base = new URL(s3Endpoint);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  const payloadHash = crypto.createHash("sha256").update(bodyBuffer).digest("hex");
  const uri = `/${bucket}/${key}`
    .split("/")
    .map((s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()))
    .join("/");

  const headers = {
    host: base.host,
    "content-type": "application/x-ndjson",
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    ...(sessionToken ? { "x-amz-security-token": sessionToken } : {}),
  };
  const signedKeys = Object.keys(headers).sort();
  const canonicalHeaders = signedKeys.map((k) => `${k}:${headers[k]}\n`).join("");
  const signedHeaders = signedKeys.join(";");
  const canonical = ["PUT", uri, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${date}/us-east-1/s3/aws4_request`;
  const hmac = (k, d) => crypto.createHmac("sha256", k).update(d).digest();
  const signingKey = hmac(hmac(hmac(hmac("AWS4" + secretKey, date), "us-east-1"), "s3"), "aws4_request");
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, crypto.createHash("sha256").update(canonical).digest("hex")].join("\n");
  const sig = crypto.createHmac("sha256", signingKey).update(toSign).digest("hex");

  const res = await fetch(`${base.origin}${uri}`, {
    method: "PUT",
    headers: {
      ...headers,
      authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${sig}`,
    },
    body: bodyBuffer,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`MinIO PUT trả ${res.status} cho ${key}`);
}

function startBridge() {
  const devicesFile = process.env.IOT_DEVICES_FILE ?? path.join(__dirname, "..", "..", "config", "iot-devices.json");
  const devicesMap = loadDevices(devicesFile);
  const mqttHost = process.env.MQTT_HOST ?? "mosquitto";
  const mqttPort = Number(process.env.MQTT_PORT ?? 1883);
  const flushMs = Math.max(1000, Number(process.env.BRIDGE_FLUSH_MS ?? 5000));
  const gatewayClientId = process.env.KEYCLOAK_IOT_CLIENT_ID ?? "dxos-iot";
  const gatewaySecret = process.env.KEYCLOAK_IOT_CLIENT_SECRET ?? "";
  const kcUrl = process.env.KEYCLOAK_INTERNAL_URL ?? "http://keycloak:8080";
  const realm = process.env.KEYCLOAK_REALM ?? "dxos";
  const s3Endpoint = process.env.S3_ENDPOINT ?? "http://minio:9000";
  const bucket = process.env.S3_BUCKET ?? "dxos-iot";

  const queue = [];
  let stsCache = null;
  let stsExpiresAt = 0;

  async function flush() {
    if (!queue.length) return;
    if (!gatewaySecret) {
      console.warn("[iot-mqtt-bridge] Chưa cấu hình KEYCLOAK_IOT_CLIENT_SECRET, bỏ qua ghi MinIO");
      queue.length = 0;
      return;
    }
    const batch = queue.splice(0, queue.length);
    try {
      if (!stsCache || Date.now() > stsExpiresAt) {
        stsCache = await acquireIotStsClient({ kcUrl, realm, clientId: gatewayClientId, clientSecret: gatewaySecret, s3Endpoint, bucket });
        stsExpiresAt = Date.now() + 10 * 60_000;
      }
      const now = new Date();
      const day = now.toISOString().slice(0, 10);
      const stamp = now.toISOString().replace(/[:.]/g, "-");
      const key = `iot/${folderOf(gatewayClientId)}/${day}/${stamp}.ndjson`;
      const body = Buffer.from(batch.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
      await putStsNdjson(stsCache, key, body);
      console.log(`[iot-mqtt-bridge] Đã ghi ${batch.length} mẫu (đã kiểm chữ ký) -> ${key}`);
    } catch (e) {
      console.error("[iot-mqtt-bridge] Lỗi ghi lô lên MinIO:", e.message);
      stsCache = null;
    }
  }

  function connectLoop() {
    const client = connectMqtt({ host: mqttHost, port: mqttPort, clientId: `dxos-bridge-${process.pid}` });
    client.on("connect", () => {
      console.log(`[iot-mqtt-bridge] Đã kết nối MQTT ${mqttHost}:${mqttPort}, đăng ký dxos/iot/+/telemetry`);
      client.subscribe("dxos/iot/+/telemetry", 1);
    });
    client.on("message", (topic, payload) => {
      const check = validateEdgeTelemetry(topic, payload, devicesMap);
      if (!check.ok) {
        console.warn(`[iot-mqtt-bridge] Từ chối bản tin từ ${topic}: ${check.reason}`);
        return;
      }
      if (check.gateway !== gatewayClientId) {
        console.warn(`[iot-mqtt-bridge] Bỏ qua thiết bị thuộc gateway khác (${check.gateway} != ${gatewayClientId})`);
        return;
      }
      queue.push(check.reading);
    });
    client.on("error", (e) => console.error("[iot-mqtt-bridge] Lỗi MQTT:", e.message));
    client.on("close", () => setTimeout(connectLoop, 3000).unref());
  }

  setInterval(() => void flush(), flushMs).unref();
  connectLoop();
}

module.exports = { TOPIC_RE, validateEdgeTelemetry, createS3Client, startBridge };

if (require.main === module) {
  startBridge();
}
