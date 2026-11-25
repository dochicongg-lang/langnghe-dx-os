// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Làng Nghề Số contributors
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { isAllowedLicense, parseComposeImages, parseLayoutFonts, auditProject } = require("../../../scripts/check-licenses");

test("isAllowedLicense: chấp nhận giấy phép tự do tương thích và chặn copyleft/thiếu", () => {
  assert.equal(isAllowedLicense("MIT"), true);
  assert.equal(isAllowedLicense("(MIT OR Apache-2.0)"), true);
  assert.equal(isAllowedLicense("(BSD-2-Clause OR MIT OR Apache-2.0)"), true);
  assert.equal(isAllowedLicense("MIT AND ISC"), true);
  assert.equal(isAllowedLicense("GPL-3.0"), false);
  assert.equal(isAllowedLicense("AGPL-3.0-only"), false);
  assert.equal(isAllowedLicense(""), false);
  assert.equal(isAllowedLicense("Apache-2.0 AND LGPL-3.0-or-later", "@img/sharp-libvips-linux-x64"), true);
  assert.equal(isAllowedLicense("Apache-2.0 AND LGPL-3.0-or-later", "some-other-pkg"), false);
});

test("parseComposeImages & parseLayoutFonts: trích xuất đúng ảnh bên ngoài và tên phông", () => {
  const imgs = parseComposeImages("services:\n  a:\n    image: postgres:16\n  b:\n    image: clamav/clamav:1.4@sha256:abc\n  c:\n    image: dxos/trace-api:local\n");
  assert.deepEqual(imgs, ["postgres", "clamav/clamav"]);
  const fonts = parseLayoutFonts('import { Geist_Mono, Playfair_Display, Source_Sans_3 } from "next/font/google";');
  assert.deepEqual(fonts, ["Geist Mono", "Playfair Display", "Source Sans 3"]);
});

test("auditProject: kho mã hiện tại đồng bộ hoàn toàn THIRD-PARTY-NOTICES.md và phụ thuộc hợp lệ", () => {
  const res = auditProject(path.join(__dirname, "..", "..", ".."));
  assert.equal(res.ok, true, res.errors.join("\n"));
});
