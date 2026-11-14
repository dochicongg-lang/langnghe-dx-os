// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Làng Nghề Số contributors
"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import Logo from "@/components/Logo";
import { roleLabels } from "@/lib/roles";
import type { InviteInfo } from "@/lib/members";

const inputCls = "w-full rounded-lg border border-stone-300 bg-white px-3 py-2.5 text-sm text-stone-900 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100";

function Accept() {
  const { token } = useParams<{ token: string }>();
  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [f, setF] = useState({ full_name: "", username: "", email: "", password: "", again: "" });

  useEffect(() => {
    fetch(`/api/public/invite/${encodeURIComponent(token)}`)
      .then(async (r) => setInfo(r.ok ? ((await r.json()) as InviteInfo) : { valid: false }))
      .catch(() => setInfo({ valid: false }));
  }, [token]);

  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF((s) => ({ ...s, [k]: e.target.value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (f.password !== f.again) return setError("Hai lần nhập mật khẩu chưa giống nhau.");
    setBusy(true);
    try {
      const res = await fetch(`/api/public/invite/${encodeURIComponent(token)}/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ full_name: f.full_name, username: f.username, email: f.email, password: f.password }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((body as { error?: string }).error ?? `Hệ thống báo lỗi (mã ${res.status})`);
      setDone((body as { username: string }).username);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Lỗi không xác định");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas px-4 py-10">
      <div className="w-full max-w-md rounded-2xl border border-stone-200 bg-white p-6 shadow-sm sm:p-8">
        <Logo className="mx-auto mb-4 h-16 w-auto" />
        {!info && <p className="text-center text-sm text-stone-500">Đang kiểm tra lời mời…</p>}

        {info && !info.valid && !done && (
          <div className="text-center">
            <h1 className="text-lg font-semibold text-stone-900">Lời mời không dùng được</h1>
            <p className="mt-2 text-sm text-stone-600">Liên kết này đã được dùng, đã hết hạn, đã bị thu hồi hoặc nhập sai. Hãy nhờ người đã mời bạn gửi lại một liên kết mới.</p>
            <Link href="/" className="mt-5 inline-block rounded-lg bg-brand-600 px-5 py-2 text-sm font-semibold text-white hover:bg-brand-700">
              Về trang đăng nhập
            </Link>
          </div>
        )}

        {done && (
          <div className="text-center">
            <h1 className="text-lg font-semibold text-emerald-700">Đã tạo tài khoản</h1>
            <p className="mt-2 text-sm text-stone-600">
              Tên đăng nhập của bạn là <span className="font-mono font-semibold text-stone-900">{done}</span>. Hãy đăng nhập bằng mật khẩu vừa đặt.
              {info?.mfa ? " Lần đầu đăng nhập, hệ thống sẽ yêu cầu bạn cài ứng dụng xác thực trên điện thoại (OTP)." : ""}
            </p>
            <Link href="/" className="mt-5 inline-block rounded-lg bg-brand-600 px-5 py-2 text-sm font-semibold text-white hover:bg-brand-700">
              Đăng nhập
            </Link>
          </div>
        )}

        {info?.valid && !done && (
          <form onSubmit={submit} className="space-y-3">
            <div className="text-center">
              <h1 className="text-lg font-semibold text-stone-900">Bạn được mời tham gia</h1>
              <p className="mt-1 text-sm text-stone-600">
                Vai trò <span className="font-medium text-stone-900">{roleLabels[info.role ?? ""] ?? info.role}</span>
                {info.coop_name || info.coop ? (
                  <>
                    {" "}
                    tại <span className="font-medium text-stone-900">{info.coop_name ?? info.coop}</span>
                  </>
                ) : null}
              </p>
            </div>
            <label className="block text-sm">
              <span className="mb-1 block text-stone-600">Họ và tên *</span>
              <input className={inputCls} required minLength={2} maxLength={80} value={f.full_name} onChange={set("full_name")} autoComplete="name" />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-stone-600">Tên đăng nhập *</span>
              <input className={inputCls} required minLength={3} maxLength={30} value={f.username} onChange={set("username")} autoComplete="username" autoCapitalize="none" placeholder="nguyenlan" />
              <span className="mt-1 block text-xs text-stone-500">Chữ thường không dấu, số, dấu chấm hoặc gạch; bắt đầu bằng chữ.</span>
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-stone-600">Email (không bắt buộc)</span>
              <input className={inputCls} type="email" value={f.email} onChange={set("email")} autoComplete="email" />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-stone-600">Mật khẩu *</span>
              <input className={inputCls} type="password" required minLength={8} maxLength={128} value={f.password} onChange={set("password")} autoComplete="new-password" />
              <span className="mt-1 block text-xs text-stone-500">Ít nhất 8 ký tự, không chứa tên đăng nhập. Chỉ mình bạn biết mật khẩu này.</span>
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-stone-600">Nhập lại mật khẩu *</span>
              <input className={inputCls} type="password" required value={f.again} onChange={set("again")} autoComplete="new-password" />
            </label>
            {error && <p className="rounded-lg bg-red-50 p-2.5 text-sm text-red-700">{error}</p>}
            <button type="submit" disabled={busy} className="w-full rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">
              {busy ? "Đang tạo tài khoản…" : "Tạo tài khoản"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

export default function InvitePage() {
  return (
    <Suspense fallback={<p className="p-10 text-center text-sm text-stone-500">Đang tải…</p>}>
      <Accept />
    </Suspense>
  );
}
