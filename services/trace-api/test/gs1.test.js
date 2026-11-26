// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Làng Nghề Số contributors
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const gs1 = require("../gs1");

test("GS1 GTIN Mod-10: tính và kiểm tra chữ số kiểm tra chuẩn quốc gia 893", () => {
  const g14 = gs1.productGtin("GOM-BT-0001");
  assert.equal(g14.length, 14);
  assert.ok(g14.startsWith("0893"));
  assert.equal(gs1.isValidGtin(g14), true);
  // đổi chữ số cuối -> sai Mod-10
  const tampered = g14.slice(0, 13) + String((Number(g14[13]) + 1) % 10);
  assert.equal(gs1.isValidGtin(tampered), false);
});

test("GS1 Digital Link (TCVN 13274:2020): dựng và phân tích /01/<GTIN>/10/<Batch>/21/<Serial>", () => {
  const gtin = gs1.productGtin("GOM-BT-0001");
  const uri = gs1.buildDigitalLink({ origin: "https://langnghe.vn", gtin, batch: "GOM-BT-0001", serial: "SN-09" });
  assert.equal(uri, `https://langnghe.vn/01/${gtin}/10/GOM-BT-0001/21/SN-09`);

  const parsed = gs1.parseDigitalLink(uri);
  assert.deepEqual(parsed, { gtin, rawGtin: gtin, batch: "GOM-BT-0001", serial: "SN-09" });

  // Hỗ trợ đường dẫn đi qua cổng công khai /public/01/...
  assert.equal(gs1.parseDigitalLink(`/public/01/${gtin}/10/GOM-BT-0001`).batch, "GOM-BT-0001");
  // Từ chối GTIN sai số kiểm tra
  assert.equal(gs1.parseDigitalLink("/01/08931234567890/10/LOT1"), null);
});

test("EPCIS 2.0 JSON-LD: xuất chuỗi sự kiện 'một bước trước – một bước sau' kèm báo cáo cảm biến nhiệt", () => {
  const doc = gs1.toEpcisDocument(
    {
      code: "GOM-BT-0001",
      name: "Bình gốm men rạn",
      category: "Gốm sứ",
      sector: "gom",
      village: "Làng gốm Bát Tràng",
      artisan: "Nghệ nhân A",
      events: [
        { stage: "nguyen-lieu", location: "Kho đất", note: "Đất sét trắng", created_at: "2026-11-01T08:00:00Z" },
        {
          stage: "nung-hoan-thien",
          location: "Lò số 1",
          note: "Nung men rạn",
          created_at: "2026-11-02T20:00:00Z",
          iot: { deviceId: "kiln-01", min: 25, avg: 780, max: 1165, count: 840, from: "2026-11-02T06:00:00Z", to: "2026-11-02T20:00:00Z", verifiedAt: "2026-11-02T20:05:00Z" },
          insight: { verdict: "ok" },
        },
        { stage: "phan-phoi", location: "Cửa hàng", note: "Xuất xưởng", created_at: "2026-11-03T09:00:00Z" },
      ],
    },
    { origin: "https://langnghe.vn" },
  );

  assert.equal(doc.type, "EPCISDocument");
  assert.equal(doc.schemaVersion, "2.0");
  assert.equal(doc.epcisBody.eventList.length, 3);

  const [e0, e1, e2] = doc.epcisBody.eventList;
  assert.equal(e0["dxos:stepChain"].previousEventId, null);
  assert.equal(e0["dxos:stepChain"].nextEventId, e1.eventID);
  assert.equal(e1["dxos:stepChain"].previousEventId, e0.eventID);
  assert.equal(e1["dxos:stepChain"].nextEventId, e2.eventID);
  assert.equal(e2["dxos:stepChain"].previousEventId, e1.eventID);
  assert.equal(e2["dxos:stepChain"].nextEventId, null);
  assert.equal(e1.type, "TransformationEvent");
  assert.equal(e1.sensorElementList[0].sensorReport[0].maxValue, 1165);
  assert.equal(e1.sensorElementList[0].sensorReport[0].uom, "CEL");
});
