// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Làng Nghề Số contributors
"use strict";
/**
 * trace-api — API truy xuất nguồn gốc sản phẩm làng nghề (Tầng 3 của DX-OS).
 *
 * Hỗ trợ đường dẫn theo phiên bản `/v1/*` và bí danh không tiền tố (APISIX bỏ `/api/trace`).
 * Các nhóm tuyến đã tách thành module độc lập trong `routes/`.
 */

const http = require("node:http");
const { Pool, Client } = require("pg");
const path = require("node:path");
const access = require("./access");
const { runMigrations } = require("./migrations");
const { loadDevices, devicesForUser } = require("./devices");
const { IotError, parseWindow, createS3Client, buildEvidence, readLatestReadings } = require("./iot");
const ocop = require("./ocop");
const attachments = require("./attachments");
const lifecycle = require("./lifecycle");
const kiln = require("./kiln");
const sectors = require("./sectors");
const overview = require("./overview");
const members = require("./members");
const { createKeycloakAdmin, KeycloakAdminError } = require("./keycloak-admin");
const audit = require("./audit");
const scan = require("./scan");
const reminders = require("./reminders");
const lake = require("./lake");
const assistant = require("./assistant");
const alerting = require("./alerting");
const pdf = require("./pdf");
const { createFlowableClient } = require("./flowable");
const { HttpError, send, makeAuthHelpers } = require("./http-util");

const { createConfigRoutes } = require("./routes/config");
const { createIotRoutes } = require("./routes/iot");
const { createProductRoutes } = require("./routes/products");
const { createOcopRoutes } = require("./routes/ocop");
const { createAlertRoutes } = require("./routes/alerts");
const { createLakeRoutes } = require("./routes/lake");
const { createMemberRoutes } = require("./routes/members");
const { createAuditRoutes } = require("./routes/audit");

const PORT = Number(process.env.PORT ?? 3000);
const pgBase = {
  host: process.env.PG_HOST ?? "postgres",
  port: Number(process.env.PG_PORT ?? 5432),
  user: process.env.PG_USER ?? "postgres",
  password: process.env.PG_PASSWORD ?? "postgres",
};
const DB_NAME = process.env.TRACE_DB ?? "traceability";
const SEED = (process.env.TRACE_SEED ?? "true") !== "false";

const ACCESS = access.load(process.env.ACCESS_FILE ?? "/app/config/access.json");
const devices = loadDevices(process.env.IOT_DEVICES_FILE ?? "/app/config/iot-devices.json");
const iotDayCache = new Map();

const s3 =
  process.env.S3_ENDPOINT && process.env.S3_ACCESS_KEY && process.env.S3_SECRET_KEY
    ? createS3Client({
        endpoint: process.env.S3_ENDPOINT,
        accessKey: process.env.S3_ACCESS_KEY,
        secretKey: process.env.S3_SECRET_KEY,
        bucket: process.env.S3_BUCKET ?? "dxos-data",
      })
    : null;

const OCOP = ocop.loadProfiles(process.env.OCOP_PROFILES_FILE ?? "/app/config/ocop-profiles.json");
const flowable = process.env.FLOWABLE_URL
  ? createFlowableClient(
      process.env.FLOWABLE_PROXY_KEY
        ? { baseUrl: process.env.FLOWABLE_URL, apiKey: process.env.FLOWABLE_PROXY_KEY }
        : { baseUrl: process.env.FLOWABLE_URL, user: process.env.FLOWABLE_USER ?? "rest-admin", password: process.env.FLOWABLE_PASSWORD ?? "" },
    )
  : null;

const SECTORS = sectors.load(process.env.SECTORS_FILE ?? "/app/config/sectors.json");
const KILN = kiln.loadProfiles(process.env.KILN_PROFILES_FILE ?? "/app/config/kiln-profiles.json");

const docsS3 =
  process.env.S3_ENDPOINT && process.env.DOCS_S3_ACCESS_KEY && process.env.DOCS_S3_SECRET_KEY
    ? createS3Client({
        endpoint: process.env.S3_ENDPOINT,
        accessKey: process.env.DOCS_S3_ACCESS_KEY,
        secretKey: process.env.DOCS_S3_SECRET_KEY,
        bucket: process.env.DOCS_BUCKET ?? "dxos-docs",
      })
    : null;

// Bucket riêng cho hồ dữ liệu phân tích (Parquet phân vùng Hive); dự phòng về docsS3 nếu chưa tách khóa.
const lakeS3 =
  process.env.S3_ENDPOINT && process.env.LAKE_S3_ACCESS_KEY && process.env.LAKE_S3_SECRET_KEY
    ? createS3Client({
        endpoint: process.env.S3_ENDPOINT,
        accessKey: process.env.LAKE_S3_ACCESS_KEY,
        secretKey: process.env.LAKE_S3_SECRET_KEY,
        bucket: process.env.LAKE_BUCKET ?? "dxos-lake",
      })
    : docsS3;

const scanner = process.env.CLAMAV_HOST ? scan.createScanner({ host: process.env.CLAMAV_HOST, port: Number(process.env.CLAMAV_PORT ?? 3310) }) : null;
const SCAN_REQUIRED = String(process.env.CLAMAV_REQUIRED ?? "true").toLowerCase() !== "false";

const anchorS3 =
  process.env.S3_ENDPOINT && process.env.ANCHOR_S3_ACCESS_KEY && process.env.ANCHOR_S3_SECRET_KEY
    ? createS3Client({
        endpoint: process.env.S3_ENDPOINT,
        accessKey: process.env.ANCHOR_S3_ACCESS_KEY,
        secretKey: process.env.ANCHOR_S3_SECRET_KEY,
        bucket: process.env.ANCHOR_BUCKET ?? "dxos-audit",
      })
    : null;

const kcAdmin = process.env.KC_MEMBERS_SECRET
  ? createKeycloakAdmin({ baseUrl: process.env.KEYCLOAK_INTERNAL_URL ?? "http://keycloak:8080", realm: process.env.KEYCLOAK_REALM ?? "dxos", clientId: process.env.KC_MEMBERS_CLIENT ?? "dxos-members", clientSecret: process.env.KC_MEMBERS_SECRET })
  : null;

const ASSISTANT = assistant.buildIndex(
  assistant.buildKnowledge({
    profile: ocop.getProfile(OCOP),
    kilnCfg: KILN,
    accessCfg: ACCESS,
    faq: assistant.loadFaq(process.env.ASSISTANT_FAQ_FILE ?? "/app/config/assistant-faq.json"),
  }),
);

let pool;
const getPool = () => pool;
const { requirePermission, needScope } = makeAuthHelpers(access, ACCESS);

async function ensureDatabase() {
  const admin = new Client({ ...pgBase, database: "postgres" });
  await admin.connect();
  try {
    const { rowCount } = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [DB_NAME]);
    if (!rowCount) await admin.query(`CREATE DATABASE "${DB_NAME.replace(/"/g, "")}"`);
  } finally {
    await admin.end();
  }
}

async function seed() {
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM products");
  if (rows[0].n > 0) return;
  const demo = [
    {
      code: "GOM-BT-0001",
      name: "Bình gốm men rạn Bát Tràng",
      category: "Gốm sứ",
      village: "Làng gốm Bát Tràng, Hà Nội",
      artisan: "Nghệ nhân Nguyễn Văn Hà",
      events: [
        ["nguyen-lieu", "Đất sét trắng khai thác tại Yên Bái, đã kiểm tra độ dẻo", "Kho đất sét Bát Tràng"],
        ["so-che", "Lọc, ủ đất 30 ngày", "Xưởng sơ chế"],
        ["tao-hinh", "Vuốt tay trên bàn xoay, cao 38 cm", "Xưởng tạo hình"],
        ["nung-hoan-thien", "Nung 1.150 °C trong 14 giờ, phủ men rạn", "Lò nung số 1"],
        ["kiem-dinh", "Đạt chuẩn: không nứt, men đều", "Tổ kiểm định"],
      ],
    },
    {
      code: "LUA-VP-0007",
      name: "Khăn lụa tơ tằm nhuộm tự nhiên",
      category: "Dệt may",
      village: "Làng lụa Vạn Phúc, Hà Đông",
      artisan: "Hợp tác xã lụa Vạn Phúc",
      events: [
        ["nguyen-lieu", "Tơ tằm nhập từ Bảo Lộc (Lâm Đồng), kiểm tra độ đều và độ bóng của sợi", "Kho tơ Vạn Phúc"],
        ["so-che", "Đánh ống, se sợi và mắc sợi chuẩn bị lên khung", "Xưởng chuẩn bị sợi"],
        ["tao-hinh", "Dệt trên khung cửi, hoa văn đối xứng", "Xưởng dệt Vạn Phúc"],
      ],
    },
  ];
  for (const p of demo) {
    const { rows: r } = await pool.query("INSERT INTO products (code, name, category, village, artisan, created_by) VALUES ($1,$2,$3,$4,$5,'seed') RETURNING id", [
      p.code,
      p.name,
      p.category,
      p.village,
      p.artisan,
    ]);
    let minutesAgo = p.events.length * 1440;
    for (const [stage, note, location] of p.events) {
      await pool.query("INSERT INTO trace_events (product_id, stage, note, location, actor, created_at) VALUES ($1,$2,$3,$4,'seed', now() - make_interval(mins => $5))", [
        r[0].id,
        stage,
        note,
        location,
        minutesAgo,
      ]);
      minutesAgo -= 1440;
    }
  }
  console.log("[trace-api] đã nạp dữ liệu mẫu (2 sản phẩm)");
}

async function seedDomain() {
  const { rows } = await pool.query("INSERT INTO cooperatives (code, name) VALUES ('htx-demo', $1) ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name RETURNING id", [
    "Hợp tác xã làng nghề mẫu (demo)",
  ]);
  const coopId = rows[0].id;
  for (const v of ["Làng gốm Bát Tràng, Hà Nội", "Làng lụa Vạn Phúc, Hà Đông"]) {
    await pool.query("INSERT INTO villages (name) VALUES ($1) ON CONFLICT (name) DO NOTHING", [v]);
  }
  await pool.query(
    "INSERT INTO producers (username, display_name, type, coop_id, village_id) VALUES ('hoa', $1, 'nghe-nhan', $2, (SELECT id FROM villages WHERE name = $3)) ON CONFLICT (username) DO NOTHING",
    ["Chị Hoa (nghệ nhân gốm Bát Tràng)", coopId, "Làng gốm Bát Tràng, Hà Nội"],
  );
  await pool.query("UPDATE products SET coop_id = $1 WHERE coop_id IS NULL AND created_by = 'seed'", [coopId]);
  const lua = await pool.query("INSERT INTO cooperatives (code, name) VALUES ('htx-lua', $1) ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name RETURNING id", [
    "Hợp tác xã lụa Vạn Phúc (demo)",
  ]);
  const luaId = lua.rows[0].id;
  await pool.query(
    "INSERT INTO producers (username, display_name, type, coop_id, village_id) VALUES ('lua', $1, 'nghe-nhan', $2, (SELECT id FROM villages WHERE name = $3)) ON CONFLICT (username) DO NOTHING",
    ["Chị Lụa (nghệ nhân dệt lụa Vạn Phúc)", luaId, "Làng lụa Vạn Phúc, Hà Đông"],
  );
  const movable = await pool.query("SELECT id, category FROM products WHERE coop_id IS NULL OR coop_id = $1", [coopId]);
  for (const r of movable.rows) {
    if (sectors.sectorOf(SECTORS, r.category).key === "lua") await pool.query("UPDATE products SET coop_id = $1 WHERE id = $2", [luaId, r.id]);
  }
  await pool.query("UPDATE products p SET village_id = v.id FROM villages v WHERE p.village_id IS NULL AND p.village = v.name");
}

// ---------- Các tác vụ định kỳ & liên kết giữa các router ----------
const ARCHIVE_KEEP_DAYS = lifecycle.validateKeepDays(process.env.ARCHIVE_KEEP_DAYS ?? 90);
const ARCHIVE_INTERVAL_HOURS = Number(process.env.ARCHIVE_INTERVAL_HOURS ?? 24);
const LAKE_INTERVAL_HOURS = Number(process.env.LAKE_INTERVAL_HOURS ?? 24);
const NOTIFY_INTERVAL_MINUTES = Number(process.env.NOTIFY_INTERVAL_MINUTES ?? 60);
const ANCHOR_INTERVAL_MINUTES = Number(process.env.ANCHOR_INTERVAL_MINUTES ?? 60);

async function runLakeExport(triggeredBy) {
  if (!lakeS3) throw new HttpError(503, "Chưa cấu hình kho hồ dữ liệu (LAKE_S3_ACCESS_KEY / DOCS_S3_ACCESS_KEY)");
  try {
    return await lake.exportAll(
      { pool, s3: lakeS3, kiln: { analyze: kiln.analyze, pickProfile: kiln.pickProfile, config: KILN }, readArchive: (id) => lifecycle.readRun(pool, docsS3, id) },
      triggeredBy,
    );
  } catch (e) {
    console.error("[trace-api] lỗi xuất hồ dữ liệu:", e.message);
    throw new HttpError(502, "Xuất hồ dữ liệu thất bại, dữ liệu nguồn không bị ảnh hưởng");
  }
}

async function scanReminders() {
  const { rows } = await pool.query(
    `SELECT a.code, a.product_name, a.owner_username AS owner, c.code AS coop, a.state, a.profile,
       (SELECT max(h.created_at) FROM ocop_application_history h WHERE h.application_id = a.id AND h.to_state = a.state AND h.action <> 'archive') AS state_since,
       (SELECT r.valid_until FROM ocop_results r WHERE r.application_id = a.id AND r.recognized ORDER BY r.id DESC LIMIT 1) AS valid_until
     FROM ocop_applications a LEFT JOIN cooperatives c ON c.id = a.coop_id
     WHERE a.state IN ('in_review','needs_revision','awaiting_result','recognized')`,
  );
  const now = new Date();
  let created = 0;
  for (const a of rows) {
    for (const n of reminders.computeReminders(now, [a], ocop.getProfile(OCOP, a.profile))) {
      const ins = await pool.query(
        `INSERT INTO notifications (dedupe_key, kind, level, title, body, link, for_user, for_role, for_coop)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (dedupe_key) DO NOTHING`,
        [n.dedupe_key, n.kind, n.level, n.title, n.body, n.link ?? null, n.for_user ?? null, n.for_role ?? null, n.for_coop ?? null],
      );
      created += ins.rowCount;
    }
  }
  return { scanned: rows.length, created };
}

async function runAnchor() {
  if (!anchorS3) throw new HttpError(503, "Chưa cấu hình kho neo nhật ký (ANCHOR_S3_ACCESS_KEY, ANCHOR_S3_SECRET_KEY)");
  try {
    return await audit.writeAnchor(pool, anchorS3);
  } catch (e) {
    console.error("[trace-api] lỗi neo nhật ký:", e.message);
    throw new HttpError(502, "Không ghi được bản neo vào kho khóa chống sửa");
  }
}

const { handleAlerts, scanAlerts } = createAlertRoutes({ getPool, access, ACCESS, requirePermission, kiln, KILN, alerting });
const { handleAudit, runArchive } = createAuditRoutes({
  getPool, access, ACCESS, requirePermission, audit, anchorS3, docsS3, lifecycle,
  archiveKeepDays: ARCHIVE_KEEP_DAYS, archiveIntervalHours: ARCHIVE_INTERVAL_HOURS, scanReminders, runAnchor,
});

const routers = [
  createConfigRoutes({ access, ACCESS, SECTORS, sectors, assistant, ASSISTANT }),
  createIotRoutes({ access, ACCESS, devices, devicesForUser, SECTORS, KILN, kiln, s3, readLatestReadings, iotDayCache }),
  createProductRoutes({ getPool, access, ACCESS, requirePermission, sectors, SECTORS, kiln, KILN, ocop, OCOP, overview, devices, s3, IotError, parseWindow, buildEvidence, getScanAlerts: () => scanAlerts }),
  createOcopRoutes({ getPool, access, ACCESS, requirePermission, ocop, OCOP, flowable, docsS3, attachments, scanner, scanRequired: SCAN_REQUIRED, pdf }),
  handleAlerts,
  createLakeRoutes({ getPool, access, ACCESS, requirePermission, lake, getLakeS3: () => lakeS3, runLakeExport }),
  createMemberRoutes({
    getPool, access, ACCESS, needScope, members, kcAdmin, KeycloakAdminError,
    inviteOrigin: (process.env.MEMBERS_INVITE_ORIGIN ?? "http://localhost:3000").replace(/\/$/, ""),
    inviteDays: Math.max(1, Number(process.env.MEMBERS_INVITE_DAYS ?? 7)),
  }),
  handleAudit,
];

async function route(req, res) {
  const url = new URL(req.url, "http://x");
  const rawParts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const parts = rawParts[0] === "v1" ? rawParts.slice(1) : rawParts;
  const m = req.method;
  for (const h of routers) {
    if (await h(req, res, parts, url, m)) return;
  }
  throw new HttpError(404, "Không có tuyến này");
}

const server = http.createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (err) {
    if (err instanceof HttpError) return send(res, err.status, { error: err.message });
    console.error("[trace-api] lỗi:", err);
    send(res, 500, { error: "Lỗi máy chủ" });
  }
});

function startSchedulers() {
  if (docsS3 && ARCHIVE_INTERVAL_HOURS > 0) {
    const tick = () => runArchive("scheduler", ARCHIVE_KEEP_DAYS).catch((e) => console.error("[trace-api] lưu trữ tự động lỗi:", e.message));
    setTimeout(tick, 60_000).unref();
    setInterval(tick, ARCHIVE_INTERVAL_HOURS * 3600_000).unref();
  }
  if (anchorS3 && ANCHOR_INTERVAL_MINUTES > 0) {
    const tick = () => runAnchor().catch((e) => console.error("[trace-api] neo nhật ký lỗi:", e.message));
    setTimeout(tick, 90_000).unref();
    setInterval(tick, ANCHOR_INTERVAL_MINUTES * 60_000).unref();
  }
  if (NOTIFY_INTERVAL_MINUTES > 0) {
    const tick = () => scanReminders().catch((e) => console.error("[trace-api] quét nhắc hạn lỗi:", e.message));
    setTimeout(tick, 45_000).unref();
    setInterval(tick, NOTIFY_INTERVAL_MINUTES * 60_000).unref();
  }
  if (lakeS3 && LAKE_INTERVAL_HOURS > 0) {
    const tick = () => runLakeExport("scheduler").catch((e) => console.error("[trace-api] xuất hồ dữ liệu tự động lỗi:", e.message));
    setTimeout(tick, 120_000).unref();
    setInterval(tick, LAKE_INTERVAL_HOURS * 3600_000).unref();
  }
}

async function main() {
  for (let i = 1; ; i++) {
    try {
      await ensureDatabase();
      break;
    } catch (e) {
      if (i >= 20) throw e;
      console.error(`[trace-api] chờ PostgreSQL (${i}/20): ${e.message}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  pool = new Pool({ ...pgBase, database: DB_NAME, max: 5 });
  await runMigrations(pool, path.join(__dirname, "migrations"));
  if (SEED) {
    await seed();
    await seedDomain();
  }
  startSchedulers();
  server.listen(PORT, () => console.log(`[trace-api] lắng nghe cổng ${PORT}, database "${DB_NAME}"`));
}

main().catch((e) => {
  console.error("[trace-api] không khởi động được:", e);
  process.exit(1);
});
