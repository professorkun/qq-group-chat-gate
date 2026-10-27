#!/usr/bin/env node
/**
 * 把群聊闸接进 dsh-im（@xmanrui/dsh-im 5.6.0）的安装脚本
 *
 * dsh-im 的群消息处理是打包后的单文件，没有对外的「入站过滤 / 出站改写」钩子，
 * 所以这里用带标记的字符串补丁接三个点：
 *   1) 入站：allow(msg) 决定这条群消息要不要唤醒模型
 *   2) 入站：decorate(msg, text) 在 prompt 前拼最近几条群消息
 *   3) 出站：cleanText(text) 去掉「（配了张…图）」这类报备括注
 * 另有两条配套改动：群消息不再强制 @；没有文本回复时不再发占位提示。
 *
 * 用法：
 *   node patch/apply.mjs --dsh-im <dsh-im 包目录> --gate-src <本仓库 src 目录> [--dry-run]
 *   node patch/apply.mjs --dsh-im <dsh-im 包目录> --revert
 *
 * 只支持 dsh-im 5.6.0；版本不对或锚点找不到会整体失败，不会写半截。
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SUPPORTED = '5.6.0';
const MARK = 'qq-group-chat-gate';
const mk = (id) => `/* [${MARK}] ${id} */`;

function argOf(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const dshImArg = argOf('dsh-im');
const gateSrcArg = argOf('gate-src');
const dryRun = argOf('dry-run', false) === true;
const revert = argOf('revert', false) === true;

if (!dshImArg || dshImArg === true) {
  console.error('缺少 --dsh-im <dsh-im 包目录或 lib/index.js>');
  process.exit(2);
}

function locate(input) {
  const p = resolve(String(input));
  const lib = p.endsWith('.js') ? p : join(p, 'lib', 'index.js');
  const pkgPath = join(dirname(dirname(lib)), 'package.json');
  if (!existsSync(lib)) throw new Error(`找不到 ${lib}`);
  if (!existsSync(pkgPath)) throw new Error(`找不到 ${pkgPath}`);
  return { lib, pkgPath };
}

const { lib, pkgPath } = locate(dshImArg);
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
if (pkg.version !== SUPPORTED) {
  console.error(`只支持 @xmanrui/dsh-im ${SUPPORTED}，当前是 ${pkg.version}。请先安装对应版本。`);
  process.exit(3);
}

const backup = `${lib}.bak-${MARK}`;

if (revert) {
  if (!existsSync(backup)) {
    console.error(`没有找到备份 ${backup}，无法还原。`);
    process.exit(4);
  }
  copyFileSync(backup, lib);
  console.log(JSON.stringify({ ok: true, reverted: true, lib }, null, 2));
  process.exit(0);
}

if (!gateSrcArg || gateSrcArg === true) {
  console.error('缺少 --gate-src <本仓库 src 目录>');
  process.exit(2);
}
const gateSrc = resolve(String(gateSrcArg));
if (!existsSync(join(gateSrc, 'gate.mjs'))) {
  console.error(`--gate-src 下没有 gate.mjs：${gateSrc}`);
  process.exit(2);
}
const gateUrl = pathToFileURL(gateSrc).href.replace(/\/+$/, '');

const PATCHES = [
  {
    id: 'QQ-GROUP-FREE-RESPONSE',
    what: '群消息不再要求 @ 才处理',
    find: 'function Dg(n){return!!n&&(n.kind!=="group"||n[Xoe]===!0||n.rawEventType==="GROUP_AT_MESSAGE_CREATE"||$oe(n).length>0)}',
    marker: mk('QQ-GROUP-FREE-RESPONSE'),
    replace: `function Dg(n){return!!n&&(${mk('QQ-GROUP-FREE-RESPONSE')}!0)}`,
  },
  {
    id: 'QQ-GROUP-SENDER-GUARD',
    what: '正文已经带过标记就不再重复拼',
    find: 'function j_(n,t=new Set){if(n?.kind!=="group")return n;',
    marker: mk('QQ-GROUP-SENDER-GUARD'),
    replace: `function j_(n,t=new Set){if(n?.kind!=="group")return n;${mk('QQ-GROUP-SENDER-GUARD')}if(typeof n.content==="string"&&/(这条 @ 了你|没点你)/.test(n.content))return n;`,
  },
  {
    id: 'QQ-GROUP-SENDER',
    what: '群消息正文前带 [昵称]，后面标「@ 了你 / 没点你」',
    find: 'return n[Xoe]=i,n.content=a.replace(/<@!?([^<>\\s]+)>[ \\t]*/gu,(A,r)=>t.has(r)?"":A).trim(),n}',
    marker: mk('QQ-GROUP-SENDER'),
    replace: `let Q=(typeof n.senderName==="string"&&n.senderName.trim())||"某人";${mk('QQ-GROUP-SENDER')}return n[Xoe]=i,n.content="["+Q+"] "+W+(R?"（这条 @ 了你，是在跟你说话）":"（没点你，看看要不要接）"),n}`,
  },
  {
    id: 'QQ-GATE',
    what: '入站先过 allow(msg)，并取消「必须 @」的硬拦',
    find: ';if(!Dg(t))return;let g=t.replyTarget,l=e??YK(t,{fetchImpl:this.#d}),d=l.content',
    marker: mk('QQ-GATE'),
    replace: `;${mk('QQ-GATE')}let __gateBlocked=!1;try{__gateBlocked=!(await (await import("${gateUrl}/gate.mjs")).allow(t))}catch(__gateErr){console.warn?.("[qq-gate] check failed, allowing message:",__gateErr?.message??__gateErr)}if(__gateBlocked)return;let g=t.replyTarget,l=e??YK(t,{fetchImpl:this.#d}),d=l.content`,
  },
  {
    id: 'QQ-GROUP-CONTEXT',
    what: '放行的消息在 prompt 前拼最近几条群消息',
    find: 'd=l.content,u=lA(l)',
    marker: mk('QQ-GROUP-CONTEXT'),
    replace: `d=l.content;${mk('QQ-GROUP-CONTEXT')}try{d=await (await import("${gateUrl}/context.mjs")).decorate(t,d)}catch(__ctxErr){console.warn?.("[qq-gate] context inject failed:",__ctxErr?.message??__ctxErr)}let u=lA(l)`,
  },
  {
    id: 'QUIET-NO-TEXT',
    what: '没有文本出口时不发「本轮处理已结束，没有文本回复。」',
    find: 'if(O.reason!=null&&_6(O.reason))return S("\\u672C\\u8F6E\\u5904\\u7406\\u5DF2\\u7ED3\\u675F\\uFF0C\\u6CA1\\u6709\\u6587\\u672C\\u56DE\\u590D\\u3002")',
    marker: mk('QUIET-NO-TEXT'),
    replace: `${mk('QUIET-NO-TEXT')}if(O.reason!=null&&_6(O.reason))return ""`,
  },
  {
    id: 'QQ-NO-META-NOTE-REPLY',
    what: '回复发往 QQ 前去掉报备式括注',
    find: ',M=null,P=null;try{let W=!1;',
    marker: mk('QQ-NO-META-NOTE-REPLY'),
    replace: `,M=null,P=null;${mk('QQ-NO-META-NOTE-REPLY')}try{let __c=(await import("${gateUrl}/outbound.mjs")).cleanText(x);if(__c)x=__c}catch(__oErr){console.warn?.("[qq-gate] outbound clean failed:",__oErr?.message??__oErr)}try{let W=!1;`,
  },
  {
    id: 'QQ-NO-META-NOTE-PROACTIVE',
    what: '主动文字发往 QQ 前去掉报备式括注',
    find: 'if(!i){let r=new TypeError("Invalid QQ proactive delivery target");throw r.code="invalid-target",r}',
    marker: mk('QQ-NO-META-NOTE-PROACTIVE'),
    replace: `if(!i){let r=new TypeError("Invalid QQ proactive delivery target");throw r.code="invalid-target",r}${mk('QQ-NO-META-NOTE-PROACTIVE')}try{o=(await import("${gateUrl}/outbound.mjs")).cleanText(o)}catch(__oErr){console.warn?.("[qq-gate] outbound clean failed:",__oErr?.message??__oErr)}`,
  },
];

function nthIndex(hay, needle, n) {
  let idx = -1;
  for (let i = 0; i <= n; i += 1) {
    idx = hay.indexOf(needle, idx + 1);
    if (idx < 0) return -1;
  }
  return idx;
}

let src = readFileSync(lib, 'utf8');
const applied = [];
const skipped = [];

for (const p of PATCHES) {
  if (src.includes(p.marker)) {
    skipped.push(p.id);
    continue;
  }
  const idx = p.nth ? nthIndex(src, p.find, p.nth) : src.indexOf(p.find);
  if (idx < 0) {
    console.error(`锚点没找到（${p.id}）：${p.what}`);
    console.error('目标文件可能不是 dsh-im 5.6.0，或已经被别的补丁改过。未写入任何内容。');
    process.exit(5);
  }
  src = src.slice(0, idx) + p.replace + src.slice(idx + p.find.length);
  applied.push(p.id);
}

if (!applied.length) {
  console.log(JSON.stringify({ ok: true, dryRun, changed: false, skipped, lib }, null, 2));
  process.exit(0);
}

if (dryRun) {
  console.log(JSON.stringify({ ok: true, dryRun: true, applied, skipped, lib, gateUrl }, null, 2));
  process.exit(0);
}

if (!existsSync(backup)) copyFileSync(lib, backup);
writeFileSync(lib, src, 'utf8');
console.log(JSON.stringify({ ok: true, dryRun: false, applied, skipped, lib, backup, gateUrl }, null, 2));
