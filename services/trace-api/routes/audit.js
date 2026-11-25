// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Làng Nghề Số contributors
"use strict";
const crypto = require("node:crypto");
const { HttpError, send, readJson, getUser, str } = require("../http-util");

/** Tuyến nhật ký kiểm toán, neo băm, lưu trữ vòng đời dữ liệu và thông báo nhắc hạn. */
function createAuditRoutes(ctx) {
  const { getPool, access, ACCESS, requirePermission, audit, anchorS3, docsS3, lifecycle, archiveKeepDays, archiveIntervalHours, scanReminders, runAnchor } = ctx;

  async function ingestAudit(req) {
    const key = process.env.AUDIT_INGEST_KEY ?? "";
    const given = Buffer.from(req.headers.authorization ?? "");
    const want = Buffer.from(`Bearer ${key}`);
    if (!key || given.length !== want.length || !crypto.timingSafeEqual(given, want)) throw new HttpError(401, "Không hợp lệ");
    const body = await readJson(req);
    const list = (Array.isArray(body) ? body : [body]).slice(0, 200);
    const entries = list.map(audit.normalize).filter(Boolean).filter(audit.shouldKeep);
    return { received: list.length, accepted: await audit.appendEntries(getPool(), entries) };
  }

  async function verifyAudit() {
    const chain = await audit.verifyChain(getPool());
    if (!anchorS3) return { ...chain, anchors: { enabled: false } };
    let anchors;
    try {
      anchors = { enabled: true, ...(await audit.verifyAnchors(getPool(), anchorS3)) };
    } catch (e) {
      console.error("[trace-api] không đọc được bản neo:", e.message);
      anchors = { enabled: true, ok: false, checked: 0, latest: null, broken: { id: 0, reason: "Không đọc được kho bản neo, chưa thể đối chiếu" } };
    }
    return { ...chain, ok: chain.ok && anchors.ok, broken: chain.broken ?? (anchors.ok ? null : anchors.broken), anchors };
  }

  async function runArchive(triggeredBy, keepDays, application) {
    if (!docsS3) throw new HttpError(503, "Chưa cấu hình kho lưu trữ (DOCS_S3_ACCESS_KEY, DOCS_S3_SECRET_KEY)");
    try {
      return await lifecycle.archiveApplicationHistory(getPool(), docsS3, { keepDays, application: application || null, triggeredBy });
    } catch (e) {
      if (e instanceof HttpError) throw e;
      console.error("[trace-api] lỗi lưu trữ:", e.message);
      throw new HttpError(502, "Lưu trữ thất bại, dữ liệu ở tầng nóng được giữ nguyên");
    }
  }

  async function archiveOverview(user) {
    requirePermission(user, "archive.manage");
    return {
      policy: { keep_days: archiveKeepDays, interval_hours: archiveIntervalHours, enabled: Boolean(docsS3), source: "ocop_application_history", terminal_states: lifecycle.TERMINAL_STATES },
      runs: await lifecycle.listRuns(getPool()),
    };
  }

  async function visibleNotifications(user, limit = 300) {
    const roles = [...access.expand(ACCESS, user.roles)];
    const seeAll = access.scopeFor(ACCESS, user.roles, "application.read") === "all";
    const { rows } = await getPool().query(
      `SELECT n.id, n.kind, n.level, n.title, n.body, n.link, n.for_user, n.for_coop, n.created_at, (r.username IS NOT NULL) AS read
       FROM notifications n LEFT JOIN notification_reads r ON r.notification_id = n.id AND r.username = $1
       WHERE n.for_user = $1 OR n.for_role = ANY($2::text[])
       ORDER BY n.created_at DESC, n.id DESC LIMIT $3`,
      [user.name, roles, limit],
    );
    return rows.filter((n) => n.for_user === user.name || !n.for_coop || seeAll || n.for_coop === user.coop).map(({ for_user: _u, for_coop: _c, ...n }) => n);
  }

  async function listNotifications(user) {
    const all = await visibleNotifications(user);
    return { unread: all.filter((n) => !n.read).length, notifications: all.slice(0, 50) };
  }

  async function markNotificationsRead(user, id) {
    const visible = await visibleNotifications(user);
    const ids = id === null ? visible.filter((n) => !n.read).map((n) => n.id) : visible.filter((n) => String(n.id) === String(id)).map((n) => n.id);
    if (id !== null && !ids.length) throw new HttpError(404, "Không tìm thấy thông báo");
    if (ids.length) await getPool().query("INSERT INTO notification_reads (notification_id, username) SELECT unnest($1::bigint[]), $2 ON CONFLICT DO NOTHING", [ids, user.name]);
    return { marked: ids.length };
  }

  async function handleAudit(req, res, parts, url, m) {
    if (parts[0] === "internal" && parts[1] === "audit" && parts.length === 2 && m === "POST") {
      send(res, 202, await ingestAudit(req));
      return true;
    }

    if (parts[0] === "notifications") {
      const user = getUser(req);
      if (!access.canApi(ACCESS, user.roles)) throw new HttpError(403, "Vai trò của bạn không dùng được API này");
      if (parts.length === 1 && m === "GET") {
        send(res, 200, await listNotifications(user));
        return true;
      }
      if (parts.length === 2 && parts[1] === "scan" && m === "POST") {
        requirePermission(user, "audit.read");
        send(res, 200, await scanReminders());
        return true;
      }
      if (parts.length === 2 && parts[1] === "read-all" && m === "POST") {
        send(res, 200, await markNotificationsRead(user, null));
        return true;
      }
      if (parts.length === 3 && parts[2] === "read" && m === "POST") {
        send(res, 200, await markNotificationsRead(user, parts[1]));
        return true;
      }
    }

    if (parts[0] === "audit") {
      const user = getUser(req);
      if (!access.canApi(ACCESS, user.roles)) throw new HttpError(403, "Vai trò của bạn không dùng được API này");
      requirePermission(user, "audit.read");
      if (parts.length === 1 && m === "GET") {
        const q = url.searchParams;
        const before = Number.parseInt(q.get("before") ?? "", 10);
        send(res, 200, {
          rows: await audit.query(getPool(), { actor: q.get("actor"), method: q.get("method"), statusClass: q.get("status_class"), q: q.get("q"), before: Number.isInteger(before) ? before : undefined, limit: q.get("limit") }),
        });
        return true;
      }
      if (parts.length === 2 && parts[1] === "verify" && m === "GET") {
        send(res, 200, await verifyAudit());
        return true;
      }
      if (parts.length === 2 && parts[1] === "anchor" && m === "POST") {
        send(res, 200, (await runAnchor()) ?? { skipped: "empty" });
        return true;
      }
    }

    if (parts[0] === "archive") {
      const user = getUser(req);
      if (!access.canApi(ACCESS, user.roles)) throw new HttpError(403, "Vai trò của bạn không dùng được API này");
      if (parts.length === 1 && m === "GET") {
        send(res, 200, await archiveOverview(user));
        return true;
      }
      if (parts.length === 2 && parts[1] === "run" && m === "POST") {
        requirePermission(user, "archive.manage");
        const body = await readJson(req);
        let keepDays = archiveKeepDays;
        if (body.keep_days !== undefined) {
          try {
            keepDays = lifecycle.validateKeepDays(body.keep_days);
          } catch (e) {
            throw new HttpError(400, e.message);
          }
        }
        const application = body.application ? str(body.application, 60, "application") : null;
        send(res, 200, { result: await runArchive(user.name, keepDays, application), ...(await archiveOverview(user)) });
        return true;
      }
      if (parts.length === 3 && parts[2] === "rows" && m === "GET") {
        requirePermission(user, "archive.manage");
        if (!docsS3) throw new HttpError(503, "Chưa cấu hình kho lưu trữ");
        let rows;
        try {
          rows = await lifecycle.readRun(getPool(), docsS3, parts[1]);
        } catch (e) {
          console.error("[trace-api] lỗi đọc bản lưu trữ:", e.message);
          throw new HttpError(502, "Không đọc được bản lưu trữ (hoặc không khớp băm)");
        }
        if (!rows) throw new HttpError(404, "Không có lần lưu trữ này");
        send(res, 200, { rows: rows.slice(0, 200), total: rows.length });
        return true;
      }
    }

    return false;
  }

  return { handleAudit, runArchive };
}

module.exports = { createAuditRoutes };
