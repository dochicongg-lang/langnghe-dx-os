// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Làng Nghề Số contributors
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parseDevices, loadDevices, devicesForUser } = require("../devices");

test("parseDevices: đọc danh bạ hợp lệ", () => {
  const m = parseDevices(
    JSON.stringify({ _doc: "bỏ qua", devices: { "kiln-01": "dxos-iot", "kiln-02": { gateway: "gw-b", min: 0, max: 1400, maxRatePerSec: 30 } } }),
  );
  assert.deepEqual(m.get("kiln-01"), { gateway: "dxos-iot", min: undefined, max: undefined, maxRatePerSec: undefined });
  assert.deepEqual(m.get("kiln-02"), { gateway: "gw-b", min: 0, max: 1400, maxRatePerSec: 30 });
  assert.equal(m.size, 2);
});

test("parseDevices: đọc coop tùy chọn và từ chối coop sai định dạng", () => {
  const m = parseDevices(JSON.stringify({ devices: { "kiln-01": { gateway: "gw-a", coop: "htx-demo" } } }));
  assert.equal(m.get("kiln-01").coop, "htx-demo");
  assert.throws(() => parseDevices(JSON.stringify({ devices: { "kiln-01": { gateway: "gw-a", coop: "../bad" } } })), /coop/);
});

test("devicesForUser: lọc thiết bị theo phạm vi all / coop", () => {
  const m = parseDevices(
    JSON.stringify({
      devices: {
        "kiln-01": { gateway: "gw-a", coop: "htx-demo" },
        "dye-01": { gateway: "gw-a", coop: "htx-lua" },
      },
    }),
  );
  assert.equal(devicesForUser(m, "all", "").size, 2);
  const demo = devicesForUser(m, "coop", "htx-demo");
  assert.deepEqual([...demo.keys()], ["kiln-01"]);
  assert.equal(devicesForUser(m, "coop", "").size, 0);
  assert.equal(devicesForUser(m, null, "htx-demo").size, 0);
});

test("parseDevices: từ chối định dạng sai", () => {
  const bad = [
    "không phải json",
    "[]",
    "{}",
    JSON.stringify({ devices: [] }),
    JSON.stringify({ devices: { "../x": "gw" } }),
    JSON.stringify({ devices: { "kiln-01": "" } }),
    JSON.stringify({ devices: { "kiln-01": "a/b" } }),
    JSON.stringify({ devices: { "kiln-01": 5 } }),
    JSON.stringify({ devices: { "kiln-01": { gateway: "gw", min: "0" } } }),
    JSON.stringify({ devices: { "kiln-01": { gateway: "gw", min: 10, max: 10 } } }),
    JSON.stringify({ devices: { "kiln-01": { gateway: "gw", maxRatePerSec: 0 } } }),
    JSON.stringify({ devices: { "kiln-01": { min: 0 } } }),
  ];
  for (const t of bad) assert.throws(() => parseDevices(t), Error, t);
});

test("loadDevices: không có tệp -> danh bạ rỗng; có tệp -> đọc được", () => {
  assert.equal(loadDevices(path.join(os.tmpdir(), "khong-ton-tai-" + Date.now() + ".json")).size, 0);
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dev-")), "iot-devices.json");
  fs.writeFileSync(f, JSON.stringify({ devices: { a1: "gw" } }));
  assert.equal(loadDevices(f).get("a1").gateway, "gw");
});

test("danh bạ trong repo (config/iot-devices.json) hợp lệ, có thiết bị lò nung và gắn coop", () => {
  const m = loadDevices(path.join(__dirname, "..", "..", "..", "config", "iot-devices.json"));
  assert.ok(m.has("kiln-01"));
  assert.ok(m.get("kiln-01").max > m.get("kiln-01").min, "kiln-01 có khoảng giá trị hợp lý");
  assert.equal(m.get("kiln-01").coop, "htx-demo");
  assert.equal(m.get("dye-01").coop, "htx-lua");
});
