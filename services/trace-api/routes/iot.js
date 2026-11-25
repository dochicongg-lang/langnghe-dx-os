// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Làng Nghề Số contributors
"use strict";
const { HttpError, send, getUser } = require("../http-util");

/** Tuyến IoT: cấu hình bảng theo dõi theo ngành và đọc số liệu cảm biến (lọc theo HTX). */
function createIotRoutes(ctx) {
  const { access, ACCESS, devices, devicesForUser, SECTORS, KILN, kiln, s3, readLatestReadings, iotDayCache } = ctx;

  return async function handleIot(req, res, parts, url, m) {
    if (parts[0] !== "iot") return false;
    const user = getUser(req);
    if (!access.canApi(ACCESS, user.roles)) throw new HttpError(403, "Vai trò của bạn không dùng được API này");
    const scope = access.scopeFor(ACCESS, user.roles, "product.read");
    if (!scope) throw new HttpError(403, "Vai trò của bạn không có quyền xem dữ liệu cảm biến");
    const allowed = devicesForUser(devices, scope, user.coop);

    if (parts.length === 2 && parts[1] === "config" && m === "GET") {
      send(res, 200, {
        boards: kiln.boardConfigs(SECTORS, KILN),
        devices: [...allowed.entries()].map(([id, d]) => ({ id, coop: d.coop ?? null })),
      });
      return true;
    }

    if (parts.length === 2 && parts[1] === "readings" && m === "GET") {
      if (!s3) throw new HttpError(503, "Chưa cấu hình kết nối kho dữ liệu cảm biến");
      const days = url.searchParams.get("days");
      send(res, 200, await readLatestReadings(s3, allowed, { maxDays: days ?? 6, cache: iotDayCache }));
      return true;
    }

    return false;
  };
}

module.exports = { createIotRoutes };
