// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Làng Nghề Số contributors
"use strict";
const crypto = require("node:crypto");
const { HttpError, send, sendBinary, readJson, readBuffer, getUser, str } = require("../http-util");

const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9-]{2,39}$/;

/** Tuyến hồ sơ OCOP: quy trình Flowable (timer + hội đồng multi-instance), tệp đính kèm, chấm điểm hội đồng và xuất biên bản PDF. */
function createOcopRoutes(ctx) {
  const { getPool, access, ACCESS, requirePermission, ocop, OCOP, flowable, docsS3, attachments, scanner, scanRequired, pdf } = ctx;

  const APP_COLS = `a.id, a.code, a.profile, a.product_code, a.product_name, a.product_group, a.description, a.owner_username AS owner,
    c.code AS coop, a.state, a.self_score, a.documents, a.flowable_instance, a.created_at, a.updated_at`;

  const appResource = (a) => ({ owner: a.owner, coop: a.coop });
  const attachmentView = (r) => ({ id: r.id, doc_key: r.doc_key, filename: r.filename, content_type: r.content_type, size: r.size, sha256: r.sha256, uploaded_by: r.uploaded_by, created_at: r.created_at });

  async function findApplicationRow(code, db = getPool(), lock = false) {
    const { rows } = await db.query(
      `SELECT ${APP_COLS} FROM ocop_applications a LEFT JOIN cooperatives c ON c.id = a.coop_id WHERE lower(a.code) = lower($1)${lock ? " FOR UPDATE OF a" : ""}`,
      [code],
    );
    return rows[0] ?? null;
  }

  function profileView(profileId) {
    const p = ocop.getProfile(OCOP, profileId);
    const { id, name, effectiveFrom, verified, sourceNote, legalBasis, authority, scoring, validityMonths, renewalWindowDays, communeReviewWorkingDays, rounds, groups, subjectTypes, checklist } = p;
    return { id, name, effectiveFrom, verified, sourceNote, legalBasis, authority, scoring, validityMonths, renewalWindowDays, communeReviewWorkingDays, rounds, groups, subjectTypes, checklist };
  }

  async function listApplications(user) {
    const scope = access.scopeFor(ACCESS, user.roles, "application.read");
    if (!scope) throw new HttpError(403, "Vai trò của bạn không có quyền xem hồ sơ OCOP");
    if (scope === "coop" && !user.coop) return [];
    const where = scope === "all" ? "" : scope === "coop" ? "WHERE c.code = $1" : "WHERE a.owner_username = $1";
    const { rows } = await getPool().query(
      `SELECT ${APP_COLS}, (SELECT stars FROM ocop_results r WHERE r.application_id = a.id ORDER BY r.id DESC LIMIT 1) AS stars
       FROM ocop_applications a LEFT JOIN cooperatives c ON c.id = a.coop_id ${where} ORDER BY a.updated_at DESC`,
      scope === "all" ? [] : [scope === "coop" ? user.coop : user.name],
    );
    return rows.map((r) => ({ ...r, flowable_instance: undefined }));
  }

  async function getCouncilState(a, profile) {
    const { rows: scores } = await getPool().query(
      "SELECT member_username, member_name, scores, total::float AS total, comment, updated_at FROM ocop_council_scores WHERE application_id = $1 ORDER BY id",
      [a.id],
    );
    const minQuorum = profile.authority?.minQuorum ?? 3;
    const summary = ocop.aggregateCouncilScores(profile, scores, minQuorum);
    return { scores, summary };
  }

  async function getApplication(code, user) {
    const a = await findApplicationRow(code);
    if (!a || !access.authorize(ACCESS, user, "application.read", appResource(a))) throw new HttpError(404, "Không tìm thấy hồ sơ");
    const pool = getPool();
    const profile = ocop.getProfile(OCOP, a.profile);
    const hist = await pool.query("SELECT action, from_state, to_state, actor, note, created_at FROM ocop_application_history WHERE application_id = $1 ORDER BY id", [a.id]);
    const resRows = await pool.query(
      "SELECT score, stars, authority, decision_no, decided_at::text AS decided_at, valid_until::text AS valid_until, recognized, recorded_by, created_at FROM ocop_results WHERE application_id = $1 ORDER BY id DESC",
      [a.id],
    );
    const attRows = await pool.query(
      "SELECT id, doc_key, filename, content_type, size, sha256, uploaded_by, created_at FROM application_attachments WHERE application_id = $1 AND removed_at IS NULL ORDER BY id",
      [a.id],
    );
    let expected = null;
    if (a.self_score) {
      try {
        const t = ocop.scoreTotals(profile, a.self_score);
        expected = { ...t, stars: ocop.starsFor(profile, t.total) };
      } catch {
        expected = null;
      }
    }
    const actions = ocop.actionsFrom(a.state).filter((act) => access.authorize(ACCESS, user, ocop.TRANSITIONS[act].permission, appResource(a)));
    let openTask = null;
    if (flowable && a.flowable_instance && !["rejected", "recognized", "not_recognized"].includes(a.state)) {
      try {
        openTask = await flowable.openTask(a.flowable_instance);
      } catch (e) {
        console.error("[trace-api] không đọc được nhiệm vụ Flowable:", e.message);
      }
    }
    const council = await getCouncilState(a, profile);
    const { flowable_instance: _omit, ...app } = a;
    return {
      ...app,
      checklist: ocop.checklistFor(profile, a.product_group),
      missing_documents: ocop.missingRequired(profile, a.product_group, a.documents),
      expected,
      council,
      result: resRows.rows[0] ?? null,
      results: resRows.rows,
      attachments: attRows.rows.map(attachmentView),
      attachment_rules: { maxBytes: profile.attachments.maxBytes, maxPerApplication: profile.attachments.maxPerApplication, types: profile.attachments.types, enabled: Boolean(docsS3) },
      history: hist.rows,
      actions,
      can_update: access.authorize(ACCESS, user, "application.update", appResource(a)) && ["draft", "needs_revision"].includes(a.state),
      open_task: openTask,
      disclaimer: "Hạng sao ở bước tự chấm chỉ là DỰ KIẾN. Kết quả OCOP chính thức do cơ quan có thẩm quyền quyết định.",
    };
  }

  function parseAppFields(body, profile, { partial = false } = {}) {
    const out = {};
    if (!partial || body.product_name !== undefined) out.product_name = str(body.product_name, 200, "product_name", true);
    if (!partial || body.product_group !== undefined) {
      out.product_group = str(body.product_group, 60, "product_group", true);
      if (!profile.groups.some((g) => g.key === out.product_group)) throw new HttpError(400, `Nhóm sản phẩm không hợp lệ. Hợp lệ: ${profile.groups.map((g) => g.key).join(", ")}`);
    }
    if (body.description !== undefined) out.description = str(body.description, 2000, "description");
    if (body.product_code !== undefined) {
      out.product_code = str(body.product_code, 40, "product_code") || null;
      if (out.product_code && !CODE_RE.test(out.product_code)) throw new HttpError(400, "Mã sản phẩm truy xuất không hợp lệ");
    }
    if (body.self_score !== undefined && body.self_score !== null) {
      try {
        out.self_score = ocop.scoreTotals(profile, body.self_score).parts;
      } catch (e) {
        throw new HttpError(400, e.message);
      }
    }
    if (body.documents !== undefined) {
      if (!Array.isArray(body.documents)) throw new HttpError(400, "documents phải là danh sách khóa giấy tờ");
      const valid = new Set(profile.checklist.map((c) => c.key));
      const bad = body.documents.filter((k) => !valid.has(k));
      if (bad.length) throw new HttpError(400, `Giấy tờ không có trong danh mục: ${bad.join(", ")}`);
      out.documents = [...new Set(body.documents)];
    }
    return out;
  }

  async function createApplication(body, user) {
    requirePermission(user, "application.create", { coop: user.coop });
    const pool = getPool();
    const profile = ocop.getProfile(OCOP);
    const f = parseAppFields(body, profile);
    const scope = access.scopeFor(ACCESS, user.roles, "application.create");
    const coopCode = scope === "all" ? str(body.coop, 60, "coop") || user.coop : user.coop;
    let coopId = null;
    if (coopCode) {
      const c = await pool.query("SELECT id FROM cooperatives WHERE code = $1", [coopCode]);
      if (!c.rows.length) throw new HttpError(400, `Không có HTX mã "${coopCode}"`);
      coopId = c.rows[0].id;
    }
    const code = `OCOP-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        `INSERT INTO ocop_applications (code, profile, product_code, product_name, product_group, description, owner_username, coop_id, self_score, documents)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [code, profile.id, f.product_code ?? null, f.product_name, f.product_group, f.description ?? "", user.name, coopId, f.self_score ?? null, JSON.stringify(f.documents ?? [])],
      );
      await client.query("INSERT INTO ocop_application_history (application_id, action, from_state, to_state, actor, note) VALUES ($1,'create',NULL,'draft',$2,'')", [rows[0].id, user.name]);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
    return getApplication(code, user);
  }

  async function updateApplication(code, body, user) {
    const a = await findApplicationRow(code);
    if (!a || !access.authorize(ACCESS, user, "application.read", appResource(a))) throw new HttpError(404, "Không tìm thấy hồ sơ");
    requirePermission(user, "application.update", appResource(a));
    if (!["draft", "needs_revision"].includes(a.state)) throw new HttpError(409, `Hồ sơ đang ở trạng thái "${a.state}", không sửa được`);
    const f = parseAppFields(body, ocop.getProfile(OCOP, a.profile), { partial: true });
    const sets = [];
    const vals = [];
    for (const [k, v] of Object.entries(f)) {
      vals.push(k === "documents" ? JSON.stringify(v) : v);
      sets.push(`${k} = $${vals.length}`);
    }
    if (sets.length) {
      vals.push(a.id);
      await getPool().query(`UPDATE ocop_applications SET ${sets.join(", ")}, updated_at = now() WHERE id = $${vals.length}`, vals);
    }
    return getApplication(code, user);
  }

  function parseResult(body, profile) {
    const score = Number(body.score);
    if (!Number.isFinite(score) || score < 0 || score > profile.scoring.maxTotal) throw new HttpError(400, `Điểm chính thức phải từ 0 đến ${profile.scoring.maxTotal}`);
    const stars = ocop.starsFor(profile, Math.round(score * 100) / 100);
    if (!stars) throw new HttpError(400, "Điểm không rơi vào khoảng hạng sao nào của cấu hình");
    const decisionNo = str(body.decision_no, 100, "decision_no", true);
    const decidedAt = str(body.decided_at, 10, "decided_at", true);
    const d = new Date(`${decidedAt}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(decidedAt) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== decidedAt) throw new HttpError(400, "decided_at phải là ngày hợp lệ dạng YYYY-MM-DD");
    if (d.getTime() > Date.now() + 86400000) throw new HttpError(400, "Ngày quyết định không được ở tương lai");
    const recognized = stars >= profile.scoring.minStarsRecognized;
    const authority = str(body.authority, 300, "authority") || ocop.authorityFor(profile, stars) || profile.authority.star3and4;
    return { score: Math.round(score * 100) / 100, stars, decisionNo, decidedAt, recognized, authority, validUntil: recognized ? ocop.validUntil(profile, decidedAt) : null };
  }

  async function applicationAction(code, body, user) {
    const peek = await findApplicationRow(code);
    if (!peek || !access.authorize(ACCESS, user, "application.read", appResource(peek))) throw new HttpError(404, "Không tìm thấy hồ sơ");
    if (!flowable) throw new HttpError(503, "Chưa cấu hình Flowable cho trace-api (FLOWABLE_URL)");
    const action = str(body.action, 20, "action", true);
    const note = str(body.note, 1000, "note");
    const profile = ocop.getProfile(OCOP, peek.profile);
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      const a = await findApplicationRow(code, client, true);
      const t = ocop.transition(a.state, action, {});
      if (!t.ok) throw new HttpError(409, t.error);
      requirePermission(user, t.permission, appResource(a));
      let to = t.to;
      let instance = a.flowable_instance;
      let result = null;
      if (action === "submit") {
        if (!a.self_score) throw new HttpError(400, "Cần tự chấm điểm (các phần A, B, C) trước khi nộp");
        const missing = ocop.missingRequired(profile, a.product_group, a.documents);
        if (missing.length) throw new HttpError(400, `Còn thiếu giấy tờ bắt buộc: ${missing.join(", ")}`);
      }
      if ((action === "revise" || action === "reject") && !note) throw new HttpError(400, "Cần ghi lý do (note) khi yêu cầu bổ sung hoặc không đạt");
      if (action === "result") {
        result = parseResult(body, profile);
        to = ocop.transition(a.state, action, { recognized: result.recognized }).to;
      }
      try {
        if (action === "submit") {
          if (a.state === "draft") instance = await flowable.start(a.code, { applicant: a.owner, coop: a.coop ?? "", profile: a.profile });
          else await flowable.complete(instance, "reviseByApplicant");
        } else {
          const councilMembers = Array.isArray(body.council_members) ? body.council_members.map((x) => String(x).trim()).filter(Boolean) : [];
          const vars = t.decision
            ? {
                decision: t.decision,
                reviewer: user.name,
                councilMembers,
                minQuorum: Math.max(1, Math.min(councilMembers.length || 1, Number(body.min_quorum ?? (councilMembers.length || 1)))),
              }
            : { recognized: result.recognized, recordedBy: user.name };
          await flowable.complete(instance, t.task, vars);
        }
      } catch (e) {
        console.error("[trace-api] lỗi Flowable:", e.message);
        throw new HttpError(502, "Không điều khiển được quy trình trong Flowable, hồ sơ giữ nguyên trạng thái");
      }
      await client.query("UPDATE ocop_applications SET state = $1, flowable_instance = $2, updated_at = now() WHERE id = $3", [to, instance, a.id]);
      await client.query("INSERT INTO ocop_application_history (application_id, action, from_state, to_state, actor, note) VALUES ($1,$2,$3,$4,$5,$6)", [a.id, action, a.state, to, user.name, note]);
      if (result) {
        await client.query(
          "INSERT INTO ocop_results (application_id, score, stars, authority, decision_no, decided_at, valid_until, recognized, recorded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
          [a.id, result.score, result.stars, result.authority, result.decisionNo, result.decidedAt, result.validUntil, result.recognized, user.name],
        );
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    return getApplication(code, user);
  }

  async function submitCouncilScore(code, body, user) {
    const a = await findApplicationRow(code);
    if (!a || !access.authorize(ACCESS, user, "application.read", appResource(a))) throw new HttpError(404, "Không tìm thấy hồ sơ");
    requirePermission(user, "application.decide", appResource(a));
    if (a.state !== "awaiting_result") throw new HttpError(409, "Hồ sơ chưa ở giai đoạn Hội đồng OCOP đánh giá");
    const profile = ocop.getProfile(OCOP, a.profile);
    let scored;
    try {
      scored = ocop.scoreTotals(profile, body?.parts);
    } catch (e) {
      throw new HttpError(400, e.message);
    }
    const comment = str(body?.comment, 1000, "comment");
    const memberName = str(body?.member_name, 120, "member_name") || user.name;
    await getPool().query(
      `INSERT INTO ocop_council_scores (application_id, member_username, member_name, scores, total, comment)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (application_id, member_username)
       DO UPDATE SET member_name = EXCLUDED.member_name, scores = EXCLUDED.scores, total = EXCLUDED.total, comment = EXCLUDED.comment, updated_at = now()`,
      [a.id, user.name, memberName, JSON.stringify(scored.parts), scored.total, comment],
    );
    if (flowable && a.flowable_instance && typeof flowable.openTasks === "function") {
      try {
        const tasks = await flowable.openTasks(a.flowable_instance);
        const mine = tasks.find((t) => t.key === "councilScoring" && t.assignee === user.name);
        if (mine) await flowable.completeTaskId(mine.id, { councilScore: scored.total });
      } catch (e) {
        console.error("[trace-api] lỗi hoàn thành task Hội đồng:", e.message);
      }
    }
    const state = await getCouncilState(a, profile);
    return { score: { member_username: user.name, member_name: memberName, scores: scored.parts, total: scored.total, comment }, ...state };
  }

  async function minutesPdf(code, user, res) {
    const a = await findApplicationRow(code);
    if (!a || !access.authorize(ACCESS, user, "application.read", appResource(a))) throw new HttpError(404, "Không tìm thấy hồ sơ");
    const profile = ocop.getProfile(OCOP, a.profile);
    const { scores, summary } = await getCouncilState(a, profile);
    const resRows = await getPool().query(
      "SELECT score, stars, authority, decision_no, decided_at::text AS decided_at, valid_until::text AS valid_until, recognized FROM ocop_results WHERE application_id = $1 ORDER BY id DESC LIMIT 1",
      [a.id],
    );
    const { buffer, sha256 } = pdf.buildMinutesPdf({ application: a, profile, councilSummary: summary, scores, result: resRows.rows[0] ?? null });
    sendBinary(res, 200, buffer, {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="bien-ban-ocop-${a.code}.pdf"`,
      "x-sha256": sha256,
      "cache-control": "private, no-store",
    });
  }

  async function readBufferWrapped(req, limit) {
    return readBuffer(req, limit);
  }

  async function loadWritableApplication(code, user) {
    const a = await findApplicationRow(code);
    if (!a || !access.authorize(ACCESS, user, "application.read", appResource(a))) throw new HttpError(404, "Không tìm thấy hồ sơ");
    requirePermission(user, "application.update", appResource(a));
    if (!["draft", "needs_revision"].includes(a.state)) throw new HttpError(409, `Hồ sơ đang ở trạng thái "${a.state}", không đổi được tệp đính kèm`);
    if (!docsS3) throw new HttpError(503, "Chưa cấu hình tài khoản ghi tệp cho trace-api (DOCS_S3_ACCESS_KEY, DOCS_S3_SECRET_KEY)");
    return a;
  }

  async function uploadAttachment(code, query, req, user) {
    const a = await loadWritableApplication(code, user);
    const pool = getPool();
    const profile = ocop.getProfile(OCOP, a.profile);
    const rules = profile.attachments;
    const docKey = str(query.get("doc"), 60, "doc", true);
    if (!ocop.checklistFor(profile, a.product_group).some((c) => c.key === docKey)) throw new HttpError(400, "Giấy tờ không có trong danh mục của hồ sơ này");
    const { rows: cnt } = await pool.query("SELECT count(*)::int AS n FROM application_attachments WHERE application_id = $1 AND removed_at IS NULL", [a.id]);
    if (cnt[0].n >= rules.maxPerApplication) throw new HttpError(409, `Mỗi hồ sơ tối đa ${rules.maxPerApplication} tệp`);
    const buf = await readBufferWrapped(req, rules.maxBytes);
    let info;
    try {
      info = attachments.inspect(buf, req.headers["content-type"], query.get("name") ?? "", rules);
    } catch (e) {
      if (e instanceof attachments.AttachmentError) throw new HttpError(e.status, e.message);
      throw e;
    }
    const dup = await pool.query("SELECT 1 FROM application_attachments WHERE application_id = $1 AND doc_key = $2 AND sha256 = $3 AND removed_at IS NULL", [a.id, docKey, info.sha256]);
    if (dup.rowCount) throw new HttpError(409, "Tệp này đã được đính kèm cho giấy tờ này");
    let scanEngine = null;
    if (scanner) {
      try {
        const r = await scanner.scan(buf);
        if (!r.clean) throw new HttpError(422, `Tệp bị chặn vì nghi chứa mã độc (${r.signature})`);
        scanEngine = "clamav";
      } catch (e) {
        if (e instanceof HttpError) throw e;
        console.error("[trace-api] không quét được tệp bằng ClamAV:", e.message);
        if (scanRequired) throw new HttpError(503, "Dịch vụ quét mã độc chưa sẵn sàng, vui lòng thử lại sau ít phút");
      }
    }
    const key = attachments.objectKey(a.code, docKey, info.sha256, info.name);
    try {
      await docsS3.putObject(key, buf, info.type);
    } catch (e) {
      console.error("[trace-api] lỗi ghi tệp lên MinIO:", e.message);
      throw new HttpError(502, "Không lưu được tệp vào kho lưu trữ");
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        `INSERT INTO application_attachments (application_id, doc_key, filename, content_type, size, sha256, object_key, uploaded_by, scan_engine, scanned_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, CASE WHEN $9::text IS NULL THEN NULL ELSE now() END) RETURNING id, doc_key, filename, content_type, size, sha256, uploaded_by, created_at`,
        [a.id, docKey, info.name, info.type, info.size, info.sha256, key, user.name, scanEngine],
      );
      await client.query(
        "UPDATE ocop_applications SET documents = CASE WHEN documents @> to_jsonb($1::text) THEN documents ELSE documents || to_jsonb($1::text) END, updated_at = now() WHERE id = $2",
        [docKey, a.id],
      );
      await client.query("INSERT INTO ocop_application_history (application_id, action, from_state, to_state, actor, note) VALUES ($1,'attach',$2,$2,$3,$4)", [a.id, a.state, user.name, `${docKey}: ${info.name}`]);
      await client.query("COMMIT");
      return attachmentView(rows[0]);
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  async function removeAttachment(code, id, user) {
    const a = await loadWritableApplication(code, user);
    const { rows } = await getPool().query(
      "UPDATE application_attachments SET removed_at = now(), removed_by = $3 WHERE id = $1 AND application_id = $2 AND removed_at IS NULL RETURNING doc_key, filename",
      [Number(id) || 0, a.id, user.name],
    );
    if (!rows.length) throw new HttpError(404, "Không tìm thấy tệp");
    await getPool().query("INSERT INTO ocop_application_history (application_id, action, from_state, to_state, actor, note) VALUES ($1,'detach',$2,$2,$3,$4)", [a.id, a.state, user.name, `${rows[0].doc_key}: ${rows[0].filename}`]);
    return { removed: true };
  }

  async function downloadAttachment(code, id, user, res) {
    const a = await findApplicationRow(code);
    if (!a || !access.authorize(ACCESS, user, "application.read", appResource(a))) throw new HttpError(404, "Không tìm thấy hồ sơ");
    if (!docsS3) throw new HttpError(503, "Chưa cấu hình kho lưu trữ tệp");
    const { rows } = await getPool().query("SELECT filename, content_type, size, sha256, object_key FROM application_attachments WHERE id = $1 AND application_id = $2 AND removed_at IS NULL", [Number(id) || 0, a.id]);
    if (!rows.length) throw new HttpError(404, "Không tìm thấy tệp");
    const r = rows[0];
    let buf;
    try {
      buf = await docsS3.getObjectBuffer(r.object_key);
    } catch (e) {
      console.error("[trace-api] lỗi đọc tệp từ MinIO:", e.message);
      throw new HttpError(502, "Không đọc được tệp từ kho lưu trữ");
    }
    if (crypto.createHash("sha256").update(buf).digest("hex") !== r.sha256) {
      console.error(`[trace-api] CẢNH BÁO: tệp ${r.object_key} không khớp băm đã lưu`);
      throw new HttpError(500, "Tệp không toàn vẹn (không khớp băm lúc tải lên)");
    }
    const disposition = r.content_type.startsWith("image/") ? "inline" : "attachment";
    sendBinary(res, 200, buf, {
      "content-type": r.content_type,
      "content-disposition": `${disposition}; filename*=UTF-8''${encodeURIComponent(r.filename)}`,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cache-control": "private, no-store",
      "x-sha256": r.sha256,
    });
  }

  return async function handleOcop(req, res, parts, url, m) {
    if (parts[0] !== "applications") return false;
    const user = getUser(req);
    if (!access.canApi(ACCESS, user.roles)) throw new HttpError(403, "Vai trò của bạn không dùng được API này");
    if (parts.length === 2 && parts[1] === "profile" && m === "GET") {
      send(res, 200, profileView());
      return true;
    }
    if (parts.length === 1 && m === "GET") {
      send(res, 200, { applications: await listApplications(user) });
      return true;
    }
    if (parts.length === 1 && m === "POST") {
      send(res, 201, await createApplication(await readJson(req), user));
      return true;
    }
    if (parts.length === 2 && m === "GET") {
      send(res, 200, await getApplication(parts[1], user));
      return true;
    }
    if (parts.length === 2 && m === "PUT") {
      send(res, 200, await updateApplication(parts[1], await readJson(req), user));
      return true;
    }
    if (parts.length === 3 && parts[2] === "actions" && m === "POST") {
      send(res, 200, await applicationAction(parts[1], await readJson(req), user));
      return true;
    }
    if (parts.length === 3 && parts[2] === "council" && m === "GET") {
      const a = await findApplicationRow(parts[1]);
      if (!a || !access.authorize(ACCESS, user, "application.read", appResource(a))) throw new HttpError(404, "Không tìm thấy hồ sơ");
      const profile = ocop.getProfile(OCOP, a.profile);
      send(res, 200, { code: a.code, product_name: a.product_name, state: a.state, ...(await getCouncilState(a, profile)) });
      return true;
    }
    if (parts.length === 4 && parts[2] === "council" && parts[3] === "scores" && m === "POST") {
      send(res, 200, await submitCouncilScore(parts[1], await readJson(req), user));
      return true;
    }
    if (parts.length === 3 && parts[2] === "minutes.pdf" && m === "GET") {
      await minutesPdf(parts[1], user, res);
      return true;
    }
    if (parts.length === 3 && parts[2] === "attachments" && m === "POST") {
      send(res, 201, await uploadAttachment(parts[1], url.searchParams, req, user));
      return true;
    }
    if (parts.length === 4 && parts[2] === "attachments" && m === "DELETE") {
      send(res, 200, await removeAttachment(parts[1], parts[3], user));
      return true;
    }
    if (parts.length === 5 && parts[2] === "attachments" && parts[4] === "file" && m === "GET") {
      await downloadAttachment(parts[1], parts[3], user, res);
      return true;
    }
    return false;
  };
}

module.exports = { createOcopRoutes };
