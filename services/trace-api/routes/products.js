// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Làng Nghề Số contributors
"use strict";
const { HttpError, send, readJson, getUser, str } = require("../http-util");

const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9-]{2,39}$/;

/** Tuyến sản phẩm truy xuất nguồn gốc, công đoạn IoT, phân tích lò/bể và tổng quan điều hành. */
function createProductRoutes(ctx) {
  const { getPool, access, ACCESS, requirePermission, sectors, SECTORS, kiln, KILN, ocop, OCOP, overview, devices, s3, IotError, parseWindow, buildEvidence, getScanAlerts } = ctx;

  async function findProductRow(code) {
    const { rows } = await getPool().query(
      `SELECT p.id, p.code, p.name, p.category, p.village, p.artisan, p.created_by, p.created_at, p.owner_username AS owner, c.code AS coop
       FROM products p LEFT JOIN cooperatives c ON c.id = p.coop_id WHERE lower(p.code) = lower($1)`,
      [code],
    );
    return rows[0] ?? null;
  }

  async function kilnPeaks(deviceId) {
    const { rows } = await getPool().query("SELECT id, (iot->>'max')::float AS peak FROM trace_events WHERE iot IS NOT NULL AND iot->>'deviceId' = $1", [deviceId]);
    return rows;
  }

  async function kilnPeerRuns(deviceId) {
    const { rows } = await getPool().query("SELECT id, iot FROM trace_events WHERE iot IS NOT NULL AND iot->>'deviceId' = $1 ORDER BY id DESC LIMIT 200", [deviceId]);
    return rows;
  }

  async function publicOcop(productCode) {
    const pool = getPool();
    const off = await pool.query(
      `SELECT r.stars, r.authority, r.decision_no, r.decided_at::text AS decided_at, r.valid_until::text AS valid_until, (r.valid_until >= CURRENT_DATE) AS active
       FROM ocop_results r JOIN ocop_applications a ON a.id = r.application_id
       WHERE lower(a.product_code) = lower($1) AND r.recognized ORDER BY r.decided_at DESC, r.id DESC LIMIT 1`,
      [productCode],
    );
    const plat = await pool.query(
      `SELECT h.created_at FROM ocop_application_history h JOIN ocop_applications a ON a.id = h.application_id
       WHERE lower(a.product_code) = lower($1) AND h.action = 'approve' ORDER BY h.id DESC LIMIT 1`,
      [productCode],
    );
    if (!off.rows.length && !plat.rows.length) return null;
    const o = off.rows[0];
    return {
      platform: plat.rows.length ? { confirmed_at: plat.rows[0].created_at, note: "Hồ sơ OCOP đã được hợp tác xã sơ duyệt đạt trên nền tảng. Đây chưa phải giấy chứng nhận OCOP." } : null,
      official: o ? { stars: o.stars, authority: o.authority, decision_no: o.decision_no, decided_at: o.decided_at, valid_until: o.valid_until, active: o.active } : null,
    };
  }

  async function listProducts(user) {
    const scope = access.scopeFor(ACCESS, user.roles, "product.read");
    if (!scope) throw new HttpError(403, "Vai trò của bạn không có quyền xem sản phẩm");
    if (scope === "coop" && !user.coop) return [];
    const where = scope === "all" ? "" : "WHERE c.code = $1";
    const { rows } = await getPool().query(
      `SELECT p.code, p.name, p.category, p.village, p.artisan, p.created_at, p.owner_username AS owner, c.code AS coop,
             count(e.id)::int AS event_count,
             (SELECT stage FROM trace_events WHERE product_id = p.id ORDER BY created_at DESC, id DESC LIMIT 1) AS last_stage
      FROM products p LEFT JOIN trace_events e ON e.product_id = p.id LEFT JOIN cooperatives c ON c.id = p.coop_id
      ${where}
      GROUP BY p.id, c.code ORDER BY p.created_at DESC`,
      scope === "all" ? [] : [user.coop],
    );
    return rows.map((r) => ({ ...r, sector: sectors.sectorOf(SECTORS, r.category).key }));
  }

  async function getProduct(code, { publicView = false, user = null } = {}) {
    const p = await findProductRow(code);
    if (!p) throw new HttpError(404, "Không tìm thấy sản phẩm");
    if (!publicView && !access.authorize(ACCESS, user, "product.read", p)) throw new HttpError(404, "Không tìm thấy sản phẩm");
    const ev = await getPool().query("SELECT id, stage, note, location, actor, iot, created_at FROM trace_events WHERE product_id = $1 ORDER BY created_at, id", [p.id]);
    const kilnProfile = kiln.pickProfile(KILN, p.category);
    const peerCache = new Map();
    const insightOf = async (e) => {
      if (!e.iot) return null;
      if (!peerCache.has(e.iot.deviceId)) peerCache.set(e.iot.deviceId, await kilnPeaks(e.iot.deviceId));
      return kiln.analyze(e.iot, kilnProfile, { baselinePeaks: peerCache.get(e.iot.deviceId).filter((r) => r.id !== e.id).map((r) => r.peak) });
    };
    const peerRuns = new Map();
    const referenceOf = async (e) => {
      if (!e.iot || publicView) return null;
      if (!peerRuns.has(e.iot.deviceId)) peerRuns.set(e.iot.deviceId, await kilnPeerRuns(e.iot.deviceId));
      const okCurves = peerRuns.get(e.iot.deviceId).filter((r) => r.id !== e.id && kiln.analyze(r.iot, kilnProfile).verdict === "ok").map((r) => r.iot.curve);
      const ref = kiln.referenceCurve(okCurves);
      return { n: ref.n, enough: ref.enough, points: ref.points, note: kiln.compareToReference(e.iot.curve, ref, kilnProfile.terms ?? {}) };
    };
    const events = [];
    for (const e of ev.rows) {
      const insight = await insightOf(e);
      const reference = await referenceOf(e);
      const { id: _id, ...rest } = e;
      events.push(
        publicView
          ? { stage: e.stage, note: e.note, location: e.location, iot: e.iot, ...(insight && kiln.publicAllows(KILN, insight.verdict) ? { insight } : {}), created_at: e.created_at }
          : { ...rest, ...(insight ? { insight } : {}), ...(reference ? { reference } : {}) },
      );
    }
    const sector = sectors.sectorOf(SECTORS, p.category);
    const product = { code: p.code, name: p.name, category: p.category, sector: sector.key, sector_label: sector.label, sensor_stage: sector.sensorStage ?? null, stages: sector.stages, village: p.village, artisan: p.artisan, created_at: p.created_at };
    if (publicView) product.ocop = await publicOcop(p.code);
    if (!publicView) {
      product.created_by = p.created_by;
      product.owner = p.owner;
      product.coop = p.coop;
      product.can_update = access.authorize(ACCESS, user, "product.update", p);
    }
    return { ...product, events };
  }

  async function createProduct(body, user) {
    requirePermission(user, "product.create", { coop: user.coop });
    const pool = getPool();
    const name = str(body.name, 200, "name", true);
    const category = str(body.category, 100, "category");
    const village = str(body.village, 200, "village");
    const artisan = str(body.artisan, 200, "artisan");
    let code = str(body.code, 40, "code");
    if (code && !CODE_RE.test(code)) throw new HttpError(400, "Mã chỉ gồm chữ, số, dấu gạch ngang (3-40 ký tự)");
    if (!code) code = `LN-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    const scope = access.scopeFor(ACCESS, user.roles, "product.create");
    const coopCode = scope === "all" ? str(body.coop, 60, "coop") || user.coop : user.coop;
    let coopId = null;
    if (coopCode) {
      const c = await pool.query("SELECT id FROM cooperatives WHERE code = $1", [coopCode]);
      if (!c.rows.length) throw new HttpError(400, `Không có HTX mã "${coopCode}"`);
      coopId = c.rows[0].id;
    }
    try {
      await pool.query("INSERT INTO products (code, name, category, village, artisan, created_by, owner_username, coop_id) VALUES ($1,$2,$3,$4,$5,$6,$6,$7)", [
        code,
        name,
        category,
        village,
        artisan,
        user.name,
        coopId,
      ]);
    } catch (e) {
      if (e.code === "23505") throw new HttpError(409, `Mã "${code}" đã tồn tại`);
      throw e;
    }
    return getProduct(code, { user });
  }

  async function addEvent(code, body, user) {
    const product = await findProductRow(code);
    if (!product) throw new HttpError(404, "Không tìm thấy sản phẩm");
    if (!access.authorize(ACCESS, user, "product.read", product)) throw new HttpError(404, "Không tìm thấy sản phẩm");
    requirePermission(user, "product.update", product);
    const stage = str(body.stage, 40, "stage", true);
    const allowedStages = sectors.stagesFor(SECTORS, product.category).map((s) => s.key);
    if (!allowedStages.includes(stage)) throw new HttpError(400, `Công đoạn không hợp lệ cho ngành này. Hợp lệ: ${allowedStages.join(", ")}`);
    const note = str(body.note, 1000, "note");
    const location = str(body.location, 200, "location");
    let iot = null;
    if (body.iot !== undefined && body.iot !== null) {
      const sensorStage = sectors.sectorOf(SECTORS, product.category).sensorStage;
      if (!sensorStage || stage !== sensorStage) throw new HttpError(400, sensorStage ? `Chỉ gắn dữ liệu cảm biến vào công đoạn ${sensorStage} của ngành này` : "Ngành này chưa có công đoạn gắn cảm biến");
      if (!s3) throw new HttpError(503, "Chưa cấu hình tài khoản đọc MinIO cho trace-api (S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY)");
      const win = parseWindow(body.iot);
      const device = devices.get(win.deviceId);
      if (!device) throw new HttpError(400, `Thiết bị "${win.deviceId}" chưa được đăng ký trong danh bạ thiết bị (config/iot-devices.json)`);
      try {
        iot = await buildEvidence(win, s3, device.gateway, device);
      } catch (e) {
        if (e instanceof IotError) throw new HttpError(e.status, e.message);
        console.error("[trace-api] lỗi đọc dữ liệu IoT:", e.message);
        throw new HttpError(502, "Không đọc được dữ liệu cảm biến từ MinIO");
      }
    }
    const ins = await getPool().query("INSERT INTO trace_events (product_id, stage, note, location, actor, iot) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id", [
      product.id,
      stage,
      note,
      location,
      user.name,
      iot,
    ]);
    const scanAlerts = getScanAlerts?.();
    if (iot && scanAlerts) await scanAlerts(ins.rows[0].id).catch((e) => console.error("[trace-api] không tạo được cảnh báo đề xuất:", e.message));
    return getProduct(code, { user });
  }

  async function kilnInsights(user) {
    const scope = access.scopeFor(ACCESS, user.roles, "product.read");
    if (!scope) throw new HttpError(403, "Vai trò của bạn không có quyền xem sản phẩm");
    if (scope === "coop" && !user.coop) return { profile: null, summary: { total: 0, ok: 0, warn: 0, alert: 0, insufficient: 0 }, runs: [] };
    const { rows } = await getPool().query(
      `SELECT e.id, e.iot, e.created_at, p.code, p.name, p.category
       FROM trace_events e JOIN products p ON p.id = e.product_id LEFT JOIN cooperatives c ON c.id = p.coop_id
       WHERE e.iot IS NOT NULL ${scope === "all" ? "" : "AND c.code = $1"} ORDER BY e.created_at DESC, e.id DESC LIMIT 200`,
      scope === "all" ? [] : [user.coop],
    );
    const peerCache = new Map();
    const summary = { total: 0, ok: 0, warn: 0, alert: 0, insufficient: 0 };
    const runs = [];
    for (const r of rows) {
      if (!peerCache.has(r.iot.deviceId)) peerCache.set(r.iot.deviceId, await kilnPeaks(r.iot.deviceId));
      const profile = kiln.pickProfile(KILN, r.category);
      const insight = kiln.analyze(r.iot, profile, { baselinePeaks: peerCache.get(r.iot.deviceId).filter((x) => x.id !== r.id).map((x) => x.peak) });
      summary.total += 1;
      summary[insight.verdict] += 1;
      runs.push({ product_code: r.code, product_name: r.name, at: r.created_at, device_id: r.iot.deviceId, from: r.iot.from, to: r.iot.to, peak: r.iot.max, unit: r.iot.unit, insight });
    }
    const d = kiln.pickProfile(KILN, null);
    return { profile: { id: d.id, name: d.name, verified: d.verified === true, note: d.note ?? "" }, summary, runs };
  }

  async function overviewFor(user) {
    const scope = access.scopeFor(ACCESS, user.roles, "overview.read");
    if (!scope) throw new HttpError(403, "Vai trò của bạn không xem được trang tổng quan");
    const profile = ocop.getProfile(OCOP);
    if (scope === "coop" && !user.coop) return overview.buildOverview({ scope, profile });
    const pool = getPool();
    const arg = scope === "all" ? [] : [user.coop];
    const byCoop = scope === "all" ? "" : "WHERE c.code = $1";
    const apps = (
      await pool.query(
        `SELECT a.code, a.product_name, c.code AS coop, a.state,
           (SELECT max(h.created_at) FROM ocop_application_history h WHERE h.application_id = a.id AND h.to_state = a.state AND h.action <> 'archive') AS state_since
         FROM ocop_applications a LEFT JOIN cooperatives c ON c.id = a.coop_id ${byCoop}`,
        arg,
      )
    ).rows;
    const renewals = (
      await pool.query(
        `SELECT a.code, a.product_name, c.code AS coop, r.valid_until::text AS valid_until
         FROM ocop_applications a LEFT JOIN cooperatives c ON c.id = a.coop_id
         JOIN LATERAL (SELECT valid_until FROM ocop_results WHERE application_id = a.id AND recognized ORDER BY id DESC LIMIT 1) r ON TRUE
         WHERE a.state = 'recognized' ${scope === "all" ? "" : "AND c.code = $1"}`,
        arg,
      )
    ).rows.filter((r) => r.valid_until);
    const evs = (
      await pool.query(
        `SELECT e.id, e.iot, p.category, c.code AS coop FROM trace_events e JOIN products p ON p.id = e.product_id LEFT JOIN cooperatives c ON c.id = p.coop_id
         WHERE e.iot IS NOT NULL ${scope === "all" ? "" : "AND c.code = $1"} ORDER BY e.id DESC LIMIT 500`,
        arg,
      )
    ).rows;
    const peers = new Map();
    const runs = [];
    for (const e of evs) {
      if (!peers.has(e.iot.deviceId)) peers.set(e.iot.deviceId, await kilnPeaks(e.iot.deviceId));
      const insight = kiln.analyze(e.iot, kiln.pickProfile(KILN, e.category), { baselinePeaks: peers.get(e.iot.deviceId).filter((x) => x.id !== e.id).map((x) => x.peak) });
      runs.push({ coop: e.coop, sector: sectors.sectorOf(SECTORS, e.category).key, verdict: insight.verdict, at: e.iot.to });
    }
    return overview.buildOverview({ now: new Date(), scope, profile, apps, runs, renewals });
  }

  return async function handleProducts(req, res, parts, _url, m) {
    if (parts[0] === "public" && parts.length === 2 && m === "GET") {
      send(res, 200, await getProduct(parts[1], { publicView: true }));
      return true;
    }

    if (parts[0] === "insights" && parts[1] === "kilns" && parts.length === 2 && m === "GET") {
      const user = getUser(req);
      if (!access.canApi(ACCESS, user.roles)) throw new HttpError(403, "Vai trò của bạn không dùng được API này");
      send(res, 200, await kilnInsights(user));
      return true;
    }

    if (parts[0] === "overview" && parts.length === 1 && m === "GET") {
      const user = getUser(req);
      if (!access.canApi(ACCESS, user.roles)) throw new HttpError(403, "Vai trò của bạn không dùng được API này");
      send(res, 200, await overviewFor(user));
      return true;
    }

    if (parts[0] === "products") {
      const user = getUser(req);
      if (!access.canApi(ACCESS, user.roles)) throw new HttpError(403, "Vai trò của bạn không dùng được API này");
      const stages = sectors.stagesFor(SECTORS, null).map((s) => s.key);
      if (parts.length === 1 && m === "GET") {
        send(res, 200, { stages, sectors: sectors.publicView(SECTORS).sectors, products: await listProducts(user) });
        return true;
      }
      if (parts.length === 1 && m === "POST") {
        send(res, 201, await createProduct(await readJson(req), user));
        return true;
      }
      if (parts.length === 2 && m === "GET") {
        send(res, 200, await getProduct(parts[1], { user }));
        return true;
      }
      if (parts.length === 3 && parts[2] === "events" && m === "POST") {
        send(res, 201, await addEvent(parts[1], await readJson(req), user));
        return true;
      }
    }

    return false;
  };
}

module.exports = { createProductRoutes };
