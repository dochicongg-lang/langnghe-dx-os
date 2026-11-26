// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Làng Nghề Số contributors
"use strict";
/**
 * Cơ chế đề xuất cảnh báo có kiểm duyệt (Human-in-the-loop Alerting).
 *
 * Khi bộ luật phân tích đường cong nhiệt (kiln.js) trả kết luận "warn" (cần xem lại) hoặc "alert" (cảnh báo),
 * mô-đun tạo một ĐỀ XUẤT CẢNH BÁO kèm căn cứ số liệu; chỉ khi người có thẩm quyền duyệt trên giao diện
 * thì thông báo mới được phát hành. Toàn bộ là hàm thuần, không phụ thuộc mạng hay CSDL.
 */

/** Tạo đề xuất cảnh báo từ kết quả phân tích đường cong nhiệt; trả null nếu đạt chuẩn hoặc chưa đủ dữ liệu. */
function proposeFromKiln({ product, eventId, insight }) {
  if (!insight || !["warn", "alert"].includes(insight.verdict)) return null;
  const severity = insight.verdict;
  const issues = (insight.findings ?? []).filter((f) => f.level === "alert" || f.level === "warn").map((f) => f.text);
  const toCoop = product.coop ? "coop-officer" : "admin"; // sản phẩm chưa gắn HTX thì báo quản trị
  const name = product.name;
  const batch = insight.profile?.terms?.batch ?? "mẻ nung";
  return {
    dedupe_key: `kiln:${eventId}`,
    kind: "kiln_review",
    severity,
    title: severity === "alert" ? `Đề nghị kiểm tra gấp ${batch} của "${name}" (${product.code})` : `Đề nghị xem lại ${batch} của "${name}" (${product.code})`,
    rationale: `${insight.summary}${issues.length ? ` Căn cứ: ${issues.join(" ")}` : ""}`,
    subject: product.code,
    coop: product.coop ?? null,
    action: {
      type: "notify",
      for_role: toCoop,
      for_coop: product.coop ?? null,
      level: severity,
      title: severity === "alert" ? `Cần kiểm tra gấp ${batch} ${product.code}` : `Cần xem lại ${batch} ${product.code}`,
      body: `${insight.summary}${issues.length ? ` ${issues.join(" ")}` : ""} Đề xuất đã được người có thẩm quyền duyệt.`,
      link: `/trace/${product.code}`,
    },
  };
}

/** Chuyển một đề xuất đã được duyệt thành thông báo cần ghi (dedupe_key riêng theo mã đề xuất). */
function notificationFor(proposal) {
  const a = proposal.action;
  if (!a || a.type !== "notify") throw new Error("hành động đề xuất không được hỗ trợ");
  return {
    dedupe_key: `agent:${proposal.id}`,
    kind: "agent_kiln",
    level: a.level === "alert" ? "alert" : "warn",
    title: a.title,
    body: a.body,
    link: a.link ?? null,
    for_role: a.for_role,
    for_coop: a.for_coop ?? null,
    for_user: null,
  };
}

module.exports = { proposeFromKiln, notificationFor };
