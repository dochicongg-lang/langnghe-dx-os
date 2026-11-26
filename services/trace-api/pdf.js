// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Làng Nghề Số contributors
"use strict";
/**
 * Bộ sinh biên bản PDF 1.4 thuần Node.js (không phụ thuộc thư viện ngoài) cho hồ sơ đánh giá OCOP.
 * Dùng phông chuẩn Type1 Helvetica, chuyển đổi dấu tiếng Việt sang dạng ASCII sạch để mọi trình đọc PDF
 * hiển thị chính xác, kèm mã băm SHA-256 kiểm chứng toàn vẹn.
 */
const crypto = require("node:crypto");

const VI_MAP = [
  [/[àáạảãâầấậẩẫăằắặẳẵ]/g, "a"],
  [/[ÀÁẠẢÃÂẦẤẬẨẪĂẰẮẶẲẴ]/g, "A"],
  [/[èéẹẻẽêềếệểễ]/g, "e"],
  [/[ÈÉẸẺẼÊỀẾỆỂỄ]/g, "E"],
  [/[ìíịỉĩ]/g, "i"],
  [/[ÌÍỊỈĨ]/g, "I"],
  [/[òóọỏõôồốộổỗơờớợởỡ]/g, "o"],
  [/[ÒÓỌỎÕÔỒỐỘỔỖƠỜỚỢỞỠ]/g, "O"],
  [/[ùúụủũưừứựửữ]/g, "u"],
  [/[ÙÚỤỦŨƯỪỨỰỬỮ]/g, "U"],
  [/[ỳýỵỷỹ]/g, "y"],
  [/[ỲÝỴỶỸ]/g, "Y"],
  [/đ/g, "d"],
  [/Đ/g, "D"],
];

function toAscii(text) {
  let out = String(text ?? "").normalize("NFC");
  for (const [re, rep] of VI_MAP) out = out.replace(re, rep);
  return out.replace(/[^\x20-\x7e]/g, " ");
}

function pdfEscape(s) {
  return toAscii(s).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function wrapLine(text, maxChars = 84) {
  const s = toAscii(text).trim();
  if (!s) return [""];
  const words = s.split(/\s+/);
  const lines = [];
  let cur = "";
  for (const w of words) {
    if (!cur) cur = w;
    else if (cur.length + 1 + w.length <= maxChars) cur += " " + w;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Tạo tệp PDF biên bản chấm điểm Hội đồng OCOP; trả `{ buffer, sha256 }`. */
function buildMinutesPdf({ application, profile, councilSummary, scores = [], result = null, generatedAt = new Date().toISOString() }) {
  const lines = [];
  lines.push({ size: 14, bold: true, text: "BIEN BAN HOI DONG DANH GIA, PHAN HANG SAN PHAM OCOP" });
  lines.push({ size: 10, text: "He thong Ho tro Ho so OCOP - Lang Nghe So (DX-OS Open-Core)" });
  lines.push({ size: 10, text: "--------------------------------------------------------------------------------" });
  lines.push({ size: 10, text: `Ma ho so: ${application.code}   |   Trang thai: ${application.state}` });
  lines.push({ size: 10, text: `San pham: ${application.product_name}` });
  lines.push({ size: 10, text: `Nhom san pham: ${application.product_group}   |   Chu the (user): ${application.owner}` });
  lines.push({ size: 10, text: `Hop tac xa: ${application.coop ?? "Khong gan HTX"}   |   Bo tieu chi: ${profile?.name ?? application.profile}` });
  if (profile?.verified === false) {
    lines.push({ size: 9, text: "Luu y: Nguong diem va quy dinh bo tieu chi dang danh dau verified=false (tham khao)." });
  }
  lines.push({ size: 10, text: "" });
  lines.push({ size: 11, bold: true, text: "I. TONG HOP DIEM CHAM HOI DONG (MULTI-INSTANCE)" });
  if (!scores.length) {
    lines.push({ size: 10, text: "Chua co phieu cham diem doc lap nao cua thanh vien Hoi dong." });
  } else {
    lines.push({
      size: 10,
      text: `So phieu hop le: ${councilSummary.count} (toi thieu ${councilSummary.minQuorum} phieu: ${councilSummary.quorumMet ? "DAT QUORUM" : "CHUA DU QUORUM"})`,
    });
    const partText = Object.entries(councilSummary.avgParts ?? {})
      .map(([k, v]) => `Phan ${k}: ${v}`)
      .join(" | ");
    lines.push({ size: 10, text: `Diem trung binh thanh phan: ${partText}` });
    lines.push({
      size: 10,
      bold: true,
      text: `Tong diem trung binh: ${councilSummary.avgTotal}/100  ->  Du kien hang: ${councilSummary.suggestedStars ?? "Chua dat"} sao`,
    });
    lines.push({ size: 10, text: "" });
    lines.push({ size: 10, bold: true, text: "Chi tiet phieu cham tung thanh vien:" });
    scores.forEach((s, idx) => {
      const p = Object.entries(s.scores ?? {})
        .map(([k, v]) => `${k}=${v}`)
        .join(", ");
      lines.push({ size: 9, text: `${idx + 1}. ${s.member_name || s.member_username} (${s.member_username}): Tong ${Number(s.total)}/100 [${p}]` });
      if (s.comment) {
        for (const wl of wrapLine(`   Nhan xet: ${s.comment}`, 86)) lines.push({ size: 9, text: wl });
      }
    });
  }
  lines.push({ size: 10, text: "" });
  lines.push({ size: 11, bold: true, text: "II. KET QUA CHINH THUC CUA CO QUAN CO THAM QUYEN" });
  if (result) {
    lines.push({ size: 10, text: `So quyet dinh: ${result.decision_no}   |   Ngay ky: ${result.decided_at}` });
    lines.push({ size: 10, text: `Co quan ban hanh: ${result.authority}` });
    lines.push({ size: 10, text: `Diem chinh thuc: ${result.score}/100   |   Hang sao: ${result.stars} sao   |   Cong nhan: ${result.recognized ? "CO" : "KHONG"}` });
    if (result.valid_until) lines.push({ size: 10, text: `Hieu luc den ngay: ${result.valid_until}` });
  } else {
    lines.push({ size: 10, text: "Chua ghi nhan quyet dinh chinh thuc." });
  }
  lines.push({ size: 10, text: "" });
  lines.push({ size: 9, text: `Xuat bien ban luc: ${generatedAt}` });
  lines.push({ size: 10, text: "Chu ky thu ky Hoi dong: ______________________    Chu tich Hoi dong: ______________________" });

  // Dựng nhiều trang A4 nếu dài
  const pages = [];
  let curOps = [];
  let y = 790;
  for (const item of lines) {
    const size = item.size ?? 10;
    const step = size + 5;
    if (y < 60) {
      pages.push(curOps.join("\n"));
      curOps = [];
      y = 790;
    }
    const font = item.bold ? "/F2" : "/F1";
    curOps.push(`BT ${font} ${size} Tf 48 ${y} Td (${pdfEscape(item.text)}) Tj ET`);
    y -= step;
  }
  if (curOps.length || pages.length === 0) pages.push(curOps.join("\n"));

  const objects = [];
  const addObj = (body) => {
    objects.push(body);
    return objects.length;
  };
  const f1Id = addObj("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const f2Id = addObj("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>");
  const pagesPlaceholderIdx = objects.length;
  addObj(""); // placeholder Pages

  const pageIds = [];
  for (const stream of pages) {
    const len = Buffer.byteLength(stream, "latin1");
    const contentId = addObj(`<< /Length ${len} >>\nstream\n${stream}\nendstream`);
    const pageId = addObj(`<< /Type /Page /Parent 3 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${f1Id} 0 R /F2 ${f2Id} 0 R >> >> /Contents ${contentId} 0 R >>`);
    pageIds.push(pageId);
  }
  objects[pagesPlaceholderIdx] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;
  const catalogId = addObj("<< /Type /Catalog /Pages 3 0 R >>");

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefPos = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i < offsets.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;

  const buffer = Buffer.from(pdf, "latin1");
  const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
  return { buffer, sha256 };
}

module.exports = { toAscii, buildMinutesPdf };
