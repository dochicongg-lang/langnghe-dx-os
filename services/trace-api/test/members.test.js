// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Làng Nghề Số contributors
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const access = require("../access");
const members = require("../members");
const { createKeycloakAdmin } = require("../keycloak-admin");

const CFG = access.load(path.join(__dirname, "..", "..", "..", "config", "access.json"));
const COOPS = new Set(["htx-demo", "htx-lua"]);
const admin = { name: "tester", roles: ["editor"], coop: "" };
const officer = { name: "htxlua", roles: ["coop-officer"], coop: "htx-lua" };
const ocop = { name: "ocop", roles: ["ocop-officer"], coop: "" };
const producer = { name: "lua", roles: ["producer"], coop: "htx-lua" };

test("vai trò được mời: quản trị mời cả cán bộ, cán bộ HTX chỉ mời nghệ nhân, còn lại không mời được ai", () => {
  assert.deepEqual(members.invitableRoles(CFG, ["editor"]).sort(), ["coop-officer", "ocop-officer", "producer", "readonly"]);
  assert.deepEqual(members.invitableRoles(CFG, ["coop-officer"]), ["producer"]);
  assert.deepEqual(members.invitableRoles(CFG, ["ocop-officer"]), []);
  assert.deepEqual(members.invitableRoles(CFG, ["producer"]), []);
  assert.ok(!members.invitableRoles(CFG, ["editor"]).includes("iot-writer"), "không mời được vai trò thiết bị");
});

test("cán bộ HTX mời nghệ nhân: HTX bị ép về HTX của mình dù client gửi HTX khác", () => {
  const r = members.checkInvite(CFG, officer, { role: "producer", coop: "htx-demo" }, COOPS);
  assert.deepEqual(r, { role: "producer", coop: "htx-lua" });
});

test("cán bộ HTX không mời được cán bộ, quản trị hay vai trò lạ", () => {
  for (const role of ["coop-officer", "ocop-officer", "admin", "editor", "iot-writer"]) {
    assert.throws(() => members.checkInvite(CFG, officer, { role }, COOPS), (e) => e.status === 403 || e.status === 400, role);
  }
  assert.throws(() => members.checkInvite(CFG, officer, { role: "không-có" }, COOPS), /không hợp lệ/);
});

test("cán bộ OCOP và nghệ nhân không mời được ai (theo quyết định: cán bộ OCOP không mời cán bộ HTX)", () => {
  assert.throws(() => members.checkInvite(CFG, ocop, { role: "coop-officer", coop: "htx-lua" }, COOPS), (e) => e.status === 403);
  assert.throws(() => members.checkInvite(CFG, producer, { role: "producer" }, COOPS), (e) => e.status === 403);
});

test("quản trị mời cán bộ HTX: bắt buộc chọn HTX có thật; vai trò không thuộc HTX thì bỏ HTX", () => {
  assert.deepEqual(members.checkInvite(CFG, admin, { role: "coop-officer", coop: "htx-demo" }, COOPS), { role: "coop-officer", coop: "htx-demo" });
  assert.throws(() => members.checkInvite(CFG, admin, { role: "coop-officer" }, COOPS), /chọn hợp tác xã/);
  assert.throws(() => members.checkInvite(CFG, admin, { role: "producer", coop: "htx-ma" }, COOPS), /không tồn tại/);
  assert.deepEqual(members.checkInvite(CFG, admin, { role: "readonly", coop: "htx-demo" }, COOPS), { role: "readonly", coop: null });
});

test("cán bộ HTX chưa có HTX thì chưa mời được", () => {
  assert.throws(() => members.checkInvite(CFG, { name: "x", roles: ["coop-officer"], coop: "" }, { role: "producer" }, COOPS), /chưa thuộc HTX/);
});

test("quản lý thành viên: cán bộ chỉ khóa được nghệ nhân cùng HTX, không khóa cán bộ khác, quản trị hay chính mình", () => {
  const m = (username, coop, roles) => ({ username, coop, roles });
  assert.equal(members.canManage(CFG, officer, m("lua", "htx-lua", ["producer"])), true);
  assert.equal(members.canManage(CFG, officer, m("hoa", "htx-demo", ["producer"])), false, "khác HTX");
  assert.equal(members.canManage(CFG, officer, m("htxlua2", "htx-lua", ["coop-officer"])), false, "cán bộ khác");
  assert.equal(members.canManage(CFG, officer, m("tester", "", ["admin"])), false);
  assert.equal(members.canManage(CFG, officer, m("htxlua", "htx-lua", ["coop-officer"])), false, "chính mình");
  assert.equal(members.canManage(CFG, admin, m("tuan", "htx-demo", ["coop-officer"])), true);
  assert.equal(members.canManage(CFG, admin, m("tester", "", ["admin"])), false, "quản trị không tự khóa mình");
  assert.equal(members.canManage(CFG, producer, m("x", "htx-lua", ["producer"])), false);
  assert.equal(members.canManage(CFG, officer, m("trống", "htx-lua", [])), false, "không rõ vai trò thì không đụng");
});

test("mã mời: ngẫu nhiên, đúng khuôn, chỉ lưu băm; trạng thái theo hạn", () => {
  const a = members.newToken();
  const b = members.newToken();
  assert.notEqual(a, b);
  assert.match(a, members.TOKEN_RE);
  assert.equal(members.hashToken(a).length, 64);
  assert.notEqual(members.hashToken(a), a);
  assert.equal(members.hashToken(a), members.hashToken(a));
  const now = new Date("2026-11-16T00:00:00Z");
  const row = (status, exp) => ({ status, expires_at: exp });
  assert.equal(members.inviteStatus(row("pending", "2026-11-20T00:00:00Z"), now), "pending");
  assert.equal(members.inviteStatus(row("pending", "2026-11-10T00:00:00Z"), now), "expired");
  assert.equal(members.inviteStatus(row("accepted", "2026-11-10T00:00:00Z"), now), "accepted");
  assert.equal(members.inviteStatus(row("revoked", "2026-11-20T00:00:00Z"), now), "revoked");
});

test("nhận lời mời: kiểm tra tên đăng nhập, mật khẩu, họ tên; tự điền email và tách họ tên", () => {
  const ok = members.checkAccept({ username: "  Nguyen.An ", password: "matkhau-dai-123", full_name: "Nguyễn  Văn  An" });
  assert.equal(ok.username, "nguyen.an");
  assert.equal(ok.email, "nguyen.an@dxos.local");
  assert.equal(ok.firstName, "An");
  assert.equal(ok.lastName, "Nguyễn Văn");
  assert.equal(members.checkAccept({ username: "abc", password: "matkhau-dai-123", full_name: "An", email: "an@x.vn" }).lastName, "-");
  const bad = (b) => assert.throws(() => members.checkAccept(b), (e) => e.status === 400);
  bad({ username: "ab", password: "matkhau-dai-123", full_name: "An An" });
  bad({ username: "1abc", password: "matkhau-dai-123", full_name: "An An" });
  bad({ username: "abc def", password: "matkhau-dai-123", full_name: "An An" });
  bad({ username: "abc", password: "ngắn", full_name: "An An" });
  bad({ username: "abc", password: "abc-abc-abc-abc", full_name: "An An" }); // chứa tên đăng nhập
  bad({ username: "abcd", password: "matkhau-dai-123", full_name: "A" });
  bad({ username: "abcd", password: "matkhau-dai-123", full_name: "An An", email: "khong-hop-le" });
});

test("keycloak-admin: tạo người dùng gán đúng một vai trò và HTX; lỗi gán vai trò thì xóa người dùng vừa tạo", async () => {
  const calls = [];
  const mk = (failMap) =>
    createKeycloakAdmin({
      baseUrl: "http://kc",
      realm: "dxos",
      clientId: "c",
      clientSecret: "s",
      fetchImpl: async (url, init = {}) => {
        const u = String(url);
        calls.push(`${init.method ?? "GET"} ${u.replace("http://kc", "")}`);
        const res = (status, body, headers = {}) => ({ ok: status < 300, status, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, json: async () => body, text: async () => (body === undefined ? "" : JSON.stringify(body)) });
        if (u.endsWith("/token")) return res(200, { access_token: "t", expires_in: 300 });
        if (u.includes("/roles/")) return res(200, { id: "r1", name: "producer" });
        if (u.endsWith("/users") && init.method === "POST") return res(201, undefined, { location: "http://kc/admin/realms/dxos/users/uid-1" });
        if (u.includes("/role-mappings/realm") && init.method === "POST") return failMap?.mapping ? res(500, {}) : res(204);
        return res(204);
      },
    });
  const arg = { username: "an", password: "matkhau-dai-123", email: "an@x.vn", firstName: "An", lastName: "Nguyễn", role: "producer", coop: "htx-lua" };
  const r = await mk().createUser(arg);
  assert.equal(r.id, "uid-1");
  assert.ok(calls.some((c) => c.startsWith("POST /admin/realms/dxos/users/uid-1/role-mappings/realm")));
  calls.length = 0;
  await assert.rejects(() => mk({ mapping: true }).createUser(arg), /Không gán được vai trò/);
  assert.ok(calls.some((c) => c.startsWith("DELETE /admin/realms/dxos/users/uid-1")), "xóa người dùng vừa tạo khi lỗi");
});

test("nhật ký kiểm toán không ghi mã trong liên kết mời", () => {
  const audit = require("../audit");
  const e = audit.normalize({ time: "2026-11-16T00:00:00Z", method: "POST", status: "429", uri: "/api/public/invite/abcDEF_123-xyz/accept?x=1", route: "invite-public", client_ip: "1.2.3.4", request_time: "0.01" });
  assert.equal(e.path, "/api/public/invite/<đã-ẩn>/accept?x=1");
  assert.ok(!JSON.stringify(e).includes("abcDEF_123-xyz"));
});
