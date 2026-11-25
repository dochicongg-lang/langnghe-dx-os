// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Làng Nghề Số contributors
"use strict";
const { HttpError, send, readJson, getUser, str } = require("../http-util");

/** Tuyến đề xuất cảnh báo có kiểm duyệt (Human-in-the-loop Alerting: /alerts/* kèm bí danh tương thích /agent/*). */
function createAlertRoutes(ctx) {
  const { getPool, access, ACCESS, requirePermission, kiln, KILN, alerting } = ctx;

  async function scanAlerts(onlyEventId = null) {
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT e.id, e.iot, p.code, p.name, p.category, c.code AS coop
       FROM trace_events e JOIN products p ON p.id = e.product_id LEFT JOIN cooperatives c ON c.id = p.coop_id
       WHERE e.iot IS NOT NULL ORDER BY e.id`,
    );
    const peaksByDevice = new Map();
    const curvesByDevice = new Map();
    for (const r of rows) {
      peaksByDevice.set(r.iot.deviceId, [...(peaksByDevice.get(r.iot.deviceId) ?? []), { id: r.id, peak: r.iot.max }]);
      curvesByDevice.set(r.iot.deviceId, [...(curvesByDevice.get(r.iot.deviceId) ?? []), { id: r.id, productCode: r.code, curve: r.iot.curve }]);
    }
    let created = 0;
    let scanned = 0;
    for (const r of rows) {
      if (onlyEventId !== null && r.id !== onlyEventId) continue;
      scanned++;
      const insight = kiln.analyze(r.iot, kiln.pickProfile(KILN, r.category), {
        baselinePeaks: peaksByDevice.get(r.iot.deviceId).filter((x) => x.id !== r.id).map((x) => x.peak),
        peerCurves: curvesByDevice.get(r.iot.deviceId).filter((x) => x.id < r.id),
      });
      const p = alerting.proposeFromKiln({ product: { code: r.code, name: r.name, coop: r.coop }, eventId: r.id, insight });
      if (!p) continue;
      const ins = await pool.query(
        `INSERT INTO agent_proposals (dedupe_key, kind, severity, title, rationale, subject, coop, action) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (dedupe_key) DO NOTHING`,
        [p.dedupe_key, p.kind, p.severity, p.title, p.rationale, p.subject, p.coop, JSON.stringify(p.action)],
      );
      created += ins.rowCount;
    }
    return { scanned, created };
  }

  async function visibleProposals(user) {
    const pool = getPool();
    if (!access.canApi(ACCESS, user.roles) || !access.scopeFor(ACCESS, user.roles, "application.review")) {
      throw new HttpError(403, "Vai trò của bạn không có quyền duyệt đề xuất");
    }
    const { rows } = await pool.query(
      "SELECT id, kind, severity, title, rationale, subject, coop, status, created_at, decided_by, decided_at, decision_note FROM agent_proposals ORDER BY (status = 'pending') DESC, id DESC LIMIT 100",
    );
    return rows.filter((r) => access.authorize(ACCESS, user, "application.review", { coop: r.coop }));
  }

  async function decideProposal(user, id, decision, note) {
    if (!["approve", "reject"].includes(decision)) throw new HttpError(400, "decision phải là approve hoặc reject");
    const text = str(note, 500, "note");
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query("SELECT * FROM agent_proposals WHERE id = $1 FOR UPDATE", [Number(id) || 0]);
      const p = rows[0];
      if (!p || !access.authorize(ACCESS, user, "application.review", { coop: p.coop })) {
        await client.query("ROLLBACK");
        throw new HttpError(404, "Không tìm thấy đề xuất");
      }
      requirePermission(user, "application.review", { coop: p.coop });
      if (p.status !== "pending") {
        await client.query("ROLLBACK");
        throw new HttpError(409, `Đề xuất đã được ${p.status === "approved" ? "duyệt" : "từ chối"} trước đó`);
      }
      await client.query("UPDATE agent_proposals SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4 WHERE id = $1", [
        p.id,
        decision === "approve" ? "approved" : "rejected",
        user.name,
        text,
      ]);
      if (decision === "approve") {
        const n = alerting.notificationFor(p);
        await client.query(
          "INSERT INTO notifications (dedupe_key, kind, level, title, body, link, for_user, for_role, for_coop) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (dedupe_key) DO NOTHING",
          [n.dedupe_key, n.kind, n.level, n.title, n.body, n.link, n.for_user, n.for_role, n.for_coop],
        );
      }
      await client.query("COMMIT");
      return { id: p.id, status: decision === "approve" ? "approved" : "rejected" };
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  async function handleAlerts(req, res, parts, _url, m) {
    if (parts[0] !== "alerts" && parts[0] !== "agent") return false;
    const user = getUser(req);
    if (!access.canApi(ACCESS, user.roles)) throw new HttpError(403, "Vai trò của bạn không dùng được API này");
    if (parts.length === 2 && parts[1] === "proposals" && m === "GET") {
      send(res, 200, { proposals: await visibleProposals(user) });
      return true;
    }
    if (parts.length === 4 && parts[1] === "proposals" && parts[3] === "decide" && m === "POST") {
      const b = await readJson(req);
      send(res, 200, await decideProposal(user, parts[2], b?.decision, b?.note));
      return true;
    }
    if (parts.length === 2 && parts[1] === "scan" && m === "POST") {
      requirePermission(user, "audit.read");
      send(res, 200, await scanAlerts());
      return true;
    }
    return false;
  }

  return { handleAlerts, scanAlerts };
}

module.exports = { createAlertRoutes };
