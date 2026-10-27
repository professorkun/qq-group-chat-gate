/**
 * qq-gate self-tune —— 应用复盘建议（带护栏）
 *
 * 模型只负责「提建议」，这里负责「能不能改、改多少」。
 * 任何一条不合法就整批拒绝，不做部分应用。
 *
 * 用法：
 *   node apply.mjs --proposal p.json --dry-run
 *   node apply.mjs --proposal p.json
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';

import { CONFIG, DIR } from '../src/paths.mjs';

const AGENTS = process.env.QQ_GATE_RULES || join(DIR, '..', 'rules', 'group-chat-rules.md');
const TUNE = process.env.QQ_GATE_TUNE || join(DIR, '..', 'self-tune');
const STATE = join(TUNE, 'state.json');
const CHANGES = join(TUNE, 'changes.jsonl');
const BACKUPS = join(TUNE, 'backups');

const GROUP_HEAD = '## 群聊模式';

/** 参数硬边界与单次最大变化。超出即整批拒绝。 */
const BOUNDS = {
  threshold: { min: 0.35, max: 0.85, step: 0.12, decimals: 2 },
  cooldownMessages: { min: 2, max: 10, step: 3, int: true },
  dailyCap: { min: 2, max: 15, step: 3, int: true },
  quietMinutesForBonus: { min: 5, max: 60, step: 20, int: true },
  contextMessages: { min: 6, max: 20, step: 4, int: true },
  burstWindowSeconds: { min: 30, max: 300, step: 120, int: true },
  burstCount: { min: 3, max: 12, step: 3, int: true },
  muteMinutes: { min: 5, max: 60, step: 20, int: true },
  minGapSeconds: { min: 30, max: 600, step: 120, int: true },
};

/** 这些行一个字都不许动，也不许被新规则覆盖语义 */
const RED_LINES = ['不碰私人资料', '不提别人的私事', '不说自己怎么部署', '不给绝对路径', '干活请求一律挡'];

/** 新规则里出现这些词一律拒绝：语义护栏，防止用反话绕过上面的红线 */
const RED_TOPICS = [
  '私人', '隐私', 'wiki', 'Wiki', 'WIKI', 'NAS', 'DSH', 'OpenClaw', '路径', '命令', '凭据', '密钥',
  '姓名', '住址', '账目', '健康', '学校', '模型名', '插件', '部署',
];

const MAX_RULE_CHANGES = 3;
const MAX_RULE_CHARS = 320;
const MAX_FAILURES = 3;

function argOf(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

/** 校验拒绝只记账，不算故障；脚本自己出错才算，连续 3 次就停手 */
function bumpFailure(reason) {
  const st = readJson(STATE, {});
  const failures = (st.failures ?? 0) + 1;
  const next = { ...st, failures, lastFailureAt: new Date().toISOString(), lastFailure: String(reason).slice(0, 300) };
  if (failures >= MAX_FAILURES) next.disabled = true;
  mkdirSync(TUNE, { recursive: true });
  writeFileSync(STATE, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  if (next.disabled) console.error(`自优化已自动停用（连续 ${failures} 次故障）：${next.lastFailure}`);
}

function fail(msg, code = 2) {
  if (code === 2) {
    // 提案不合法是护栏在干活，记下来但不算故障
    try {
      mkdirSync(TUNE, { recursive: true });
      writeFileSync(join(TUNE, 'rejected.jsonl'),
        `${JSON.stringify({ at: new Date().toISOString(), reason: String(msg).slice(0, 300) })}\n`,
        { encoding: 'utf8', flag: 'a' });
    } catch {}
  } else {
    bumpFailure(msg);
  }
  console.error(`REJECT: ${msg}`);
  process.exit(code);
}

/** 群聊段在 AGENTS.md 里的 [startLine, endLine) */
function groupSectionRange(lines) {
  const start = lines.findIndex((l) => l.startsWith(GROUP_HEAD));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith('## ')) { end = i; break; }
  }
  return { start, end };
}

function validateParams(changes, current) {
  if (!Array.isArray(changes) || changes.length === 0) return [];
  const seen = new Set();
  const out = [];
  for (const c of changes) {
    if (!c || typeof c !== 'object') fail('paramChanges 条目不是对象');
    const name = String(c.name ?? '');
    const bound = BOUNDS[name];
    if (!bound) fail(`参数 ${name} 不在自动调整白名单里`);
    if (seen.has(name)) fail(`参数 ${name} 重复提交`);
    seen.add(name);
    const from = Number(current[name]);
    const to = Number(c.to);
    if (!Number.isFinite(to)) fail(`${name} 的 to 不是数字`);
    if (to < bound.min || to > bound.max) fail(`${name}=${to} 越出硬边界 ${bound.min}~${bound.max}`);
    if (bound.int && !Number.isInteger(to)) fail(`${name} 必须是整数`);
    if (bound.decimals !== undefined && Number(to.toFixed(bound.decimals)) !== to) {
      fail(`${name} 最多 ${bound.decimals} 位小数`);
    }
    if (Number.isFinite(from) && Math.abs(to - from) > bound.step + 1e-9) {
      fail(`${name} 单次变化 ${Math.abs(to - from)} 超过上限 ${bound.step}`);
    }
    if (Number.isFinite(from) && from === to) continue;
    out.push({ name, from: Number.isFinite(from) ? from : null, to, why: String(c.why ?? '').slice(0, 200) });
  }
  return out;
}

function locateRule(lines, range, want) {
  const target = String(want ?? '').trim();
  if (!target) fail('ruleChange.match 为空');
  const hits = [];
  for (let i = range.start + 1; i < range.end; i += 1) {
    if (lines[i].includes(target)) hits.push(i);
  }
  if (hits.length === 0) fail(`群聊段里找不到要改的那条：${target.slice(0, 40)}`);
  if (hits.length > 1) fail(`要改的那条匹配到 ${hits.length} 处，无法唯一定位：${target.slice(0, 40)}`);
  return hits[0];
}

function validateRules(lines, range, changes) {
  if (!Array.isArray(changes) || changes.length === 0) return [];
  if (changes.length > MAX_RULE_CHANGES) fail(`规则改动最多 ${MAX_RULE_CHANGES} 条，提交了 ${changes.length} 条`);
  const out = [];
  for (const c of changes) {
    const action = String(c.action ?? '');
    const text = String(c.text ?? '').trim();
    if (!text) fail('ruleChange.text 为空');
    if ([...text].length > MAX_RULE_CHARS) fail(`ruleChange.text 超过 ${MAX_RULE_CHARS} 字`);
    if (RED_LINES.some((r) => text.includes(r))) fail(`新规则碰到红线内容：${text.slice(0, 40)}`);
    const hitTopic = RED_TOPICS.find((t) => text.includes(t));
    if (hitTopic) fail(`新规则涉及禁止自动改写的话题「${hitTopic}」：${text.slice(0, 40)}`);
    if (!text.startsWith('- ')) fail('新规则必须以 "- " 开头的单条要点');
    if (text.includes('\n')) fail('新规则不能是多行');

    if (action === 'append') {
      out.push({ action, index: null, text, why: String(c.why ?? '').slice(0, 200) });
      continue;
    }
    if (action === 'replace') {
      const idx = locateRule(lines, range, c.match);
      if (RED_LINES.some((r) => lines[idx].includes(r))) {
        fail(`拒绝改动红线行：${lines[idx].slice(0, 40)}`);
      }
      out.push({ action, index: idx, old: lines[idx], text, why: String(c.why ?? '').slice(0, 200) });
      continue;
    }
    fail(`不认识的 action：${action}（只支持 append / replace）`);
  }
  return out;
}

const proposalPath = argOf('proposal', null);
const dryRun = argOf('dry-run', false) === true;
if (!proposalPath || proposalPath === true) fail('缺少 --proposal <path>');

const proposal = readJson(proposalPath, null);
if (!proposal) fail('建议文件读不出来或不是 JSON');

const config = readJson(CONFIG, null);
if (!config) fail('config.json 读不出来', 3);

const tuneState = readJson(STATE, {});
if (tuneState.disabled === true) {
  console.log(JSON.stringify({
    ok: false, disabled: true,
    reason: `自优化已停用（连续 ${tuneState.failures ?? '?'} 次故障）：${tuneState.lastFailure ?? ''}。删掉 ${STATE} 里的 disabled 才能恢复。`,
  }, null, 2));
  process.exit(5);
}

const agentsText = readFileSync(AGENTS, 'utf8');
const lines = agentsText.split('\n');
const range = groupSectionRange(lines);
if (!range) fail('AGENTS.md 里找不到「## 群聊模式」段');

const paramChanges = validateParams(proposal.paramChanges, config);
const ruleChanges = validateRules(lines, range, proposal.ruleChanges);

if (!paramChanges.length && !ruleChanges.length) {
  console.log(JSON.stringify({ ok: true, applied: false, reason: '没有需要应用的改动' }));
  process.exit(0);
}

// —— 组装结果 ——
const nextConfig = { ...config };
for (const c of paramChanges) nextConfig[c.name] = c.to;

const nextLines = [...lines];
// replace 先做，再 append（append 永远插在段末，不依赖行号）
for (const c of ruleChanges.filter((r) => r.action === 'replace')) {
  nextLines[c.index] = c.text;
}
for (const c of ruleChanges.filter((r) => r.action === 'append')) {
  const r = groupSectionRange(nextLines);
  nextLines.splice(r.end - 1, 0, c.text);
}
// 结构自检：段还在、下一个标题没被吃掉
const afterRange = groupSectionRange(nextLines);
if (!afterRange) fail('改完后群聊段消失了，拒绝写入');
if (nextLines[afterRange.start] !== lines[range.start]) fail('群聊段标题被改动，拒绝写入');

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const backupDir = join(BACKUPS, stamp);
const summary = {
  stamp,
  date: String(proposal.date ?? ''),
  dryRun: !!dryRun,
  paramChanges,
  ruleChanges: ruleChanges.map((c) => ({ action: c.action, text: c.text, why: c.why })),
  reasoning: String(proposal.reasoning ?? '').slice(0, 1200),
};

if (dryRun) {
  console.log(JSON.stringify({ ok: true, dryRun: true, ...summary }, null, 2));
  process.exit(0);
}

// —— 备份 → 原子写 → 读回校验 ——
mkdirSync(backupDir, { recursive: true });
copyFileSync(CONFIG, join(backupDir, 'config.json'));
copyFileSync(AGENTS, join(backupDir, 'AGENTS.md'));

function atomicWrite(path, content) {
  const tmp = join(dirname(path), `.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, path);
}

atomicWrite(CONFIG, `${JSON.stringify(nextConfig, null, 2)}\n`);
atomicWrite(AGENTS, `${nextLines.join('\n')}`);

// 读回校验
const backConfig = readJson(CONFIG, null);
if (!backConfig) fail('写完 config.json 读不回来', 4);
for (const c of paramChanges) {
  if (backConfig[c.name] !== c.to) fail(`config.json 回读不一致：${c.name}`, 4);
}
const backAgents = readFileSync(AGENTS, 'utf8');
if (!backAgents.includes(GROUP_HEAD)) fail('写完 AGENTS.md 找不到群聊段', 4);
for (const c of ruleChanges) {
  if (!backAgents.includes(c.text)) fail('写完 AGENTS.md 找不到新规则文本', 4);
}

mkdirSync(TUNE, { recursive: true });
writeFileSync(CHANGES, `${JSON.stringify({ at: new Date().toISOString(), ...summary })}\n`,
  { encoding: 'utf8', flag: 'a' });

const st = readJson(STATE, {});
writeFileSync(STATE, `${JSON.stringify({ ...st, lastAppliedAt: new Date().toISOString(), failures: 0 }, null, 2)}\n`, 'utf8');

console.log(JSON.stringify({ ok: true, dryRun: false, backupDir, ...summary }, null, 2));
