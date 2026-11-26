#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Làng Nghề Số contributors
"use strict";
/**
 * Kiểm tra cấu hình JSON cộng đồng đóng góp (config/*.json) khớp các JSON Schema trong `schemas/`
 * và kiểm tra đặc tả `openapi.yaml` đạt chuẩn OpenAPI 3.1. Không phụ thuộc thư viện ngoài.
 */
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

function resolveRef(rootSchema, ref) {
  if (!ref.startsWith("#/")) throw new Error(`Không hỗ trợ $ref ngoài tệp: ${ref}`);
  let cur = rootSchema;
  for (const part of ref.slice(2).split("/")) {
    cur = cur?.[part];
  }
  if (!cur) throw new Error(`Không tìm thấy $ref ${ref}`);
  return cur;
}

function matchType(expected, val) {
  if (Array.isArray(expected)) return expected.some((t) => matchType(t, val));
  if (expected === "null") return val === null;
  if (expected === "array") return Array.isArray(val);
  if (expected === "object") return typeof val === "object" && val !== null && !Array.isArray(val);
  if (expected === "integer") return typeof val === "number" && Number.isInteger(val);
  return typeof val === expected;
}

/** Kiểm tra dữ liệu JSON theo JSON Schema (Draft 2020-12 subset). Trả về danh sách lỗi (rỗng = hợp lệ). */
function validateAgainstSchema(schema, data, rootSchema = schema, p = "$") {
  const errors = [];
  if (schema.$ref) {
    return validateAgainstSchema(resolveRef(rootSchema, schema.$ref), data, rootSchema, p);
  }
  if (schema.type && !matchType(schema.type, data)) {
    errors.push(`${p}: kỳ vọng kiểu ${JSON.stringify(schema.type)}, nhận ${Array.isArray(data) ? "array" : data === null ? "null" : typeof data}`);
    return errors;
  }
  if (schema.enum && !schema.enum.includes(data)) {
    errors.push(`${p}: giá trị ${JSON.stringify(data)} không nằm trong enum [${schema.enum.join(", ")}]`);
  }
  if (typeof data === "string") {
    if (schema.minLength !== undefined && data.length < schema.minLength) errors.push(`${p}: độ dài tối thiểu ${schema.minLength}`);
    if (schema.pattern && !new RegExp(schema.pattern).test(data)) errors.push(`${p}: "${data}" không khớp mẫu ${schema.pattern}`);
  }
  if (typeof data === "number") {
    if (schema.minimum !== undefined && data < schema.minimum) errors.push(`${p}: ${data} < minimum (${schema.minimum})`);
    if (schema.maximum !== undefined && data > schema.maximum) errors.push(`${p}: ${data} > maximum (${schema.maximum})`);
  }
  if (Array.isArray(data)) {
    if (schema.minItems !== undefined && data.length < schema.minItems) errors.push(`${p}: cần tối thiểu ${schema.minItems} phần tử`);
    if (schema.maxItems !== undefined && data.length > schema.maxItems) errors.push(`${p}: tối đa ${schema.maxItems} phần tử`);
    if (schema.items) {
      data.forEach((item, idx) => errors.push(...validateAgainstSchema(schema.items, item, rootSchema, `${p}[${idx}]`)));
    }
  }
  if (typeof data === "object" && data !== null && !Array.isArray(data)) {
    for (const reqKey of schema.required ?? []) {
      if (!(reqKey in data)) errors.push(`${p}: thiếu trường bắt buộc "${reqKey}"`);
    }
    const props = schema.properties ?? {};
    const patterns = Object.entries(schema.patternProperties ?? {}).map(([re, sub]) => [new RegExp(re), sub]);
    for (const [k, v] of Object.entries(data)) {
      if (k in props) {
        errors.push(...validateAgainstSchema(props[k], v, rootSchema, `${p}.${k}`));
      } else {
        const hit = patterns.find(([re]) => re.test(k));
        if (hit) errors.push(...validateAgainstSchema(hit[1], v, rootSchema, `${p}.${k}`));
        else if (schema.additionalProperties === false) errors.push(`${p}: không cho phép trường lạ "${k}"`);
        else if (typeof schema.additionalProperties === "object") errors.push(...validateAgainstSchema(schema.additionalProperties, v, rootSchema, `${p}.${k}`));
      }
    }
  }
  return errors;
}

const PAIRS = [
  ["schemas/sectors.schema.json", "config/sectors.json"],
  ["schemas/kiln-profiles.schema.json", "config/kiln-profiles.json"],
  ["schemas/ocop-profiles.schema.json", "config/ocop-profiles.json"],
];

function auditSchemas(root = ROOT) {
  const errors = [];
  for (const [schemaRel, dataRel] of PAIRS) {
    const schema = JSON.parse(fs.readFileSync(path.join(root, schemaRel), "utf8"));
    const data = JSON.parse(fs.readFileSync(path.join(root, dataRel), "utf8"));
    for (const err of validateAgainstSchema(schema, data)) errors.push(`${dataRel}: ${err}`);
  }
  const openapiPath = path.join(root, "openapi.yaml");
  if (!fs.existsSync(openapiPath)) errors.push("Thiếu openapi.yaml ở gốc kho mã");
  else {
    const oa = fs.readFileSync(openapiPath, "utf8");
    if (!/^openapi:\s*3\.1\.0\b/m.test(oa)) errors.push("openapi.yaml: phải khai báo openapi: 3.1.0");
    if (!oa.includes("/api/trace/v1")) errors.push("openapi.yaml: thiếu server đường dẫn /api/trace/v1");
    for (const mustPath of ["/products:", "/iot/readings:", "/applications/{code}/council/scores:", "/applications/{code}/minutes.pdf:", "/alerts/proposals:", "/lake/analytics/{name}:"]) {
      if (!oa.includes(mustPath)) errors.push(`openapi.yaml: thiếu mô tả tuyến ${mustPath}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

module.exports = { validateAgainstSchema, auditSchemas, PAIRS };

if (require.main === module) {
  const r = auditSchemas(ROOT);
  if (!r.ok) {
    console.error("KHÔNG ĐẠT kiểm tra Schema & OpenAPI:");
    for (const e of r.errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log(`OK: ${PAIRS.length} tệp cấu hình khớp JSON Schema và openapi.yaml (3.1.0) hợp lệ.`);
}
