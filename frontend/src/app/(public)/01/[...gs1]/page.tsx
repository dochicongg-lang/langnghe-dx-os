// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Làng Nghề Số contributors
"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

/**
 * Trang giải mã đường dẫn chuẩn TCVN 13274:2020 / GS1 Digital Link:
 *   `/01/<GTIN>[/10/<Batch>][/21/<Serial>]`
 * Tự động xác thực chữ số kiểm tra Mod-10 qua máy chủ và chuyển đến trang câu chuyện xác thực sản phẩm.
 */
function Gs1ResolverInner() {
  const params = useParams<{ gs1: string[] }>();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const segments = Array.isArray(params.gs1) ? params.gs1 : [params.gs1];
    const path = segments.map(encodeURIComponent).join("/");
    fetch(`/api/public/trace/01/${path}`)
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error ?? `Không giải mã được GS1 Digital Link (mã ${res.status})`);
        if (!cancelled && body.code) {
          router.replace(`/verify/${encodeURIComponent(body.code)}`);
        }
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "Đường dẫn GS1 không hợp lệ"));
    return () => {
      cancelled = true;
    };
  }, [params.gs1, router]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas p-6 text-center">
      <div className="max-w-md rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-widest text-brand-700">TCVN 13274:2020 · GS1 Digital Link</p>
        {!error ? (
          <p className="mt-3 text-sm text-stone-600">Đang kiểm tra mã GTIN-14 và chuyển tới hồ sơ truy xuất sản phẩm…</p>
        ) : (
          <>
            <p className="mt-3 text-sm font-medium text-red-700">{error}</p>
            <Link href="/danh-ba" className="mt-4 inline-block rounded-lg bg-brand-600 px-4 py-2 text-xs font-semibold text-white hover:bg-brand-700">
              Mở danh bạ sản phẩm công khai
            </Link>
          </>
        )}
      </div>
    </div>
  );
}

export default function Gs1DigitalLinkPage() {
  return (
    <Suspense fallback={<p className="p-10 text-center text-sm text-stone-500">Đang giải mã GS1 Digital Link…</p>}>
      <Gs1ResolverInner />
    </Suspense>
  );
}
