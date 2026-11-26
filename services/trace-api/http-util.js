// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Làng Nghề Số contributors
"use strict";
/** Tiện ích HTTP, kiểm tra đầu vào cơ bản và giải mã JWT / phân quyền dùng chung cho các router. */

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(data) });
  res.end(data);
}

function sendText(res, status, text, contentType = "text/plain; charset=utf-8") {
  const buf = Buffer.from(text, "utf8");
  res.writeHead(status, { "content-type": contentType, "content-length": buf.length });
  res.end(buf);
}

function sendBinary(res, status, buf, headers = {}) {
  res.writeHead(status, { "content-length": buf.length, ...headers });
  res.end(buf);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 100_000) throw new HttpError(413, "Nội dung quá lớn");
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "JSON không hợp lệ");
  }
}

async function readBuffer(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size <= limit) chunks.push(chunk);
  }
  if (size > limit) throw new HttpError(413, `Tệp quá lớn (tối đa ${Math.floor(limit / 1024 / 1024)} MB)`);
  return Buffer.concat(chunks);
}

/** Đọc thông tin người dùng từ JWT (chữ ký đã được APISIX kiểm tra). */
function getUser(req) {
  const h = req.headers.authorization ?? "";
  const m = /^Bearer\s+([\w-]+)\.([\w-]+)\.[\w-]+$/.exec(h);
  if (!m) throw new HttpError(401, "Thiếu hoặc sai token");
  try {
    const p = JSON.parse(Buffer.from(m[2], "base64url").toString("utf8"));
    if (p.exp && p.exp * 1000 < Date.now()) throw new Error("hết hạn");
    const coop = Array.isArray(p.coop) ? p.coop[0] : p.coop;
    return { name: p.preferred_username ?? p.sub ?? "unknown", roles: Array.isArray(p.policy) ? p.policy : [], coop: typeof coop === "string" ? coop : "" };
  } catch {
    throw new HttpError(401, "Token không hợp lệ");
  }
}

const str = (v, max, field, required = false) => {
  const s = typeof v === "string" ? v.trim() : "";
  if (required && !s) throw new HttpError(400, `Thiếu trường "${field}"`);
  if (s.length > max) throw new HttpError(400, `Trường "${field}" tối đa ${max} ký tự`);
  return s;
};

function makeAuthHelpers(access, ACCESS) {
  function requirePermission(user, action, resource = {}) {
    if (!access.canApi(ACCESS, user.roles)) throw new HttpError(403, "Vai trò của bạn không dùng được API này");
    if (access.authorize(ACCESS, user, action, resource)) return;
    const scope = access.scopeFor(ACCESS, user.roles, action);
    if (!scope) throw new HttpError(403, "Vai trò của bạn không có quyền thực hiện thao tác này");
    if ((scope === "coop" || scope === "self") && !user.coop) throw new HttpError(403, "Tài khoản chưa thuộc HTX nào (thiếu thuộc tính coop), liên hệ quản trị");
    throw new HttpError(403, scope === "own" ? "Chỉ được thao tác trên sản phẩm do chính bạn tạo" : "Chỉ được thao tác trên sản phẩm thuộc HTX của bạn");
  }

  function needScope(user, action) {
    if (!access.canApi(ACCESS, user.roles)) throw new HttpError(403, "Vai trò của bạn không dùng được API này");
    const scope = access.scopeFor(ACCESS, user.roles, action);
    if (!scope) throw new HttpError(403, "Vai trò của bạn không có quyền thực hiện thao tác này");
    if (scope === "coop" && !user.coop) throw new HttpError(403, "Tài khoản của bạn chưa thuộc HTX nào (thiếu thuộc tính coop), liên hệ quản trị");
    return scope;
  }

  return { requirePermission, needScope };
}

module.exports = { HttpError, send, sendText, sendBinary, readJson, readBuffer, getUser, str, makeAuthHelpers };
