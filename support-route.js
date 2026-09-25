// ═══════════════════════════════════════════════════════════════
// support-route.js — Messages (account page) and Inbox (admin).
//
// Built from the approved prototype, support-inbox-prototype.html.
// Needs migration-support-inbox.sql (Phase 1).
//
//   customer   /api/support/...          behind requireAuth
//   admin      /admin/api/support/...    behind requireAdmin (mounted
//                                        from admin-route.js)
//
// ── HOW FILES MOVE ──────────────────────────────────────────────
// Screenshots never pass through this server. The browser asks for a
// short-lived upload link, puts the file straight into the private
// Storage bucket, then sends the message naming the file. Before the
// file is attached, the server asks Storage what actually arrived and
// records Storage's size and type — never the browser's claim.
//
// Every file lives under its customer's folder:  <userId>/<id>.<ext>
// Your attachments go in the same folder as admin-<id>.<ext>, so one
// customer's conversation is always in one place, and removing a
// customer removes all of it.
//
// ── STAGES (exactly the prototype's) ────────────────────────────
//   customer writes              → Received
//   you reply                    → In review (from Received)
//   you reply + ask              → Waiting on you
//   customer replies while waiting → back to In review, by itself
//   you click a stage            → that stage
//   Restore access & notify      → Resolved
// A Resolved conversation is closed; the customer starts a new one.
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const axios   = require('axios');
const crypto  = require('crypto');
const cron    = require('node-cron');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim();
const SUPABASE_SVC = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = 'support-attachments';

const STAGES = ['received', 'review', 'waiting', 'resolved'];
const STAGE_LABEL = { received: 'Received', review: 'In review', waiting: 'Waiting on you', resolved: 'Resolved' };
const TOPICS = ['licence', 'billing', 'technical', 'other'];
const TYPES  = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'application/pdf': 'pdf' };
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 5;
const MAX_OPEN_THREADS = 5;          // per customer, so the inbox cannot be flooded
const DOWNLOAD_LINK_SECS = 300;      // a viewing link lasts five minutes

// The message the customer sees when you restore access. Same words as
// the approved prototype.
const RESTORE_TEXT =
  'Thank you for your patience while we reviewed your licence. Our checks are complete and ' +
  'everything is in order, so your Pro Dashboard is available again. Refresh this page, or use ' +
  'the button below, to continue.';

// ── Supabase access ──────────────────────────────────────────────
// Service role: this server is the only thing that ever touches these
// tables (RLS is on with no policies), so every ownership check below is
// the whole of the protection. Each one is deliberate.
function headers(extra = {}) {
  const isNew = String(SUPABASE_SVC || '').startsWith('sb_secret_');
  return { apikey: SUPABASE_SVC, ...(isNew ? {} : { Authorization: `Bearer ${SUPABASE_SVC}` }), ...extra };
}
const REST = `${SUPABASE_URL}/rest/v1`;
const STORE = `${SUPABASE_URL}/storage/v1`;

async function rows(table, query) {
  const { data } = await axios.get(`${REST}/${table}?${query}`, { headers: headers(), timeout: 10000 });
  return data || [];
}
async function insert(table, row) {
  const { data } = await axios.post(`${REST}/${table}`, row,
    { headers: headers({ 'Content-Type': 'application/json', Prefer: 'return=representation' }), timeout: 10000 });
  return Array.isArray(data) ? data[0] : data;
}
async function patch(table, query, body) {
  await axios.patch(`${REST}/${table}?${query}`, body,
    { headers: headers({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }), timeout: 10000 });
}

// ── Storage: three calls, each small so a surprise fails in one place ──
async function signUpload(path) {
  const { data } = await axios.post(`${STORE}/object/upload/sign/${BUCKET}/${path}`, {},
    { headers: headers({ 'Content-Type': 'application/json' }), timeout: 10000 });
  const rel = data && (data.url || data.signedUrl || data.signedURL);
  if (!rel) throw new Error('Storage did not return an upload link');
  return /^https?:/.test(rel) ? rel : `${STORE}${rel}`;
}
async function listFolder(prefix, search) {
  const { data } = await axios.post(`${STORE}/object/list/${BUCKET}`,
    { prefix, search: search || '', limit: 1000, offset: 0 },
    { headers: headers({ 'Content-Type': 'application/json' }), timeout: 10000 });
  return Array.isArray(data) ? data : [];
}
async function signDownload(path) {
  const { data } = await axios.post(`${STORE}/object/sign/${BUCKET}/${path}`, { expiresIn: DOWNLOAD_LINK_SECS },
    { headers: headers({ 'Content-Type': 'application/json' }), timeout: 10000 });
  const rel = data && (data.signedURL || data.signedUrl || data.url);
  if (!rel) throw new Error('Storage did not return a download link');
  return /^https?:/.test(rel) ? rel : `${STORE}${rel}`;
}
async function removeFiles(paths) {
  if (!paths.length) return;
  await axios.delete(`${STORE}/object/${BUCKET}`,
    { headers: headers({ 'Content-Type': 'application/json' }), data: { prefixes: paths }, timeout: 15000 });
}

// ── Small rules ──────────────────────────────────────────────────
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = v => UUID.test(String(v || ''));
const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);
// Display name only — never used as a path. Drops anything that could
// look like a folder.
const cleanName = v => clean(v, 200).replace(/[\\/]/g, '_') || 'file';

// Checks the list a browser wants to upload BEFORE handing out links.
function checkFiles(files) {
  if (!Array.isArray(files) || !files.length) return 'No files given';
  if (files.length > MAX_FILES) return `Up to ${MAX_FILES} files per message`;
  for (const f of files) {
    if (!TYPES[f && f.type]) return `${cleanName(f && f.name)}: only images (PNG, JPG, WebP, GIF) and PDFs are accepted`;
    const size = Number(f.size);
    if (!(size > 0) || size > MAX_BYTES) return `${cleanName(f.name)}: must be under 10 MB`;
  }
  return null;
}

// Turns "the browser says it uploaded these" into attachment rows, but
// only for files that are (a) in THIS customer's folder, (b) really in
// Storage, and (c) within the limits by Storage's own measurement.
async function verifyAttachments(ownerId, list, prefixKind) {
  if (!list || !list.length) return [];
  if (!Array.isArray(list) || list.length > MAX_FILES) throw httpErr(400, `Up to ${MAX_FILES} files per message`);
  const want = prefixKind === 'admin' ? `${ownerId}/admin-` : `${ownerId}/`;
  const out = [];
  const seen = new Set();
  for (const a of list) {
    const path = String(a && a.path || '');
    // The path must be exactly <owner>/<name>.<ext> — no other folder,
    // no "..", nothing another customer's file could be reached by.
    const m = /^([0-9a-f-]{36})\/((?:admin-)?[0-9a-f-]{36}\.(png|jpg|webp|gif|pdf))$/i.exec(path);
    if (!m || !path.startsWith(want) || m[1] !== ownerId || seen.has(path)) throw httpErr(400, 'An attachment was not recognised');
    seen.add(path);
    const found = (await listFolder(`${ownerId}/`, m[2])).find(o => o.name === m[2]);
    if (!found) throw httpErr(400, `${cleanName(a.name)} did not finish uploading — please try again`);
    const size = Number(found.metadata && found.metadata.size);
    const mime = found.metadata && found.metadata.mimetype;
    if (!TYPES[mime] || !(size > 0) || size > MAX_BYTES) throw httpErr(400, `${cleanName(a.name)} is not an accepted file`);
    out.push({ storage_path: path, file_name: cleanName(a.name), mime_type: mime, size_bytes: size });
  }
  return out;
}

function httpErr(status, message) { const e = new Error(message); e.status = status; return e; }
function fail(res, e, where) {
  if (e.status) return res.status(e.status).json({ error: e.message });
  console.error(`[SUPPORT] ${where}:`, e.response?.data || e.message);
  res.status(502).json({ error: 'Something went wrong on our side — please try again' });
}

async function addMessage(threadId, author, body, atts, ownerId, adminEmail) {
  const msg = await insert('support_messages', {
    thread_id: threadId, author, body: body || '', admin_email: author === 'admin' ? (adminEmail || null) : null
  });
  for (const a of atts) {
    await insert('support_attachments', { ...a, message_id: msg.id, thread_id: threadId, user_id: ownerId });
  }
  return msg;
}
const system = (threadId, text) => insert('support_messages', { thread_id: threadId, author: 'system', body: text });

// A conversation with its messages and attachment details — for either side.
// admin_email is only ever returned to the admin side.
async function loadThread(id, forAdmin) {
  const [t] = await rows('support_threads', `id=eq.${id}&select=*`);
  if (!t) return null;
  const msgs = await rows('support_messages', `thread_id=eq.${id}&select=id,author,body,admin_email,created_at&order=created_at.asc`);
  const atts = await rows('support_attachments', `thread_id=eq.${id}&select=id,message_id,file_name,mime_type,size_bytes`);
  const byMsg = {};
  for (const a of atts) (byMsg[a.message_id] = byMsg[a.message_id] || []).push(
    { id: a.id, name: a.file_name, type: a.mime_type, size: a.size_bytes });
  return {
    id: t.id, userId: forAdmin ? t.user_id : undefined, topic: t.topic, subject: t.subject, stage: t.stage,
    createdAt: t.created_at, lastMessageAt: t.last_message_at, resolvedAt: t.resolved_at,
    unread: forAdmin ? t.unread_admin : t.unread_user,
    messages: msgs.map(m => ({
      id: m.id, from: m.author === 'user' ? 'customer' : m.author, text: m.body, at: m.created_at,
      ...(forAdmin && m.admin_email ? { by: m.admin_email } : {}),
      attachments: byMsg[m.id] || []
    }))
  };
}

// Who a customer is, for the inbox and for emails.
async function person(userId) {
  try {
    const { data } = await axios.get(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, { headers: headers(), timeout: 6000 });
    const words = String(data?.user_metadata?.full_name || '').trim().split(/\s+/).filter(Boolean);
    return { email: data?.email || null, name: words[0] || null, lastName: words.length ? words[words.length - 1] : null };
  } catch { return { email: null, name: null, lastName: null }; }
}

// Emails are a courtesy: a failure is logged and never undoes the action.
function notifyCustomer(userId, kind, subject) {
  const mail = require('./email-service');
  if (!mail.sendSupportUpdate) return;
  person(userId).then(p => p.email && mail.sendSupportUpdate(p.email, p.name, { kind, subject }))
    .catch(e => console.warn('[SUPPORT] email failed:', e.message));
}
function notifyYou(subject, topic, fromEmail) {
  const mail = require('./email-service');
  if (!mail.sendSupportAlert) return;
  Promise.resolve(mail.sendSupportAlert({ subject, topic, fromEmail }))
    .catch(e => console.warn('[SUPPORT] alert failed:', e.message));
}

// ═══════════════════════════════════════════════════════════════
//  CUSTOMER — /api/support/...
// ═══════════════════════════════════════════════════════════════
function customerRouter(requireAuth) {
  const r = express.Router();
  r.use('/api/support', requireAuth);

  // Their conversations, newest first.
  r.get('/api/support/threads', async (req, res) => {
    try {
      const list = await rows('support_threads',
        `user_id=eq.${req.user.id}&select=id,topic,subject,stage,unread_user,last_message_at&order=last_message_at.desc`);
      res.json({ threads: list.map(t => ({ id: t.id, topic: t.topic, subject: t.subject, stage: t.stage,
        unread: t.unread_user, lastMessageAt: t.last_message_at })) });
    } catch (e) { fail(res, e, 'list threads'); }
  });

  // Upload links for the files they are about to attach.
  r.post('/api/support/uploads', async (req, res) => {
    try {
      const why = checkFiles(req.body && req.body.files);
      if (why) return res.status(400).json({ error: why });
      const uploads = [];
      for (const f of req.body.files) {
        const path = `${req.user.id}/${crypto.randomUUID()}.${TYPES[f.type]}`;
        uploads.push({ path, name: cleanName(f.name), uploadUrl: await signUpload(path) });
      }
      res.json({ uploads });
    } catch (e) { fail(res, e, 'sign uploads'); }
  });

  // A new conversation.
  r.post('/api/support/threads', async (req, res) => {
    try {
      const b = req.body || {};
      const topic = TOPICS.includes(b.topic) ? b.topic : 'other';
      const subject = clean(b.subject, 140);
      const body = clean(b.body, 5000);
      if (!subject) return res.status(400).json({ error: 'Add a subject' });
      if (!body) return res.status(400).json({ error: 'Write a message first' });
      const open = await rows('support_threads', `user_id=eq.${req.user.id}&stage=neq.resolved&select=id`);
      if (open.length >= MAX_OPEN_THREADS) {
        return res.status(429).json({ error: `You have ${open.length} open conversations — please reply in one of those, and we will get to it` });
      }
      const atts = await verifyAttachments(req.user.id, b.attachments, 'customer');
      const t = await insert('support_threads', { user_id: req.user.id, topic, subject, unread_admin: true, unread_user: false });
      await addMessage(t.id, 'user', body, atts, req.user.id);
      notifyYou(subject, topic, req.user.email);
      res.status(201).json({ thread: await loadThread(t.id, false) });
    } catch (e) { fail(res, e, 'create thread'); }
  });

  // One conversation. Opening it clears their unread dot.
  r.get('/api/support/threads/:id', async (req, res) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Not found' });
      const [t] = await rows('support_threads', `id=eq.${req.params.id}&user_id=eq.${req.user.id}&select=id,unread_user`);
      // Someone else's conversation reads as not found — never "forbidden",
      // which would confirm that it exists.
      if (!t) return res.status(404).json({ error: 'Not found' });
      if (t.unread_user) await patch('support_threads', `id=eq.${t.id}`, { unread_user: false });
      res.json({ thread: await loadThread(t.id, false) });
    } catch (e) { fail(res, e, 'read thread'); }
  });

  // Their reply.
  r.post('/api/support/threads/:id/reply', async (req, res) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Not found' });
      const [t] = await rows('support_threads', `id=eq.${req.params.id}&user_id=eq.${req.user.id}&select=*`);
      if (!t) return res.status(404).json({ error: 'Not found' });
      if (t.stage === 'resolved') {
        return res.status(409).json({ error: 'This conversation is closed. Something else? Start a new message.' });
      }
      const body = clean(req.body && req.body.body, 5000);
      const atts = await verifyAttachments(req.user.id, req.body && req.body.attachments, 'customer');
      if (!body && !atts.length) return res.status(400).json({ error: 'Write a reply or attach a file' });
      await addMessage(t.id, 'user', body, atts, req.user.id);
      const upd = { unread_admin: true, last_message_at: new Date().toISOString() };
      // A reply while you were waiting on them moves the ball back to you.
      if (t.stage === 'waiting') {
        upd.stage = 'review';
        await system(t.id, 'Moved to In review after a reply');
      }
      await patch('support_threads', `id=eq.${t.id}`, upd);
      res.json({ thread: await loadThread(t.id, false) });
    } catch (e) { fail(res, e, 'reply'); }
  });

  // A five-minute link to view one of their own files.
  r.get('/api/support/files/:id', async (req, res) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Not found' });
      const [a] = await rows('support_attachments', `id=eq.${req.params.id}&user_id=eq.${req.user.id}&select=storage_path`);
      if (!a) return res.status(404).json({ error: 'Not found' });
      res.json({ url: await signDownload(a.storage_path), expiresIn: DOWNLOAD_LINK_SECS });
    } catch (e) { fail(res, e, 'file link'); }
  });

  // Opening the Pro Dashboard clears the "review complete" notice.
  r.post('/api/support/notice/dismiss', async (req, res) => {
    try {
      await patch('subscriptions', `user_id=eq.${req.user.id}`, { restore_notice: null, restore_notice_at: null });
      res.json({ ok: true });
    } catch (e) { fail(res, e, 'dismiss notice'); }
  });

  return r;
}

// ═══════════════════════════════════════════════════════════════
//  ADMIN — mounted inside admin-route.js, after requireAdmin.
// ═══════════════════════════════════════════════════════════════
function adminRouter({ audit, licenceSharing }) {
  const r = express.Router();

  // The inbox. Filters match the prototype's buttons.
  r.get('/api/support', async (req, res) => {
    try {
      const f = String(req.query.filter || 'open');
      const q = f === 'all' ? '' : f === 'waiting' ? '&stage=eq.waiting' : f === 'licence' ? '&topic=eq.licence'
              : f === 'resolved' ? '&stage=eq.resolved' : '&stage=neq.resolved';
      const list = await rows('support_threads',
        `select=id,user_id,topic,subject,stage,unread_admin,last_message_at${q}&order=last_message_at.desc&limit=200`);
      const open = await rows('support_threads', `stage=neq.resolved&select=id`);
      const who = {};
      for (const uid of [...new Set(list.map(t => t.user_id))]) who[uid] = await person(uid);
      res.json({
        openCount: open.length,
        threads: list.map(t => ({ id: t.id, userId: t.user_id, topic: t.topic, subject: t.subject, stage: t.stage,
          unread: t.unread_admin, lastMessageAt: t.last_message_at,
          email: who[t.user_id]?.email || null, lastName: who[t.user_id]?.lastName || null }))
      });
    } catch (e) { fail(res, e, 'inbox'); }
  });

  // One conversation, with who it is and whether Restore applies.
  r.get('/api/support/:id', async (req, res) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Not found' });
      const t = await loadThread(req.params.id, true);
      if (!t) return res.status(404).json({ error: 'Not found' });
      if (t.unread) await patch('support_threads', `id=eq.${t.id}`, { unread_admin: false });
      const [sub] = await rows('subscriptions', `user_id=eq.${t.userId}&select=sharing_state,access_status`);
      const p = await person(t.userId);
      res.json({ thread: { ...t, unread: false }, customer: { email: p.email, lastName: p.lastName },
        // The prototype only offers Restore on a licence conversation, and
        // only while the dashboard is actually paused.
        canRestore: t.topic === 'licence' && !!sub && sub.sharing_state === 'blocked' && t.stage !== 'resolved' });
    } catch (e) { fail(res, e, 'admin read'); }
  });

  // Upload links for YOUR attachments, into that customer's folder.
  r.post('/api/support/:id/uploads', async (req, res) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Not found' });
      const [t] = await rows('support_threads', `id=eq.${req.params.id}&select=user_id`);
      if (!t) return res.status(404).json({ error: 'Not found' });
      const why = checkFiles(req.body && req.body.files);
      if (why) return res.status(400).json({ error: why });
      const uploads = [];
      for (const f of req.body.files) {
        const path = `${t.user_id}/admin-${crypto.randomUUID()}.${TYPES[f.type]}`;
        uploads.push({ path, name: cleanName(f.name), uploadUrl: await signUpload(path) });
      }
      res.json({ uploads });
    } catch (e) { fail(res, e, 'admin uploads'); }
  });

  // Your reply. { body, attachments, ask } — ask moves it to Waiting on you.
  r.post('/api/support/:id/reply', async (req, res) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Not found' });
      const [t] = await rows('support_threads', `id=eq.${req.params.id}&select=*`);
      if (!t) return res.status(404).json({ error: 'Not found' });
      const body = clean(req.body && req.body.body, 5000);
      const atts = await verifyAttachments(t.user_id, req.body && req.body.attachments, 'admin');
      if (!body && !atts.length) return res.status(400).json({ error: 'Write a reply first' });
      await addMessage(t.id, 'admin', body, atts, t.user_id, req.admin && req.admin.email);
      const upd = { unread_user: true, last_message_at: new Date().toISOString() };
      if (req.body && req.body.ask && t.stage !== 'waiting') {
        upd.stage = 'waiting'; upd.resolved_at = null;
        await system(t.id, 'Moved to Waiting on you');
      } else if (t.stage === 'received') {
        upd.stage = 'review';
        await system(t.id, 'Moved to In review');
      }
      await patch('support_threads', `id=eq.${t.id}`, upd);
      audit({ req, action: 'support.reply', targetUser: t.user_id, note: `reply on "${t.subject}"${upd.stage ? ' → ' + STAGE_LABEL[upd.stage] : ''}` });
      notifyCustomer(t.user_id, upd.stage === 'waiting' ? 'waiting' : 'reply', t.subject);
      res.json({ thread: await loadThread(t.id, true) });
    } catch (e) { fail(res, e, 'admin reply'); }
  });

  // Move the progress bar by hand.
  r.post('/api/support/:id/stage', async (req, res) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Not found' });
      const stage = String(req.body && req.body.stage || '');
      if (!STAGES.includes(stage)) return res.status(400).json({ error: 'Unknown stage' });
      const [t] = await rows('support_threads', `id=eq.${req.params.id}&select=*`);
      if (!t) return res.status(404).json({ error: 'Not found' });
      if (t.stage === stage) return res.json({ thread: await loadThread(t.id, true) });
      await system(t.id, `Moved to ${STAGE_LABEL[stage]}`);
      await patch('support_threads', `id=eq.${t.id}`, {
        stage, unread_user: true, last_message_at: new Date().toISOString(),
        resolved_at: stage === 'resolved' ? new Date().toISOString() : null
      });
      audit({ req, action: 'support.stage', targetUser: t.user_id, note: `"${t.subject}" → ${STAGE_LABEL[stage]}` });
      // Only the moves a customer needs to act on, or would want to know
      // about, send an email — clicking through stages must not spam them.
      if (stage === 'waiting' || stage === 'resolved') notifyCustomer(t.user_id, stage, t.subject);
      res.json({ thread: await loadThread(t.id, true) });
    } catch (e) { fail(res, e, 'stage'); }
  });

  // Restore access & notify.
  r.post('/api/support/:id/restore', async (req, res) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Not found' });
      const [t] = await rows('support_threads', `id=eq.${req.params.id}&select=*`);
      if (!t) return res.status(404).json({ error: 'Not found' });
      if (t.topic !== 'licence') return res.status(400).json({ error: 'Restore is only for licence review conversations' });
      const [sub] = await rows('subscriptions', `user_id=eq.${t.user_id}&select=sharing_state`);
      if (!sub || sub.sharing_state !== 'blocked') {
        return res.status(409).json({ error: 'Their dashboard is not paused — nothing to restore' });
      }
      // Clear & accept: your review found their setup legitimate, so it
      // must not re-flag tonight. 'unblock' alone would leave them warned,
      // and the warning banner would sit beside "your review is complete".
      await licenceSharing.setState(t.user_id, 'clear');
      await patch('subscriptions', `user_id=eq.${t.user_id}`,
        { restore_notice: RESTORE_TEXT, restore_notice_at: new Date().toISOString() });
      await addMessage(t.id, 'admin', RESTORE_TEXT, [], t.user_id, req.admin && req.admin.email);
      await system(t.id, 'Access restored · marked as resolved');
      const now = new Date().toISOString();
      await patch('support_threads', `id=eq.${t.id}`,
        { stage: 'resolved', resolved_at: now, unread_user: true, last_message_at: now });
      audit({ req, action: 'support.restore', targetUser: t.user_id,
              note: `licence review "${t.subject}" — access restored after review` });
      notifyCustomer(t.user_id, 'restored', t.subject);
      res.json({ thread: await loadThread(t.id, true) });
    } catch (e) { fail(res, e, 'restore'); }
  });

  // A five-minute link to view any attachment.
  r.get('/api/support-files/:id', async (req, res) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Not found' });
      const [a] = await rows('support_attachments', `id=eq.${req.params.id}&select=storage_path`);
      if (!a) return res.status(404).json({ error: 'Not found' });
      res.json({ url: await signDownload(a.storage_path), expiresIn: DOWNLOAD_LINK_SECS });
    } catch (e) { fail(res, e, 'admin file link'); }
  });

  return r;
}

// ═══════════════════════════════════════════════════════════════
//  NIGHTLY CLEAN-UP — 00:40 UTC, after the licence sweep.
//
// Two kinds of leftover file, both removed:
//   · a whole folder whose customer no longer exists. Customers are
//     deleted from the Supabase dashboard, which removes their message
//     rows but never touches Storage.
//   · a file uploaded more than a day ago but never attached — someone
//     started a message and closed the tab.
// ═══════════════════════════════════════════════════════════════
async function cleanUp() {
  if (!SUPABASE_URL || !SUPABASE_SVC) return { folders: 0, strays: 0 };
  let folders = 0, strays = 0;
  const top = await listFolder('', '');
  for (const f of top) {
    const uid = f.name;
    if (!isUuid(uid)) continue;
    let exists = true;
    try { await axios.get(`${SUPABASE_URL}/auth/v1/admin/users/${uid}`, { headers: headers(), timeout: 6000 }); }
    catch (e) { if (e.response && e.response.status === 404) exists = false; else continue; }
    const files = await listFolder(`${uid}/`, '');
    const paths = files.filter(x => x.name).map(x => `${uid}/${x.name}`);
    if (!exists) { await removeFiles(paths); folders++; continue; }
    const kept = new Set((await rows('support_attachments', `user_id=eq.${uid}&select=storage_path`)).map(a => a.storage_path));
    const dayAgo = Date.now() - 86400000;
    const stray = files.filter(x => x.name && !kept.has(`${uid}/${x.name}`) &&
      Date.parse(x.created_at || x.updated_at || 0) < dayAgo).map(x => `${uid}/${x.name}`);
    if (stray.length) { await removeFiles(stray); strays += stray.length; }
  }
  if (folders || strays) console.log(`[SUPPORT] clean-up: ${folders} departed customers' files, ${strays} unsent uploads removed`);
  return { folders, strays };
}

function start() {
  cron.schedule('40 0 * * *', () => cleanUp().catch(e => console.warn('[SUPPORT] clean-up failed:', e.message)));
  console.log('[SUPPORT] nightly attachment clean-up scheduled for 00:40 UTC');
}

module.exports = {
  customerRouter, adminRouter, start, cleanUp,
  // exported for tests
  checkFiles, verifyAttachments, RESTORE_TEXT, STAGES, TOPICS, MAX_FILES, MAX_BYTES
};
