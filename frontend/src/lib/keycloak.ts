// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Làng Nghề Số contributors
import Keycloak from "keycloak-js";
import { config } from "./config";

let instance: Keycloak | null = null;
let initPromise: Promise<boolean> | null = null;

export function getKeycloak(): Keycloak {
  if (!instance) {
    instance = new Keycloak({
      url: config.keycloakUrl,
      realm: config.realm,
      clientId: config.clientId,
    });
  }
  return instance;
}

/**
 * Chỉ init một lần (React StrictMode gọi effect hai lần ở môi trường dev).
 * mode "check-sso": chỉ kiểm tra đã có phiên đăng nhập chưa, KHÔNG ép đăng nhập (dùng ở trang gốc để người chưa đăng nhập được đưa tới trang giới thiệu).
 * mode "login-required": mọi trang còn lại, chưa đăng nhập thì chuyển sang trang đăng nhập.
 */
export function initKeycloak(mode: "check-sso" | "login-required" = "login-required"): Promise<boolean> {
  if (!initPromise) {
    initPromise = getKeycloak().init({
      onLoad: mode,
      pkceMethod: "S256",
      checkLoginIframe: false,
    });
  }
  return initPromise;
}
