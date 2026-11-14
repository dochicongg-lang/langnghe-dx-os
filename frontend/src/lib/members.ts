// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Làng Nghề Số contributors
export interface InvitableRole {
  role: string;
  desc: string;
  needs_coop: boolean;
}
export interface Invitation {
  id: number;
  role: string;
  coop: string | null;
  note: string | null;
  invited_by: string;
  status: "pending" | "accepted" | "revoked" | "expired";
  created_at: string;
  expires_at: string;
  accepted_username: string | null;
  accepted_at: string | null;
  link?: string; // chỉ có ngay lúc tạo, máy chủ không lưu mã gốc
}
export interface Member {
  username: string;
  name: string;
  coop: string | null;
  roles: string[];
  enabled: boolean;
  created_at: string | null;
  can_manage: boolean;
}
export interface MembersData {
  scope: "all" | "coop";
  coops: { code: string; name: string }[];
  invitable: InvitableRole[];
  invitations: Invitation[];
  members: Member[];
}
export interface InviteInfo {
  valid: boolean;
  role?: string;
  role_desc?: string;
  coop?: string | null;
  coop_name?: string | null;
  expires_at?: string;
  mfa?: boolean;
}

export const inviteStatusLabels: Record<Invitation["status"], string> = {
  pending: "Đang chờ",
  accepted: "Đã nhận",
  revoked: "Đã thu hồi",
  expired: "Hết hạn",
};
