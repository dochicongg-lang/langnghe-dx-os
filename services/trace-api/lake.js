// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Làng Nghề Số contributors
"use strict";
/**
 * Hồ dữ liệu phân tích (Lakehouse):
 * - Xuất các bộ dữ liệu từ PostgreSQL và kho lạnh sang Parquet nén ZSTD lưu tại bucket riêng (`dxos-lake`),
 *   phân vùng theo chuẩn Hive (`lake/<dataset>/coop=<coop>/year=<YYYY>/month=<MM>/part-<stamp>-<hash>.parquet`)
 *   kèm tệp manifest JSON chứa danh sách phân vùng và mã băm SHA-256 kiểm chứng toàn vẹn.
 * - Khi truy vấn phân tích (`runAnalytics`), lọc phân vùng (`filterPartitions`) theo `coop`, `year`, `month`
 *   TRƯỚC khi đọc tệp Parquet hoặc dùng DuckDB `httpfs` / `read_parquet([...], hive_partitioning=true)`.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DuckDBInstance } = require("@duckdb/node-api");

const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
const LOCK_KEY = 727003;

/** Chạy hàm với một kết nối DuckDB trong bộ nhớ, luôn đóng sau khi xong. */
async function withDuck(fn) {
  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();
  try {
    return await fn(conn);
  } finally {
    conn.closeSync?.();
    instance.closeSync?.();
  }
}

const tmpFile = (ext) => path.join(os.tmpdir(), `dxos-lake-${process.pid}-${crypto.randomBytes(6).toString("hex")}.${ext}`);
const quote = (p) => `'${String(p).replace(/\\/g, "/").replace(/'/g, "''")}'`;
const SQL_TYPES = new Set(["VARCHAR", "INTEGER", "BIGINT", "DOUBLE", "BOOLEAN", "DATE", "TIMESTAMP"]);

/** Chuẩn hóa giá trị JS cho DuckDB theo kiểu cột (null giữ nguyên). */
function cell(type, v) {
  if (v === null || v === undefined) return null;
  switch (type) {
    case "DATE":
      return new Date(v).toISOString().slice(0, 10);
    case "TIMESTAMP":
      return new Date(v).toISOString().replace("T", " ").replace("Z", "");
    case "INTEGER":
    case "BIGINT":
      return Math.trunc(Number(v));
    case "DOUBLE":
      return Number(v);
    case "BOOLEAN":
      return Boolean(v);
    default:
      return String(v);
  }
}

/** Ghi các dòng thành tệp Parquet (trả Buffer). columns: [{ name, type }]. */
async function toParquet(columns, rows) {
  for (const c of columns) {
    if (!/^[a-z_][a-z0-9_]*$/.test(c.name) || !SQL_TYPES.has(c.type)) throw new Error(`cột không hợp lệ: ${c.name} ${c.type}`);
  }
  const file = tmpFile("parquet");
  try {
    await withDuck(async (conn) => {
      await conn.run(`CREATE TABLE t (${columns.map((c) => `${c.name} ${c.type}`).join(", ")})`);
      const appender = await conn.createAppender("t");
      for (const r of rows) {
        for (const c of columns) {
          const v = cell(c.type, r[c.name]);
          if (v === null) appender.appendNull();
          else if (c.type === "VARCHAR" || c.type === "DATE" || c.type === "TIMESTAMP") appender.appendVarchar(v);
          else if (c.type === "INTEGER") appender.appendInteger(v);
          else if (c.type === "BIGINT") appender.appendBigInt(BigInt(v));
          else if (c.type === "DOUBLE") appender.appendDouble(v);
          else appender.appendBoolean(v);
        }
        appender.endRow();
      }
      appender.closeSync();
      await conn.run(`COPY t TO ${quote(file)} (FORMAT PARQUET, COMPRESSION ZSTD)`);
    });
    return fs.readFileSync(file);
  } finally {
    fs.rmSync(file, { force: true });
  }
}

function normalizeJsonRows(res) {
  return res.getRowObjectsJson().map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v])));
}

/** Chạy một truy vấn cố định (`{FILE}`) trên nội dung một Buffer Parquet. */
async function queryParquet(buf, sqlTemplate) {
  const file = tmpFile("parquet");
  fs.writeFileSync(file, buf);
  try {
    return await withDuck(async (conn) => {
      const res = await conn.runAndReadAll(sqlTemplate.split("{FILE}").join(`read_parquet(${quote(file)})`));
      return normalizeJsonRows(res);
    });
  } finally {
    fs.rmSync(file, { force: true });
  }
}

/** Cấu hình DuckDB `httpfs` để đọc trực tiếp từ MinIO/S3 (khi bật LAKE_DUCKDB_HTTPFS=true). */
async function configureHttpfs(conn, s3Cfg) {
  const u = new URL(s3Cfg.endpoint);
  await conn.run("INSTALL httpfs; LOAD httpfs;");
  await conn.run(`SET s3_endpoint=${quote(u.host)};`);
  await conn.run(`SET s3_use_ssl=${u.protocol === "https:" ? "true" : "false"};`);
  await conn.run("SET s3_url_style='path';");
  await conn.run(`SET s3_access_key_id=${quote(s3Cfg.accessKey)};`);
  await conn.run(`SET s3_secret_access_key=${quote(s3Cfg.secretKey)};`);
}

/** Truy vấn DuckDB trên nhiều tệp Parquet đã cắt tỉa theo phân vùng Hive (`hive_partitioning=true`). */
async function queryParquetFiles(files, sqlTemplate) {
  if (!files.length) return [];
  const listSql = `[${files.map(quote).join(", ")}]`;
  return withDuck(async (conn) => {
    const res = await conn.runAndReadAll(sqlTemplate.split("{FILE}").join(`read_parquet(${listSql}, hive_partitioning=true)`));
    return normalizeJsonRows(res);
  });
}

// ---------- Phân vùng Hive ----------
function sanitizePartition(v) {
  const s = String(v ?? "")
    .trim()
    .replace(/[^A-Za-z0-9_-]/g, "_");
  return s || "_none";
}

function partitionOf(row, dateField, coopField, fallbackDate = new Date()) {
  const coop = coopField ? sanitizePartition(row[coopField]) : "_system";
  const rawDate = row[dateField];
  const d = rawDate ? new Date(rawDate) : fallbackDate;
  const iso = Number.isNaN(d.getTime()) ? fallbackDate.toISOString() : d.toISOString();
  return { coop, year: iso.slice(0, 4), month: iso.slice(5, 7) };
}

function partitionKey(dataset, part, stamp, hash8) {
  return `lake/${dataset}/coop=${part.coop}/year=${part.year}/month=${part.month}/part-${stamp}-${hash8}.parquet`;
}

function filterPartitions(partitions, filters = {}) {
  return (partitions ?? []).filter((p) => {
    if (filters.coop && p.coop !== sanitizePartition(filters.coop)) return false;
    if (filters.year && p.year !== String(filters.year)) return false;
    if (filters.month && p.month !== String(filters.month).padStart(2, "0")) return false;
    return true;
  });
}

function groupByPartition(rows, dateField, coopField, now = new Date()) {
  const groups = new Map();
  for (const r of rows) {
    const part = partitionOf(r, dateField, coopField, now);
    const id = `${part.coop}|${part.year}|${part.month}`;
    let g = groups.get(id);
    if (!g) groups.set(id, (g = { ...part, rows: [] }));
    g.rows.push(r);
  }
  if (groups.size === 0) {
    const iso = now.toISOString();
    groups.set("empty", { coop: "_empty", year: iso.slice(0, 4), month: iso.slice(5, 7), rows: [] });
  }
  return [...groups.values()];
}

// ---------- Bộ dữ liệu ----------
const DATASETS = {
  applications: {
    title: "Hồ sơ OCOP",
    partitionDateField: "created_at",
    partitionCoopField: "coop",
    columns: [
      { name: "code", type: "VARCHAR" }, { name: "product_name", type: "VARCHAR" }, { name: "product_group", type: "VARCHAR" },
      { name: "owner", type: "VARCHAR" }, { name: "coop", type: "VARCHAR" }, { name: "state", type: "VARCHAR" },
      { name: "stars", type: "INTEGER" }, { name: "score", type: "DOUBLE" }, { name: "decided_at", type: "DATE" }, { name: "valid_until", type: "DATE" },
      { name: "created_at", type: "TIMESTAMP" }, { name: "updated_at", type: "TIMESTAMP" },
    ],
    async collect({ pool }) {
      const { rows } = await pool.query(
        `SELECT a.code, a.product_name, a.product_group, a.owner_username AS owner, c.code AS coop, a.state, r.stars, r.score::float AS score,
           r.decided_at, r.valid_until, a.created_at, a.updated_at
         FROM ocop_applications a LEFT JOIN cooperatives c ON c.id = a.coop_id
         LEFT JOIN LATERAL (SELECT * FROM ocop_results x WHERE x.application_id = a.id ORDER BY x.id DESC LIMIT 1) r ON TRUE ORDER BY a.id`,
      );
      return { rows, lineage: [{ source: "postgres:ocop_applications", rows: rows.length }, { source: "postgres:ocop_results", note: "kết quả mới nhất của mỗi hồ sơ" }, { source: "postgres:cooperatives" }] };
    },
  },
  application_history: {
    title: "Lịch sử xử lý hồ sơ (nóng và lạnh)",
    partitionDateField: "created_at",
    partitionCoopField: "coop",
    columns: [
      { name: "application", type: "VARCHAR" }, { name: "coop", type: "VARCHAR" }, { name: "action", type: "VARCHAR" }, { name: "from_state", type: "VARCHAR" }, { name: "to_state", type: "VARCHAR" },
      { name: "actor", type: "VARCHAR" }, { name: "created_at", type: "TIMESTAMP" }, { name: "tier", type: "VARCHAR" },
    ],
    async collect({ pool, readArchive }) {
      const hot = (
        await pool.query(
          `SELECT a.code AS application, c.code AS coop, h.action, h.from_state, h.to_state, h.actor, h.created_at
           FROM ocop_application_history h JOIN ocop_applications a ON a.id = h.application_id LEFT JOIN cooperatives c ON c.id = a.coop_id ORDER BY h.id`,
        )
      ).rows.map((r) => ({ ...r, tier: "hot" }));
      const lineage = [{ source: "postgres:ocop_application_history", rows: hot.length, tier: "hot" }];
      const cold = [];
      for (const run of (await pool.query("SELECT id, object_key, sha256, row_count FROM archive_runs ORDER BY id")).rows) {
        const data = await readArchive(run.id);
        for (const r of data) cold.push({ application: r.application, coop: r.coop ?? null, action: r.action, from_state: r.from_state, to_state: r.to_state, actor: r.actor, created_at: r.created_at, tier: "cold" });
        lineage.push({ source: `minio:${run.object_key}`, sha256: run.sha256, rows: data.length, tier: "cold", archive_run: run.id });
      }
      return { rows: [...hot, ...cold], lineage };
    },
  },
  kiln_runs: {
    title: "Mẻ nung và mẻ nhuộm có bằng chứng cảm biến",
    partitionDateField: "started_at",
    partitionCoopField: "coop",
    columns: [
      { name: "product_code", type: "VARCHAR" }, { name: "coop", type: "VARCHAR" }, { name: "category", type: "VARCHAR" }, { name: "device_id", type: "VARCHAR" }, { name: "started_at", type: "TIMESTAMP" },
      { name: "ended_at", type: "TIMESTAMP" }, { name: "peak", type: "DOUBLE" }, { name: "avg_temp", type: "DOUBLE" }, { name: "min_temp", type: "DOUBLE" },
      { name: "samples", type: "INTEGER" }, { name: "coverage", type: "DOUBLE" }, { name: "verdict", type: "VARCHAR" },
    ],
    async collect({ pool, kiln }) {
      const { rows } = await pool.query(
        `SELECT p.code AS product_code, c.code AS coop, p.category, e.iot
         FROM trace_events e JOIN products p ON p.id = e.product_id LEFT JOIN cooperatives c ON c.id = p.coop_id
         WHERE e.iot IS NOT NULL ORDER BY e.id`,
      );
      const out = rows.map((r) => {
        const iot = r.iot;
        let verdict = null;
        try {
          verdict = kiln.analyze(iot, kiln.pickProfile(kiln.config, r.category)).verdict;
        } catch {
          verdict = null;
        }
        return {
          product_code: r.product_code, coop: r.coop, category: r.category, device_id: iot.deviceId, started_at: iot.from, ended_at: iot.to,
          peak: iot.max, avg_temp: iot.avg, min_temp: iot.min, samples: iot.count, coverage: iot.quality?.coverage ?? null, verdict,
        };
      });
      return { rows: out, lineage: [{ source: "postgres:trace_events", note: "chỉ công đoạn có bằng chứng IoT (cột iot, đã được máy chủ đối chiếu)", rows: out.length }, { source: "config:kiln-profiles", note: "kết luận (verdict) tính bằng bộ luật, chưa so với mẻ khác" }] };
    },
  },
  audit_events: {
    title: "Nhật ký kiểm toán (đã bỏ nội dung nhạy cảm)",
    partitionDateField: "ts",
    partitionCoopField: null,
    columns: [
      { name: "id", type: "BIGINT" }, { name: "ts", type: "TIMESTAMP" }, { name: "actor", type: "VARCHAR" }, { name: "verified", type: "BOOLEAN" },
      { name: "method", type: "VARCHAR" }, { name: "route", type: "VARCHAR" }, { name: "status", type: "INTEGER" }, { name: "latency_ms", type: "INTEGER" },
    ],
    async collect({ pool }) {
      const { rows } = await pool.query("SELECT id, ts, actor, verified, method, route, status, latency_ms FROM audit_log ORDER BY id");
      return { rows, lineage: [{ source: "postgres:audit_log", rows: rows.length, note: "không xuất đường dẫn và IP; bảng nguồn là chỉ-ghi-thêm có chuỗi băm" }] };
    },
  },
};

// ---------- Truy vấn phân tích (mẫu cố định) ----------
const ANALYTICS = {
  "applications-by-state": { dataset: "applications", title: "Hồ sơ theo trạng thái", sql: "SELECT state, count(*) AS n FROM {FILE} GROUP BY state ORDER BY n DESC, state" },
  "applications-by-month": {
    dataset: "applications",
    title: "Hồ sơ lập theo tháng và số sao trung bình",
    sql: "SELECT strftime(created_at, '%Y-%m') AS month, count(*) AS n, round(avg(stars), 2) AS avg_stars FROM {FILE} GROUP BY 1 ORDER BY 1",
  },
  "history-by-tier": { dataset: "application_history", title: "Lịch sử xử lý theo tầng lưu trữ", sql: "SELECT tier, action, count(*) AS n FROM {FILE} GROUP BY tier, action ORDER BY tier, n DESC, action" },
  "kiln-by-verdict": { dataset: "kiln_runs", title: "Mẻ nung và mẻ nhuộm theo kết luận", sql: "SELECT coalesce(verdict, 'không rõ') AS verdict, count(*) AS runs, round(avg(peak), 1) AS avg_peak, max(peak) AS max_peak FROM {FILE} GROUP BY 1 ORDER BY runs DESC, verdict" },
  "audit-by-status": { dataset: "audit_events", title: "Yêu cầu API theo nhóm mã trạng thái", sql: "SELECT (status // 100) * 100 AS status_class, count(*) AS n, round(avg(latency_ms), 1) AS avg_latency_ms FROM {FILE} GROUP BY 1 ORDER BY 1" },
};

/**
 * Xuất mọi bộ dữ liệu sang Parquet phân vùng Hive (`lake/<dataset>/coop=.../year=YYYY/month=MM/`).
 * Mỗi phân vùng được đọc lại đối chiếu SHA-256 rồi ghi vào manifest JSON trước khi lưu sổ truy vết `lake_runs`.
 */
async function exportAll(deps, triggeredBy, now = new Date()) {
  const { pool, s3 } = deps;
  const client = await pool.connect();
  let locked = false;
  try {
    const lock = await client.query("SELECT pg_try_advisory_lock($1) AS ok", [LOCK_KEY]);
    if (!lock.rows[0].ok) return { skipped: "busy" };
    locked = true;
    const stamp = now.toISOString().replace(/[-:.]/g, "").slice(0, 15);
    const results = [];
    for (const [name, ds] of Object.entries(DATASETS)) {
      const { rows, lineage } = await ds.collect(deps);
      const groups = groupByPartition(rows, ds.partitionDateField, ds.partitionCoopField, now);
      const partitions = [];
      let totalSize = 0;
      for (const g of groups) {
        const buf = await toParquet(ds.columns, g.rows);
        const hash = sha256(buf);
        const key = partitionKey(name, g, stamp, hash.slice(0, 8));
        await s3.putObject(key, buf, "application/vnd.apache.parquet");
        if (sha256(await s3.getObjectBuffer(key)) !== hash) throw new Error(`Tệp ${key} đọc lại không khớp băm, hủy`);
        partitions.push({ coop: g.coop, year: g.year, month: g.month, key, sha256: hash, rows: g.rows.length, size: buf.length });
        totalSize += buf.length;
      }
      const manifestBuf = Buffer.from(JSON.stringify({ format: "hive-parquet-v1", dataset: name, created_at: now.toISOString(), partitions }, null, 2));
      const manifestHash = sha256(manifestBuf);
      const manifestKey = `lake/${name}/_manifests/run-${stamp}-${manifestHash.slice(0, 8)}.json`;
      await s3.putObject(manifestKey, manifestBuf, "application/json");
      if (sha256(await s3.getObjectBuffer(manifestKey)) !== manifestHash) throw new Error(`Manifest ${manifestKey} đọc lại không khớp băm, hủy`);
      const fullLineage = [...lineage, { format: "hive-parquet-v1", partitions: partitions.length }];
      const { rows: ins } = await client.query(
        "INSERT INTO lake_runs (dataset, rows, object_key, sha256, size, columns, lineage, triggered_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id",
        [name, rows.length, manifestKey, manifestHash, totalSize, JSON.stringify(ds.columns), JSON.stringify(fullLineage), triggeredBy],
      );
      results.push({ dataset: name, run_id: ins[0].id, rows: rows.length, object_key: manifestKey, sha256: manifestHash, size: totalSize, partitions: partitions.length });
    }
    return { exported: results };
  } finally {
    if (locked) await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {});
    client.release();
  }
}

/** Tổng quan: mỗi bộ dữ liệu với lần xuất mới nhất (kèm truy vết nguồn) và số lần đã xuất. */
async function overview(pool) {
  const out = [];
  for (const [name, ds] of Object.entries(DATASETS)) {
    const { rows } = await pool.query(
      "SELECT id, rows, object_key, sha256, size, columns, lineage, triggered_by, created_at, (SELECT count(*)::int FROM lake_runs WHERE dataset = $1) AS runs FROM lake_runs WHERE dataset = $1 ORDER BY id DESC LIMIT 1",
      [name],
    );
    out.push({ dataset: name, title: ds.title, columns: ds.columns, latest: rows[0] ?? null });
  }
  return { datasets: out, analytics: Object.entries(ANALYTICS).map(([id, a]) => ({ id, title: a.title, dataset: a.dataset })) };
}

/** Chạy truy vấn phân tích trên phân vùng đã cắt tỉa (`coop`, `year`, `month`); tương thích ngược với Parquet đơn lẻ cũ. */
async function runAnalytics(pool, s3, name, filters = {}) {
  const a = ANALYTICS[name];
  if (!a) return null;
  const { rows } = await pool.query("SELECT id, object_key, sha256, created_at FROM lake_runs WHERE dataset = $1 ORDER BY id DESC LIMIT 1", [a.dataset]);
  if (!rows.length) return { id: name, title: a.title, dataset: a.dataset, exported: false, rows: [] };
  const headBuf = await s3.getObjectBuffer(rows[0].object_key);
  if (sha256(headBuf) !== rows[0].sha256) throw new Error("Tệp xuất không khớp băm trong sổ truy vết");

  if (!rows[0].object_key.endsWith(".json")) {
    return { id: name, title: a.title, dataset: a.dataset, exported: true, from_run: rows[0].id, sha256: rows[0].sha256, as_of: rows[0].created_at, rows: await queryParquet(headBuf, a.sql) };
  }

  const manifest = JSON.parse(headBuf.toString("utf8"));
  const allParts = manifest.partitions ?? [];
  const picked = filterPartitions(allParts, filters);
  if (picked.length === 0) {
    return { id: name, title: a.title, dataset: a.dataset, exported: true, from_run: rows[0].id, sha256: rows[0].sha256, as_of: rows[0].created_at, partitions_total: allParts.length, partitions_scanned: 0, filters, rows: [] };
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dxos-lake-hive-"));
  try {
    const localFiles = [];
    for (const p of picked) {
      const pBuf = await s3.getObjectBuffer(p.key);
      if (sha256(pBuf) !== p.sha256) throw new Error(`Phân vùng ${p.key} không khớp băm`);
      const pDir = path.join(dir, `coop=${p.coop}`, `year=${p.year}`, `month=${p.month}`);
      fs.mkdirSync(pDir, { recursive: true });
      const filePath = path.join(pDir, path.basename(p.key));
      fs.writeFileSync(filePath, pBuf);
      localFiles.push(filePath);
    }
    const resultRows = await queryParquetFiles(localFiles, a.sql);
    return {
      id: name,
      title: a.title,
      dataset: a.dataset,
      exported: true,
      from_run: rows[0].id,
      sha256: rows[0].sha256,
      as_of: rows[0].created_at,
      partitions_total: allParts.length,
      partitions_scanned: picked.length,
      filters,
      rows: resultRows,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = {
  DATASETS,
  ANALYTICS,
  toParquet,
  queryParquet,
  queryParquetFiles,
  configureHttpfs,
  sanitizePartition,
  partitionOf,
  partitionKey,
  filterPartitions,
  groupByPartition,
  exportAll,
  overview,
  runAnalytics,
  cell,
};
