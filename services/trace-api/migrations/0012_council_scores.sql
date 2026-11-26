-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 The Làng Nghề Số contributors
-- Phiếu chấm điểm độc lập của từng thành viên Hội đồng OCOP (kết nối Parallel Multi-Instance BPMN). Chỉ THÊM bảng.

CREATE TABLE IF NOT EXISTS ocop_council_scores (
  id              SERIAL PRIMARY KEY,
  application_id  INTEGER NOT NULL REFERENCES ocop_applications(id),
  member_username TEXT NOT NULL,
  member_name     TEXT NOT NULL DEFAULT '',
  scores          JSONB NOT NULL,
  total           NUMERIC(5,2) NOT NULL,
  comment         TEXT NOT NULL DEFAULT '',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (application_id, member_username)
);

CREATE INDEX IF NOT EXISTS idx_ocop_council_app ON ocop_council_scores(application_id, id);
