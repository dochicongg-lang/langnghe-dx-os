-- Mời thành viên: lời mời một lần, có hạn. Chỉ lưu BĂM của mã trong liên kết (không lưu mã gốc), nên ai đọc được cơ sở dữ liệu cũng không dựng lại được liên kết.
-- Chỉ thêm bảng mới. Trạng thái "hết hạn" tính lúc đọc từ expires_at, không lưu.
CREATE TABLE IF NOT EXISTS invitations (
  id            BIGSERIAL PRIMARY KEY,
  token_hash    TEXT NOT NULL UNIQUE,
  role          TEXT NOT NULL,
  coop          TEXT,                              -- mã HTX (null với vai trò không thuộc HTX)
  note          TEXT,                              -- ghi chú của người mời (ví dụ tên người được mời)
  invited_by    TEXT NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'revoked')),
  accepted_username TEXT,
  accepted_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_invitations_coop ON invitations (coop, created_at DESC);
