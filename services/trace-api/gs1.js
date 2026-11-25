// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Làng Nghề Số contributors
"use strict";
/**
 * Chuẩn hóa Truy xuất nguồn gốc Quốc gia (TCVN 13274:2020 / TCVN 12850:2019 / Thông tư 02/2024/TT-BKHCN):
 *   1. Mã định danh GS1 GTIN-14 (mã quốc gia Việt Nam 893, số kiểm tra Mod-10 chuẩn GS1).
 *   2. Đường dẫn GS1 Digital Link (`/01/<GTIN>/10/<Batch>/21/<Serial>`).
 *   3. Xuất tài liệu sự kiện chuẩn GS1 EPCIS 2.0 JSON-LD thể hiện rõ chuỗi "một bước trước – một bước sau"
 *      (`previousEventId` / `nextEventId`) và đính kèm `sensorElementList` cho dữ liệu nhiệt độ IoT.
 */
const crypto = require("node:crypto");

const STAGE_CBV = {
  "nguyen-lieu": { bizStep: "commissioning", disposition: "active" },
  "so-che": { bizStep: "transforming", disposition: "in_progress" },
  "tao-hinh": { bizStep: "transforming", disposition: "in_progress" },
  "nung-hoan-thien": { bizStep: "transforming", disposition: "in_progress" },
  "nhuom-hoan-thien": { bizStep: "transforming", disposition: "in_progress" },
  "kiem-dinh": { bizStep: "inspecting", disposition: "conformant" },
  "dong-goi": { bizStep: "packing", disposition: "in_progress" },
  "phan-phoi": { bizStep: "shipping", disposition: "in_transit" },
};

/** Tính chữ số kiểm tra GS1 Mod-10 cho chuỗi 7, 11, 12 hoặc 13 chữ số. */
function computeGtinCheckDigit(digitsWithoutCheck) {
  const s = String(digitsWithoutCheck ?? "").trim();
  if (!/^\d{7}$|^\d{11,13}$/.test(s)) throw new Error("Chuỗi cơ sở GTIN phải gồm 7, 11, 12 hoặc 13 chữ số");
  let sum = 0;
  // Tính từ phải sang trái: vị trí lẻ (tính từ 1 ở ngoài cùng bên phải) nhân 3, vị trí chẵn nhân 1
  for (let i = 0; i < s.length; i++) {
    const d = s.charCodeAt(s.length - 1 - i) - 48;
    sum += d * (i % 2 === 0 ? 3 : 1);
  }
  return String((10 - (sum % 10)) % 10);
}

/** Kiểm tra chuỗi GTIN (8, 12, 13, 14 chữ số) có chữ số kiểm tra Mod-10 hợp lệ hay không. */
function isValidGtin(gtin) {
  const s = String(gtin ?? "").trim();
  if (!/^\d{8}$|^\d{12,14}$/.test(s)) return false;
  return computeGtinCheckDigit(s.slice(0, -1)) === s.slice(-1);
}

/** Chuẩn hóa bất kỳ GTIN-8/12/13/14 hợp lệ về dạng 14 chữ số (đệm số 0 bên trái). */
function normalizeGtin14(gtin) {
  const s = String(gtin ?? "").trim();
  if (!isValidGtin(s)) throw new Error(`Mã GTIN không hợp lệ (sai độ dài hoặc chữ số kiểm tra Mod-10): ${gtin}`);
  return s.padStart(14, "0");
}

/**
 * Sinh mã GTIN-14 xác định (deterministic) mang đầu số Việt Nam `0893` từ mã sản phẩm nội bộ
 * khi chủ thể chưa đăng ký mã số mã vạch riêng, đảm bảo tuân thủ cấu trúc chữ số kiểm tra Mod-10.
 */
function productGtin(productCode, explicitGtin = null) {
  if (explicitGtin && isValidGtin(explicitGtin)) return normalizeGtin14(explicitGtin);
  const hash = crypto.createHash("sha256").update(String(productCode ?? "").toUpperCase()).digest();
  let nineDigits = "";
  for (let i = 0; i < 9; i++) nineDigits += String(hash[i] % 10);
  const base13 = `0893${nineDigits}`;
  return base13 + computeGtinCheckDigit(base13);
}

const AI_VALUE_RE = /^[A-Za-z0-9._-]{1,40}$/;

/** Dựng đường dẫn GS1 Digital Link chuẩn TCVN 13274:2020: `/01/<GTIN>/10/<Batch>[/21/<Serial>]`. */
function buildDigitalLink({ origin = "", gtin, batch, serial }) {
  const g14 = normalizeGtin14(gtin);
  let p = `/01/${g14}`;
  if (batch) {
    if (!AI_VALUE_RE.test(batch)) throw new Error("Số lô (AI 10) chứa ký tự không hợp lệ");
    p += `/10/${encodeURIComponent(batch)}`;
  }
  if (serial) {
    if (!AI_VALUE_RE.test(serial)) throw new Error("Số sê-ri (AI 21) chứa ký tự không hợp lệ");
    p += `/21/${encodeURIComponent(serial)}`;
  }
  return origin ? `${String(origin).replace(/\/$/, "")}${p}` : p;
}

/** Phân tích đường dẫn hoặc URL GS1 Digital Link `/01/<GTIN>[/10/<Batch>][/21/<Serial>]`. Trả null nếu không khớp. */
function parseDigitalLink(pathOrUrl) {
  const raw = String(pathOrUrl ?? "").trim();
  if (!raw) return null;
  let pathname = raw;
  try {
    if (/^https?:\/\//i.test(raw)) pathname = new URL(raw).pathname;
  } catch {
    return null;
  }
  const parts = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const idx01 = parts[0] === "public" ? 1 : 0;
  if (parts[idx01] !== "01" || !parts[idx01 + 1]) return null;
  const gtinRaw = parts[idx01 + 1];
  if (!isValidGtin(gtinRaw)) return null;
  const out = { gtin: normalizeGtin14(gtinRaw), rawGtin: gtinRaw, batch: null, serial: null };
  for (let i = idx01 + 2; i < parts.length; i += 2) {
    const ai = parts[i];
    const val = parts[i + 1];
    if (!val || !AI_VALUE_RE.test(val)) return null;
    if (ai === "10") out.batch = val;
    else if (ai === "21") out.serial = val;
    else return null;
  }
  return out;
}

function slugUri(text, fallback = "unknown") {
  const s = String(text ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return s || fallback;
}

/**
 * Xuất hồ sơ sự kiện truy xuất nguồn gốc theo chuẩn quốc tế **GS1 EPCIS 2.0 JSON-LD**
 * kết hợp nguyên tắc "một bước trước – một bước sau" (`previousEventId` / `nextEventId`) của TCVN 12850.
 */
function toEpcisDocument(product, { origin = "https://langnghe.vn" } = {}) {
  const gtin = productGtin(product.code, product.gtin);
  const baseOrigin = String(origin).replace(/\/$/, "");
  const epcUri = `${baseOrigin}/01/${gtin}/10/${encodeURIComponent(product.code)}`;
  const events = Array.isArray(product.events) ? product.events : [];

  const eventIds = events.map((ev, idx) => {
    const h = crypto
      .createHash("sha256")
      .update(`${product.code}|${idx}|${ev.stage}|${ev.created_at}`)
      .digest("hex")
      .slice(0, 16);
    return `urn:uuid:dxos-${product.code.toLowerCase()}-${String(idx + 1).padStart(3, "0")}-${h}`;
  });

  const eventList = events.map((ev, idx) => {
    const cbv = STAGE_CBV[ev.stage] ?? { bizStep: "other", disposition: "active" };
    const isTransform = cbv.bizStep === "transforming";
    const item = {
      type: isTransform ? "TransformationEvent" : "ObjectEvent",
      eventID: eventIds[idx],
      eventTime: new Date(ev.created_at).toISOString(),
      eventTimeZoneOffset: "+07:00",
      ...(isTransform
        ? { inputEPCList: [epcUri], outputEPCList: [epcUri] }
        : { action: cbv.bizStep === "commissioning" ? "ADD" : "OBSERVE", epcList: [epcUri] }),
      bizStep: cbv.bizStep,
      disposition: cbv.disposition,
      readPoint: { id: `urn:epc:id:sgln:8930000.${slugUri(ev.location || product.village, "site")}.0` },
      bizLocation: { id: `urn:epc:id:sgln:8930000.${slugUri(product.village, "village")}.0` },
      // Chuỗi liên kết "một bước trước – một bước sau" (TCVN 12850 / Thông tư 02/2024/TT-BKHCN)
      "dxos:stepChain": {
        stepIndex: idx + 1,
        totalSteps: events.length,
        stageKey: ev.stage,
        previousEventId: idx > 0 ? eventIds[idx - 1] : null,
        nextEventId: idx < events.length - 1 ? eventIds[idx + 1] : null,
        locationName: ev.location || product.village || "",
        note: ev.note || "",
      },
    };

    if (ev.iot) {
      item.sensorElementList = [
        {
          sensorMetadata: {
            time: ev.iot.verifiedAt ?? new Date(ev.created_at).toISOString(),
            deviceID: `urn:dxos:iot:device:${ev.iot.deviceId}`,
            startTime: ev.iot.from,
            endTime: ev.iot.to,
          },
          sensorReport: [
            {
              type: "Temperature",
              minValue: ev.iot.min,
              maxValue: ev.iot.max,
              meanValue: ev.iot.avg,
              uom: "CEL",
              "dxos:sampleCount": ev.iot.count,
              ...(ev.insight ? { "dxos:verdict": ev.insight.verdict } : {}),
            },
          ],
        },
      ];
    }
    return item;
  });

  return {
    "@context": [
      "https://ref.gs1.org/standards/epcis/2.0.0/epcis-context.jsonld",
      { dxos: "https://langnghe.vn/ns/trace#" },
    ],
    type: "EPCISDocument",
    schemaVersion: "2.0",
    creationDate: new Date().toISOString(),
    "dxos:standardCompliance": ["TCVN 13274:2020", "TCVN 12850:2019", "GS1 Digital Link 1.1", "GS1 EPCIS 2.0"],
    "dxos:product": {
      code: product.code,
      gtin,
      digitalLink: buildDigitalLink({ origin: baseOrigin, gtin, batch: product.code }),
      name: product.name,
      category: product.category,
      sector: product.sector,
      village: product.village,
      artisan: product.artisan,
      ocop: product.ocop ?? null,
    },
    epcisBody: { eventList },
  };
}

module.exports = {
  computeGtinCheckDigit,
  isValidGtin,
  normalizeGtin14,
  productGtin,
  buildDigitalLink,
  parseDigitalLink,
  toEpcisDocument,
};
