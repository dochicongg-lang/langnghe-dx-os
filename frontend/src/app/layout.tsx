// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Làng Nghề Số contributors
import AutoTitle from "@/components/AutoTitle";
import type { Metadata } from "next";
import { Geist_Mono, Playfair_Display, Source_Sans_3 } from "next/font/google";
import "./globals.css";

// Playfair Display: phông tiêu đề (h1-h3, viết hoa); Source Sans 3: phông nội dung, menu, nút, bảng (đủ dấu tiếng Việt, chữ nhỏ vẫn rõ); Geist Mono cho mã, khóa, số quyết định.
const playfair = Playfair_Display({
  variable: "--font-playfair",
  subsets: ["latin", "vietnamese"],
  weight: ["600", "700", "800"],
});

const sourceSans = Source_Sans_3({
  variable: "--font-source-sans",
  subsets: ["latin", "vietnamese"],
  weight: ["400", "500", "600", "700"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Làng Nghề Số",
  description: "Cổng dịch vụ làng nghề: truy xuất nguồn gốc và hồ sơ OCOP",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="vi" className={`${playfair.variable} ${sourceSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">
        {children}
        <AutoTitle />
      </body>
    </html>
  );
}
