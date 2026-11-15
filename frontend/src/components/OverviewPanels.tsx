// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Làng Nghề Số contributors
"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import Card from "@/components/Card";
import EmptyState from "@/components/EmptyState";
import Pager, { usePaged } from "@/components/Pager";
import Tip from "@/components/Tip";
import type { Overview, OverviewRenewal, OverviewWaiting, VerdictCounts } from "@/lib/overview";
import { useSectors } from "@/lib/sectors";

const LEVEL = {
  late: { label: "Quá hạn", cls: "bg-red-50 text-red-700" },
  soon: { label: "Sắp hạn", cls: "bg-amber-50 text-amber-800" },
  waiting: { label: "Đang chờ", cls: "bg-stone-100 text-stone-700" },
} as const;

const VERDICTS: { key: keyof VerdictCounts; label: string; cls: string }[] = [
  { key: "ok", label: "Đạt", cls: "bg-emerald-500" },
  { key: "warn", label: "Cần xem lại", cls: "bg-amber-400" },
  { key: "alert", label: "Cần xem lại gấp", cls: "bg-red-500" },
  { key: "insufficient", label: "Chưa đủ dữ liệu", cls: "bg-stone-300" },
];

function Bar({ counts, total }: { counts: VerdictCounts; total: number }) {
  if (total === 0) return <div className="h-3 rounded-full bg-stone-100" />;
  return (
    <div className="flex h-3 overflow-hidden rounded-full bg-stone-100" role="img" aria-label={VERDICTS.map((v) => `${v.label}: ${counts[v.key]}`).join(", ")}>
      {VERDICTS.map((v) => (counts[v.key] > 0 ? <div key={v.key} className={v.cls} style={{ width: `${(counts[v.key] / total) * 100}%` }} /> : null))}
    </div>
  );
}

const coopName = (c: string | null) => c ?? "Chưa gắn HTX";
const fmtDate = (d: string) => new Date(d).toLocaleDateString("vi-VN");

function WaitingList({ items }: { items: OverviewWaiting[] }) {
  const paged = usePaged(items, 5);
  if (items.length === 0) return <EmptyState title="Không có hồ sơ nào chờ lâu" hint="Mọi hồ sơ đang trong thời hạn xử lý." />;
  return (
    <>
      <ul className="divide-y divide-stone-100">
        {paged.items.map((w) => (
          <li key={w.code} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3">
            <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${LEVEL[w.level].cls}`}>{LEVEL[w.level].label}</span>
            <Link href={`/ocop/${encodeURIComponent(w.code)}`} className="min-w-0 flex-1 font-medium text-stone-900 hover:underline">
              {w.name}
              <span className="ml-2 font-mono text-xs font-normal text-stone-400">{w.code}</span>
            </Link>
            <span className="text-sm text-stone-600">{w.text}</span>
            <span className="text-sm font-semibold text-stone-800">
              {w.days} {w.unit}
            </span>
          </li>
        ))}
      </ul>
      <Pager paged={paged} noun="hồ sơ" />
    </>
  );
}

function RenewalList({ items }: { items: OverviewRenewal[] }) {
  const paged = usePaged(items, 5);
  if (items.length === 0) return <EmptyState title="Chưa có kết quả nào sắp hết hiệu lực" hint="Hiện chưa có hồ sơ được công nhận hết hạn trong thời gian tới." />;
  return (
    <>
      <ul className="divide-y divide-stone-100">
        {paged.items.map((r) => (
          <li key={r.code} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3">
            <Link href={`/ocop/${encodeURIComponent(r.code)}`} className="min-w-0 flex-1 font-medium text-stone-900 hover:underline">
              {r.name}
            </Link>
            <span className="text-sm text-stone-600">Hết hiệu lực {fmtDate(r.valid_until)}</span>
            <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${r.daysLeft < 0 ? "bg-red-50 text-red-700" : r.daysLeft <= 120 ? "bg-amber-50 text-amber-800" : "bg-stone-100 text-stone-700"}`}>
              {r.daysLeft < 0 ? `Đã hết hạn ${-r.daysLeft} ngày` : `Còn ${r.daysLeft} ngày`}
            </span>
          </li>
        ))}
      </ul>
      <Pager paged={paged} noun="kết quả" />
    </>
  );
}

/**
 * Phần "Tình hình chung" của Trang chủ cho vai trò quản lý (quản trị, cán bộ OCOP, cán bộ HTX): hồ sơ chờ lâu, chất lượng mẻ nung/nhuộm,
 * kết quả OCOP sắp hết hiệu lực và (chỉ quản trị, cán bộ OCOP) bảng so sánh các HTX. Số hồ sơ theo trạng thái đã có ở bốn ô số của Trang chủ nên không lặp lại.
 */
export default function OverviewPanels() {
  const { apiFetch } = useAuth();
  const sectors = useSectors();
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch("/api/trace/overview")
      .then(async (res) => {
        if (!res.ok) throw new Error(`Hệ thống báo lỗi (mã ${res.status})`);
        setData((await res.json()) as Overview);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Lỗi không xác định"));
  }, [apiFetch]);

  const sectorLabel = (k: string) => sectors?.find((s) => s.key === k)?.label ?? k;
  const coops = data?.coops;

  return (
    <section aria-labelledby="chung-h" className="space-y-6">
      <h2 id="chung-h" className="text-base font-semibold text-stone-800">
        Tình hình chung {data ? (data.scope === "all" ? "của tất cả hợp tác xã" : "của hợp tác xã bạn") : ""}
      </h2>
      {error && <p className="text-sm text-red-600">Không tải được dữ liệu: {error}</p>}
      {!data && !error && <p className="text-sm text-stone-500">Đang tải…</p>}
      {data && (
        <>
          <div className="grid gap-6 lg:grid-cols-2">
            <Card title="Hồ sơ cần chú ý">
              <WaitingList items={data.waiting} />
            </Card>

            <Card title={`Mẻ nung, nhuộm trong ${data.quality.days} ngày gần nhất`}>
              {data.quality.total === 0 ? (
                <EmptyState title="Chưa có mẻ nào trong thời gian này" />
              ) : (
                <div className="space-y-4">
                  {Object.entries(data.quality.bySector).map(([k, c]) => (
                    <div key={k}>
                      <p className="mb-1 flex justify-between text-sm">
                        <span className="font-medium text-stone-800">{sectorLabel(k)}</span>
                        <span className="text-stone-500">{c.total} mẻ</span>
                      </p>
                      <Bar counts={c} total={c.total} />
                    </div>
                  ))}
                  <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-stone-500">
                    {VERDICTS.map((v) => (
                      <span key={v.key} className="inline-flex items-center gap-1.5">
                        <span aria-hidden="true" className={`inline-block h-2.5 w-2.5 rounded-full ${v.cls}`} />
                        {v.label}: {data.quality.byVerdict[v.key]}
                      </span>
                    ))}
                  </p>
                </div>
              )}
            </Card>
          </div>

          <Card title="Kết quả OCOP sắp hết hiệu lực">
            <RenewalList items={data.renewals} />
          </Card>

          {coops && (
            <Card title="So sánh các hợp tác xã">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="text-xs uppercase text-stone-500">
                    <tr>
                      <th className="pb-2">Hợp tác xã</th>
                      <th className="pb-2 text-right">Hồ sơ</th>
                      <th className="pb-2 text-right">Đã công nhận</th>
                      <th className="pb-2 text-right">
                        Quá hạn
                        <Tip text="Hồ sơ chờ HTX sơ duyệt quá hạn xử lý." />
                      </th>
                      <th className="pb-2 text-right">Mẻ gần đây</th>
                      <th className="pb-2 text-right">
                        Cần xem
                        <Tip text="Mẻ có kết luận Cần xem lại (kể cả mức gấp)." />
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-stone-100">
                    {coops.map((c) => (
                      <tr key={c.coop ?? "none"}>
                        <td className="py-2 font-medium text-stone-800">{coopName(c.coop)}</td>
                        <td className="py-2 text-right">{c.apps}</td>
                        <td className="py-2 text-right">{c.recognized}</td>
                        <td className={`py-2 text-right ${c.late ? "font-semibold text-red-700" : ""}`}>{c.late}</td>
                        <td className="py-2 text-right">{c.runs}</td>
                        <td className={`py-2 text-right ${c.attention ? "font-semibold text-amber-700" : ""}`}>{c.attention}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </>
      )}
    </section>
  );
}
