// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Làng Nghề Số contributors
"use strict";
const { HttpError, send, readJson, getUser } = require("../http-util");

/** Tuyến mời thành viên, nhận lời mời và khóa/mở tài khoản trong phạm vi HTX. */
function createMemberRoutes(ctx) {
  const { getPool, access, ACCESS, needScope, members, kcAdmin, KeycloakAdminError, inviteOrigin, inviteDays } = ctx;

  async function asHttp(fn) {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof members.MemberError || e instanceof KeycloakAdminError) throw new HttpError(e.status, e.message);
      throw e;
    }
  }

  const needKc = () => {
    if (!kcAdmin) throw new HttpError(503, "Chưa cấu hình tính năng mời thành viên (thiếu KC_MEMBERS_SECRET, chạy bash scripts/upgrade.sh)");
    return kcAdmin;
  };

  const inviteView = (r, now = new Date()) => ({
    id: Number(r.id),
    role: r.role,
    coop: r.coop,
    note: r.note,
    invited_by: r.invited_by,
    status: members.inviteStatus(r, now),
    created_at: r.created_at,
    expires_at: r.expires_at,
    accepted_username: r.accepted_username,
    accepted_at: r.accepted_at,
  });

  async function listMembers(user) {
    const scope = needScope(user, "member.invite");
    const kc = needKc();
    const pool = getPool();
    const coopRows = (await pool.query("SELECT code, name FROM cooperatives ORDER BY code")).rows;
    const inv = await pool.query(`SELECT * FROM invitations ${scope === "all" ? "" : "WHERE coop = $1"} ORDER BY id DESC LIMIT 100`, scope === "all" ? [] : [user.coop]);
    const people = await asHttp(() => kc.listMembers({ coop: scope === "all" ? null : user.coop }));
    const now = new Date();
    return {
      scope,
      coops: scope === "all" ? coopRows : coopRows.filter((c) => c.code === user.coop),
      invitable: members.invitableRoles(ACCESS, user.roles).map((r) => ({ role: r, desc: ACCESS.roles[r].desc, needs_coop: members.roleNeedsCoop(ACCESS, r) })),
      invitations: inv.rows.map((r) => inviteView(r, now)),
      members: people.map((p) => ({ username: p.username, name: p.name, coop: p.coop, roles: p.roles, enabled: p.enabled, created_at: p.created_at, can_manage: members.canManage(ACCESS, user, p) })),
    };
  }

  async function createInvitation(user, body) {
    needScope(user, "member.invite");
    needKc();
    const pool = getPool();
    const codes = new Set((await pool.query("SELECT code FROM cooperatives")).rows.map((r) => r.code));
    const chk = await asHttp(async () => members.checkInvite(ACCESS, user, body, codes));
    const note = typeof body?.note === "string" ? body.note.trim().slice(0, 120) : "";
    const token = members.newToken();
    const expires = new Date(Date.now() + inviteDays * 86_400_000);
    const { rows } = await pool.query(
      "INSERT INTO invitations (token_hash, role, coop, note, invited_by, expires_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *",
      [members.hashToken(token), chk.role, chk.coop, note || null, user.name, expires],
    );
    return { ...inviteView(rows[0]), link: `${inviteOrigin}/moi/${token}` };
  }

  async function revokeInvitation(user, id) {
    const scope = needScope(user, "member.invite");
    const pool = getPool();
    const row = (await pool.query("SELECT * FROM invitations WHERE id = $1", [Number(id)])).rows[0];
    if (!row || (scope === "coop" && row.coop !== user.coop)) throw new HttpError(404, "Không tìm thấy lời mời");
    if (row.status !== "pending") throw new HttpError(409, "Lời mời này đã được dùng hoặc đã thu hồi");
    await pool.query("UPDATE invitations SET status = 'revoked' WHERE id = $1", [row.id]);
    return inviteView({ ...row, status: "revoked" });
  }

  async function setMemberEnabled(user, username, enabled) {
    needScope(user, "member.lock");
    const kc = needKc();
    const target = await asHttp(() => kc.findMember(String(username)));
    if (!target || !members.canManage(ACCESS, user, target)) throw new HttpError(404, "Không tìm thấy thành viên trong phạm vi của bạn");
    return asHttp(() => kc.setEnabled(target.username, enabled));
  }

  async function inviteInfo(token) {
    if (!members.TOKEN_RE.test(token)) return { valid: false };
    const row = (
      await getPool().query("SELECT i.*, c.name AS coop_name FROM invitations i LEFT JOIN cooperatives c ON c.code = i.coop WHERE token_hash = $1", [members.hashToken(token)])
    ).rows[0];
    if (!row || members.inviteStatus(row) !== "pending") return { valid: false };
    return { valid: true, role: row.role, role_desc: ACCESS.roles[row.role]?.desc ?? row.role, coop: row.coop, coop_name: row.coop_name, expires_at: row.expires_at, mfa: ACCESS.roles[row.role]?.mfa === true };
  }

  async function acceptInvite(token, body) {
    const kc = needKc();
    if (!members.TOKEN_RE.test(token)) throw new HttpError(404, "Lời mời không hợp lệ hoặc đã hết hạn");
    const info = await asHttp(async () => members.checkAccept(body));
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      const row = (await client.query("SELECT * FROM invitations WHERE token_hash = $1 FOR UPDATE", [members.hashToken(token)])).rows[0];
      if (!row || members.inviteStatus(row) !== "pending") throw new HttpError(404, "Lời mời không hợp lệ hoặc đã hết hạn");
      if (await asHttp(() => kc.usernameTaken(info.username))) throw new HttpError(409, "Tên đăng nhập này đã có người dùng, hãy chọn tên khác");
      await asHttp(() => kc.createUser({ ...info, role: row.role, coop: row.coop }));
      await client.query("UPDATE invitations SET status = 'accepted', accepted_username = $2, accepted_at = now() WHERE id = $1", [row.id, info.username]);
      await client.query("COMMIT");
      return { ok: true, username: info.username };
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  return async function handleMembers(req, res, parts, _url, m) {
    if (parts[0] === "invite") {
      if (parts.length === 2 && m === "GET") {
        send(res, 200, await inviteInfo(parts[1]));
        return true;
      }
      if (parts.length === 3 && parts[2] === "accept" && m === "POST") {
        send(res, 201, await acceptInvite(parts[1], await readJson(req)));
        return true;
      }
    }
    if (parts[0] === "members") {
      const user = getUser(req);
      if (!access.canApi(ACCESS, user.roles)) throw new HttpError(403, "Vai trò của bạn không dùng được API này");
      if (parts.length === 1 && m === "GET") {
        send(res, 200, await listMembers(user));
        return true;
      }
      if (parts.length === 2 && parts[1] === "invitations" && m === "POST") {
        send(res, 201, await createInvitation(user, await readJson(req)));
        return true;
      }
      if (parts.length === 4 && parts[1] === "invitations" && parts[3] === "revoke" && m === "POST") {
        send(res, 200, await revokeInvitation(user, parts[2]));
        return true;
      }
      if (parts.length === 3 && (parts[2] === "lock" || parts[2] === "unlock") && m === "POST") {
        send(res, 200, await setMemberEnabled(user, parts[1], parts[2] === "unlock"));
        return true;
      }
    }
    return false;
  };
}

module.exports = { createMemberRoutes };
