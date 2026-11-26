// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Làng Nghề Số contributors
"use strict";
/**
 * Xác thực chữ ký số Ed25519 tại biên (Edge IoT Signing) cho vi điều khiển ESP32 / cổng thu thập.
 *
 * Chuỗi chuẩn hóa để ký (UTF-8, không phụ thuộc khoảng trắng JSON):
 *   `${deviceId}|${metric}|${value}|${unit}|${timestamp}`
 *
 * Khóa công khai lưu trong `config/iot-devices.json` ở dạng hex 64 ký tự (raw 32-byte Ed25519 public key)
 * để tương thích trực tiếp với thư viện `Ed25519` / `libsodium` trên ESP32.
 */
const crypto = require("node:crypto");

// Tiền tố ASN.1 DER cố định cho khóa Ed25519 (RFC 8410) để chuyển đổi nhanh giữa raw 32-byte và KeyObject của Node.js
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

const HEX32_RE = /^[0-9a-fA-F]{64}$/;
const HEX64_RE = /^[0-9a-fA-F]{128}$/;

/** Chuỗi thông điệp chuẩn hóa để thiết bị biên ký và máy chủ xác thực. */
function canonicalReadingPayload(r) {
  const numVal = Number(r?.value);
  const valStr = Number.isFinite(numVal) ? String(numVal) : "";
  return `${r?.deviceId ?? ""}|${r?.metric ?? ""}|${valStr}|${r?.unit ?? ""}|${r?.timestamp ?? ""}`;
}

/** Sinh cặp khóa Ed25519 dạng raw hex 32-byte (`{ publicKeyHex, privateSeedHex }`). */
function generateEdgeKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const spki = publicKey.export({ type: "spki", format: "der" });
  const pkcs8 = privateKey.export({ type: "pkcs8", format: "der" });
  return {
    publicKeyHex: spki.subarray(SPKI_ED25519_PREFIX.length).toString("hex"),
    privateSeedHex: pkcs8.subarray(PKCS8_ED25519_PREFIX.length).toString("hex"),
  };
}

function publicKeyFromHex(publicKeyHex) {
  if (typeof publicKeyHex !== "string" || !HEX32_RE.test(publicKeyHex)) {
    throw new Error("Khóa công khai Ed25519 phải là chuỗi hex 64 ký tự (32 byte)");
  }
  const der = Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(publicKeyHex, "hex")]);
  return crypto.createPublicKey({ key: der, format: "der", type: "spki" });
}

function privateKeyFromSeedHex(privateSeedHex) {
  if (typeof privateSeedHex !== "string" || !HEX32_RE.test(privateSeedHex)) {
    throw new Error("Khóa bí mật (seed) Ed25519 phải là chuỗi hex 64 ký tự (32 byte)");
  }
  const der = Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(privateSeedHex, "hex")]);
  return crypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" });
}

/** Ký bản ghi đo cảm biến bằng Ed25519 private seed (hex 64 ký tự), trả chữ ký hex 128 ký tự (64 byte). */
function signReading(reading, privateSeedHex) {
  const priv = privateKeyFromSeedHex(privateSeedHex);
  const msg = Buffer.from(canonicalReadingPayload(reading), "utf8");
  return crypto.sign(null, msg, priv).toString("hex");
}

/** Xác thực chữ ký Ed25519 của một bản ghi đo cảm biến với `publicKeyHex`. */
function verifyReading(reading, publicKeyHex, signatureHex = reading?.sig) {
  if (!publicKeyHex || !HEX32_RE.test(publicKeyHex)) return false;
  if (typeof signatureHex !== "string" || !HEX64_RE.test(signatureHex)) return false;
  try {
    const pub = publicKeyFromHex(publicKeyHex);
    const msg = Buffer.from(canonicalReadingPayload(reading), "utf8");
    return crypto.verify(null, msg, pub, Buffer.from(signatureHex, "hex"));
  } catch {
    return false;
  }
}

module.exports = {
  HEX32_RE,
  HEX64_RE,
  canonicalReadingPayload,
  generateEdgeKeypair,
  signReading,
  verifyReading,
};
