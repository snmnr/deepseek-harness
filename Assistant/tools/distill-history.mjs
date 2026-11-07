#!/usr/bin/env node
/**
 * 历史对话蒸馏素材抽取器（不调用 LLM）。
 *
 * 把 Claude Code 的 .jsonl 会话记录清洗成适合 LLM 总结的 Markdown：
 *   - 只保留 user / assistant 的文本，去掉工具输出、thinking、附件、系统提醒；
 *   - 密钥脱敏；单条消息截断；连续重复内容去重；
 *   - 按 token 预算切分，输出到 ~/.affine-docs/distill/<session>/part-NN.md。
 *
 * 真正的总结由 Claude 在当前会话里完成（/distill-history），本脚本只负责降噪和计费预估。
 *
 * 用法：
 *   node distill-history.mjs --list [--limit N] [--json]
 *   node distill-history.mjs --pending [--json]
 *   node distill-history.mjs --unpend <sessionId>
 *   node distill-history.mjs --check <sessionId>
 *   node distill-history.mjs --mark <sessionId> --note <笔记路径>
 *   node distill-history.mjs --status [--json]
 *   node distill-history.mjs --extract <sessionId|文件路径> [--dry-run]
 *   node distill-history.mjs --extract-all [--since YYYY-MM-DD] [--limit N]
 *
 * 选项：
 *   --chunk-tokens N       每片 token 预算（默认 40000）
 *   --max-message-chars N  单条消息截断长度（默认 8000）
 *   --include-thinking     保留 thinking 文本（默认丢弃）
 *   --out <dir>            输出根目录（默认 ~/.affine-docs/distill）
 *   --force                强制重新抽取/更新（配合 --check/--mark 使用）
 *
 * 蒸馏台账：<out>/index.json 记录 sessionId → 源文件 hash、笔记路径、蒸馏时间。
 * 源文件 hash 变化即视为“有更新”，应更新同一篇笔记后重新 --mark。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

// dsh 适配（mem0-claude-kit 副本）：会话导出根可被 --projects / DSH_EXPORT_DIR 覆盖，
// 默认指向 mem0-dsh-bridge 的导出目录（CC 兼容 JSONL，由插件在会话结束时写出）。
const PROJECTS = process.env.DSH_EXPORT_DIR
  || path.join(os.homedir(), '.mem0-claude-dsh', 'exports');
let PROJECTS_OVERRIDE = null;
const OUT_ROOT_DEFAULT = path.join(os.homedir(), '.affine-docs', 'distill');
function projectsRoot() {
  return PROJECTS_OVERRIDE || PROJECTS;
}

function usage() {
  console.log(`用法:
  node distill-history.mjs --list [--limit N] [--json]
  node distill-history.mjs --pending [--json]
  node distill-history.mjs --unpend <sessionId>
  node distill-history.mjs --check <sessionId>
  node distill-history.mjs --mark <sessionId> --note <笔记路径>
  node distill-history.mjs --status [--json]
  node distill-history.mjs --extract <sessionId|文件路径> [--dry-run]
  node distill-history.mjs --extract-all [--since YYYY-MM-DD] [--limit N]

选项:
  --chunk-tokens N       每片 token 预算（默认 40000）
  --max-message-chars N  单条消息截断长度（默认 8000）
  --include-thinking     保留 thinking 文本
  --out <dir>            输出根目录
  --force                强制重新抽取/更新`);
}

function parseArgs(argv) {
  const out = {
    list: false, extract: null, extractAll: false, json: false, dryRun: false,
    pending: false, unpend: null,
    check: null, mark: null, note: null, status: false, force: false,
    since: null, limit: null, chunkTokens: 40000, maxMessageChars: 8000,
    includeThinking: false, out: OUT_ROOT_DEFAULT,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { usage(); process.exit(0); }
    else if (a === '--list') out.list = true;
    else if (a === '--projects') { PROJECTS_OVERRIDE = argv[++i]; }
    else if (a === '--extract') out.extract = argv[++i];
    else if (a === '--extract-all') out.extractAll = true;
    else if (a === '--pending') out.pending = true;
    else if (a === '--unpend') out.unpend = argv[++i];
    else if (a === '--check') out.check = argv[++i];
    else if (a === '--mark') out.mark = argv[++i];
    else if (a === '--note') out.note = argv[++i];
    else if (a === '--status') out.status = true;
    else if (a === '--force') out.force = true;
    else if (a === '--json') out.json = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--include-thinking') out.includeThinking = true;
    else if (a === '--since') out.since = argv[++i];
    else if (a === '--limit') out.limit = Number(argv[++i]);
    else if (a === '--chunk-tokens') out.chunkTokens = Number(argv[++i]);
    else if (a === '--max-message-chars') out.maxMessageChars = Number(argv[++i]);
    else if (a === '--out') out.out = argv[++i];
    else throw new Error(`未知参数：${a}`);
  }
  return out;
}
const ARGS = parseArgs(process.argv.slice(2));
const INDEX_PATH = path.join(OUT_ROOT_DEFAULT, 'index.json');
const PENDING_PATH = path.join(OUT_ROOT_DEFAULT, 'pending.json');

function walkJsonl(dir) {
  const found = [];
  if (!fs.existsSync(dir)) return found;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) found.push(...walkJsonl(p));
    else if (e.isFile() && e.name.endsWith('.jsonl')) found.push(p);
  }
  return found;
}
function sessionIdOf(file) {
  return path.basename(file, '.jsonl');
}
function projectOf(file) {
  return path.basename(path.dirname(file));
}
function estimateTokens(s) {
  let cjk = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3000 && c <= 0x303f) || (c >= 0xff00 && c <= 0xffef)) cjk++;
  }
  return cjk + Math.ceil((s.length - cjk) / 4);
}
function redact(s) {
  // 整体是密钥的：直接替换
  const whole = [
    /sk-ant-[A-Za-z0-9_-]{10,}/g,
    /m0sk_[A-Za-z0-9_-]{6,}/g,
    /sk-[A-Za-z0-9_-]{10,}/g,
    /gh[pousr]_[A-Za-z0-9]{10,}/g,
    /AKIA[0-9A-Z]{12,}/g,
  ];
  let out = s;
  for (const rx of whole) out = out.replace(rx, '[REDACTED]');
  // 带前缀的：保留键名，替换值
  out = out.replace(/(Bearer\s+)[A-Za-z0-9._-]{10,}/gi, '$1[REDACTED]');
  out = out.replace(/((?:password|passwd|pwd|api[_-]?key|token|secret)\s*[:=]\s*)[^\s"'`]+/gi, '$1[REDACTED]');
  return out;
}
function cleanText(s, maxChars) {
  if (!s) return '';
  let out = String(s)
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  out = redact(out);
  if (out.length > maxChars) out = out.slice(0, maxChars) + '\n…[已截断]';
  return out;
}
function blocksToText(content, opts) {
  if (typeof content === 'string') return content;
  const out = [];
  for (const b of content || []) {
    if (!b || !b.type) continue;
    if (b.type === 'text' && b.text) out.push(b.text);
    else if (b.type === 'tool_use') out.push(`[工具: ${b.name || 'unknown'}]`);
    else if (b.type === 'thinking' && opts.includeThinking && b.thinking) out.push(`[思考] ${b.thinking}`);
    // tool_result / image / 其它块默认丢弃
  }
  return out.join('\n');
}

function readMessages(file, opts) {
  const messages = [];
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.isSidechain) continue;
    if (o.type !== 'user' && o.type !== 'assistant') continue;
    const role = o.type;
    const text = cleanText(blocksToText(o.message?.content, opts), opts.maxMessageChars);
    if (!text) continue;
    const prev = messages[messages.length - 1];
    if (prev && prev.role === role && prev.text === text) continue;
    messages.push({ role, ts: o.timestamp || '', text });
  }
  return messages;
}

function splitLongText(text, maxChars) {
  const parts = [];
  let rest = text;
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf('\n\n', maxChars);
    if (cut < maxChars * 0.5) cut = rest.lastIndexOf('\n', maxChars);
    if (cut < maxChars * 0.5) cut = maxChars;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) parts.push(rest);
  return parts;
}

function chunkMessages(messages, maxTokens, maxChars) {
  const parts = [];
  let cur = [];
  let curTok = 0;
  for (const m of messages) {
    const pieces = m.text.length > maxChars ? splitLongText(m.text, maxChars) : [m.text];
    for (const piece of pieces) {
      const t = estimateTokens(piece) + 8;
      if (curTok + t > maxTokens && cur.length) {
        parts.push(cur);
        cur = [];
        curTok = 0;
      }
      cur.push({ role: m.role, ts: m.ts, text: piece });
      curTok += t;
    }
  }
  if (cur.length) parts.push(cur);
  return parts;
}

function groupSessions() {
  const files = walkJsonl(projectsRoot());
  const groups = new Map();
  for (const f of files) {
    const id = sessionIdOf(f);
    const st = fs.statSync(f);
    const g = groups.get(id) || { id, files: [], size: 0, mtime: 0 };
    g.files.push(f);
    g.size = Math.max(g.size, st.size);
    g.mtime = Math.max(g.mtime, st.mtimeMs);
    groups.set(id, g);
  }
  const list = [];
  for (const g of groups.values()) {
    const best = g.files
      .map((f) => {
        const st = fs.statSync(f);
        return { f, size: st.size, mtimeMs: st.mtimeMs };
      })
      .sort((a, b) => b.size - a.size)[0];
    list.push({
      id: g.id,
      path: best.f,
      project: projectOf(best.f),
      size: best.size,
      bestMtime: best.mtimeMs,
      mtime: g.mtime,
      copies: g.files.length,
      estTokens: Math.ceil(best.size / 3.2),
    });
  }
  return list.sort((a, b) => b.mtime - a.mtime);
}

/* ---------- 蒸馏台账 ---------- */
function readIndex() {
  try { return JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8')); }
  catch { return { version: 1, sessions: {} }; }
}
function writeIndex(idx) {
  fs.mkdirSync(path.dirname(INDEX_PATH), { recursive: true });
  const tmp = `${INDEX_PATH}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(idx, null, 2), 'utf8');
  fs.renameSync(tmp, INDEX_PATH);
}
function shaFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function readPending() {
  try { return JSON.parse(fs.readFileSync(PENDING_PATH, 'utf8')); }
  catch { return { version: 1, items: [] }; }
}
function writePending(q) {
  fs.mkdirSync(path.dirname(PENDING_PATH), { recursive: true });
  const tmp = `${PENDING_PATH}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(q, null, 2), 'utf8');
  fs.renameSync(tmp, PENDING_PATH);
}
function stateOf(session, idx) {
  const rec = idx.sessions?.[session.id];
  if (!rec) return 'new';
  if (rec.sourceHash && session.size === rec.sourceSize && session.bestMtime === rec.sourceMtimeMs) {
    return 'up-to-date';
  }
  return 'changed';
}
function findSession(id) {
  const s = groupSessions().find((x) => x.id === id);
  if (!s) throw new Error(`找不到会话：${id}`);
  return s;
}

function renderPart(sessionId, file, partIdx, partCount, messages) {
  const head = [
    `# 对话蒸馏素材 — ${sessionId} — Part ${partIdx}/${partCount}`,
    '',
    `> 来源: ${file}`,
    `> 时间: ${messages[0]?.ts || ''} → ${messages[messages.length - 1]?.ts || ''}`,
    '> 已去除工具输出/思考/附件，密钥已脱敏；单条消息可能截断。',
    '',
  ];
  const body = messages.map((m) => `## ${m.role}${m.ts ? ' · ' + m.ts : ''}\n\n${m.text}`);
  return head.concat(body).join('\n') + '\n';
}

function extractOne(file, opts) {
  const messages = readMessages(file, opts);
  if (!messages.length) return null;
  const parts = chunkMessages(messages, opts.chunkTokens, opts.maxMessageChars * 2);
  const totalChars = messages.reduce((n, m) => n + m.text.length, 0);
  const totalTokens = messages.reduce((n, m) => n + estimateTokens(m.text), 0);
  const sessionId = sessionIdOf(file);
  const dir = path.join(opts.out, sessionId);
  const manifest = {
    sessionId,
    source: file,
    project: projectOf(file),
    messages: messages.length,
    parts: parts.length,
    chars: totalChars,
    estTokens: totalTokens,
    chunkTokens: opts.chunkTokens,
    startedAt: messages[0]?.ts || null,
    endedAt: messages[messages.length - 1]?.ts || null,
    generatedAt: new Date().toISOString(),
  };
  if (!opts.dryRun) {
    fs.mkdirSync(dir, { recursive: true });
    parts.forEach((p, i) => {
      const name = `part-${String(i + 1).padStart(2, '0')}.md`;
      fs.writeFileSync(path.join(dir, name), renderPart(sessionId, file, i + 1, parts.length, p), 'utf8');
    });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  }
  return { manifest, dir };
}

function main() {
  const idx = readIndex();

  if (ARGS.pending) {
    const q = readPending();
    const rows = [];
    for (const item of q.items || []) {
      let s = null;
      try { s = findSession(item.sessionId); } catch {}
      rows.push({
        ...item,
        state: s ? stateOf(s, idx) : 'missing',
        note: idx.sessions?.[item.sessionId]?.note || null,
        estTokens: s?.estTokens || null,
      });
    }
    if (ARGS.json) console.log(JSON.stringify(rows, null, 2));
    else if (!rows.length) console.log('（没有待蒸馏会话）');
    else for (const r of rows) {
      console.log(`${r.sessionId}\t${r.state}\t${r.estTokens || '-'}\t${r.project || '-'}\t${r.note || '-'}`);
    }
    return;
  }

  if (ARGS.unpend) {
    const q = readPending();
    const before = (q.items || []).length;
    q.version = 1;
    q.items = (q.items || []).filter((x) => x.sessionId !== ARGS.unpend);
    writePending(q);
    console.log(`unpend ${ARGS.unpend}: ${before} -> ${q.items.length}`);
    return;
  }

  if (ARGS.status) {
    const rows = groupSessions().map((s) => {
      const rec = idx.sessions?.[s.id];
      return {
        id: s.id,
        state: stateOf(s, idx),
        distilledAt: rec?.distilledAt || null,
        note: rec?.note || null,
        estTokens: s.estTokens,
      };
    });
    if (ARGS.json) console.log(JSON.stringify(rows, null, 2));
    else for (const r of rows) console.log(`${r.id}\t${r.state}\t${r.distilledAt || '-'}\t${r.note || '-'}`);
    return;
  }

  if (ARGS.check) {
    const s = findSession(ARGS.check);
    const rec = idx.sessions?.[s.id];
    const currentHash = shaFile(s.path);
    const status = !rec ? 'new' : (rec.sourceHash === currentHash ? 'up-to-date' : 'changed');
    console.log(JSON.stringify({
      sessionId: s.id,
      status,
      source: s.path,
      size: s.size,
      estTokens: s.estTokens,
      note: rec?.note || null,
      distilledAt: rec?.distilledAt || null,
      previousSourceHash: rec?.sourceHash || null,
      currentSourceHash: currentHash,
    }, null, 2));
    return;
  }

  if (ARGS.mark) {
    const s = findSession(ARGS.mark);
    if (!ARGS.note) throw new Error('--mark 需要 --note <已生成的笔记路径>');
    const notePath = path.resolve(ARGS.note);
    if (!fs.existsSync(notePath)) throw new Error(`笔记不存在：${notePath}`);
    const manifestPath = path.join(ARGS.out, s.id, 'manifest.json');
    let manifest = null;
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch {}
    idx.version = 1;
    idx.sessions = idx.sessions || {};
    idx.sessions[s.id] = {
      source: s.path,
      sourceHash: shaFile(s.path),
      sourceSize: s.size,
      sourceMtimeMs: s.bestMtime,
      extractedAt: manifest?.generatedAt || null,
      estTokens: manifest?.estTokens || null,
      parts: manifest?.parts || null,
      note: notePath,
      noteHash: shaFile(notePath),
      distilledAt: new Date().toISOString(),
    };
    writeIndex(idx);
    console.log(JSON.stringify(idx.sessions[s.id], null, 2));
    return;
  }

  if (ARGS.list) {
    const list = groupSessions();
    const limited = ARGS.limit ? list.slice(0, ARGS.limit) : list;
    if (ARGS.json) {
      console.log(JSON.stringify(limited.map((s) => ({ ...s, state: stateOf(s, idx) })), null, 2));
      return;
    }
    console.log(`共 ${list.length} 个会话（按修改时间倒序）`);
    for (const s of limited) {
      console.log(`${s.id}\t${new Date(s.mtime).toISOString().slice(0, 10)}\t${(s.size / 1048576).toFixed(1)}MB\t~${s.estTokens.toLocaleString()}tok\tcopies=${s.copies}\tstate=${stateOf(s, idx)}\t${s.project}`);
    }
    return;
  }

  if (ARGS.extractAll) {
    let list = groupSessions();
    if (ARGS.since) {
      const since = new Date(ARGS.since).getTime();
      list = list.filter((s) => s.mtime >= since);
    }
    if (ARGS.limit) list = list.slice(0, ARGS.limit);
    let total = 0;
    for (const s of list) {
      const r = extractOne(s.path, ARGS);
      if (!r) continue;
      total += r.manifest.estTokens;
      console.log(`${s.id}\t${r.manifest.estTokens.toLocaleString()}tok\t${r.manifest.parts} parts`);
    }
    console.log(`done sessions=${list.length} estTokens=${total.toLocaleString()}`);
    return;
  }

  if (ARGS.extract) {
    let file = ARGS.extract;
    if (!fs.existsSync(file)) {
      const hit = groupSessions().find((s) => s.id === ARGS.extract);
      if (!hit) throw new Error(`找不到会话：${ARGS.extract}`);
      file = hit.path;
    }
    const r = extractOne(file, ARGS);
    if (!r) { console.log('没有可提取的文本消息'); return; }
    const m = r.manifest;
    console.log(`${m.sessionId}\tmessages=${m.messages}\tparts=${m.parts}\tchars=${m.chars}\testTokens=${m.estTokens}`);
    if (ARGS.dryRun) console.log('dry-run：未写入文件');
    else console.log(`输出: ${r.dir}`);
    return;
  }

  usage();
}
main();
