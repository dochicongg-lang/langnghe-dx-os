// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Làng Nghề Số contributors
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { toAscii, buildMinutesPdf } = require("../pdf");

test("toAscii: chuyển đổi tiếng Việt có dấu sang ASCII an toàn cho Type1 Helvetica", () => {
  assert.equal(toAscii("Biên bản Hội đồng OCOP — Đạt 4 sao"), "Bien ban Hoi dong OCOP   Dat 4 sao");
  assert.equal(toAscii("Hợp tác xã Làng gốm Bát Tràng"), "Hop tac xa Lang gom Bat Trang");
});

test("buildMinutesPdf: xuất tệp PDF 1.4 hợp lệ chứa mã hồ sơ, điểm trung bình và băm SHA-256", () => {
  const { buffer, sha256 } = buildMinutesPdf({
    application: {
      code: "OCOP-20261125-AB12",
      state: "recognized",
      product_name: "Bình gốm men rạn Bát Tràng",
      product_group: "thu-cong-my-nghe",
      owner: "hoa",
      coop: "htx-demo",
      profile: "hanoi-2026",
    },
    profile: { name: "Thành phố Hà Nội (2026)", verified: false },
    councilSummary: { count: 2, minQuorum: 2, quorumMet: true, avgParts: { A: 31, B: 20, C: 26 }, avgTotal: 77, suggestedStars: 4 },
    scores: [
      { member_username: "ocop", member_name: "Nguyễn Văn A", scores: { A: 30, B: 20, C: 26 }, total: 76, comment: "Mẫu mã tốt" },
      { member_username: "chuyen-gia-1", member_name: "Trần Thị B", scores: { A: 32, B: 20, C: 26 }, total: 78, comment: "Đạt chuẩn" },
    ],
    result: { decision_no: "123/QĐ-UBND", decided_at: "2026-11-25", authority: "UBND Thành phố Hà Nội", score: 77, stars: 4, recognized: true, valid_until: "2029-11-25" },
    generatedAt: "2026-11-25T13:00:00Z",
  });
  assert.match(sha256, /^[0-9a-f]{64}$/);
  const text = buffer.toString("latin1");
  assert.ok(text.startsWith("%PDF-1.4\n"));
  assert.ok(text.includes("xref\n"));
  assert.ok(text.trimEnd().endsWith("%%EOF"));
  assert.ok(text.includes("OCOP-20261125-AB12"));
  assert.ok(text.includes("77/100"));
  assert.ok(text.includes("123/QD-UBND"));
});
