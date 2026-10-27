// 最小冒烟测试：不依赖任何真实 IM，直接喂假消息给门闸
// 运行：node test/smoke.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dir = mkdtempSync(join(tmpdir(), 'qq-gate-test-'));
process.env.QQ_GATE_DIR = dir;

const dbPath = join(dir, 'group-history.sqlite');
const db = new DatabaseSync(dbPath);
db.exec(`CREATE TABLE groups (id TEXT PRIMARY KEY, platform_group_id TEXT NOT NULL);
CREATE TABLE messages (id TEXT PRIMARY KEY, group_id TEXT NOT NULL, sender_id TEXT NOT NULL,
  sender_name TEXT NOT NULL DEFAULT '', sent_at INTEGER NOT NULL, text TEXT NOT NULL);`);
db.prepare('INSERT INTO groups VALUES (?, ?)').run('g1', 'group-1');
const now = Date.now();
for (let i = 0; i < 3; i += 1) {
  db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?)')
    .run(`m${i}`, 'g1', 'u2', '群友', now - (3 - i) * 60000, '前面聊过的一句');
}
db.close();

const configPath = join(dir, 'config.json');
const writeConfig = (over = {}) => writeFileSync(configPath, JSON.stringify({
  mode: 'block', threshold: 0.3, dailyCap: 10, minGapSeconds: 120,
  quietMinutesForBonus: 10, contextMessages: 12, burstWindowSeconds: 60, burstCount: 5,
  muteMinutes: 15, namePattern: '助手|小助手', databasePath: dbPath, ...over,
}), 'utf8');

const { allow, decorate, scoreMessage } = await import('../src/gate.mjs');
const { cleanText } = await import('../src/outbound.mjs');

const base = { kind: 'group', groupOpenid: 'group-1', senderId: 'u1', senderName: '群友' };
const say = (content, extra = {}) => ({ ...base, content, ...extra });
const statePath = join(dir, 'state.json');
const readState = () => JSON.parse(readFileSync(statePath, 'utf8'));
const writeState = (st) => writeFileSync(statePath, JSON.stringify(st), 'utf8');

const results = [];
async function ok(name, fn) {
  try { await fn(); results.push(`PASS ${name}`); }
  catch (err) { results.push(`FAIL ${name}: ${err.message}`); process.exitCode = 1; }
}

// 1) 私聊永远放行
await ok('私聊放行', async () => {
  writeConfig();
  assert.equal(await allow({ kind: 'c2c', content: '在吗' }), true);
});

// 2) 叫闭嘴 → 拦，并进入静默
await ok('叫闭嘴被拦', async () => {
  writeConfig();
  assert.equal(await allow(say('闭嘴')), false);
  assert.equal(await allow(say('随便聊聊')), false, '静默期内应拦');
  assert.ok(readState().mutedUntil > Date.now(), '应写入静默截止时间');
});

// 3) @ 别人 → 拦
await ok('@别人被拦', async () => {
  writeConfig();
  assert.equal(await allow(say('<@ABCDEF123456> 你看这个')), false);
});

// 4) 被点名 → 放行（静默期也解除）
await ok('被点名放行', async () => {
  writeConfig();
  assert.equal(await allow(say('小助手在吗', { rawEventType: 'GROUP_AT_MESSAGE_CREATE' })), true);
});

// 5) 普通闲聊在阈值下调时能放行
await ok('闲聊可放行', async () => {
  writeConfig({ threshold: 0.2 });
  writeState({ ...readState(), lastReplyAt: 0, replies: 0 });
  assert.equal(await allow(say('今天作业写不完了，好烦')), true);
});

// 6) 时间冷却：刚接过话，非点名再高分也先拦
await ok('时间冷却生效', async () => {
  writeConfig({ threshold: 0.2 });
  assert.equal(await allow(say('太困了，想睡觉')), false);
  const last = readFileSync(join(dir, 'gate.log.jsonl'), 'utf8').trim().split('\n').pop();
  assert.equal(JSON.parse(last).rateLimited, true);
});

// 7) 上下文注入
await ok('上下文注入', async () => {
  writeConfig();
  const out = await decorate(say('这句是新的'), '这句是新的');
  assert.match(out, /【群里刚才在聊/);
  assert.ok(out.includes('【当前这条】'));
});

// 8) 出站括注清理
await ok('括注清理', () => {
  assert.equal(cleanText('睡醒了就接着呗，梦里作业又写不完。（配了张睡着的图）'), '睡醒了就接着呗，梦里作业又写不完。');
  assert.equal(cleanText('好耶（附一张猫图）'), '好耶');
  assert.equal(cleanText('行吧（笑）'), '行吧（笑）');
  assert.equal(cleanText('什么叫开源之光啊（战术后仰）'), '什么叫开源之光啊（战术后仰）');
});

// 9) 打分函数本身：叫闭嘴 / @别人 / 被点名
await ok('scoreMessage 硬规则', () => {
  assert.equal(scoreMessage({ text: '闭嘴', addressed: false, mentionsOthers: false }, { threshold: 0.4 }).pass, false);
  assert.equal(scoreMessage({ text: '你好', addressed: true, mentionsOthers: false }, { threshold: 0.4 }).pass, true);
  assert.equal(scoreMessage({ text: '<@ABCDEF123456> 好', addressed: false, mentionsOthers: true }, { threshold: 0.4 }).pass, false);
});

console.log(results.join('\n'));
console.log(`\n临时目录：${dir}`);
if (process.exitCode) process.exit(process.exitCode);
console.log('全部通过');
