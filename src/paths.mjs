/**
 * 路径与默认值（公开版，按环境变量定位；私有部署里这些常量原本写死在文件里）
 *
 * - QQ_GATE_DIR：配置、状态、日志所在目录，默认 <repo>/data
 * - QQ_GATE_DB：群消息历史库路径（只读），默认 <QQ_GATE_DIR>/group-history.sqlite
 */
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

const DATA_DIR = fileURLToPath(new URL('../data', import.meta.url));

export const DIR = resolve(process.env.QQ_GATE_DIR || DATA_DIR);
export const CONFIG = join(DIR, 'config.json');
export const LOG = join(DIR, 'gate.log.jsonl');
export const STATE = join(DIR, 'state.json');
export const DB = resolve(process.env.QQ_GATE_DB || join(DIR, 'group-history.sqlite'));
