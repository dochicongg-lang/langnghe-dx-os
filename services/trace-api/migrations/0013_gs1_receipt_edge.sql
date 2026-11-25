-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 The Làng Nghề Số contributors
-- P2: Mã GTIN (TCVN 13274:2020 / GS1 Digital Link) cho sản phẩm và mã biên nhận tra cứu công khai cho hồ sơ OCOP. Chỉ THÊM cột nullable.

ALTER TABLE products ADD COLUMN IF NOT EXISTS gtin TEXT;
CREATE INDEX IF NOT EXISTS idx_products_gtin ON products(gtin) WHERE gtin IS NOT NULL;

ALTER TABLE ocop_applications ADD COLUMN IF NOT EXISTS receipt_code TEXT;
UPDATE ocop_applications SET receipt_code = 'BN-' || substring(code from 6) WHERE receipt_code IS NULL AND code LIKE 'OCOP-%';
CREATE UNIQUE INDEX IF NOT EXISTS idx_ocop_app_receipt ON ocop_applications(lower(receipt_code)) WHERE receipt_code IS NOT NULL;
