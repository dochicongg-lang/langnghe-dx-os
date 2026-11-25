// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Làng Nghề Số contributors
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { validateAgainstSchema, auditSchemas } = require("../../../scripts/validate-schemas");

test("validateAgainstSchema: từ chối trường lạ, kiểu sai, và chấp nhận bản hợp lệ", () => {
  const schema = {
    type: "object",
    required: ["key"],
    additionalProperties: false,
    properties: { key: { type: "string", pattern: "^[a-z]+$" }, count: { type: "number", minimum: 1 } },
  };
  assert.deepEqual(validateAgainstSchema(schema, { key: "gom", count: 2 }), []);
  assert.ok(validateAgainstSchema(schema, { key: "GOM", extra: 1 }).length >= 2);
});

test("tất cả tệp config/*.json khớp schemas/*.schema.json và openapi.yaml 3.1 hợp lệ", () => {
  const r = auditSchemas(path.join(__dirname, "..", "..", ".."));
  assert.equal(r.ok, true, r.errors.join("\n"));
});
