// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Làng Nghề Số contributors
"use strict";
const { HttpError, send, getUser } = require("../http-util");

/** Tuyến hồ dữ liệu phân tích (Parquet phân vùng Hive + DuckDB). */
function createLakeRoutes(ctx) {
  const { getPool, access, ACCESS, requirePermission, lake, getLakeS3, runLakeExport } = ctx;

  return async function handleLake(req, res, parts, url, m) {
    if (parts[0] !== "lake") return false;
    const user = getUser(req);
    if (!access.canApi(ACCESS, user.roles)) throw new HttpError(403, "Vai trò của bạn không dùng được API này");
    requirePermission(user, "archive.manage");

    if (parts.length === 1 && m === "GET") {
      send(res, 200, await lake.overview(getPool()));
      return true;
    }
    if (parts.length === 2 && parts[1] === "export" && m === "POST") {
      send(res, 200, await runLakeExport(user.name));
      return true;
    }
    if (parts.length === 3 && parts[1] === "analytics" && m === "GET") {
      const lakeS3 = getLakeS3();
      if (!lakeS3) throw new HttpError(503, "Chưa cấu hình kho lưu trữ");
      const filters = {
        coop: url.searchParams.get("coop") ?? undefined,
        year: url.searchParams.get("year") ?? undefined,
        month: url.searchParams.get("month") ?? undefined,
      };
      let r;
      try {
        r = await lake.runAnalytics(getPool(), lakeS3, parts[2], filters);
      } catch (e) {
        console.error("[trace-api] lỗi truy vấn hồ dữ liệu:", e.message);
        throw new HttpError(502, "Không truy vấn được hồ dữ liệu");
      }
      if (!r) throw new HttpError(404, "Không có truy vấn phân tích này");
      send(res, 200, r);
      return true;
    }
    return false;
  };
}

module.exports = { createLakeRoutes };
