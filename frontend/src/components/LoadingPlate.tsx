// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Làng Nghề Số contributors
"use client";

import { useEffect, useState } from "react";

// Ảnh nền màn hình chờ (ảnh có bản quyền của tác giả, chỉ giữ cục bộ, không đưa lên kho mã; thiếu ảnh thì còn lại nền gradient)
const PHOTOS = ["/photos/loading-1.webp", "/photos/loading-2.webp", "/photos/loading-3.webp", "/photos/loading-4.webp"];

/** Màn hình chờ: đĩa gốm xoay chậm có nhịp, nền là các ảnh làng nghề đổi nhau bằng một đường sáng quét chéo, chạy cùng nhịp với vòng xoay của đĩa (mỗi vòng đĩa đổi một ảnh). */
export default function LoadingPlate({ label = "Đang xác thực…" }: { label?: string }) {
  // Thứ tự ảnh được xáo mỗi lần mở (để không lần nào cũng bắt đầu bằng cùng một ảnh); chọn sau khi trang đã dựng để không lệch giữa máy chủ và trình duyệt
  const [order, setOrder] = useState<number[] | null>(null);
  const [cur, setCur] = useState(0);
  const [scanning, setScanning] = useState(false);
  const next = (cur + 1) % PHOTOS.length;

  useEffect(() => {
    const t = setTimeout(() => {
      const o = PHOTOS.map((_, i) => i);
      for (let i = o.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [o[i], o[j]] = [o[j], o[i]];
      }
      setOrder(o);
    }, 0);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    PHOTOS.forEach((src) => {
      const img = new Image();
      img.src = src;
    });
  }, []);

  const petals = Array.from({ length: 8 }, (_, i) => i * 45);
  const dots = Array.from({ length: 24 }, (_, i) => i * 15);
  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden bg-canvas p-6">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-[radial-gradient(900px_420px_at_85%_-10%,var(--color-brand-100),transparent_60%),radial-gradient(700px_420px_at_-10%_110%,#f5ebe0,transparent_55%)]" />
      {/* Mỗi ảnh là một lớp riêng, khóa theo số thứ tự: ảnh mới lộ ra rồi chính lớp đó trở thành ảnh nền (không đổi ảnh của một lớp đang hiện), nên không bị chớp khi quét xong */}
      {order && (scanning ? [cur, next] : [cur]).map((i) => {
        const revealing = scanning && i === next;
        return (
          <div
            key={i}
            aria-hidden="true"
            className={`loading-photo absolute inset-0 bg-cover bg-center ${revealing ? "loading-reveal keep-motion" : ""}`}
            style={{ backgroundImage: `url(${PHOTOS[order[i]]})` }}
            onAnimationEnd={
              revealing
                ? () => {
                    setCur(next);
                    setScanning(false);
                  }
                : undefined
            }
          />
        );
      })}
      {scanning && <div key={`l${cur}`} aria-hidden="true" className="loading-scan keep-motion" />}
      {/* màn phủ kem: dịu màu ảnh, giữ cho đĩa và chữ luôn đọc được */}
      <div aria-hidden="true" className="absolute inset-0 bg-[#faf6ef]/70" />
      <div className="relative flex flex-col items-center">
        <div className="plate-shadow rounded-full">
          <svg viewBox="0 0 100 100" className="plate-spin keep-motion h-28 w-28" onAnimationIteration={() => setScanning(true)} aria-hidden="true">
            <circle cx="50" cy="50" r="48" fill="#fbf4ea" stroke="#9a3f1c" strokeWidth="1.6" />
            <circle cx="50" cy="50" r="43" fill="none" stroke="#c0562a" strokeWidth="0.8" />
            {dots.map((a) => (
              <circle key={a} cx="50" cy="9.5" r={a === 0 ? 2.2 : 1} fill={a === 0 ? "#b4301c" : "#c0562a"} transform={`rotate(${a} 50 50)`} />
            ))}
            <circle cx="50" cy="50" r="33" fill="none" stroke="#9a3f1c" strokeWidth="1.2" />
            {petals.map((a) => (
              <path key={a} d="M50 50 C44 40 44 28 50 21 C56 28 56 40 50 50Z" fill="#c0562a" fillOpacity="0.9" transform={`rotate(${a} 50 50)`} />
            ))}
            {petals.map((a) => (
              <path key={`s${a}`} d="M50 50 C47.5 44 47.5 38 50 34 C52.5 38 52.5 44 50 50Z" fill="#fbf4ea" transform={`rotate(${a + 22.5} 50 50)`} />
            ))}
            <circle cx="50" cy="50" r="6" fill="#fbf4ea" stroke="#9a3f1c" strokeWidth="1.2" />
            <circle cx="50" cy="50" r="2.2" fill="#9a3f1c" />
          </svg>
        </div>
        <p className="mt-6 rounded-full bg-white/90 px-5 py-2 text-sm font-semibold text-stone-800 shadow-md ring-1 ring-brand-200" role="status">
          {label}
        </p>
      </div>
    </div>
  );
}
