// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Làng Nghề Số contributors
"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Khối nội dung trượt nhẹ từ dưới lên và hiện dần khi cuộn tới (trang giới thiệu), để chuyển giữa các phần có cảm giác lướt.
 * Khi hệ điều hành bật "giảm chuyển động" thì hiện ngay, không trượt.
 */
export default function Reveal({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          setShown(true);
          io.disconnect();
        }
      },
      { threshold: 0.1, rootMargin: "0px 0px -8% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className={`transition-[opacity,transform] duration-[900ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:translate-y-0 motion-reduce:opacity-100 ${shown ? "translate-y-0 opacity-100" : "translate-y-10 opacity-0"} ${className}`}
    >
      {children}
    </div>
  );
}
