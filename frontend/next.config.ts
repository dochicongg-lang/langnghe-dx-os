// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Làng Nghề Số contributors
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  output: "standalone",
  cacheComponents: true,
  partialPrefetching: true,
  // Ẩn nút công cụ phát triển (N · Insight) ở góc màn hình khi chạy npm run dev; bản đóng gói vốn không có.
  devIndicators: false,
  // Tắt kiểm tra tự động "Instant Insight" ở chế độ dev (nó báo một cảnh báo kỹ thuật ở trang Sản phẩm, người dùng không cần thấy).
  experimental: { instantInsights: { validationLevel: "manual-warning" } },
  // Trang công khai (quét QR) gọi API cùng nguồn gốc với chính nó: Next chuyển tiếp /api/public/trace/* tới cổng gác APISIX.
  // Nhờ vậy điện thoại chỉ cần vào được cổng 3000 của máy chạy giao diện (không phải mở thêm cổng 9080 hay cấu hình CORS theo địa chỉ LAN).
  // PUBLIC_API_PROXY_TARGET: địa chỉ cổng gác nhìn từ máy chủ Next (mặc định http://localhost:9080).
  // Luồng đầu tiên: vào trang gốc "/" mà chưa từng đăng nhập (chưa có cookie dxos_session) thì máy chủ chuyển NGAY sang trang giới thiệu,
  // không phải chờ Keycloak kiểm tra phiên. Cookie do AuthProvider đặt sau khi đăng nhập thành công và xóa khi đăng xuất.
  async redirects() {
    return [{ source: "/", missing: [{ type: "cookie", key: "dxos_session" }], destination: "/gioi-thieu", permanent: false }];
  },
  async rewrites() {
    const target = process.env.PUBLIC_API_PROXY_TARGET ?? `http://localhost:${process.env.APISIX_GATEWAY_PORT ?? 9080}`;
    // Trang đăng nhập Keycloak đi qua cùng gốc với giao diện (người dùng chỉ thấy một địa chỉ, cổng 3000). Chỉ chuyển tiếp realm của hệ thống
    // và tài nguyên giao diện đăng nhập; trang quản trị Keycloak (/admin) và realm master KHÔNG được mở qua đường này.
    // KEYCLOAK_PROXY_TARGET: địa chỉ Keycloak nhìn từ máy chủ Next (mặc định http://localhost:8080).
    const kc = process.env.KEYCLOAK_PROXY_TARGET ?? `http://localhost:${process.env.KEYCLOAK_PORT ?? 8080}`;
    const realm = process.env.NEXT_PUBLIC_KEYCLOAK_REALM ?? process.env.KEYCLOAK_REALM ?? "dxos";
    return [
      { source: `/realms/${realm}/:path*`, destination: `${kc}/realms/${realm}/:path*` },
      { source: "/resources/:path*", destination: `${kc}/resources/:path*` },
      { source: "/api/:path*", destination: `${target}/api/:path*` },
    ];
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
