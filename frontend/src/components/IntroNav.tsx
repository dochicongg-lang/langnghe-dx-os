// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Làng Nghề Số contributors
"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const ITEMS: [string, string][] = [
  ["gia-tri", "Giá trị"],
  ["cach-hoat-dong", "Cách hoạt động"],
  ["nghe", "Các nghề"],
  ["danh-cho-ai", "Dành cho ai"],
  ["cam-ket", "Cam kết"],
];


const HEADER = 64; // chiều cao thanh menu dính
const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/**
 * Lướt tới vị trí `to` bằng hiệu ứng tự viết (không phụ thuộc cuộn mượt của trình duyệt): có đà lúc bắt đầu và lúc dừng, quãng càng xa càng lâu.
 * Người dùng tự cuộn chuột, chạm hoặc bấm phím giữa chừng thì dừng ngay. Chuyển động ngắn do chính người dùng bấm nên chạy cả khi bật giảm chuyển động.
 * Trả về hàm hủy.
 */
function glideTo(to: number, onDone: () => void): () => void {
  const from = window.scrollY;
  const duration = Math.min(1400, 650 + Math.abs(to - from) * 0.28);
  const t0 = performance.now();
  let raf = 0;
  const cancel = () => {
    cancelAnimationFrame(raf);
    window.removeEventListener("wheel", cancel);
    window.removeEventListener("touchstart", cancel);
    window.removeEventListener("keydown", cancel);
  };
  window.addEventListener("wheel", cancel, { passive: true });
  window.addEventListener("touchstart", cancel, { passive: true });
  window.addEventListener("keydown", cancel);
  const step = (now: number) => {
    const k = Math.min(1, (now - t0) / duration);
    window.scrollTo(0, from + (to - from) * easeInOutCubic(k));
    if (k < 1) raf = requestAnimationFrame(step);
    else {
      cancel();
      onDone();
    }
  };
  raf = requestAnimationFrame(step);
  return cancel;
}

const PAD = 14; // gạch chân ngắn hơn chữ mỗi bên một đoạn cho gọn

/**
 * Thanh menu của trang giới thiệu.
 * - MỘT thanh gạch chân trượt mượt tới mục đang được trỏ chuột (đen), thả chuột ra thì trượt về mục đang xem (màu thương hiệu).
 * - Mục nào đang nằm ở giữa màn hình thì sáng lên: biết mình đang xem phần nào.
 * - Bấm vào mục thì trang lướt mượt tới phần đó.
 */
export default function IntroNav() {
  const [active, setActive] = useState("");
  const [hover, setHover] = useState("");
  const [bar, setBar] = useState({ x: 0, w: 0, show: false });
  const links = useRef<Record<string, HTMLAnchorElement | null>>({});
  const nav = useRef<HTMLElement>(null);
  const state = useRef({ active: "", hover: "" });

  // Đặt thanh gạch chân dưới mục `id` (không có mục thì mờ đi, giữ nguyên vị trí cũ để lần sau trượt từ đó).
  const place = useCallback((id: string) => {
    const el = id ? links.current[id] : null;
    setBar((b) => (el ? { x: el.offsetLeft + PAD, w: Math.max(0, el.offsetWidth - PAD * 2), show: true } : { ...b, show: false }));
  }, []);
  const refresh = useCallback(() => place(state.current.hover || state.current.active), [place]);

  useEffect(() => {
    const seen = new Map<string, boolean>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) seen.set(e.target.id, e.isIntersecting);
        // phần đang nằm ở dải giữa màn hình; nếu nhiều phần cùng chạm thì lấy phần đầu theo thứ tự trang
        const next = ITEMS.find(([id]) => seen.get(id))?.[0] ?? "";
        state.current.active = next;
        setActive(next);
        refresh();
      },
      { rootMargin: "-40% 0px -55% 0px" },
    );
    for (const [id] of ITEMS) {
      const el = document.getElementById(id);
      if (el) io.observe(el);
    }
    // đo lại khi đổi kích thước (phông tải xong, đổi cỡ cửa sổ)
    const ro = new ResizeObserver(refresh);
    if (nav.current) ro.observe(nav.current);
    return () => {
      io.disconnect();
      ro.disconnect();
    };
  }, [refresh]);

  const cancelGlide = useRef<() => void>(() => {});
  const go = (e: React.MouseEvent, id: string) => {
    const el = document.getElementById(id);
    if (!el) return;
    e.preventDefault();
    cancelGlide.current();
    const to = Math.max(0, Math.min(el.getBoundingClientRect().top + window.scrollY - HEADER, document.documentElement.scrollHeight - window.innerHeight));
    cancelGlide.current = glideTo(to, () => history.replaceState(null, "", `#${id}`));
  };

  const hovering = hover && hover !== active; // đang trỏ vào mục khác mục đang xem: gạch chân đen, ngược lại màu thương hiệu

  return (
    <nav ref={nav} aria-label="Các mục trang giới thiệu" className="relative hidden h-full items-stretch md:flex" onMouseLeave={() => { state.current.hover = ""; setHover(""); refresh(); }}>
      {ITEMS.map(([id, label]) => {
        const on = active === id;
        const pointed = hover === id;
        return (
          <a
            key={id}
            ref={(el) => {
              links.current[id] = el;
            }}
            href={`#${id}`}
            aria-current={on ? "true" : undefined}
            onClick={(e) => go(e, id)}
            onMouseEnter={() => { state.current.hover = id; setHover(id); refresh(); }}
            onFocus={() => { state.current.hover = id; setHover(id); refresh(); }}
            onBlur={() => { state.current.hover = ""; setHover(""); refresh(); }}
            className={`keep-motion flex items-center px-[15px] font-display text-[13px] font-semibold uppercase tracking-[0.08em] transition-colors duration-300 ${on ? "text-brand-700" : pointed ? "text-stone-900" : "text-stone-600"}`}
          >
            {label}
          </a>
        );
      })}
      <span
        aria-hidden="true"
        className={`keep-motion pointer-events-none absolute bottom-0 left-0 h-0.5 rounded-full transition-[transform,width,background-color,opacity] duration-500 ease-[cubic-bezier(0.65,0,0.35,1)] ${bar.show ? "opacity-100" : "opacity-0"} ${hovering ? "bg-stone-900" : "bg-brand-600"}`}
        style={{ width: bar.w, transform: `translateX(${bar.x}px)` }}
      />
    </nav>
  );
}
