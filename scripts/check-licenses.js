#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Làng Nghề Số contributors
"use strict";
/**
 * Tự động kiểm tra tính nhất quán Proof of Freedom (PoF):
 *   1. Mọi ảnh Docker bên ngoài trong `docker-compose.yml` phải được kê khai trong `THIRD-PARTY-NOTICES.md`.
 *   2. Mọi phông chữ Google trong `frontend/src/app/layout.tsx` phải được kê khai trong `THIRD-PARTY-NOTICES.md`.
 *   3. Toàn bộ cây phụ thuộc npm (`services/trace-api/node_modules`, `frontend/node_modules`) phải dùng giấy phép tự do
 *      tương thích với Apache-2.0 (chặn GPL/AGPL lây nhiễm hoặc gói không rõ giấy phép).
 *
 * Dùng: node scripts/check-licenses.js
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

const ALLOWED_TOKENS = new Set([
  "MIT",
  "ISC",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "0BSD",
  "MPL-2.0",
  "CC-BY-4.0",
  "CC0-1.0",
  "BlueOak-1.0.0",
  "Python-2.0",
  "Unlicense",
  "WTFPL",
  "Zlib",
  "PSF-2.0",
  "MIT-0",
  "Artistic-2.0",
  "AFL-2.1",
  "BSD",
]);

/** Chuẩn hóa trường `license` / `licenses` trong `package.json`. */
function extractLicense(pkg) {
  if (typeof pkg?.license === "string" && pkg.license.trim()) return pkg.license.trim();
  if (pkg?.license && typeof pkg.license.type === "string" && pkg.license.type.trim()) return pkg.license.type.trim();
  if (Array.isArray(pkg?.licenses) && pkg.licenses.length > 0) {
    const types = pkg.licenses.map((l) => (typeof l === "string" ? l : l?.type)).filter(Boolean);
    if (types.length > 0) return types.join(" OR ");
  }
  return "";
}

/** Kiểm tra một biểu thức SPDX đơn giản có nằm trong danh sách cho phép hay không. */
function isAllowedLicense(expr, pkgName = "") {
  if (!expr || typeof expr !== "string") return false;
  const clean = expr.replace(/[()]/g, "").trim();
  if (ALLOWED_TOKENS.has(clean)) return true;

  // Cho phép ngoại lệ đã ghi rõ trong THIRD-PARTY-NOTICES.md (gói nhị phân tùy chọn tối ưu ảnh Next.js, không dùng & không sửa).
  if (/^@img\/sharp-/.test(pkgName) && clean === "Apache-2.0 AND LGPL-3.0-or-later") return true;

  // Nếu là biểu thức OR: chỉ cần ít nhất một lựa chọn nằm trong danh sách tương thích.
  if (/\s+OR\s+/i.test(clean) && !/\s+AND\s+/i.test(clean)) {
    return clean.split(/\s+OR\s+/i).some((part) => isAllowedLicense(part, pkgName));
  }

  // Nếu là biểu thức AND: mọi nhánh đều phải nằm trong danh sách cho phép.
  if (/\s+AND\s+/i.test(clean)) {
    return clean.split(/\s+AND\s+/i).every((part) => isAllowedLicense(part, pkgName));
  }

  return false;
}

/** Trích danh sách repository ảnh Docker bên ngoài từ `docker-compose.yml`. */
function parseComposeImages(composeText) {
  const images = new Set();
  for (const line of String(composeText).split(/\r?\n/)) {
    const m = /^\s*image:\s*([^\s#]+)/.exec(line);
    if (!m) continue;
    const raw = m[1].replace(/^["']|["']$/g, "");
    if (raw.startsWith("dxos/")) continue; // ảnh dựng nội bộ của dự án
    const repo = raw.split("@")[0].split(":")[0];
    if (repo) images.add(repo);
  }
  return [...images];
}

/** Trích tên các phông `next/font/google` được nạp trong `frontend/src/app/layout.tsx`. */
function parseLayoutFonts(layoutText) {
  const m = /import\s*\{([^}]+)\}\s*from\s*["']next\/font\/google["']/.exec(String(layoutText));
  if (!m) return [];
  return m[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((name) => name.replace(/_/g, " "));
}

/** Duyệt đệ quy `node_modules` và thu thập `{ name, version, license }` cho mọi gói cài đặt. */
function collectPackageLicenses(nodeModulesDir) {
  const results = [];
  if (!fs.existsSync(nodeModulesDir)) return results;

  function scanDir(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.name.startsWith("@")) {
        for (const sub of fs.readdirSync(full, { withFileTypes: true })) {
          if (sub.isDirectory()) inspectPkg(path.join(full, sub.name));
        }
      } else {
        inspectPkg(full);
      }
    }
  }

  function inspectPkg(pkgDir) {
    const pkgPath = path.join(pkgDir, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
        if (pkg.name && pkg.version) {
          results.push({ name: pkg.name, version: pkg.version, license: extractLicense(pkg), path: pkgDir });
        }
      } catch {
        // bỏ qua package.json phụ không phải manifest chuẩn (ví dụ file thử nghiệm)
      }
    }
    const nested = path.join(pkgDir, "node_modules");
    if (fs.existsSync(nested)) scanDir(nested);
  }

  scanDir(nodeModulesDir);
  return results;
}

/** Kiểm tra toàn bộ dự án, trả về danh sách lỗi và thống kê. */
function auditProject(root = ROOT) {
  const errors = [];
  const notices = fs.readFileSync(path.join(root, "THIRD-PARTY-NOTICES.md"), "utf8");
  const compose = fs.readFileSync(path.join(root, "docker-compose.yml"), "utf8");
  const layout = fs.readFileSync(path.join(root, "frontend", "src", "app", "layout.tsx"), "utf8");

  const images = parseComposeImages(compose);
  for (const img of images) {
    if (!notices.includes(img)) {
      errors.push(`Ảnh Docker "${img}" trong docker-compose.yml chưa được kê khai trong THIRD-PARTY-NOTICES.md`);
    }
  }

  const fonts = parseLayoutFonts(layout);
  for (const font of fonts) {
    if (!notices.includes(font)) {
      errors.push(`Phông chữ "${font}" trong frontend/src/app/layout.tsx chưa được kê khai trong THIRD-PARTY-NOTICES.md`);
    }
  }

  const workspaces = ["services/trace-api", "frontend"];
  const stats = {};
  for (const ws of workspaces) {
    const nm = path.join(root, ws, "node_modules");
    if (!fs.existsSync(nm)) {
      errors.push(`Thiếu ${ws}/node_modules — cần chạy npm ci trước khi kiểm tra giấy phép`);
      continue;
    }
    const pkgs = collectPackageLicenses(nm);
    const counts = {};
    for (const p of pkgs) {
      const lic = p.license || "MISSING";
      counts[lic] = (counts[lic] ?? 0) + 1;
      if (!isAllowedLicense(p.license, p.name)) {
        errors.push(`[${ws}] Gói ${p.name}@${p.version} dùng giấy phép không nằm trong danh sách tương thích: "${lic}"`);
      }
    }
    stats[ws] = { total: pkgs.length, counts };
  }

  return { ok: errors.length === 0, errors, images, fonts, stats };
}

module.exports = { extractLicense, isAllowedLicense, parseComposeImages, parseLayoutFonts, collectPackageLicenses, auditProject };

if (require.main === module) {
  const r = auditProject(ROOT);
  if (!r.ok) {
    console.error(`KHÔNG ĐẠT kiểm tra Proof of Freedom (${r.errors.length} lỗi):`);
    for (const e of r.errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log(`OK: Đã đồng bộ ${r.images.length} ảnh Docker, ${r.fonts.length} phông chữ với THIRD-PARTY-NOTICES.md.`);
  for (const [ws, st] of Object.entries(r.stats)) {
    console.log(`OK: [${ws}] ${st.total} gói phụ thuộc đều dùng giấy phép tương thích Apache-2.0.`);
  }
}
