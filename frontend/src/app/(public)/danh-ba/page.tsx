// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Làng Nghề Số contributors
"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import Logo from "@/components/Logo";
import ProductImage from "@/components/ProductImage";

interface DirectoryItem {
  code: string;
  gtin: string;
  digital_link: string;
  name: string;
  category: string;
  sector: string;
  sector_label: string;
  village: string;
  artisan: string;
  event_count: number;
  has_iot: boolean;
  ocop_stars: number | null;
}

interface DirectoryResponse {
  sectors: { key: string; label: string }[];
  villages: string[];
  total: number;
  items: DirectoryItem[];
}

export default function PublicDirectoryPage() {
  const [q, setQ] = useState("");
  const [sector, setSector] = useState("");
  const [village, setVillage] = useState("");
  const [stars, setStars] = useState("");
  const [data, setData] = useState<DirectoryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams();
    if (q.trim()) params.set("q", q.trim());
    if (sector) params.set("sector", sector);
    if (village) params.set("village", village);
    if (stars) params.set("stars", stars);
    const qs = params.toString();

    const timer = setTimeout(() => {
      fetch(`/api/public/trace/directory${qs ? `?${qs}` : ""}`)
        .then(async (res) => {
          const body = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(body.error ?? `Lỗi tải danh bạ (${res.status})`);
          if (!cancelled) {
            setData(body as DirectoryResponse);
            setError(null);
          }
        })
        .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "Lỗi không xác định"));
    }, 150);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [q, sector, village, stars]);

  return (
    <div className="min-h-screen bg-canvas text-stone-800">
      <header className="sticky top-0 z-30 border-b border-stone-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4">
          <Link href="/gioi-thieu" className="flex items-center gap-3">
            <Logo className="h-10 w-auto" />
          </Link>
          <nav className="flex items-center gap-3 text-sm font-medium">
            <Link href="/gioi-thieu" className="text-stone-600 hover:text-stone-900">
              Giới thiệu
            </Link>
            <Link href="/tra-cuu-ho-so" className="text-stone-600 hover:text-stone-900">
              Tra cứu hồ sơ OCOP
            </Link>
            <Link href="/vao" className="rounded-lg bg-brand-600 px-3.5 py-2 font-semibold text-white hover:bg-brand-700">
              Đăng nhập
            </Link>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-10">
        <div className="mb-8">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-brand-700">Cổng Truy xuất nguồn gốc &amp; OCOP công khai</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-stone-900 sm:text-4xl">Danh bạ sản phẩm làng nghề</h1>
          <p className="mt-2 max-w-2xl text-sm text-stone-600">
            Tra cứu sản phẩm làng nghề theo ngành nghề, địa phương và hạng sao OCOP chính thức. Mỗi sản phẩm hỗ trợ định danh chuẩn quốc gia TCVN 13274:2020 (GS1 Digital Link) và xuất sự kiện EPCIS 2.0.
          </p>
        </div>

        <section aria-label="Bộ lọc danh bạ" className="mb-8 grid gap-3 rounded-2xl border border-stone-200 bg-white p-4 shadow-sm sm:grid-cols-2 lg:grid-cols-4">
          <label className="block text-xs font-medium text-stone-600">
            Từ khóa / Mã / GTIN
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Tên sản phẩm, mã, nghệ nhân…"
              className="mt-1 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900 outline-none focus:border-brand-500"
            />
          </label>
          <label className="block text-xs font-medium text-stone-600">
            Ngành nghề
            <select
              value={sector}
              onChange={(e) => setSector(e.target.value)}
              className="mt-1 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900 outline-none focus:border-brand-500"
            >
              <option value="">Tất cả ngành nghề</option>
              {(data?.sectors ?? []).map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs font-medium text-stone-600">
            Địa phương / Làng nghề
            <select
              value={village}
              onChange={(e) => setVillage(e.target.value)}
              className="mt-1 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900 outline-none focus:border-brand-500"
            >
              <option value="">Tất cả địa phương</option>
              {(data?.villages ?? []).map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs font-medium text-stone-600">
            Chứng nhận OCOP chính thức
            <select
              value={stars}
              onChange={(e) => setStars(e.target.value)}
              className="mt-1 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900 outline-none focus:border-brand-500"
            >
              <option value="">Mọi sản phẩm</option>
              <option value="3">Từ 3 sao trở lên</option>
              <option value="4">Từ 4 sao trở lên</option>
              <option value="5">5 sao cấp quốc gia</option>
            </select>
          </label>
        </section>

        {error && <p className="mb-6 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">{error}</p>}

        {!data && !error && <p className="text-sm text-stone-500">Đang tải danh bạ sản phẩm…</p>}

        {data && (
          <>
            <p className="mb-4 text-sm text-stone-600">
              Tìm thấy <strong>{data.total}</strong> sản phẩm công bố.
            </p>
            {data.items.length === 0 ? (
              <div className="rounded-2xl border border-stone-200 bg-white p-8 text-center text-sm text-stone-500">
                Không có sản phẩm nào khớp bộ lọc hiện tại.
              </div>
            ) : (
              <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
                {data.items.map((item) => (
                  <article key={item.code} className="flex flex-col overflow-hidden rounded-2xl border border-stone-200 bg-white shadow-sm transition hover:shadow-md">
                    <ProductImage category={item.category} seed={item.code} className="h-40 w-full" />
                    <div className="flex flex-1 flex-col p-5">
                      <div className="flex flex-wrap items-center gap-1.5 text-xs">
                        <span className="rounded-full bg-stone-100 px-2.5 py-0.5 font-medium text-stone-700">{item.sector_label}</span>
                        {item.ocop_stars && (
                          <span className="rounded-full bg-amber-100 px-2.5 py-0.5 font-semibold text-amber-900">
                            ★ OCOP {item.ocop_stars} sao
                          </span>
                        )}
                        {item.has_iot && (
                          <span className="rounded-full bg-emerald-50 px-2.5 py-0.5 font-medium text-emerald-700">
                            ✓ Cảm biến IoT
                          </span>
                        )}
                      </div>
                      <h2 className="mt-2.5 text-lg font-semibold text-stone-900">
                        <Link href={`/verify/${encodeURIComponent(item.code)}`} className="hover:text-brand-700 hover:underline">
                          {item.name}
                        </Link>
                      </h2>
                      <p className="mt-1 text-xs text-stone-600">{item.village || "Chưa ghi địa phương"}</p>
                      {item.artisan && <p className="text-xs text-stone-500">Chủ thể: {item.artisan}</p>}
                      <p className="mt-2 font-mono text-[11px] text-stone-400">
                        Mã: {item.code} · GTIN: {item.gtin}
                      </p>
                      <div className="mt-auto flex items-center justify-between border-t border-stone-100 pt-3 text-xs font-medium">
                        <Link href={`/verify/${encodeURIComponent(item.code)}`} className="text-brand-700 hover:underline">
                          Xem hành trình ({item.event_count} bước) →
                        </Link>
                        <a href={`/api/public/trace/${encodeURIComponent(item.code)}/epcis`} target="_blank" rel="noreferrer" className="text-stone-500 hover:text-stone-800">
                          EPCIS 2.0
                        </a>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
