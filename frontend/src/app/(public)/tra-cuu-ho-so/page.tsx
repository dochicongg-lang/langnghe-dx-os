// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Làng Nghề Số contributors
"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import Logo from "@/components/Logo";
import { fmtDate } from "@/lib/trace";

interface PublicLookupResult {
  code: string;
  receipt_code: string;
  product_name: string;
  product_group_label: string;
  coop_name: string;
  state: string;
  created_at: string;
  updated_at: string;
  steps: { action: string; from_state: string | null; to_state: string; created_at: string }[];
  official_result: {
    stars: number;
    authority: string;
    decision_no: string;
    decided_at: string;
    valid_until: string | null;
    recognized: boolean;
  } | null;
}

const STATE_INFO: Record<string, { label: string; step: number; tone: string }> = {
  draft: { label: "Đang soạn hồ sơ nháp", step: 1, tone: "bg-stone-100 text-stone-700" },
  in_review: { label: "Đang chờ Hợp tác xã sơ duyệt", step: 2, tone: "bg-sky-50 text-sky-800" },
  needs_revision: { label: "Yêu cầu chủ thể bổ sung hồ sơ", step: 2, tone: "bg-amber-50 text-amber-800" },
  awaiting_result: { label: "Đã qua sơ duyệt · Chờ Hội đồng OCOP đánh giá", step: 3, tone: "bg-indigo-50 text-indigo-800" },
  recognized: { label: "Đã được công nhận OCOP chính thức", step: 4, tone: "bg-emerald-50 text-emerald-800" },
  not_recognized: { label: "Chưa đạt công nhận đợt này", step: 4, tone: "bg-stone-200 text-stone-800" },
  rejected: { label: "Không đạt sơ duyệt tại Hợp tác xã", step: 4, tone: "bg-red-50 text-red-800" },
};

const ACTION_LABELS: Record<string, string> = {
  create: "Khởi tạo hồ sơ trực tuyến",
  attach: "Bổ sung tài liệu minh chứng",
  detach: "Gỡ bớt tài liệu đính kèm",
  submit: "Nộp hồ sơ lên Hợp tác xã sơ duyệt",
  revise: "Hợp tác xã đề nghị bổ sung, hoàn thiện",
  approve: "Hợp tác xã sơ duyệt đạt, chuyển Hội đồng đánh giá",
  reject: "Hợp tác xã kết luận chưa đạt sơ duyệt",
  result: "Cơ quan có thẩm quyền ghi nhận kết quả chính thức",
};

const STAGES = ["Tiếp nhận hồ sơ", "HTX sơ duyệt", "Hội đồng đánh giá", "Kết quả chính thức"];

function ReceiptLookupInner() {
  const searchParams = useSearchParams();
  const initial = searchParams.get("q") ?? "";
  const [input, setInput] = useState(initial);
  const [data, setData] = useState<PublicLookupResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const lookup = useCallback(async (raw: string) => {
    const key = raw.trim();
    if (!key) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/public/trace/applications/lookup/${encodeURIComponent(key)}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "Không tìm thấy hồ sơ khớp với mã đã nhập.");
      setData(body as PublicLookupResult);
    } catch (e) {
      setData(null);
      setError(e instanceof Error ? e.message : "Lỗi không xác định");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!initial.trim()) return;
    const t = setTimeout(() => void lookup(initial), 0);
    return () => clearTimeout(t);
  }, [initial, lookup]);

  const info = data ? (STATE_INFO[data.state] ?? { label: data.state, step: 1, tone: "bg-stone-100 text-stone-700" }) : null;

  return (
    <main className="mx-auto max-w-4xl px-4 py-10">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-brand-700">Dịch vụ công trực tuyến · Không cần đăng nhập</p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight text-stone-900 sm:text-4xl">Tra cứu tiến độ hồ sơ OCOP</h1>
      <p className="mt-2 text-sm text-stone-600">
        Nhập <strong>Mã biên nhận</strong> (ví dụ: <code>BN-20261125-AB12</code>) hoặc <strong>Mã hồ sơ</strong> (<code>OCOP-...</code>) để kiểm tra trạng thái xử lý. Hệ thống bảo mật thông tin cá nhân và tài liệu nội bộ của chủ thể.
      </p>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void lookup(input);
        }}
        className="mt-6 flex flex-col gap-2 sm:flex-row"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Nhập mã biên nhận (BN-...) hoặc mã hồ sơ (OCOP-...)"
          aria-label="Mã biên nhận hồ sơ"
          className="min-w-0 flex-1 rounded-xl border border-stone-300 bg-white px-4 py-3 text-sm text-stone-900 outline-none focus:border-brand-500"
        />
        <button
          type="submit"
          disabled={loading || !input.trim()}
          className="rounded-xl bg-brand-600 px-6 py-3 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
        >
          {loading ? "Đang tra cứu…" : "Tra cứu biên nhận"}
        </button>
      </form>

      {error && (
        <div role="alert" className="mt-6 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          {error}
        </div>
      )}

      {data && info && (
        <section className="mt-8 space-y-6 rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-stone-100 pb-4">
            <div>
              <p className="font-mono text-xs text-stone-500">
                Mã biên nhận: <strong className="text-stone-800">{data.receipt_code}</strong> · Mã hồ sơ: {data.code}
              </p>
              <h2 className="mt-1 text-xl font-semibold text-stone-900">{data.product_name}</h2>
              <p className="mt-0.5 text-sm text-stone-600">
                Nhóm: {data.product_group_label} · Đơn vị tiếp nhận: {data.coop_name}
              </p>
            </div>
            <span className={`rounded-full px-3.5 py-1.5 text-xs font-semibold ${info.tone}`}>{info.label}</span>
          </div>

          <ol className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label="Các bước xử lý">
            {STAGES.map((label, idx) => {
              const stepNum = idx + 1;
              const done = stepNum < info.step || (info.step === 4 && stepNum === 4);
              const active = stepNum === info.step && info.step < 4;
              return (
                <li
                  key={label}
                  className={`rounded-xl border p-3 text-center text-xs ${
                    active ? "border-brand-400 bg-brand-50 font-semibold text-brand-900" : done ? "border-emerald-200 bg-emerald-50/70 font-medium text-emerald-900" : "border-stone-200 bg-stone-50 text-stone-500"
                  }`}
                >
                  <span className={`mx-auto mb-1 flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${active ? "bg-brand-600 text-white" : done ? "bg-emerald-600 text-white" : "bg-stone-200 text-stone-600"}`}>
                    {done ? "✓" : stepNum}
                  </span>
                  {label}
                </li>
              );
            })}
          </ol>

          {data.official_result && (
            <div className="rounded-xl border border-amber-200 bg-amber-50/70 p-4 text-sm">
              <p className="font-semibold text-stone-900">
                Kết quả chính thức: {data.official_result.recognized ? `Công nhận OCOP ${data.official_result.stars} sao` : "Chưa được công nhận"}
              </p>
              <p className="mt-1 text-xs text-stone-700">
                Cơ quan quyết định: {data.official_result.authority} · Số QĐ: {data.official_result.decision_no} ({data.official_result.decided_at})
                {data.official_result.valid_until ? ` · Hiệu lực đến: ${data.official_result.valid_until}` : ""}
              </p>
            </div>
          )}

          <div>
            <h3 className="text-sm font-semibold text-stone-800">Nhật ký mốc thời gian xử lý</h3>
            <ol className="mt-3 space-y-2 border-l-2 border-stone-200 pl-4 text-sm">
              {data.steps.map((s, idx) => (
                <li key={idx} className="text-stone-700">
                  <span className="font-medium text-stone-900">{ACTION_LABELS[s.action] ?? s.action}</span>
                  <span className="ml-2 text-xs text-stone-500">({fmtDate(s.created_at)})</span>
                </li>
              ))}
            </ol>
          </div>
        </section>
      )}
    </main>
  );
}

export default function ReceiptLookupPage() {
  return (
    <div className="min-h-screen bg-canvas text-stone-800">
      <header className="sticky top-0 z-30 border-b border-stone-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4">
          <Link href="/gioi-thieu" className="flex items-center gap-3">
            <Logo className="h-10 w-auto" />
          </Link>
          <nav className="flex items-center gap-3 text-sm font-medium">
            <Link href="/danh-ba" className="text-stone-600 hover:text-stone-900">
              Danh bạ sản phẩm
            </Link>
            <Link href="/gioi-thieu" className="text-stone-600 hover:text-stone-900">
              Giới thiệu
            </Link>
            <Link href="/vao" className="rounded-lg bg-brand-600 px-3.5 py-2 font-semibold text-white hover:bg-brand-700">
              Đăng nhập
            </Link>
          </nav>
        </div>
      </header>
      <Suspense fallback={<p className="p-10 text-center text-sm text-stone-500">Đang tải…</p>}>
        <ReceiptLookupInner />
      </Suspense>
    </div>
  );
}
