// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Làng Nghề Số contributors
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { HttpError, send, sendText, readJson, getUser } = require("../http-util");

function findOpenApiFile() {
  const candidates = [
    process.env.OPENAPI_FILE,
    path.join(__dirname, "..", "openapi.yaml"),
    path.join(__dirname, "..", "..", "..", "openapi.yaml"),
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

const DOCS_HTML = `<!doctype html>
<html lang="vi">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Làng Nghề Số · DX-OS OpenAPI 3.1</title>
  </head>
  <body>
    <script id="api-reference" data-url="./openapi.yaml"></script>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
  </body>
</html>
`;

/** Tuyến hệ thống, cấu hình ngành, OpenAPI/Scalar docs, hồ sơ bản thân và hỏi đáp trợ lý. */
function createConfigRoutes(ctx) {
  const { access, ACCESS, SECTORS, sectors, assistant, ASSISTANT } = ctx;

  return async function handleConfig(req, res, parts, _url, m) {
    if (m === "GET" && parts[0] === "healthz") {
      send(res, 200, { status: "ok" });
      return true;
    }

    if (m === "GET" && ((parts.length === 1 && parts[0] === "openapi.yaml") || (parts.length === 2 && parts[0] === "public" && parts[1] === "openapi.yaml"))) {
      const file = findOpenApiFile();
      if (!file) throw new HttpError(404, "Chưa tìm thấy đặc tả openapi.yaml");
      sendText(res, 200, fs.readFileSync(file, "utf8"), "application/yaml; charset=utf-8");
      return true;
    }

    if (m === "GET" && ((parts.length === 1 && parts[0] === "docs") || (parts.length === 2 && parts[0] === "public" && parts[1] === "docs"))) {
      sendText(res, 200, DOCS_HTML, "text/html; charset=utf-8");
      return true;
    }

    if (parts[0] === "me" && parts.length === 1 && m === "GET") {
      const user = getUser(req);
      if (!access.canApi(ACCESS, user.roles)) throw new HttpError(403, "Vai trò của bạn không dùng được API này");
      send(res, 200, {
        username: user.name,
        roles: user.roles,
        coop: user.coop,
        permissions: access.permissionsOf(ACCESS, user.roles),
        pages: access.pagesOf(ACCESS, user.roles),
      });
      return true;
    }

    if (parts[0] === "sectors" && parts.length === 1 && m === "GET") {
      const user = getUser(req);
      if (!access.canApi(ACCESS, user.roles)) throw new HttpError(403, "Vai trò của bạn không dùng được API này");
      send(res, 200, sectors.publicView(SECTORS));
      return true;
    }

    if (parts[0] === "assistant" && parts[1] === "ask" && parts.length === 2 && m === "POST") {
      const user = getUser(req);
      if (!access.canApi(ACCESS, user.roles)) throw new HttpError(403, "Vai trò của bạn không dùng được API này");
      const body = await readJson(req);
      send(res, 200, assistant.ask(ASSISTANT, body?.question));
      return true;
    }

    return false;
  };
}

module.exports = { createConfigRoutes };
