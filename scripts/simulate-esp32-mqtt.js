#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Làng Nghề Số contributors
"use strict";
/**
 * Trình mô phỏng vi điều khiển ESP32 gửi số liệu nhiệt độ kèm chữ ký số Ed25519 qua giao thức MQTT
 * tới broker Eclipse Mosquitto (`127.0.0.1:1883`, chủ đề `dxos/iot/<deviceId>/telemetry`).
 *
 * Dùng: node scripts/simulate-esp32-mqtt.js [deviceId] [value] [privateSeedHex]
 */
const { generateEdgeKeypair, signReading } = require("../services/trace-api/iot-signing");
const { connectMqtt } = require("../services/trace-api/mqtt-protocol");

const deviceId = process.argv[2] || "kiln-01";
const value = Number(process.argv[3] ?? 1152.4);
const keys = process.argv[4] ? { privateSeedHex: process.argv[4], publicKeyHex: "(đã cấp)" } : generateEdgeKeypair();

const reading = {
  deviceId,
  deviceName: `Cảm biến biên ${deviceId}`,
  metric: "temperature",
  value,
  unit: "°C",
  timestamp: new Date().toISOString(),
};
const sig = signReading(reading, keys.privateSeedHex);
const packet = { ...reading, sig };

const host = process.env.MQTT_HOST ?? "127.0.0.1";
const port = Number(process.env.MQTT_PORT ?? 1883);
const topic = `dxos/iot/${deviceId}/telemetry`;

const client = connectMqtt({ host, port, clientId: `esp32-sim-${deviceId}` });
client.on("connect", () => {
  client.publish(topic, JSON.stringify(packet), { qos: 1 });
  console.log(`Đã gửi gói tin MQTT có chữ ký Ed25519 tới ${host}:${port} [${topic}]:`);
  console.log(JSON.stringify(packet, null, 2));
  setTimeout(() => client.end(), 300);
});
client.on("error", (e) => {
  console.error("Không kết nối được MQTT broker:", e.message);
  process.exit(1);
});
