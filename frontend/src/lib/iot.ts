// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Làng Nghề Số contributors
export interface Reading {
  deviceId: string;
  deviceName: string;
  metric: string;
  value: number;
  unit: string;
  timestamp: string;
}

export interface Series {
  id: string; // deviceId/metric
  deviceName: string;
  metric: string;
  unit: string;
  points: { t: number; v: number }[]; // sắp xếp theo thời gian
}

export interface BoardConfig {
  id: string;
  sectorKey: string;
  sectorLabel: string;
  profileId: string;
  prefix: string;
  metric: string;
  unit: string;
  scaleMax: number;
  ticks: number[];
  ref: {
    peakMin: number;
    peakMax: number;
    critical: number;
    holdAbove: number;
    holdMinutes: number;
    rampMaxPerHour: number;
  };
  nearBand: number;
  rampFrom: number;
  rampWindowMin: number;
  cold: { last: number; peak: number };
  labels: {
    phases: [string, string, string, string];
    total: string;
    recent: string;
    aria: string;
    device: string;
    peakNote: string;
    note: string;
  };
}

export type ApiFetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Tải cấu hình động các bảng giám sát cảm biến theo ngành từ `trace-api`. */
export async function fetchIotConfig(apiFetch: ApiFetch): Promise<{ boards: BoardConfig[]; devices: { id: string; coop: string | null }[] }> {
  const res = await apiFetch("/api/trace/iot/config");
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error ?? `Không tải được cấu hình cảm biến (mã ${res.status})`);
  return body as { boards: BoardConfig[]; devices: { id: string; coop: string | null }[] };
}

/**
 * Đọc số liệu cảm biến gần nhất qua API nội bộ `/api/trace/iot/readings` (đi qua APISIX + JWT Keycloak,
 * máy chủ đọc MinIO bằng tài khoản chỉ-đọc và lọc theo đúng HTX của người dùng).
 */
export async function fetchReadings(apiFetch: ApiFetch, maxDays = 6): Promise<{ readings: Reading[]; objects: number }> {
  const res = await apiFetch(`/api/trace/iot/readings?days=${maxDays}`);
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error ?? `Không đọc được dữ liệu cảm biến (mã ${res.status})`);
  return body as { readings: Reading[]; objects: number };
}

export function toSeries(readings: Reading[]): Series[] {
  const map = new Map<string, Series>();
  for (const r of readings) {
    const id = `${r.deviceId}/${r.metric}`;
    let s = map.get(id);
    if (!s) {
      s = { id, deviceName: r.deviceName, metric: r.metric, unit: r.unit, points: [] };
      map.set(id, s);
    }
    s.points.push({ t: Date.parse(r.timestamp), v: r.value });
  }
  for (const s of map.values()) s.points.sort((a, b) => a.t - b.t);
  return Array.from(map.values());
}

/** Giữ lại đợt đo gần nhất của một chuỗi: tách đợt khi hai điểm liền nhau cách quá `gapMs` (mặc định 3 giờ). */
export function latestBatch(s: Series, gapMs = 3 * 3600_000): Series {
  let start = 0;
  for (let i = 1; i < s.points.length; i++) if (s.points[i].t - s.points[i - 1].t > gapMs) start = i;
  return start === 0 ? s : { ...s, points: s.points.slice(start) };
}
