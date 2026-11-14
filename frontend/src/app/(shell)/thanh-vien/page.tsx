// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Làng Nghề Số contributors
"use client";

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import Card, { PageTitle } from "@/components/Card";
import EmptyState from "@/components/EmptyState";
import Pager, { usePaged } from "@/components/Pager";
import QrCode from "@/components/QrCode";
import Tip from "@/components/Tip";
import { inviteStatusLabels, type Invitation, type MembersData } from "@/lib/members";
import { roleLabels, visibleRoles } from "@/lib/roles";

const inputCls = "w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100";
const fmt = (d: string) => new Date(d).toLocaleString("vi-VN", { dateStyle: "short", timeStyle: "short" });
const STATUS_CLS: Record<Invitation["status"], string> = {
  pending: "bg-amber-50 text-amber-800",
  accepted: "bg-emerald-50 text-emerald-700",
  revoked: "bg-stone-100 text-stone-600",
  expired: "bg-stone-100 text-stone-600",
};

export default function MembersPage() {
  const { apiFetch } = useAuth();
  const [data, setData] = useState<MembersData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [role, setRole] = useState("");
  const [coop, setCoop] = useState("");
  const [note, setNote] = useState("");
  const [fresh, setFresh] = useState<Invitation | null>(null); // lời mời vừa tạo, còn hiện liên kết
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch("/api/trace/members");
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((body as { error?: string }).error ?? `Hệ thống báo lỗi (mã ${res.status})`);
      setData(body as MembersData);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Lỗi không xác định");
    }
  }, [apiFetch]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);

  const picked = data?.invitable.find((r) => r.role === (role || data.invitable[0]?.role));
  const effRole = picked?.role ?? "";
  const effCoop = data?.scope === "coop" ? (data.coops[0]?.code ?? "") : coop || data?.coops[0]?.code || "";

  async function act(path: string, method = "POST") {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(path, { method });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((body as { error?: string }).error ?? `Hệ thống báo lỗi (mã ${res.status})`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Lỗi không xác định");
    } finally {
      setBusy(false);
    }
  }

  async function onInvite(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setFormError(null);
    setFresh(null);
    try {
      const res = await apiFetch("/api/trace/members/invitations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: effRole, coop: picked?.needs_coop ? effCoop : undefined, note }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((body as { error?: string }).error ?? `Hệ thống báo lỗi (mã ${res.status})`);
      setFresh(body as Invitation);
      setNote("");
      setCopied(false);
      await load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Lỗi không xác định");
    } finally {
      setBusy(false);
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  const invs = usePaged(data?.invitations ?? [], 5);
  const people = usePaged(data?.members ?? [], 10);

  return (
    <div className="mx-auto max-w-6xl">
      <PageTitle title="Thành viên" desc={data?.scope === "all" ? "Mời người dùng mới và quản lý tài khoản của tất cả hợp tác xã." : "Mời nghệ nhân vào hợp tác xã của bạn và quản lý tài khoản của họ."} />
      {error && <p className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      {!data && !error && <p className="text-sm text-stone-500">Đang tải…</p>}
      {data && (
        <div className="space-y-6">
          <Card title="Mời thành viên mới">
            <form onSubmit={onInvite} className="grid gap-3 md:grid-cols-3">
              <label className="block text-sm">
                <span className="mb-1 block text-stone-600">
                  Vai trò *<Tip text="Quyền của người được mời. Vai trò cán bộ chỉ quản trị mời được." />
                </span>
                <select className={inputCls} value={effRole} onChange={(e) => setRole(e.target.value)}>
                  {data.invitable.map((r) => (
                    <option key={r.role} value={r.role}>
                      {roleLabels[r.role] ?? r.role}
                    </option>
                  ))}
                </select>
              </label>
              {picked?.needs_coop && (
                <label className="block text-sm">
                  <span className="mb-1 block text-stone-600">Hợp tác xã *</span>
                  {data.scope === "coop" ? (
                    <p className="rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-stone-800">{data.coops[0]?.name ?? data.coops[0]?.code}</p>
                  ) : (
                    <select className={inputCls} value={effCoop} onChange={(e) => setCoop(e.target.value)}>
                      {data.coops.map((c) => (
                        <option key={c.code} value={c.code}>
                          {c.name} ({c.code})
                        </option>
                      ))}
                    </select>
                  )}
                </label>
              )}
              <label className="block text-sm">
                <span className="mb-1 block text-stone-600">Ghi chú (ví dụ tên người được mời)</span>
                <input className={inputCls} value={note} maxLength={120} onChange={(e) => setNote(e.target.value)} placeholder="Nghệ nhân Nguyễn Thị Lan" />
              </label>
              <p className="text-xs text-stone-500 md:col-span-3">{picked?.desc}</p>
              {formError && <p className="text-sm text-red-600 md:col-span-3">{formError}</p>}
              <div className="md:col-span-3">
                <button type="submit" disabled={busy || !effRole} className="rounded-lg bg-brand-600 px-5 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">
                  {busy ? "Đang tạo…" : "Tạo liên kết mời"}
                </button>
              </div>
            </form>

            {fresh?.link && (
              <div className="mt-5 grid gap-5 rounded-xl border border-emerald-200 bg-emerald-50/60 p-4 md:grid-cols-[1fr_auto]">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-emerald-800">Đã tạo lời mời cho {roleLabels[fresh.role] ?? fresh.role}</p>
                  <p className="mt-1 text-xs text-stone-600">Gửi liên kết này cho người được mời (Zalo, tin nhắn...). Họ tự đặt tên đăng nhập và mật khẩu, bạn không cần biết mật khẩu. Liên kết dùng được một lần, hết hạn lúc {fmt(fresh.expires_at)}.</p>
                  <div className="mt-3 flex gap-2">
                    <input readOnly value={fresh.link} onFocus={(e) => e.target.select()} className={`${inputCls} font-mono text-xs`} aria-label="Liên kết mời" />
                    <button type="button" onClick={() => void copy(fresh.link ?? "")} className="shrink-0 rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-stone-700 hover:bg-stone-50">
                      {copied ? "Đã chép" : "Sao chép"}
                    </button>
                  </div>
                  <p className="mt-2 text-xs font-medium text-amber-700">Liên kết chỉ hiện một lần. Rời trang này là không xem lại được; nếu lỡ mất, hãy thu hồi và tạo lời mời mới.</p>
                </div>
                <div className="w-40">
                  <QrCode url={fresh.link} filename={`moi-${fresh.id}`} />
                </div>
              </div>
            )}
          </Card>

          <Card title="Lời mời đã tạo">
            {data.invitations.length === 0 ? (
              <EmptyState title="Chưa có lời mời nào" hint="Tạo lời mời ở phía trên để thêm thành viên." />
            ) : (
              <>
                <ul className="divide-y divide-stone-100">
                  {invs.items.map((i) => (
                    <li key={i.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3 text-sm">
                      <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_CLS[i.status]}`}>{inviteStatusLabels[i.status]}</span>
                      <span className="font-medium text-stone-900">{roleLabels[i.role] ?? i.role}</span>
                      {i.coop && <span className="text-stone-500">{i.coop}</span>}
                      {i.note && <span className="text-stone-600">· {i.note}</span>}
                      <span className="ml-auto text-xs text-stone-500">
                        {i.status === "accepted" ? `${i.accepted_username} nhận lúc ${fmt(i.accepted_at ?? i.created_at)}` : i.status === "pending" ? `Hết hạn ${fmt(i.expires_at)}` : `Tạo ${fmt(i.created_at)}`} · bởi {i.invited_by}
                      </span>
                      {i.status === "pending" && (
                        <button type="button" disabled={busy} onClick={() => void act(`/api/trace/members/invitations/${i.id}/revoke`)} className="rounded-lg border border-stone-300 px-2.5 py-1 text-xs font-medium text-stone-700 hover:bg-stone-50 disabled:opacity-50">
                          Thu hồi
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
                <Pager paged={invs} noun="lời mời" />
              </>
            )}
          </Card>

          <Card title="Thành viên hiện có">
            {data.members.length === 0 ? (
              <EmptyState title="Chưa có thành viên" />
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="text-xs uppercase text-stone-500">
                      <tr>
                        <th className="pb-2">Tên</th>
                        <th className="pb-2">Tài khoản</th>
                        <th className="pb-2">Vai trò</th>
                        <th className="pb-2">HTX</th>
                        <th className="pb-2">Trạng thái</th>
                        <th className="pb-2" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-stone-100">
                      {people.items.map((m) => (
                        <tr key={m.username}>
                          <td className="py-2 font-medium text-stone-900">{m.name}</td>
                          <td className="py-2 font-mono text-xs text-stone-600">{m.username}</td>
                          <td className="py-2 text-stone-700">{visibleRoles(m.roles).join(", ") || "—"}</td>
                          <td className="py-2 text-stone-600">{m.coop ?? "—"}</td>
                          <td className="py-2">
                            <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${m.enabled ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"}`}>{m.enabled ? "Đang dùng" : "Đã khóa"}</span>
                          </td>
                          <td className="py-2 text-right">
                            {m.can_manage && (
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => {
                                  if (m.enabled && !window.confirm(`Khóa tài khoản ${m.username}? Người này sẽ bị đăng xuất và không đăng nhập được cho đến khi mở khóa.`)) return;
                                  void act(`/api/trace/members/${encodeURIComponent(m.username)}/${m.enabled ? "lock" : "unlock"}`);
                                }}
                                className="rounded-lg border border-stone-300 px-2.5 py-1 text-xs font-medium text-stone-700 hover:bg-stone-50 disabled:opacity-50"
                              >
                                {m.enabled ? "Khóa" : "Mở khóa"}
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <Pager paged={people} noun="thành viên" />
              </>
            )}
            <p className="mt-3 text-xs text-stone-500">Khóa là tạm dừng, không xóa: hồ sơ và nhật ký cũ vẫn còn đúng người. Tài khoản cán bộ HTX bắt buộc cài ứng dụng xác thực (OTP) ở lần đăng nhập đầu.</p>
          </Card>
        </div>
      )}
    </div>
  );
}
