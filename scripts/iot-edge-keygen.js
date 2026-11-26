#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Làng Nghề Số contributors
"use strict";
/**
 * Sinh cặp khóa chữ ký số Ed25519 (32-byte raw hex) cho thiết bị cảm biến biên (ví dụ ESP32 + MAX6675 / DS18B20).
 * Dùng: node scripts/iot-edge-keygen.js [deviceId]
 */
const { generateEdgeKeypair } = require("../services/trace-api/iot-signing");

const deviceId = process.argv[2] || "kiln-esp32-01";
const { publicKeyHex, privateSeedHex } = generateEdgeKeypair();

console.log(`=== CẶP KHÓA ED25519 CHO THIẾT BỊ BIÊN: ${deviceId} ===\n`);
console.log("1. Khai báo vào config/iot-devices.json (khóa công khai để máy chủ xác thực):");
console.log(
  JSON.stringify(
    {
      [deviceId]: {
        gateway: "dxos-iot",
        coop: "htx-demo",
        min: 0,
        max: 1400,
        maxRatePerSec: 30,
        publicKey: publicKeyHex,
        requireSignature: true,
      },
    },
    null,
    2,
  ),
);
console.log("\n2. Nạp vào firmware ESP32 / thiết bị biên (BÍ MẬT, không đưa lên git):");
console.log(`   ED25519_PRIVATE_SEED_HEX = "${privateSeedHex}"`);
console.log(`   ED25519_PUBLIC_KEY_HEX   = "${publicKeyHex}"`);
console.log(`   Chuỗi chuẩn hóa để ký:   "<deviceId>|<metric>|<value>|<unit>|<timestamp>"`);
