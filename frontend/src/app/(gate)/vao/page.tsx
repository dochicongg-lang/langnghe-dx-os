// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Làng Nghề Số contributors
"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import AuthProvider from "@/components/AuthProvider";

/** Cổng vào ứng dụng từ trang giới thiệu: bắt đầu đăng nhập (nếu chưa), đăng nhập xong thì chuyển về trang chủ của ứng dụng. */
function Go() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/");
  }, [router]);
  return null;
}

export default function EnterPage() {
  return (
    <AuthProvider>
      <Go />
    </AuthProvider>
  );
}
