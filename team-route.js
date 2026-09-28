// ═══════════════════════════════════════════════════════════════
// team-route.js — Team chat: you and your support agents.
//
// Built from the approved prototype (team-chat-prototype.html).
// Needs migration-team-chat.sql.
//
//   you     /admin/api/team-chat/...    behind requireAdmin (admin-route.js)
//   agents  /support/api/team-chat/...  behind requireAgent (agent-auth.js)
//
// Two kinds of chat:
//   'team'          — you and every agent
//   'dm:<agent id>' — you and ONE agent. No other agent can read it.
//
// THE PROTECTION IS IN TWO PLACES:
//   mayRead(actor, chat) — which chats a person can reach at all. An
//       agent: the Team room and their own private chat, nothing else.
//       Anything else answers 404, as if it did not exist.
//   card(actor, thread)  — what a message's customer conversation shows.
//       You: the customer's name and full email. An agent: masked, as in
//       their Inbox — and NOTHING about it (not even its subject) once it
//       is a conversation only you handle.
// Customers never reach any of this.
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const axios   = require('axios');
const crypto  = require('crypto');
const SR = require('./support-route');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim();
const SUPABASE_SVC = process.env.SUPABASE_SERVICE_ROLE_KEY;
const REST = `${SUPABASE_URL}/rest/v1`;
const REMIND_MS = 15 * 60 * 1000;

function headers(extra = {}) {
  const isNew = String(SUPABASE_SVC || '').startsWith('sb_secret_');
  return { apikey: SUPABASE_SVC, ...(isNew ? {} : { Authorization: `Bearer ${SUPABASE_SVC}` }), ...extra };
}
async function rows(table, q) { const { data } = await axios.get(`${REST}/${table}?${q}`, { headers: headers(), timeout: 10000 }); return data || []; }
async function insert(table, row) {
  const { data } = await axios.post(`${REST}/${table}`, row,
    { headers: headers({ 'Content-Type': 'application/json', Prefer: 'return=representation' }), timeout: 10000 });
  return Array.isArray(data) ? data[0] : data;
}
async function patch(table, q, body) {
  await axios.patch(`${REST}/${table}?${q}`, body, { headers: headers({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }), timeout: 10000 });
}
async function upsert(table, row) {
  await axios.post(`${REST}/${table}`, row,
    { headers: headers({ 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }), timeout: 10000 });
}
async function remove(table, q) { await axios.delete(`${REST}/${table}?${q}`, { headers: headers(), timeout: 10000 }); }

function httpErr(status, message) { const e = new Error(message); e.status = status; return e; }
function fail(res, e, where) {
  if (e.status) return res.status(e.status).json({ error: e.message });
  console.error(`[TEAM] ${where}:`, e.response?.data || e.message);
  res.status(502).json({ error: 'Something went wrong on our side — please try again' });
}

// ── Chats and who may read them ─────────────────────────────────
const CHAT = /^(team|dm:[0-9a-f-]{36})$/i;
const agentOf = chat => chat.startsWith('dm:') ? chat.slice(3) : null;
const where = chat => chat === 'team' ? 'channel=eq.team' : `channel=eq.dm&channel_agent_id=eq.${agentOf(chat)}`;
const dirOf = chat => chat === 'team' ? 'team' : 'dm-' + agentOf(chat);
const readerOf = actor => actor.owner ? 'owner' : actor.agentId;
function mayRead(actor, chat) {
  if (!CHAT.test(String(chat || ''))) return false;
  if (actor.owner) return true;
  return chat === 'team' || chat === 'dm:' + actor.agentId;
}

let agentCache = { at: 0, list: [] };
async function agents() {
  if (Date.now() - agentCache.at < 60000) return agentCache.list;
  agentCache = { at: Date.now(), list: await rows('support_agents', 'select=id,name,active&order=created_at.asc') };
  return agentCache.list;
}
function forgetAgents() { agentCache.at = 0; }
async function nameOf(id) { const a = (await agents()).find(x => x.id === id); return a ? a.name : 'a removed agent'; }

// ── What a customer conversation shows, per reader ──────────────
async function cards(actor, ids) {
  const out = {};
  if (!ids.length) return out;
  const threads = await rows('support_threads', `id=in.(${ids.join(',')})&select=id,user_id,topic,subject,stage,escalated_at`);
  await Promise.all(threads.map(async t => {
    const visible = SR.agentMay(t);
    if (!actor.owner && !visible) { out[t.id] = { id: t.id, withOwner: true }; return; }   // nothing — not even the subject
    const p = await SR.person(t.user_id);
    const name = [p.name, p.lastName].filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).join(' ') || 'Customer';
    out[t.id] = { id: t.id, subject: t.subject, stage: visible ? SR.stageName(t.topic, t.stage) : 'With the owner',
      withOwner: !visible, customer: { name, email: actor.owner ? p.email : SR.maskEmail(p.email) } };
  }));
  return out;
}

async function loadChat(actor, chat) {
  const list = (await rows('team_messages',
    `${where(chat)}&select=id,author,author_agent_id,body,thread_ref,created_at&order=created_at.desc&limit=200`)).reverse();
  const ids = list.map(m => m.id);
  const atts = ids.length ? await rows('team_attachments', `message_id=in.(${ids.join(',')})&select=id,message_id,file_name,mime_type,size_bytes`) : [];
  const byMsg = {};
  for (const a of atts) (byMsg[a.message_id] = byMsg[a.message_id] || []).push({ id: a.id, name: a.file_name, type: a.mime_type, size: a.size_bytes });
  const refs = await cards(actor, [...new Set(list.map(m => m.thread_ref).filter(Boolean))]);
  const out = [];
  for (const m of list) {
    const mine = actor.owner ? m.author === 'owner' : (m.author === 'agent' && m.author_agent_id === actor.agentId);
    out.push({ id: m.id, from: m.author, mine, text: m.body, at: m.created_at,
      by: m.author === 'owner' ? 'the owner' : m.author === 'agent' ? await nameOf(m.author_agent_id) : null,
      attachments: byMsg[m.id] || [], ref: m.thread_ref ? (refs[m.thread_ref] || null) : null });
  }
  return out;
}

async function chatsFor(actor) {
  const keys = actor.owner ? ['team', ...(await agents()).map(a => 'dm:' + a.id)] : ['team', 'dm:' + actor.agentId];
  const reads = await rows('team_reads', `reader=eq.${readerOf(actor)}&select=chat,last_read_at`);
  const lastRead = Object.fromEntries(reads.map(r => [r.chat, r.last_read_at]));
  const all = await agents();
  return Promise.all(keys.map(async chat => {
    const since = lastRead[chat] || '1970-01-01T00:00:00Z';
    const [[last], newer] = await Promise.all([
      rows('team_messages', `${where(chat)}&select=body,author,created_at&order=created_at.desc&limit=1`),
      rows('team_messages', `${where(chat)}&created_at=gt.${encodeURIComponent(since)}&select=author,author_agent_id&limit=500`)
    ]);
    const unread = newer.filter(m => actor.owner ? m.author !== 'owner' : !(m.author === 'agent' && m.author_agent_id === actor.agentId)).length;
    const a = agentOf(chat) ? all.find(x => x.id === agentOf(chat)) : null;
    return { chat, unread, last: last ? { text: last.body, at: last.created_at } : null,
      title: chat === 'team' ? 'Team room' : actor.owner ? (a ? a.name : 'A removed agent') : 'You & the owner',
      ...(a && actor.owner && !a.active ? { disabled: true } : {}) };
  }));
}

// Files the sender says they uploaded — only accepted from THIS chat's
// folder, and only if Storage really has them within the limits.
async function verifyFiles(chat, list) {
  if (!list || !list.length) return [];
  if (!Array.isArray(list) || list.length > 5) throw httpErr(400, 'Up to 5 files per message');
  const dir = dirOf(chat), out = [], seen = new Set();
  for (const a of list) {
    const path = String(a && a.path || '');
    const m = /^team\/(team|dm-[0-9a-f-]{36})\/([0-9a-f-]{36}\.(png|jpg|webp|gif|pdf))$/i.exec(path);
    if (!m || m[1] !== dir || seen.has(path)) throw httpErr(400, 'An attachment was not recognised');
    seen.add(path);
    const found = (await SR.listFolder(`team/${dir}/`, m[2])).find(o => o.name === m[2]);
    if (!found) throw httpErr(400, `${SR.cleanName(a.name)} did not finish uploading — please try again`);
    const size = Number(found.metadata && found.metadata.size), mime = found.metadata && found.metadata.mimetype;
    if (!SR.TYPES[mime] || !(size > 0) || size > 10 * 1024 * 1024) throw httpErr(400, `${SR.cleanName(a.name)} is not an accepted file`);
    out.push({ storage_path: path, file_name: SR.cleanName(a.name), mime_type: mime, size_bytes: size });
  }
  return out;
}

// ── Emails to you: one per burst, one reminder at 15 minutes ────
function mail(kind, chat, who) {
  const to = (process.env.ADMIN_EMAIL || '').trim();
  const svc = require('./email-service');
  if (!to || !svc.sendTeamAlert) return;
  Promise.resolve(svc.sendTeamAlert(to, { kind, who, where: chat === 'team' ? 'team' : 'private' }))
    .catch(e => console.warn('[TEAM] email failed:', e.message));
}
async function agentWrote(chat, agentId) {
  const [st] = await rows('team_mail_state', `chat=eq.${encodeURIComponent(chat)}&select=chat`);
  if (st) return;                                       // already emailed for this burst
  await upsert('team_mail_state', { chat, burst_at: new Date().toISOString(), reminded_at: null });
  mail('new', chat, await nameOf(agentId));
}
async function ownerAnswered(chat) { await remove('team_mail_state', `chat=eq.${encodeURIComponent(chat)}`); }
async function reminders() {
  if (!SUPABASE_URL || !SUPABASE_SVC) return 0;
  const due = await rows('team_mail_state',
    `reminded_at=is.null&burst_at=lte.${encodeURIComponent(new Date(Date.now() - REMIND_MS).toISOString())}&select=chat`);
  for (const d of due) {
    try {
      await patch('team_mail_state', `chat=eq.${encodeURIComponent(d.chat)}`, { reminded_at: new Date().toISOString() });
      const [last] = await rows('team_messages', `${where(d.chat)}&author=eq.agent&select=author_agent_id&order=created_at.desc&limit=1`);
      mail('reminder', d.chat, last ? await nameOf(last.author_agent_id) : 'An agent');
    } catch (e) { console.warn('[TEAM] reminder:', e.message); }
  }
  return due.length;
}

// ── The routes, the same for both sides ─────────────────────────
function routes(r, base, actorOf, { audit } = {}) {
  const A = req => actorOf(req);

  r.get(base, async (req, res) => {
    try { res.json({ chats: await chatsFor(A(req)) }); } catch (e) { fail(res, e, 'chats'); }
  });
  r.get(`${base}/:chat`, async (req, res) => {
    try {
      const actor = A(req), chat = req.params.chat;
      if (!mayRead(actor, chat)) return res.status(404).json({ error: 'Not found' });
      res.json({ chat, messages: await loadChat(actor, chat) });
    } catch (e) { fail(res, e, 'read chat'); }
  });
  r.post(`${base}/:chat/read`, async (req, res) => {
    try {
      const actor = A(req), chat = req.params.chat;
      if (!mayRead(actor, chat)) return res.status(404).json({ error: 'Not found' });
      await upsert('team_reads', { reader: readerOf(actor), chat, last_read_at: new Date().toISOString() });
      res.json({ ok: true });
    } catch (e) { fail(res, e, 'mark read'); }
  });
  r.post(`${base}/:chat/uploads`, async (req, res) => {
    try {
      const actor = A(req), chat = req.params.chat;
      if (!mayRead(actor, chat)) return res.status(404).json({ error: 'Not found' });
      const why = SR.checkFiles(req.body && req.body.files);
      if (why) return res.status(400).json({ error: why });
      const uploads = [];
      for (const f of req.body.files) {
        const path = `team/${dirOf(chat)}/${crypto.randomUUID()}.${SR.TYPES[f.type]}`;
        uploads.push({ path, name: SR.cleanName(f.name), uploadUrl: await SR.signUpload(path) });
      }
      res.json({ uploads });
    } catch (e) { fail(res, e, 'uploads'); }
  });
  r.post(`${base}/:chat/send`, async (req, res) => {
    try {
      const actor = A(req), chat = req.params.chat;
      if (!mayRead(actor, chat)) return res.status(404).json({ error: 'Not found' });
      if (chat !== 'team' && !actor.owner && agentOf(chat) !== actor.agentId) return res.status(404).json({ error: 'Not found' });
      // A private chat must belong to a real agent — never an orphan nobody can see.
      if (chat !== 'team' && !(await agents()).some(a => a.id === agentOf(chat))) return res.status(404).json({ error: 'Not found' });
      const body = SR.clean(req.body && req.body.body, 5000);
      const files = await verifyFiles(chat, req.body && req.body.attachments);
      if (!body && !files.length) return res.status(400).json({ error: 'Write something first' });
      let ref = null;
      const want = req.body && req.body.threadRef;
      if (want) {
        if (!SR.isUuid(want)) return res.status(400).json({ error: 'That conversation was not recognised' });
        const [t] = await rows('support_threads', `id=eq.${want}&select=id,topic,escalated_at`);
        // An agent may only point at a conversation they can see.
        if (!t || (!actor.owner && !SR.agentMay(t))) return res.status(400).json({ error: 'That conversation was not recognised' });
        ref = t.id;
      }
      const msg = await insert('team_messages', {
        channel: chat === 'team' ? 'team' : 'dm', channel_agent_id: agentOf(chat),
        author: actor.owner ? 'owner' : 'agent', author_agent_id: actor.owner ? null : actor.agentId,
        body, thread_ref: ref });
      for (const f of files) await insert('team_attachments', { ...f, message_id: msg.id });
      await upsert('team_reads', { reader: readerOf(actor), chat, last_read_at: new Date().toISOString() });
      if (actor.owner) await ownerAnswered(chat); else await agentWrote(chat, actor.agentId);
      SR.teamChanged(chat);
      res.status(201).json({ chat, messages: await loadChat(actor, chat) });
    } catch (e) { fail(res, e, 'send'); }
  });
  r.get(`${base}-files/:id`, async (req, res) => {
    try {
      if (!SR.isUuid(req.params.id)) return res.status(404).json({ error: 'Not found' });
      const [a] = await rows('team_attachments', `id=eq.${req.params.id}&select=storage_path,message_id`);
      if (!a) return res.status(404).json({ error: 'Not found' });
      const [m] = await rows('team_messages', `id=eq.${a.message_id}&select=channel,channel_agent_id`);
      const chat = m && (m.channel === 'team' ? 'team' : 'dm:' + m.channel_agent_id);
      if (!chat || !mayRead(A(req), chat)) return res.status(404).json({ error: 'Not found' });
      res.json({ url: await SR.signDownload(a.storage_path), expiresIn: SR.DOWNLOAD_LINK_SECS });
    } catch (e) { fail(res, e, 'file'); }
  });

  // Take this conversation — yours only. The same as an agent passing it
  // to you: it leaves every agent's Inbox, and the customer sees nothing.
  if (audit) r.post(`${base}/:chat/take`, async (req, res) => {
    try {
      const chat = req.params.chat, id = req.body && req.body.threadRef;
      if (!mayRead({ owner: true }, chat) || !SR.isUuid(id)) return res.status(404).json({ error: 'Not found' });
      const [t] = await rows('support_threads', `id=eq.${id}&select=*`);
      if (!t) return res.status(404).json({ error: 'Not found' });
      if (!t.escalated_at) await patch('support_threads', `id=eq.${t.id}`, { escalated_at: new Date().toISOString() });
      await insert('team_messages', { channel: chat === 'team' ? 'team' : 'dm', channel_agent_id: agentOf(chat), author: 'system',
        body: `The owner took over "${t.subject}" — it has left the agents' Inbox.`, thread_ref: t.id });
      await ownerAnswered(chat);
      SR.changed({ ...t, escalated_at: new Date().toISOString() }, { tellAgents: true });
      SR.teamChanged(chat);
      audit({ req, action: 'teamchat.take', targetUser: t.user_id, note: `took over "${t.subject}" from Team chat` });
      res.json({ chat, messages: await loadChat({ owner: true }, chat) });
    } catch (e) { fail(res, e, 'take'); }
  });
}

function ownerRouter({ audit }) {
  const r = express.Router();
  routes(r, '/api/team-chat', () => ({ owner: true }), { audit });
  return r;
}
function agentRouter({ requireAgent }) {
  const r = express.Router();
  r.use(['/api/team-chat', '/api/team-chat-files'], express.json({ limit: '64kb' }), requireAgent);
  routes(r, '/api/team-chat', req => ({ agentId: req.agent.id }));
  return r;
}

let timer = null;
function start() {
  if (timer) return;
  timer = setInterval(() => reminders().catch(e => console.warn('[TEAM] reminders failed:', e.message)), 60 * 1000);
  if (timer.unref) timer.unref();
  console.log('[TEAM] Team chat reminders checked every minute');
}

module.exports = { ownerRouter, agentRouter, start, reminders, forgetAgents, mayRead };
