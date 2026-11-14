// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Làng Nghề Số contributors
"use strict";
/**
 * Gọi Keycloak Admin REST bằng client dịch vụ CHỈ có quyền quản lý người dùng (không dùng tài khoản admin Keycloak).
 * Chỉ vài thao tác: tạo người dùng kèm vai trò và HTX, kiểm tra tên đã có chưa, liệt kê, khóa/mở khóa.
 */

class KeycloakAdminError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function createKeycloakAdmin({ baseUrl, realm, clientId, clientSecret, fetchImpl = fetch }) {
  let cached = null; // { token, exp }
  const admin = `${baseUrl}/admin/realms/${encodeURIComponent(realm)}`;

  async function token() {
    if (cached && cached.exp > Date.now() + 10_000) return cached.token;
    const r = await fetchImpl(`${baseUrl}/realms/${encodeURIComponent(realm)}/protocol/openid-connect/token`, {
      method: "POST",
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw new KeycloakAdminError(502, "Không đăng nhập được Keycloak bằng client mời thành viên (đã chạy bash scripts/upgrade.sh chưa?)");
    cached = { token: j.access_token, exp: Date.now() + (j.expires_in ?? 60) * 1000 };
    return cached.token;
  }

  async function call(method, path, body) {
    const r = await fetchImpl(`${admin}${path}`, {
      method,
      headers: { authorization: `Bearer ${await token()}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: r.status, ok: r.ok, json, location: r.headers.get("location") };
  }

  const exact = async (username) => {
    const r = await call("GET", `/users?username=${encodeURIComponent(username)}&exact=true`);
    if (!r.ok) throw new KeycloakAdminError(502, "Keycloak không trả lời yêu cầu tìm người dùng");
    return (r.json ?? [])[0] ?? null;
  };

  return {
    async usernameTaken(username) {
      return Boolean(await exact(username));
    },

    /** Tạo người dùng đã bật, có mật khẩu, thuộc tính coop và đúng MỘT vai trò. Lỗi giữa chừng thì xóa người dùng vừa tạo. */
    async createUser({ username, password, email, firstName, lastName, role, coop, requiredActions = [] }) {
      const roleRep = await call("GET", `/roles/${encodeURIComponent(role)}`);
      if (!roleRep.ok) throw new KeycloakAdminError(502, `Keycloak không có vai trò ${role}`);
      const created = await call("POST", "/users", {
        username,
        email,
        firstName,
        lastName,
        enabled: true,
        emailVerified: true,
        attributes: coop ? { coop: [coop] } : {},
        credentials: [{ type: "password", value: password, temporary: false }],
        requiredActions,
      });
      if (created.status === 409) throw new KeycloakAdminError(409, "Tên đăng nhập hoặc email đã có người dùng");
      if (!created.ok) {
        const msg = created.json?.errorMessage ?? "";
        throw new KeycloakAdminError(created.status === 400 ? 400 : 502, /password/i.test(msg) ? "Mật khẩu chưa đạt yêu cầu của hệ thống, hãy chọn mật khẩu dài và khó đoán hơn" : "Keycloak không tạo được tài khoản");
      }
      const id = (created.location ?? "").split("/").pop();
      const mapped = await call("POST", `/users/${id}/role-mappings/realm`, [roleRep.json]);
      if (!mapped.ok) {
        await call("DELETE", `/users/${id}`);
        throw new KeycloakAdminError(502, "Không gán được vai trò, tài khoản chưa được tạo");
      }
      return { id };
    },

    /** Người dùng thuộc một HTX (hoặc tất cả khi coop = null), kèm vai trò và trạng thái. Tối đa 200 người. */
    async listMembers({ coop = null } = {}) {
      const q = coop ? `?q=${encodeURIComponent(`coop:${coop}`)}&max=200` : "?max=200";
      const r = await call("GET", `/users${q}`);
      if (!r.ok) throw new KeycloakAdminError(502, "Keycloak không trả danh sách người dùng");
      const out = [];
      for (const u of r.json ?? []) {
        if (u.username?.startsWith("service-account-")) continue;
        const rolesRes = await call("GET", `/users/${u.id}/role-mappings/realm`);
        const roles = (rolesRes.json ?? []).map((x) => x.name).filter((n) => !["offline_access", "uma_authorization"].includes(n) && !n.startsWith("default-roles-"));
        out.push({ id: u.id, username: u.username, name: [u.lastName, u.firstName].filter((x) => x && x !== "-").join(" ") || u.username, coop: u.attributes?.coop?.[0] ?? null, roles, enabled: u.enabled !== false, created_at: u.createdTimestamp ? new Date(u.createdTimestamp).toISOString() : null });
      }
      return out;
    },

    async setEnabled(username, enabled) {
      const u = await exact(username);
      if (!u) throw new KeycloakAdminError(404, "Không có người dùng này");
      const r = await call("PUT", `/users/${u.id}`, { ...u, enabled });
      if (!r.ok) throw new KeycloakAdminError(502, "Keycloak không cập nhật được trạng thái tài khoản");
      if (!enabled) await call("POST", `/users/${u.id}/logout`); // thu hồi phiên đang đăng nhập
      return { username, enabled };
    },

    async findMember(username) {
      const u = await exact(username);
      if (!u) return null;
      const rolesRes = await call("GET", `/users/${u.id}/role-mappings/realm`);
      const roles = (rolesRes.json ?? []).map((x) => x.name).filter((n) => !["offline_access", "uma_authorization"].includes(n) && !n.startsWith("default-roles-"));
      return { id: u.id, username: u.username, coop: u.attributes?.coop?.[0] ?? null, roles, enabled: u.enabled !== false };
    },
  };
}

module.exports = { createKeycloakAdmin, KeycloakAdminError };
