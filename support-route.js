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
// The same four steps, named for the kind of issue — as in prototype v2.
const TOPIC_STAGES = {
  licence:   { received: 'Received', review: 'Under review',          waiting: 'Waiting on you', resolved: 'Resolved' },
  billing:   { received: 'Received', review: 'Checking your payment', waiting: 'Waiting on you', resolved: 'Sorted' },
  technical: { received: 'Received', review: 'Investigating',         waiting: 'Waiting on you', resolved: 'Fixed' },
  other:     { received: 'Received', review: 'In review',             waiting: 'Waiting on you', resolved: 'Resolved' }
};
const stageName = (topic, stage) => (TOPIC_STAGES[topic] || TOPIC_STAGES.other)[stage] || stage;
const REOPEN_DAYS = 7;          // a resolved conversation can be reopened for this long
const REMIND_DAYS = 3;          // Waiting on you: reminder emailed after this long
const CLOSE_DAYS  = 7;          // Waiting on you: closed after this long (never a licence review)
const DAY = 86400000;
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

async function addMessage(threadId, author, body, atts, ownerId, adminEmail, agentId) {
  const msg = await insert('support_messages', {
    thread_id: threadId, author, body: body || '', admin_email: author === 'admin' ? (adminEmail || null) : null,
    // Which agent wrote it. Agent replies are otherwise stored exactly like
    // yours, so the customer still sees "Blackwood support".
    ...(agentId ? { agent_id: agentId } : {})
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
  // The three pieces load side by side — they used to load one after
  // another, three waits in a row on every open, reply and button press.
  const [[t], msgs, atts] = await Promise.all([
    rows('support_threads', `id=eq.${id}&select=*`),
    rows('support_messages', `thread_id=eq.${id}&select=id,author,body,admin_email,agent_id,created_at&order=created_at.asc`),
    rows('support_attachments', `thread_id=eq.${id}&select=id,message_id,file_name,mime_type,size_bytes`)
  ]);
  if (!t) return null;
  // Team names are for your side only; a customer's view never needs them.
  const names = forAdmin ? await agentNames() : {};
  const byMsg = {};
  for (const a of atts) (byMsg[a.message_id] = byMsg[a.message_id] || []).push(
    { id: a.id, name: a.file_name, type: a.mime_type, size: a.size_bytes });
  return {
    id: t.id, userId: forAdmin ? t.user_id : undefined, topic: t.topic, subject: t.subject, stage: t.stage,
    createdAt: t.created_at, lastMessageAt: t.last_message_at, resolvedAt: t.resolved_at,
    unread: forAdmin ? t.unread_admin : t.unread_user,
    resolvedBy: t.resolved_by || null, rating: t.rating || null,
    waitingSince: t.waiting_since || null, remindedAt: t.reminded_at || null,
    reopenedCount: t.reopened_count || 0,
    // Internal hand-over — YOUR view only. A customer must never learn their
    // conversation was passed on, or which agent passed it.
    ...(forAdmin ? { escalatedAt: t.escalated_at || null,
                     escalatedBy: t.escalated_by ? (names[t.escalated_by] || 'a removed agent') : null } : {}),
    // Worked out here, not in the page, so both pages agree on the window.
    canReopen: t.stage === 'resolved' && !!t.resolved_at && (Date.now() - Date.parse(t.resolved_at)) < REOPEN_DAYS * DAY,
    // A licence review is closed by you, once their access is restored.
    canResolve: t.stage !== 'resolved' && t.topic !== 'licence',
    messages: msgs.map(m => ({
      id: m.id, from: m.author === 'user' ? 'customer' : m.author, text: m.body, at: m.created_at,
      ...(forAdmin && m.agent_id ? { by: (names[m.agent_id] || 'a removed agent') + ' (agent)', agentId: m.agent_id }
          : forAdmin && m.admin_email ? { by: m.admin_email } : {}),
      attachments: byMsg[m.id] || []
    }))
  };
}

// Agents' names, for "by Ama (agent)" and "passed to you by Ama".
// Remembered for a minute; forgotten when the team changes. Empty if the
// agents migration has not been run — everything else carries on.
let agentNameCache = { at: 0, map: {} };
async function agentNames() {
  if (Date.now() - agentNameCache.at < 60000) return agentNameCache.map;
  try {
    const list = await rows('support_agents', 'select=id,name');
    agentNameCache = { at: Date.now(), map: Object.fromEntries(list.map(a => [a.id, a.name])) };
  } catch { agentNameCache = { at: Date.now(), map: {} }; }
  return agentNameCache.map;
}
function forgetAgentNames() { agentNameCache.at = 0; }

// Who a customer is, for the inbox and for emails.
const people = new Map();                  // userId -> { at, p }
const PERSON_TTL = 10 * 60 * 1000;
async function person(userId) {
  const hit = people.get(userId);
  if (hit && Date.now() - hit.at < PERSON_TTL) return hit.p;
  const p = await personUncached(userId);
  if (p.email) people.set(userId, { at: Date.now(), p });   // only remember a real answer
  return p;
}
async function personUncached(userId) {
  try {
    const { data } = await axios.get(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, { headers: headers(), timeout: 6000 });
    const words = String(data?.user_metadata?.full_name || '').trim().split(/\s+/).filter(Boolean);
    return { email: data?.email || null, name: words[0] || null, lastName: words.length ? words[words.length - 1] : null };
  } catch { return { email: null, name: null, lastName: null }; }
}

// What kind of customer this is, for the Inbox badge.
//   free · pro_monthly · pro_yearly · lifetime — and 'pro' if a Pro plan
//   somehow has no billing period recorded, rather than guessing one.
function planOf(sub) {
  if (!sub) return 'free';
  if (sub.plan === 'lifetime' || sub.plan_key === 'lifetime') return 'lifetime';
  if (sub.plan_key === 'pro_yearly')  return 'pro_yearly';
  if (sub.plan_key === 'pro_monthly') return 'pro_monthly';
  return sub.plan === 'pro' ? 'pro' : 'free';
}
// Their licence at a glance — the most serious state wins.
function licenceOf(sub) {
  if (!sub) return 'clear';
  if (sub.access_status === 'banned')    return 'banned';
  if (sub.access_status === 'suspended') return 'suspended';
  if (sub.sharing_state === 'blocked')   return 'paused';
  if (sub.sharing_state === 'warned')    return 'warned';
  return 'clear';
}
const SUB_COLS = 'user_id,plan,plan_key,status,sharing_state,access_status';

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

// ── Timing ──────────────────────────────────────────────────────
// So speed is measured, not guessed. Every support request carries its
// server time in a Server-Timing header (visible in the browser's network
// panel). Anything slower than 0.7 s is logged as "[SUPPORT] slow: ...";
// set SUPPORT_TIMING=all on Railway to log every request while you watch.
const SLOW_MS = 700;
function timing(req, res, next) {
  const t0 = process.hrtime.bigint();
  const ms = () => Number(process.hrtime.bigint() - t0) / 1e6;
  const writeHead = res.writeHead;
  res.writeHead = function () {
    try { res.setHeader('Server-Timing', 'app;dur=' + ms().toFixed(0)); } catch (e) {}
    return writeHead.apply(this, arguments);
  };
  res.on('finish', () => {
    const t = Math.round(ms());
    const path = req.originalUrl.split('?')[0].replace(/[0-9a-f-]{36}/gi, ':id');
    if (process.env.SUPPORT_TIMING === 'all') console.log(`[SUPPORT] ${req.method} ${path} ${t} ms`);
    else if (t >= SLOW_MS) console.warn(`[SUPPORT] slow: ${req.method} ${path} ${t} ms`);
  });
  next();
}

// ═══════════════════════════════════════════════════════════════
//  CUSTOMER — /api/support/...
// ═══════════════════════════════════════════════════════════════
function customerRouter(requireAuth) {
  const r = express.Router();
  r.use('/api/support', timing, requireAuth);

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
        upd.stage = 'review'; upd.waiting_since = null; upd.reminded_at = null;
        await system(t.id, `Moved to ${stageName(t.topic, 'review')} after a reply`);
      }
      await patch('support_threads', `id=eq.${t.id}`, upd);
      res.json({ thread: await loadThread(t.id, false) });
    } catch (e) { fail(res, e, 'reply'); }
  });

  // Their own conversation, or nothing — the same rule as every route here.
  async function ownThread(req) {
    if (!isUuid(req.params.id)) return null;
    const [t] = await rows('support_threads', `id=eq.${req.params.id}&user_id=eq.${req.user.id}&select=*`);
    return t || null;
  }

  // "Yes — mark as solved". Any topic EXCEPT a licence review: that one is
  // tied to their access being restored, and a paused customer who closed
  // it would be closing the one conversation that gets them unlocked.
  r.post('/api/support/threads/:id/resolve', async (req, res) => {
    try {
      const t = await ownThread(req);
      if (!t) return res.status(404).json({ error: 'Not found' });
      if (t.topic === 'licence') return res.status(400).json({ error: 'A licence review is closed for you once your review is complete' });
      if (t.stage === 'resolved') return res.json({ thread: await loadThread(t.id, false) });
      const now = new Date().toISOString();
      await Promise.all([
        system(t.id, 'Marked as solved by the customer'),
        patch('support_threads', `id=eq.${t.id}`, { stage: 'resolved', resolved_at: now, resolved_by: 'customer',
          rating: null, rated_at: null, waiting_since: null, reminded_at: null, unread_admin: true, last_message_at: now })
      ]);
      res.json({ thread: await loadThread(t.id, false) });
    } catch (e) { fail(res, e, 'resolve'); }
  });

  // "Did this solve it?" — once, while it is resolved.
  r.post('/api/support/threads/:id/rate', async (req, res) => {
    try {
      const t = await ownThread(req);
      if (!t) return res.status(404).json({ error: 'Not found' });
      const rating = req.body && req.body.rating;
      if (rating !== 'yes' && rating !== 'no') return res.status(400).json({ error: 'Choose yes or no' });
      if (t.stage !== 'resolved') return res.status(409).json({ error: 'This conversation is still open' });
      if (t.rating) return res.status(409).json({ error: 'You have already told us — thank you' });
      await Promise.all([
        system(t.id, rating === 'yes' ? 'Customer says this solved it 👍' : 'Customer says this did not solve it 👎'),
        patch('support_threads', `id=eq.${t.id}`, { rating, rated_at: new Date().toISOString(), unread_admin: true })
      ]);
      res.json({ thread: await loadThread(t.id, false) });
    } catch (e) { fail(res, e, 'rate'); }
  });

  // Reopen — within 7 days of it being resolved. After that it is closed
  // for good, and something new starts a new conversation.
  r.post('/api/support/threads/:id/reopen', async (req, res) => {
    try {
      const t = await ownThread(req);
      if (!t) return res.status(404).json({ error: 'Not found' });
      if (t.stage !== 'resolved') return res.json({ thread: await loadThread(t.id, false) });
      if (!t.resolved_at || Date.now() - Date.parse(t.resolved_at) >= REOPEN_DAYS * DAY) {
        return res.status(409).json({ error: 'This conversation closed more than 7 days ago. Something new? Start a new message.' });
      }
      const open = await rows('support_threads', `user_id=eq.${req.user.id}&stage=neq.resolved&select=id`);
      if (open.length >= MAX_OPEN_THREADS) {
        return res.status(429).json({ error: `You have ${open.length} open conversations — please reply in one of those` });
      }
      const now = new Date().toISOString();
      await Promise.all([system(t.id, 'Reopened by the customer'),
      patch('support_threads', `id=eq.${t.id}`, { stage: 'review', resolved_at: null, resolved_by: null,
        rating: null, rated_at: null, unread_admin: true, last_message_at: now,
        reopened_count: (t.reopened_count || 0) + 1 })]);
      res.json({ thread: await loadThread(t.id, false) });
    } catch (e) { fail(res, e, 'reopen'); }
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

// ── Shared by your Inbox and the agents' Inbox ───────────────────
// One copy of the reply and stage logic, so the two Inboxes can never
// drift apart. The only difference is WHO is acting:
//   { adminEmail }  — you
//   { agentId }     — a support agent
// What each side may SEE is decided elsewhere (loadThread + forAgent).
async function doReply(t, input, actor) {
  const body = clean(input && input.body, 5000);
  const atts = await verifyAttachments(t.user_id, input && input.attachments, 'admin');
  if (!body && !atts.length) throw httpErr(400, 'Write a reply first');
  await addMessage(t.id, 'admin', body, atts, t.user_id, actor.adminEmail || null, actor.agentId || null);
  const upd = { unread_user: true, last_message_at: new Date().toISOString() };
  if (input && input.ask && t.stage !== 'waiting') {
    upd.stage = 'waiting'; upd.resolved_at = null;
    upd.waiting_since = new Date().toISOString(); upd.reminded_at = null;   // starts the reminder clock
    await system(t.id, 'Moved to Waiting on you');
  } else if (t.stage === 'received') {
    upd.stage = 'review';
    await system(t.id, `Moved to ${stageName(t.topic, 'review')}`);
  }
  await patch('support_threads', `id=eq.${t.id}`, upd);
  notifyCustomer(t.user_id, upd.stage === 'waiting' ? 'waiting' : 'reply', t.subject);
  return upd;
}
async function doStage(t, stage) {
  if (t.stage === stage) return false;
  await Promise.all([system(t.id, `Moved to ${stageName(t.topic, stage)}`),
  patch('support_threads', `id=eq.${t.id}`, {
    stage, unread_user: true, last_message_at: new Date().toISOString(),
    resolved_at: stage === 'resolved' ? new Date().toISOString() : null,
    // Resolving records who closed it and asks "Did this solve it?"
    // afresh; waiting starts the reminder clock; anything else stops it.
    resolved_by: stage === 'resolved' ? 'admin' : null,
    rating: stage === 'resolved' ? null : t.rating,
    waiting_since: stage === 'waiting' ? new Date().toISOString() : null,
    reminded_at: null
  })]);
  // Only the moves a customer needs to act on, or would want to know
  // about, send an email — clicking through stages must not spam them.
  if (stage === 'waiting' || stage === 'resolved') notifyCustomer(t.user_id, stage, t.subject);
  return true;
}

// ═══════════════════════════════════════════════════════════════
//  ADMIN — mounted inside admin-route.js, after requireAdmin.
// ═══════════════════════════════════════════════════════════════
function adminRouter({ audit, licenceSharing }) {
  const r = express.Router();
  r.use(['/api/support', '/api/support-saved', '/api/support-files'], timing);

  // The inbox. Filters match the prototype's buttons.
  r.get('/api/support', async (req, res) => {
    try {
      const f = String(req.query.filter || 'open');
      const q = f === 'all' ? '' : f === 'waiting' ? '&stage=eq.waiting' : f === 'licence' ? '&topic=eq.licence'
              : f === 'resolved' ? '&stage=eq.resolved' : '&stage=neq.resolved';
      // The Inbox now asks for everything once and filters in the page, so
      // switching filters is instant; 'all' carries the 500 most recent.
      const [list, open] = await Promise.all([
        rows('support_threads',
          `select=id,user_id,topic,subject,stage,unread_admin,last_message_at,rating,waiting_since,reminded_at,resolved_by,escalated_at,escalated_by${q}` +
          `&order=last_message_at.desc&limit=${f === 'all' ? 500 : 200}`),
        rows('support_threads', `stage=neq.resolved&select=id`)
      ]);
      const ids = [...new Set(list.map(t => t.user_id))];
      const names = await agentNames();
      // Names come from a 10-minute cache; plans and licence state from ONE
      // query for the whole list — not one per customer, every 30 seconds.
      const who = {};
      await Promise.all(ids.map(async uid => { who[uid] = await person(uid); }));
      const subs = {};
      if (ids.length) (await rows('subscriptions', `user_id=in.(${ids.join(',')})&select=${SUB_COLS}`))
        .forEach(x => { subs[x.user_id] = x; });
      res.json({
        openCount: open.length,
        threads: list.map(t => ({ id: t.id, userId: t.user_id, topic: t.topic, subject: t.subject, stage: t.stage,
          unread: t.unread_admin, lastMessageAt: t.last_message_at,
          email: who[t.user_id]?.email || null, lastName: who[t.user_id]?.lastName || null,
          plan: planOf(subs[t.user_id]), planActive: !subs[t.user_id] || subs[t.user_id].status !== 'expired',
          licence: licenceOf(subs[t.user_id]),
          rating: t.rating || null, resolvedBy: t.resolved_by || null,
          waitingSince: t.waiting_since || null, remindedAt: t.reminded_at || null,
          // Passed to you by an agent; and whether agents can see it at all.
          escalatedAt: t.escalated_at || null, escalatedBy: t.escalated_by ? (names[t.escalated_by] || 'a removed agent') : null,
          agentsSee: agentMay(t) }))
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
      const [sub] = await rows('subscriptions', `user_id=eq.${t.userId}&select=${SUB_COLS}`);
      const p = await person(t.userId);
      res.json({ thread: { ...t, unread: false },
        customer: { email: p.email, lastName: p.lastName, plan: planOf(sub),
                    planActive: !sub || sub.status !== 'expired', licence: licenceOf(sub) },
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
      const upd = await doReply(t, req.body, { adminEmail: req.admin && req.admin.email });
      audit({ req, action: 'support.reply', targetUser: t.user_id, note: `reply on "${t.subject}"${upd.stage ? ' → ' + STAGE_LABEL[upd.stage] : ''}` });
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
      if (await doStage(t, stage)) {
        audit({ req, action: 'support.stage', targetUser: t.user_id, note: `"${t.subject}" → ${STAGE_LABEL[stage]}` });
      }
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
        { stage: 'resolved', resolved_at: now, resolved_by: 'admin', rating: null,
          waiting_since: null, reminded_at: null, unread_user: true, last_message_at: now });
      audit({ req, action: 'support.restore', targetUser: t.user_id,
              note: `licence review "${t.subject}" — access restored after review` });
      notifyCustomer(t.user_id, 'restored', t.subject);
      res.json({ thread: await loadThread(t.id, true) });
    } catch (e) { fail(res, e, 'restore'); }
  });

  // ── Saved replies ──────────────────────────────────────────────
  // Choosing one in the Inbox only puts it in the reply box; nothing is
  // ever sent from here.
  r.get('/api/support-saved', async (req, res) => {
    try {
      const list = await rows('support_saved_replies', 'select=id,body&order=created_at.asc');
      res.json({ replies: list });
    } catch (e) { fail(res, e, 'saved list'); }
  });
  r.post('/api/support-saved', async (req, res) => {
    try {
      const body = clean(req.body && req.body.body, 2000);
      if (!body) return res.status(400).json({ error: 'Type the reply first, then save it' });
      const dup = await rows('support_saved_replies', `body=eq.${encodeURIComponent(body)}&select=id`);
      if (dup.length) return res.json({ reply: dup[0], existed: true });
      const saved = await insert('support_saved_replies', { body, created_by: req.admin && req.admin.email || null });
      audit({ req, action: 'support.saved_add', note: body.slice(0, 120) });
      res.status(201).json({ reply: { id: saved.id, body: saved.body } });
    } catch (e) { fail(res, e, 'saved add'); }
  });
  r.delete('/api/support-saved/:id', async (req, res) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Not found' });
      await axios.delete(`${REST}/support_saved_replies?id=eq.${req.params.id}`, { headers: headers(), timeout: 10000 });
      audit({ req, action: 'support.saved_remove', note: req.params.id });
      res.json({ ok: true });
    } catch (e) { fail(res, e, 'saved remove'); }
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
//  AGENTS — mounted at /support, behind requireAgent (agent-auth.js).
//
// THE WHOLE PROTECTION IS IN TWO FUNCTIONS:
//   agentMay(t)  — which conversations exist for an agent at all.
//                  Never a licence review, never one passed to you.
//                  Anything else answers 404, as if it did not exist.
//   forAgent(…)  — what an agent receives. Built FIELD BY FIELD from an
//                  allow-list, never by copying your view and deleting
//                  the sensitive parts: a field added to the database
//                  later is then left out by default, not leaked by
//                  default. No licence key, no full email, no sharing
//                  evidence, no payments, no customer id, no admin email.
// ═══════════════════════════════════════════════════════════════
const agentMay = t => !!t && t.topic !== 'licence' && !t.escalated_at;
function maskEmail(e) {
  const [u, d] = String(e || '').split('@');
  return u && d ? u[0] + '•••@' + d : null;
}
function forAgentCustomer(p, sub) {
  return { name: [p.name, p.lastName].filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).join(' ') || 'Customer',
           email: maskEmail(p.email), plan: planOf(sub), planActive: !sub || sub.status !== 'expired',
           // The status only — never why.
           status: licenceOf(sub) };
}
function forAgentThread(t) {
  return {
    id: t.id, topic: t.topic, subject: t.subject, stage: t.stage,
    createdAt: t.createdAt, lastMessageAt: t.lastMessageAt, resolvedAt: t.resolvedAt,
    rating: t.rating, resolvedBy: t.resolvedBy, waitingSince: t.waitingSince, remindedAt: t.remindedAt,
    reopenedCount: t.reopenedCount,
    messages: t.messages.map(m => ({
      id: m.id, from: m.from, text: m.text, at: m.at,
      // Who on the team wrote it: an agent's name, or "the owner" — never your email.
      ...(m.from === 'admin' ? { by: m.agentId ? m.by : 'the owner' } : {}),
      attachments: (m.attachments || []).map(a => ({ id: a.id, name: a.name, type: a.type, size: a.size }))
    }))
  };
}
function agentAudit(req, action, targetUser, note) {
  axios.post(`${REST}/admin_audit`, { actor_email: req.agent.email, action, target_user: targetUser || null,
      note: note ? `${note} — agent ${req.agent.name}` : `agent ${req.agent.name}`, ip: (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || null },
    { headers: headers({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }), timeout: 6000 })
    .catch(() => {});
}

function agentRouter({ requireAgent }) {
  const r = express.Router();
  r.use('/api', express.json({ limit: '64kb' }), timing, requireAgent);

  async function visible(req) {
    if (!isUuid(req.params.id)) return null;
    const [t] = await rows('support_threads', `id=eq.${req.params.id}&select=*`);
    return agentMay(t) ? t : null;
  }

  // The agent's list. Licence reviews and passed-on conversations are
  // excluded by the database query itself, not filtered afterwards.
  r.get('/api/threads', async (req, res) => {
    try {
      const list = await rows('support_threads',
        'topic=neq.licence&escalated_at=is.null' +
        '&select=id,user_id,topic,subject,stage,unread_admin,last_message_at,rating,waiting_since,reminded_at,resolved_by' +
        '&order=last_message_at.desc&limit=500');
      const ids = [...new Set(list.map(t => t.user_id))];
      const who = {}, subs = {};
      await Promise.all(ids.map(async u => { who[u] = await person(u); }));
      if (ids.length) (await rows('subscriptions', `user_id=in.(${ids.join(',')})&select=${SUB_COLS}`)).forEach(x => { subs[x.user_id] = x; });
      res.json({
        openCount: list.filter(t => t.stage !== 'resolved').length,
        threads: list.map(t => ({ id: t.id, topic: t.topic, subject: t.subject, stage: t.stage, unread: t.unread_admin,
          lastMessageAt: t.last_message_at, rating: t.rating || null, resolvedBy: t.resolved_by || null,
          waitingSince: t.waiting_since || null, remindedAt: t.reminded_at || null,
          customer: forAgentCustomer(who[t.user_id] || {}, subs[t.user_id]) }))
      });
    } catch (e) { fail(res, e, 'agent inbox'); }
  });

  r.get('/api/threads/:id', async (req, res) => {
    try {
      const t = await visible(req);
      if (!t) return res.status(404).json({ error: 'Not found' });
      if (t.unread_admin) await patch('support_threads', `id=eq.${t.id}`, { unread_admin: false });
      const [full, p, [sub]] = await Promise.all([loadThread(t.id, true), person(t.user_id),
        rows('subscriptions', `user_id=eq.${t.user_id}&select=${SUB_COLS}`)]);
      res.json({ thread: forAgentThread(full), customer: forAgentCustomer(p, sub) });
    } catch (e) { fail(res, e, 'agent read'); }
  });

  r.post('/api/threads/:id/uploads', async (req, res) => {
    try {
      const t = await visible(req);
      if (!t) return res.status(404).json({ error: 'Not found' });
      const why = checkFiles(req.body && req.body.files);
      if (why) return res.status(400).json({ error: why });
      const uploads = [];
      for (const f of req.body.files) {
        const path = `${t.user_id}/admin-${crypto.randomUUID()}.${TYPES[f.type]}`;
        uploads.push({ path, name: cleanName(f.name), uploadUrl: await signUpload(path) });
      }
      res.json({ uploads });
    } catch (e) { fail(res, e, 'agent uploads'); }
  });

  r.post('/api/threads/:id/reply', async (req, res) => {
    try {
      const t = await visible(req);
      if (!t) return res.status(404).json({ error: 'Not found' });
      const upd = await doReply(t, req.body, { agentId: req.agent.id });
      agentAudit(req, 'agent.reply', t.user_id, `reply on "${t.subject}"${upd.stage ? ' → ' + STAGE_LABEL[upd.stage] : ''}`);
      res.json({ thread: forAgentThread(await loadThread(t.id, true)) });
    } catch (e) { fail(res, e, 'agent reply'); }
  });

  r.post('/api/threads/:id/stage', async (req, res) => {
    try {
      const stage = String(req.body && req.body.stage || '');
      if (!STAGES.includes(stage)) return res.status(400).json({ error: 'Unknown stage' });
      const t = await visible(req);
      if (!t) return res.status(404).json({ error: 'Not found' });
      if (await doStage(t, stage)) agentAudit(req, 'agent.stage', t.user_id, `"${t.subject}" → ${STAGE_LABEL[stage]}`);
      res.json({ thread: forAgentThread(await loadThread(t.id, true)) });
    } catch (e) { fail(res, e, 'agent stage'); }
  });

  // Pass to owner. The conversation leaves every agent's Inbox for good.
  // No message is added: the customer sees nothing change.
  r.post('/api/threads/:id/pass', async (req, res) => {
    try {
      const t = await visible(req);
      if (!t) return res.status(404).json({ error: 'Not found' });
      await patch('support_threads', `id=eq.${t.id}`, { escalated_at: new Date().toISOString(), escalated_by: req.agent.id,
                                                       unread_admin: true });
      agentAudit(req, 'agent.pass', t.user_id, `passed "${t.subject}" to the owner`);
      res.json({ ok: true });
    } catch (e) { fail(res, e, 'agent pass'); }
  });

  // A five-minute viewing link — only for files in a conversation the
  // agent may see.
  r.get('/api/files/:id', async (req, res) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Not found' });
      const [a] = await rows('support_attachments', `id=eq.${req.params.id}&select=storage_path,thread_id`);
      if (!a) return res.status(404).json({ error: 'Not found' });
      const [t] = await rows('support_threads', `id=eq.${a.thread_id}&select=topic,escalated_at`);
      if (!agentMay(t)) return res.status(404).json({ error: 'Not found' });
      res.json({ url: await signDownload(a.storage_path), expiresIn: DOWNLOAD_LINK_SECS });
    } catch (e) { fail(res, e, 'agent file'); }
  });

  // Saved replies: agents use them and can add their own; only you remove.
  r.get('/api/saved', async (req, res) => {
    try { res.json({ replies: await rows('support_saved_replies', 'select=id,body&order=created_at.asc') }); }
    catch (e) { fail(res, e, 'agent saved'); }
  });
  r.post('/api/saved', async (req, res) => {
    try {
      const body = clean(req.body && req.body.body, 2000);
      if (!body) return res.status(400).json({ error: 'Type the reply first, then save it' });
      const dup = await rows('support_saved_replies', `body=eq.${encodeURIComponent(body)}&select=id,body`);
      if (dup.length) return res.json({ reply: dup[0], existed: true });
      const saved = await insert('support_saved_replies', { body, created_by: req.agent.email });
      res.status(201).json({ reply: { id: saved.id, body: saved.body } });
    } catch (e) { fail(res, e, 'agent saved add'); }
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

// ═══════════════════════════════════════════════════════════════
//  WAITING ON THE CUSTOMER — 00:45 UTC.
//   3 days of silence → one reminder email
//   7 days of silence → closed, and the customer is told (they can still
//                       reopen it for 7 days)
//   A LICENCE REVIEW is reminded but never closed: closing it would leave
//   a paused customer with no open conversation and no dashboard.
// ═══════════════════════════════════════════════════════════════
async function staleSweep(nowMs) {
  if (!SUPABASE_URL || !SUPABASE_SVC) return { reminded: 0, closed: 0 };
  const now = nowMs || Date.now();
  const waiting = await rows('support_threads',
    `stage=eq.waiting&waiting_since=not.is.null&select=id,user_id,topic,subject,waiting_since,reminded_at`);
  let reminded = 0, closed = 0;
  for (const t of waiting) {
    const days = (now - Date.parse(t.waiting_since)) / DAY;
    try {
      if (days >= CLOSE_DAYS && t.topic !== 'licence') {
        const at = new Date(now).toISOString();
        await system(t.id, `Closed automatically — no reply for ${CLOSE_DAYS} days`);
        await patch('support_threads', `id=eq.${t.id}`, { stage: 'resolved', resolved_at: at, resolved_by: 'system',
          rating: null, rated_at: null, waiting_since: null, unread_user: true, last_message_at: at });
        notifyCustomer(t.user_id, 'autoclosed', t.subject);
        closed++;
      } else if (days >= REMIND_DAYS && !t.reminded_at) {
        await system(t.id, 'Reminder emailed — still waiting on the customer');
        await patch('support_threads', `id=eq.${t.id}`, { reminded_at: new Date(now).toISOString(), unread_user: true });
        notifyCustomer(t.user_id, 'reminder', t.subject);
        reminded++;
      }
    } catch (e) { console.warn('[SUPPORT] stale sweep:', t.id, e.message); }
  }
  if (reminded || closed) console.log(`[SUPPORT] waiting sweep: ${reminded} reminded, ${closed} closed`);
  return { reminded, closed };
}

function start() {
  cron.schedule('40 0 * * *', () => cleanUp().catch(e => console.warn('[SUPPORT] clean-up failed:', e.message)));
  cron.schedule('45 0 * * *', () => staleSweep().catch(e => console.warn('[SUPPORT] waiting sweep failed:', e.message)));
  console.log('[SUPPORT] nightly clean-up 00:40 UTC, waiting sweep 00:45 UTC');
}

module.exports = {
  customerRouter, adminRouter, agentRouter, forgetAgentNames, agentMay, forAgentThread, forAgentCustomer, maskEmail, start, cleanUp, staleSweep, planOf, licenceOf, stageName,
  // exported for tests
  checkFiles, verifyAttachments, RESTORE_TEXT, STAGES, TOPICS, MAX_FILES, MAX_BYTES
};
