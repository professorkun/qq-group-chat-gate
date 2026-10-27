/**
 * qq-gate self-tune —— 采集当天群聊复盘素材
 *
 * 只读，零 token。把「群消息时间线 + 门闸判定 + 事后反应」合成一份
 * 紧凑 JSON，交给每天的复盘模型判断「哪些接得好、哪些不该接」。
 *
 * 用法：node collect.mjs [--date YYYY-MM-DD] [--out PATH]
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { CONFIG, DB, DIR, LOG, STATE } from '../src/paths.mjs';

const OUTDIR = join(DIR, 'self-tune/daily');
const MAX_CONVO = 200;
const TEXT_CAP = 140;

function argOf(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function pad(n) { return String(n).padStart(2, '0'); }
function hhmmss(ms) {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 本地日的 [start, end) epoch ms */
function dayWindow(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const start = new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
  return { start, end: start + 86400000 };
}

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

function readGateLog() {
  if (!existsSync(LOG)) return [];
  const out = [];
  for (const line of readFileSync(LOG, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch {}
  }
  return out;
}

function stripTags(text) {
  return String(text ?? '')
    .replace(/<faceType=[^>]*>/g, '[表情]')
    .replace(/<img[^>]*>/g, '[图片]')
    .replace(/<@!?[0-9A-Za-z_-]{6,}>/g, '@某人')
    .replace(/【群里刚才在聊[\s\S]*?】\n?/g, '')
    .replace(/\[表情\](?:\[表情\])+/g, '[表情]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, TEXT_CAP);
}

async function readMessages(start, end, dbPath) {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare(`SELECT group_id, sender_id, sender_name, sent_at, text
      FROM messages WHERE sent_at >= ? AND sent_at < ? ORDER BY sent_at ASC, id ASC`).all(start, end);
    return rows.map((r) => ({
      at: Number(r.sent_at),
      senderId: r.sender_id,
      sender: r.sender_name || '某人',
      text: String(r.text ?? ''),
      group: r.group_id,
    }));
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
}

/** 把门闸记录对到具体某条消息上（时间近 + 正文像） */
function attachGate(messages, gates) {
  const used = new Set();
  for (const g of gates) {
    const gt = Date.parse(g.at);
    if (!Number.isFinite(gt)) continue;
    let best = -1;
    let bestDiff = Infinity;
    for (let i = 0; i < messages.length; i += 1) {
      if (used.has(i)) continue;
      const diff = Math.abs(messages[i].at - gt);
      if (diff > 120000) continue;
      if (diff < bestDiff) { bestDiff = diff; best = i; }
    }
    if (best >= 0) {
      used.add(best);
      Object.assign(messages[best], {
        gate: g.pass ? 'pass' : 'block',
        score: g.score,
        why: Array.isArray(g.why) ? g.why : [],
        addressed: !!g.addressed,
      });
    } else {
      messages.push({
        at: gt, sender: g.sender || '某人', senderId: null,
        text: stripTags(g.text), gate: g.pass ? 'pass' : 'block',
        score: g.score, why: Array.isArray(g.why) ? g.why : [], addressed: !!g.addressed,
        orphan: true,
      });
    }
  }
  messages.sort((a, b) => a.at - b.at);
  return messages;
}

/** 采样：保证所有有 gate 判定的条目都在，其余均匀取 */
function sample(list, cap) {
  if (list.length <= cap) return list;
  const pinned = list.filter((m) => m.gate);
  const rest = list.filter((m) => !m.gate);
  const room = Math.max(0, cap - pinned.length);
  if (room === 0) return pinned.slice(-cap);
  const step = rest.length / room;
  const picked = [];
  for (let i = 0; i < room; i += 1) picked.push(rest[Math.floor(i * step)]);
  return [...pinned, ...picked].sort((a, b) => a.at - b.at);
}

function analyse(messages, gates, params) {
  const passed = gates.filter((g) => g.pass);
  const blocked = gates.filter((g) => !g.pass);

  // 被 @ 了却没放行 —— 最硬的漏判信号
  const addressedBlocked = blocked
    .filter((g) => g.addressed && !(g.why || []).includes('叫闭嘴'))
    .map((g) => ({ at: g.at, score: g.score, why: g.why, text: stripTags(g.text) }));

  // 放行之后十分钟内群里彻底没动静 —— 可能是多余的一句
  const passedNoActivity = [];
  for (const g of passed) {
    const gt = Date.parse(g.at);
    const next = messages.find((m) => m.at > gt + 5000);
    if (next && next.at - gt < 600000) continue;
    passedNoActivity.push({
      at: g.at, score: g.score, why: g.why, addressed: !!g.addressed,
      after: next ? `${next.sender}:${stripTags(next.text).slice(0, 40)}` : '(之后群里没人说话了)',
    });
  }

  const muted = gates.filter((g) => (g.why || []).includes('叫闭嘴'))
    .map((g) => ({ at: g.at, text: stripTags(g.text) }));
  const capHits = gates.filter((g) => (g.why || []).includes('今天说够了'))
    .map((g) => ({ at: g.at, score: g.score }));

  // 分数分布，帮模型判断阈值是不是卡在尴尬位置
  const scores = gates.map((g) => g.score).filter((s) => typeof s === 'number').sort((a, b) => a - b);
  const nearMiss = blocked
    .filter((g) => typeof g.score === 'number' && params && g.score >= params.threshold - 0.15)
    .map((g) => ({ at: g.at, score: g.score, why: g.why, text: stripTags(g.text).slice(0, 60) }));

  return {
    counts: {
      messages: messages.length,
      gateChecked: gates.length,
      passed: passed.length,
      blocked: blocked.length,
      addressedBlocked: addressedBlocked.length,
      passedNoActivity: passedNoActivity.length,
    },
    scores,
    addressedBlocked,
    passedNoActivity,
    muted,
    capHits,
    nearMiss,
  };
}

const date = argOf('date', todayLocal());
const outPath = argOf('out', join(OUTDIR, `${date}.json`));
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  console.error('bad --date, want YYYY-MM-DD');
  process.exit(2);
}

const { start, end } = dayWindow(date);
const params = readJson(CONFIG, {});
const state = readJson(STATE, {});
const gates = readGateLog().filter((g) => {
  const t = Date.parse(g.at);
  return Number.isFinite(t) && t >= start && t < end;
});

const raw = await readMessages(start, end, params.databasePath || DB);
if (!Array.isArray(raw)) {
  console.error('cannot read group history:', raw.error);
  process.exit(3);
}

const withGate = attachGate(raw, gates);
const signals = analyse(withGate, gates, params);

const conversation = sample(withGate, MAX_CONVO).map((m) => {
  const row = {
    t: hhmmss(m.at),
    who: m.sender,
    text: stripTags(m.text),
  };
  if (m.gate) {
    row.gate = m.gate;
    row.score = m.score;
    if (m.why && m.why.length) row.why = m.why;
  }
  return row;
});

const payload = {
  date,
  generatedAt: new Date().toISOString(),
  params,
  state: { replies: state.replies ?? null, sinceMyReply: state.sinceMyReply ?? null },
  signals,
  conversation,
  truncated: withGate.length > conversation.length,
};

mkdirSync(OUTDIR, { recursive: true });
writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({
  ok: true, date, out: outPath,
  messages: payload.signals.counts.messages,
  gateChecked: payload.signals.counts.gateChecked,
  passed: payload.signals.counts.passed,
  addressedBlocked: payload.signals.counts.addressedBlocked,
  passedNoActivity: payload.signals.counts.passedNoActivity,
  truncated: payload.truncated,
}));
