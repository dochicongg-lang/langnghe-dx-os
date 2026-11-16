// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Làng Nghề Số contributors
// Nút chỉ có biểu tượng (đăng nhập lại từ đầu, hiện/ẩn mật khẩu) đã có aria-label nhưng chưa có chú giải khi rê chuột: gắn title từ aria-label.
(function () {
  function label(root) {
    root.querySelectorAll("button[aria-label], a[aria-label]").forEach(function (el) {
      var t = el.getAttribute("aria-label");
      if (t && el.getAttribute("title") !== t) el.setAttribute("title", t);
    });
  }
  function start() {
    label(document);
    // nút hiện/ẩn mật khẩu đổi aria-label mỗi lần bấm
    new MutationObserver(function () { label(document); }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["aria-label"], childList: true });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
// Nền: ảnh hai nghệ nhân ở hai bên, ảnh phố làng nghề ở giữa hòa vào bằng mặt nạ gradient (không có đường cắt cứng). Thiếu ảnh thì chỉ còn gradient của trang.
(function () {
  function bg() {
    if (document.querySelector(".dx-bg")) return;
    var wrap = document.createElement("div");
    wrap.className = "dx-bg";
    wrap.setAttribute("aria-hidden", "true");
    for (var i = 1; i <= 3; i++) {
      var l = document.createElement("div");
      l.className = "dx-bg__layer dx-bg__layer--" + i;
      wrap.appendChild(l);
    }
    document.body.insertBefore(wrap, document.body.firstChild);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bg); else bg();
})();

// Chữ gợi ý (placeholder) trong ô tên đăng nhập và mật khẩu; nhãn phía trên giữ nguyên.
(function () {
  function ph() {
    var u = document.getElementById("username");
    if (u && !u.getAttribute("placeholder")) u.setAttribute("placeholder", "Nhập tên đăng nhập");
    var p = document.getElementById("password");
    if (p && !p.getAttribute("placeholder")) p.setAttribute("placeholder", "Nhập mật khẩu");
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ph); else ph();
})();

// Thông báo có hai câu: mỗi câu một dòng (câu ngắn thì không bị bẻ giữa chừng).
(function () {
  function split() {
    document.querySelectorAll("[id^=input-error], .pf-v5-c-alert__title").forEach(function (el) {
      if (el.getAttribute("data-split")) return;
      var txt = (el.textContent || "").trim();
      var m = txt.match(/^(.+?[.!?])\s+(.+[.!?])$/);
      if (!m) return;
      var target = el.querySelector(".pf-v5-c-helper-text__item-text") || el;
      if (target.children.length) return;
      target.textContent = "";
      [m[1], m[2]].forEach(function (s) {
        var d = document.createElement("span");
        d.style.display = "block";
        d.textContent = s;
        target.appendChild(d);
      });
      el.setAttribute("data-split", "1");
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", split); else split();
})();
