#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Làng Nghề Số contributors
// Kiểm chứng THẬT (cổng gác APISIX, Keycloak, trace-api, PostgreSQL) cho việc mời và quản lý thành viên:
//  - ai được mời ai: cán bộ HTX chỉ mời nghệ nhân và HTX bị ép về HTX của mình; cán bộ OCOP và nghệ nhân bị từ chối;
//  - liên kết một lần: dùng xong, thu hồi, hết hạn đều bị từ chối; chỉ băm của mã nằm trong CSDL;
//  - người nhận lời mời tự đặt mật khẩu, đăng nhập được, đúng vai trò và HTX trong token;
//  - khóa/mở khóa: đúng phạm vi, người ngoài phạm vi thấy 404; tài khoản bị khóa không lấy được token;
//  - nhật ký kiểm toán không chứa mã trong liên kết mời.
// Tự dọn các tài khoản và lời mời thử. Cần dữ liệu mẫu và trạng thái chưa cài OTP cho htxlua (bash scripts/reset-otp.sh nếu bị từ chối).
"use strict";
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");

const env = Object.fromEntries(fs.readFileSync(".env", "utf8").split(/\r?\n/).map((l) => l.match(/^([A-Za-z_]\w*)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]]));
const GW = `http://localhost:${env.APISIX_GATEWAY_PORT ?? 9080}`;
const KC = `http://localhost:8080/realms/${env.KEYCLOAK_REALM ?? "dxos"}/protocol/openid-connect/token`;
const R = env.KEYCLOAK_REALM ?? "dxos";
const NOTE = "kiểm-thử-mời-thành-viên";
const tag = Date.now().toString(36).slice(-5);

let fails = 0;
let skipped = 0;
const ok = (c, m) => {
  console.log(`${c ? "✓" : "✗"} ${m}`);
  if (!c) fails++;
};
const sql = (q) => execFileSync("docker", ["exec", "dxos-postgres", "psql", "-U", env.POSTGRES_USER ?? "postgres", "-d", env.TRACE_DB ?? "traceability", "-tAc", q], { stdio: "pipe", env: { ...process.env, MSYS_NO_PATHCONV: "1" } }).toString().trim();
const kc = (...a) => execFileSync("docker", ["exec", "dxos-keycloak", "/opt/keycloak/bin/kcadm.sh", ...a], { stdio: "pipe", env: { ...process.env, MSYS_NO_PATHCONV: "1" } }).toString();

const token = async (u, p = u) => (await (await fetch(KC, { method: "POST", body: new URLSearchParams({ grant_type: "password", client_id: env.KEYCLOAK_CLIENT_ID, client_secret: env.KEYCLOAK_CLIENT_SECRET, username: u, password: p }) })).json()).access_token;
const api = async (method, path, tok, body) => {
  const r = await fetch(`${GW}${path}`, { method, headers: { ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const tokenOf = (link) => link.split("/moi/")[1];
const created = [];

(async () => {
  kc("config", "credentials", "--server", "http://localhost:8080", "--realm", "master", "--user", env.KEYCLOAK_ADMIN ?? "admin", "--password", env.KEYCLOAK_ADMIN_PASSWORD ?? "admin");
  const admin = await token("tester");
  const ocop = await token("ocop");
  const hoa = await token("hoa");
  const officer = await token("htxlua");

  // 1. Ai xem được trang thành viên
  const a = await api("GET", "/api/trace/members", admin);
  ok(a.status === 200 && a.json.scope === "all", `quản trị xem được danh sách (phạm vi ${a.json.scope})`);
  ok(a.json.invitable?.some((r) => r.role === "coop-officer") && a.json.invitable.some((r) => r.role === "producer"), "quản trị được mời cả cán bộ HTX và nghệ nhân");
  for (const [name, t] of [["cán bộ OCOP", ocop], ["nghệ nhân hoa", hoa]]) {
    ok((await api("GET", "/api/trace/members", t)).status === 403, `${name} bị từ chối xem danh sách (403)`);
    ok((await api("POST", "/api/trace/members/invitations", t, { role: "producer", coop: "htx-lua", note: NOTE })).status === 403, `${name} bị từ chối mời (403)`);
  }
  ok((await api("GET", "/api/trace/members")).status === 401, "không token: 401");

  // 2. Quản trị mời cán bộ HTX gốm (bước phê duyệt vai trò cán bộ)
  const invOfficer = await api("POST", "/api/trace/members/invitations", admin, { role: "coop-officer", coop: "htx-demo", note: NOTE });
  ok(invOfficer.status === 201 && /\/moi\/[\w-]{43}$/.test(invOfficer.json.link ?? ""), `quản trị mời cán bộ HTX: liên kết ${invOfficer.json.link?.replace(/[\w-]{43}$/, "<mã>")}`);
  const offTok = tokenOf(invOfficer.json.link);
  const row = sql(`SELECT token_hash FROM invitations WHERE id = ${invOfficer.json.id}`);
  ok(row.length === 64 && row !== offTok && sql(`SELECT count(*) FROM invitations WHERE token_hash = '${offTok}'`) === "0", "CSDL chỉ lưu băm của mã, không lưu mã gốc");

  // 3. Trang nhận lời mời (công khai, không đăng nhập)
  const info = await api("GET", `/api/public/invite/${offTok}`);
  ok(info.status === 200 && info.json.valid === true && info.json.role === "coop-officer" && info.json.coop === "htx-demo", "trang nhận lời mời đọc được vai trò và HTX, không cần đăng nhập");
  ok((await api("GET", `/api/public/invite/${"x".repeat(43)}`)).json.valid === false, "mã sai: không hợp lệ");

  // 4. Nhận lời mời: kiểm tra đầu vào và tên trùng
  const user1 = `kt${tag}o`;
  const bad = (b) => api("POST", `/api/public/invite/${offTok}/accept`, null, b);
  ok((await bad({ username: user1, password: "ngắn", full_name: "Kiểm Thử" })).status === 400, "mật khẩu ngắn bị từ chối (400)");
  ok((await bad({ username: "hoa", password: "mat-khau-thu-nghiem-1", full_name: "Kiểm Thử" })).status === 409, "tên đăng nhập đã có bị từ chối (409)");
  const acc = await bad({ username: user1, password: "mat-khau-thu-nghiem-1", full_name: "Kiểm Thử Cán Bộ" });
  ok(acc.status === 201 && acc.json.username === user1, `người được mời tự đặt mật khẩu và tạo được tài khoản ${user1}`);
  created.push(user1);
  const t1 = await token(user1, "mat-khau-thu-nghiem-1");
  ok(Boolean(t1), "tài khoản mới đăng nhập được bằng mật khẩu vừa đặt");
  const me = await api("GET", "/api/trace/me", t1);
  ok(me.json.roles?.includes("coop-officer") && me.json.coop === "htx-demo" && !me.json.roles.includes("admin"), `token có đúng vai trò coop-officer và HTX htx-demo (${JSON.stringify(me.json.roles)}, ${me.json.coop})`);
  const reuse = await bad({ username: `${user1}x`, password: "mat-khau-thu-nghiem-1", full_name: "Kiểm Thử" });
  ok(reuse.status === 404, "dùng lại liên kết đã dùng bị từ chối (404)");

  // 5. Cán bộ HTX mời: HTX bị ép về HTX của mình, không mời được cán bộ
  if (!officer) {
    console.log("- htxlua: không lấy được token (đã cài OTP?), bỏ qua các kiểm tra của cán bộ HTX");
    skipped++;
  } else {
    const l = await api("GET", "/api/trace/members", officer);
    ok(l.status === 200 && l.json.scope === "coop" && l.json.members.every((m) => m.coop === "htx-lua") && l.json.invitable.length === 1 && l.json.invitable[0].role === "producer", "cán bộ HTX lụa: chỉ thấy thành viên HTX lụa và chỉ được mời nghệ nhân");
    for (const role of ["coop-officer", "ocop-officer", "admin", "editor"]) {
      ok([400, 403].includes((await api("POST", "/api/trace/members/invitations", officer, { role, coop: "htx-lua", note: NOTE })).status), `cán bộ HTX bị từ chối khi mời vai trò ${role}`);
    }
    const inv = await api("POST", "/api/trace/members/invitations", officer, { role: "producer", coop: "htx-demo", note: NOTE });
    ok(inv.status === 201 && inv.json.coop === "htx-lua", `cán bộ HTX gửi coop htx-demo nhưng lời mời vẫn thuộc ${inv.json.coop} (bị ép về HTX của mình)`);
    const tk = tokenOf(inv.json.link);
    const user2 = `kt${tag}p`;
    const a2 = await api("POST", `/api/public/invite/${tk}/accept`, null, { username: user2, password: "mat-khau-thu-nghiem-2", full_name: "Kiểm Thử Nghệ Nhân", email: `${user2}@example.com` });
    ok(a2.status === 201, `nghệ nhân ${user2} nhận lời mời`);
    created.push(user2);
    const t2 = await token(user2, "mat-khau-thu-nghiem-2");
    const me2 = await api("GET", "/api/trace/me", t2);
    ok(me2.json.roles?.includes("producer") && me2.json.coop === "htx-lua", `nghệ nhân mới đúng vai trò producer, HTX htx-lua (${JSON.stringify(me2.json.roles)}, ${me2.json.coop})`);
    ok((await api("GET", "/api/trace/members", t2)).status === 403, "nghệ nhân mới không xem được trang thành viên (403)");
    const prods = await api("GET", "/api/trace/products", t2);
    ok(prods.status === 200 && (prods.json.products ?? []).every((p) => p.coop === "htx-lua" || p.coop === undefined), "nghệ nhân mới chỉ thấy sản phẩm của HTX lụa");

    // 6. Khóa và mở khóa
    const lockOther = await api("POST", "/api/trace/members/hoa/lock", officer);
    ok(lockOther.status === 404, "cán bộ HTX lụa khóa người HTX gốm: 404 (không lộ sự tồn tại)");
    ok((await api("POST", "/api/trace/members/htxlua/lock", officer)).status === 404, "cán bộ không tự khóa mình (404)");
    ok((await api("POST", `/api/trace/members/${user1}/lock`, officer)).status === 404, "cán bộ HTX lụa không khóa được cán bộ HTX gốm (404)");
    const lock = await api("POST", `/api/trace/members/${user2}/lock`, officer);
    ok(lock.status === 200 && lock.json.enabled === false, `cán bộ khóa nghệ nhân ${user2}`);
    ok(!(await token(user2, "mat-khau-thu-nghiem-2")), "tài khoản bị khóa không lấy được token");
    const unlock = await api("POST", `/api/trace/members/${user2}/unlock`, officer);
    ok(unlock.status === 200 && Boolean(await token(user2, "mat-khau-thu-nghiem-2")), "mở khóa xong đăng nhập lại được");

    // 7. Thu hồi
    const inv3 = await api("POST", "/api/trace/members/invitations", officer, { role: "producer", note: NOTE });
    const rev = await api("POST", `/api/trace/members/invitations/${inv3.json.id}/revoke`, officer);
    ok(rev.status === 200 && rev.json.status === "revoked", "cán bộ thu hồi lời mời");
    ok((await api("GET", `/api/public/invite/${tokenOf(inv3.json.link)}`)).json.valid === false, "lời mời đã thu hồi không còn hợp lệ");
    const lst = await api("GET", "/api/trace/members", officer);
    ok(lst.json.invitations.every((i) => i.coop === "htx-lua") && !JSON.stringify(lst.json).includes(tk), "danh sách lời mời chỉ của HTX mình và không chứa mã gốc");
  }
  ok((await api("POST", `/api/trace/members/${user1}/lock`, admin)).status === 200, "quản trị khóa được cán bộ HTX");
  ok((await api("POST", "/api/trace/members/tester/lock", admin)).status === 404, "quản trị không tự khóa mình");

  // 8. Hết hạn
  const exp = await api("POST", "/api/trace/members/invitations", admin, { role: "readonly", note: NOTE });
  sql(`UPDATE invitations SET expires_at = now() - interval '1 hour' WHERE id = ${exp.json.id}`);
  ok((await api("GET", `/api/public/invite/${tokenOf(exp.json.link)}`)).json.valid === false, "lời mời hết hạn không còn hợp lệ");
  ok((await api("POST", `/api/public/invite/${tokenOf(exp.json.link)}/accept`, null, { username: `kt${tag}e`, password: "mat-khau-thu-nghiem-3", full_name: "Hết Hạn" })).status === 404, "nhận lời mời đã hết hạn bị từ chối (404)");

  // 9. Nhật ký kiểm toán không chứa mã mời
  await new Promise((r) => setTimeout(r, 9000));
  const leaked = sql(`SELECT count(*) FROM audit_log WHERE path LIKE '%${offTok}%'`);
  const redacted = sql("SELECT count(*) FROM audit_log WHERE path LIKE '%/api/public/invite/<đã-ẩn>%'");
  ok(leaked === "0", "nhật ký kiểm toán KHÔNG chứa mã trong liên kết mời");
  ok(Number(redacted) >= 1, `nhật ký có các dòng đã ẩn mã (${redacted} dòng; đối chứng là phép thử có bắt được)`);

  // Dọn
  for (const u of created) {
    try {
      const id = kc("get", "users", "-r", R, "-q", `username=${u}`, "-q", "exact=true", "--fields", "id", "--format", "csv", "--noquotes").replace(/\r/g, "").trim();
      if (id) kc("delete", `users/${id}`, "-r", R);
    } catch {
      /* đã xóa */
    }
  }
  sql(`DELETE FROM invitations WHERE note = '${NOTE}'`);
  console.log(fails ? `\n${fails} kiểm tra KHÔNG đạt` : `\nTất cả đạt${skipped ? ` (bỏ qua ${skipped} nhóm vì OTP)` : ""}.`);
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error("LỖI:", e.message);
  process.exit(1);
});
