// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Làng Nghề Số contributors
"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Trang Tổng quan đã gộp vào Trang chủ (phần "Tình hình chung"); giữ đường dẫn cũ để liên kết đã lưu vẫn dùng được. */
export default function OverviewMovedPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/");
  }, [router]);
  return <p className="text-sm text-stone-500">Đang chuyển về Trang chủ…</p>;
}
