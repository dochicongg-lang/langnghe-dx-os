// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Làng Nghề Số contributors
"use strict";
/**
 * Mời và quản lý thành viên: luật "ai được mời ai", mã mời, kiểm tra thông tin nhận lời mời.
 * Hàm thuần (không đụng CSDL hay Keycloak) để kiểm thử được; máy chủ nối phần còn lại.
 *
 * Nguyên tắc: người mời chỉ cấp được vai trò và HTX nằm trong phạm vi của chính mình (config/access.json: "invitable" và quyền member.invite).
 * Vai trò cán bộ chỉ quản trị mời được (đó là bước phê duyệt vai trò cán bộ); cán bộ HTX chỉ mời nghệ nhân vào HTX của mình.
 */
const crypto = require("node:crypto");
const access = require("./access");

class MemberError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Mã trong liên kết mời: 32 byte ngẫu nhiên (256 bit), dạng base64url. Chỉ băm của nó được lưu. */
const newToken = () => crypto.randomBytes(32).toString("base64url");
const hashToken = (token) => crypto.createHash("sha256").update(String(token)).digest("hex");
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** Các vai trò mà người dùng này được mời (hợp của các vai trò của họ), chỉ lấy role có trong cấu hình. */
function invitableRoles(cfg, roles) {
  const out = new Set();
  for (const r of access.expand(cfg, roles)) for (const t of cfg.invitable?.[r] ?? []) if (cfg.roles[t]) out.add(t);
  return [...out];
}

/** Vai trò nào gắn với một HTX (nghệ nhân, cán bộ HTX): các vai trò có quyền theo phạm vi coop hoặc own/self. */
function roleNeedsCoop(cfg, role) {
  return Object.values(cfg.permissions).some((byRole) => ["coop", "own", "self"].includes(byRole[role]));
}

/**
 * Kiểm tra một lời mời. user: { name, roles, coop }. input: { role, coop }. coops: tập mã HTX hợp lệ.
 * Trả { role, coop } đã chuẩn hóa (coop của người mời được ép lại nếu phạm vi chỉ là HTX của họ), hoặc ném MemberError.
 */
function checkInvite(cfg, user, input, coops) {
  const scope = access.scopeFor(cfg, user.roles, "member.invite");
  if (!scope) throw new MemberError(403, "Vai trò của bạn không được mời thành viên");
  const role = typeof input?.role === "string" ? input.role : "";
  const allowed = invitableRoles(cfg, user.roles);
  if (!cfg.roles[role]) throw new MemberError(400, "Vai trò không hợp lệ");
  if (!allowed.includes(role)) throw new MemberError(403, "Bạn không được mời vai trò này (vai trò cán bộ do quản trị mời)");
  let coop = typeof input?.coop === "string" ? input.coop.trim() : "";
  if (scope === "coop") {
    if (!user.coop) throw new MemberError(403, "Tài khoản của bạn chưa thuộc HTX nào nên chưa mời được");
    coop = user.coop; // luôn là HTX của người mời, bỏ qua giá trị client gửi
  }
  if (roleNeedsCoop(cfg, role)) {
    if (!coop) throw new MemberError(400, "Cần chọn hợp tác xã cho vai trò này");
    if (!coops.has(coop)) throw new MemberError(400, "Hợp tác xã không tồn tại");
  } else coop = "";
  return { role, coop: coop || null };
}

/** Người mời có quản lý (xem, khóa, mở khóa) được thành viên này không: cùng HTX và là vai trò mình được mời; quản trị thì mọi người trừ chính mình. */
function canManage(cfg, user, member) {
  const scope = access.scopeFor(cfg, user.roles, "member.lock");
  if (!scope) return false;
  if (member.username === user.name) return false; // không tự khóa mình
  if (scope === "all") return true;
  if (scope !== "coop" || !user.coop || member.coop !== user.coop) return false;
  const mine = new Set(invitableRoles(cfg, user.roles));
  return member.roles.length > 0 && member.roles.every((r) => mine.has(r)); // không đụng vào cán bộ hay quản trị
}

/** Trạng thái hiển thị của lời mời. */
function inviteStatus(row, now = new Date()) {
  if (row.status !== "pending") return row.status;
  return new Date(row.expires_at).getTime() <= now.getTime() ? "expired" : "pending";
}

const USERNAME_RE = /^[a-z][a-z0-9._-]{2,29}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Kiểm tra thông tin người nhận lời mời nhập; trả bản chuẩn hóa để tạo tài khoản. */
function checkAccept(b) {
  const username = typeof b?.username === "string" ? b.username.trim().toLowerCase() : "";
  if (!USERNAME_RE.test(username)) throw new MemberError(400, "Tên đăng nhập dài 3 đến 30 ký tự, bắt đầu bằng chữ thường, chỉ gồm chữ không dấu, số, dấu chấm, gạch ngang, gạch dưới");
  const password = typeof b?.password === "string" ? b.password : "";
  if (password.length < 8 || password.length > 128) throw new MemberError(400, "Mật khẩu dài từ 8 đến 128 ký tự");
  if (password.toLowerCase().includes(username)) throw new MemberError(400, "Mật khẩu không được chứa tên đăng nhập");
  const full = typeof b?.full_name === "string" ? b.full_name.trim().replace(/\s+/g, " ") : "";
  if (full.length < 2 || full.length > 80) throw new MemberError(400, "Họ và tên dài 2 đến 80 ký tự");
  let email = typeof b?.email === "string" ? b.email.trim() : "";
  if (email && (!EMAIL_RE.test(email) || email.length > 120)) throw new MemberError(400, "Email không hợp lệ");
  if (!email) email = `${username}@dxos.local`; // Keycloak yêu cầu có email mới cấp được token; chưa dùng để gửi thư
  const words = full.split(" ");
  const firstName = words[words.length - 1]; // tên (từ cuối)
  const lastName = words.length > 1 ? words.slice(0, -1).join(" ") : "-"; // họ và tên đệm
  return { username, password, email, firstName, lastName };
}

module.exports = { MemberError, newToken, hashToken, TOKEN_RE, invitableRoles, roleNeedsCoop, checkInvite, canManage, inviteStatus, checkAccept };
