// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Làng Nghề Số contributors
"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import Card from "./Card";
import { useAuth } from "./AuthProvider";
import Pager, { usePaged } from "./Pager";
import { VerdictBadge } from "./KilnInsight";
import type { KilnInsight, KilnVerdict } from "@/lib/trace";

interface Run {
  product_code: string;
  product_name: string;
  at: string;
  device_id: string;
  from: string;
  to: string;
  peak: number;
  unit: string;
  insight: KilnInsight;
}
interface Overview {
  profile: { name: string; verified: boolean; note: string } | null;
  summary: Record<"total" | KilnVerdict, number>;
  runs: Run[];
}

type Filter = "all" | "attention" | "ok" | "insufficient";

// "Cần xem lại" gồm cả mẻ lệch chuẩn (warn) và mẻ vượt ngưỡng nguy hiểm (alert: nhãn "gấp", màu đỏ), vì với người dùng cả hai đều là việc phải xem.
const inFilter = (f: Filter, v: KilnVerdict) => f === "all" || (f === "attention" ? v === "warn" || v === "alert" : v === f);

const TILES: [Filter, string][] = [
  ["all", "Tất cả"],
  ["attention", "Cần xem lại"],
  ["ok", "Đạt chuẩn"],
  ["insufficient", "Chưa đủ dữ liệu"],
];

const fmt = (iso: string) => new Date(iso).toLocaleString("vi-VN", { dateStyle: "short", timeStyle: "short" });

/** Tổng hợp phân tích thông minh các mẻ nung và nhuộm mà người dùng được xem: bấm vào thẻ số để lọc, mẻ cần xem hiện trước kèm lý do. */
export default function KilnInsights() {
  const { apiFetch } = useAuth();
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");

  const load = useCallback(async () => {
    try {
      const res = await apiFetch("/api/trace/insights/kilns");
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `Hệ thống báo lỗi (mã ${res.status})`);
      setData(body as Overview);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Lỗi không xác định");
    }
  }, [apiFetch]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);

  const order: Record<KilnVerdict, number> = { alert: 0, warn: 1, insufficient: 2, ok: 3 };
  const runs = data ? [...data.runs].sort((a, b) => order[a.insight.verdict] - order[b.insight.verdict] || Date.parse(b.at) - Date.parse(a.at)) : [];
  const shown = runs.filter((r) => inFilter(filter, r.insight.verdict));
  const count = (f: Filter) => runs.filter((r) => inFilter(f, r.insight.verdict)).length;

  const paged = usePaged(shown, 5, filter);

  return (
    <Card title="Phân tích thông minh các mẻ nung và mẻ nhuộm">
      {error && (
        <p className="text-sm text-red-600" role="alert">
          Không tải được: {error}
        </p>
      )}
      {!error && !data && <p className="text-sm text-stone-500">Đang tải…</p>}
      {data && (
        <>
          <div role="group" aria-label="Lọc theo kết luận" className="mt-3 grid grid-cols-2 gap-2 text-center sm:grid-cols-4">
            {TILES.map(([k, label]) => {
              const on = filter === k;
              return (
                <button
                  key={k}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setFilter(k)}
                  className={`rounded-lg border py-2 transition-colors ${on ? "border-brand-500 bg-brand-50 ring-1 ring-brand-500" : "border-transparent bg-stone-50 hover:border-stone-300 hover:bg-white"}`}
                >
                  <span className={`block text-xs ${on ? "font-semibold text-brand-700" : "text-stone-500"}`}>{label}</span>
                  <span className="block text-2xl font-bold text-stone-900">{count(k)}</span>
                </button>
              );
            })}
          </div>
          {runs.length === 0 ? (
            <p className="mt-4 text-sm text-stone-500">Chưa có công đoạn nung hoặc nhuộm nào gắn dữ liệu cảm biến trong phạm vi bạn được xem.</p>
          ) : shown.length === 0 ? (
            <p className="mt-4 text-sm text-stone-500">Không có mẻ nào thuộc nhóm này.</p>
          ) : (
            <ul className="mt-4 divide-y divide-stone-100">
              {paged.items.map((r) => {
                const notable = r.insight.findings.filter((f) => f.level === "alert" || f.level === "warn");
                return (
                  <li key={`${r.product_code}-${r.at}`} className="py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <VerdictBadge verdict={r.insight.verdict} />
                      <Link href={`/trace/${encodeURIComponent(r.product_code)}`} className="text-sm font-medium text-brand-700 hover:underline">
                        {r.product_name}
                      </Link>
                      <span className="font-mono text-xs text-stone-500">{r.product_code}</span>
                    </div>
                    <p className="mt-1 text-xs text-stone-500">
                      {r.device_id} · đỉnh {r.peak} {r.unit} · {fmt(r.from)} → {fmt(r.to)}
                    </p>
                    {notable.length > 0 ? (
                      <ul className="mt-1 space-y-0.5 text-xs text-stone-700">
                        {notable.slice(0, 3).map((f) => (
                          <li key={f.code}>
                            <span aria-hidden="true">{f.level === "alert" ? "⛔ " : "⚠ "}</span>
                            {f.text}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-1 text-xs text-stone-600">{r.insight.summary}</p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          <Pager paged={paged} noun="mẻ" />
        </>
      )}
    </Card>
  );
}
