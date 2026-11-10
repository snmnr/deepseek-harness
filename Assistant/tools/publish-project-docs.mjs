#!/usr/bin/env node
/**
 * 通用项目文档发布器：扫描任意项目目录下的 md，增量推送到 AFFiNE。
 *
 * 用法：
 *   node publish-project-docs.mjs [路径] [选项]
 *
 * 选项：
 *   --project <名称>      AFFiNE 项目文件夹名（默认取目录名）
 *   --preview, --dry-run  预览：只列出会上传/更新的文档，不写 AFFiNE
 *   --all, --force        忽略 hash，强制重写全部
 *   --include <glob>      只包含匹配的 md（可重复）
 *   --exclude <glob>      排除匹配的 md（可重复）
 *   --flat                不保留子目录，全部放在 AI-Docs/<项目>/
 *   --plan-layout         只读预演：打印生命周期目录路由，不写 AFFiNE
 *   --reconcile           只读对账：列出 manifest 中源文件已不存在的文档
 *   --manifest <路径>     指定 manifest（测试用；默认按项目根计算）
 *   --json-out <路径>     plan/reconcile 结果写入指定 JSON
 *   --help, -h            显示帮助
 *
 * 项目根可用 .affine-docs.config.json 覆盖（字段：project / include / exclude / flat / layout）。
 */
// 配置示例：{ "project": "名称", "include": ["docs/**/*.md"], "exclude": ["draft/**"], "flat": false }
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const STATE_DIR = path.join(os.homedir(), '.affine-docs');
function readJsonSafe(p) {
  // 去掉 BOM：手工编辑过的 JSON 常带 BOM，JSON.parse 会抛错并静默返回 {}
  try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '')); } catch { return {}; }
}
// 优先级：环境变量 > ~/.affine-docs/config.json > 内置默认值
const FILE_CFG = readJsonSafe(path.join(STATE_DIR, 'config.json'));
const CONFIG = {
  mcpUrl: process.env.AFFINE_MCP_URL || FILE_CFG.mcpUrl || 'https://affinemcp.shm.fun:4430/mcp',
  tokenFile: process.env.AFFINE_TOKEN_FILE || FILE_CFG.tokenFile || path.join(os.homedir(), '.secrets', 'affine_mcp_token.txt'),
  workspaceId: process.env.AFFINE_WORKSPACE_ID || FILE_CFG.workspaceId || 'c98ccc82-d368-4a3c-ac2d-1cd6bab61b02',
  webBase: process.env.AFFINE_WEB_BASE || FILE_CFG.webBase || 'https://wiki.shm.fun:4430',
  rootFolder: process.env.AFFINE_ROOT_FOLDER || FILE_CFG.rootFolder || 'AI/AI-Docs',
  stateDir: STATE_DIR,
  maxFileBytes: 512 * 1024,
  maxFiles: 500,
};
const DEFAULT_EXCLUDE_DIRS = new Set([
  '.git', '.svn', '.hg', 'node_modules', '.venv', 'venv', 'env',
  'dist', 'build', 'outbox', 'n8n_data', 'redis_data', 'data',
  'results', 'memory', '.claude', '.idea', '.vscode', '__pycache__',
]);
// 「UTF-8 文件被当 GBK 读」后的典型乱码字符；命中过多说明文件编码已损坏
const MOJIBAKE_RX = /鈥|锛|鎶|鍜|脳|鐨|鏄|涓|瀹|绋|娉|銆|鍙|闂|閿/g;
const MOJIBAKE_LIMIT = 8;

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function usage() {
  console.log(`用法: node publish-project-docs.mjs [路径] [选项]

  --project <名称>      AFFiNE 项目文件夹名（默认取目录名）
  --preview, --dry-run  预览：只列出会上传/更新的文档，不写 AFFiNE
  --all, --force        忽略 hash，强制重写全部
  --include <glob>      只包含匹配的 md（可重复）
  --exclude <glob>      排除匹配的 md（可重复）
  --flat                不保留子目录，全部放在 AI-Docs/<项目>/
  --no-pointer          不往 mem0 写“文档已发布”的指针记忆
  --plan-layout         只读预演：打印生命周期目录路由，不写 AFFiNE
  --reconcile           只读对账：列出 manifest 中源文件已不存在的文档
  --manifest <路径>     指定 manifest（测试用；默认按项目根计算）
  --json-out <路径>     plan/reconcile 结果写入指定 JSON
  --help, -h            显示帮助`);
}

function parseArgs(argv) {
  const out = { root: null, project: null, preview: false, force: false, flat: null, noPointer: false, includes: [], excludes: [], planLayout: false, reconcile: false, manifest: null, jsonOut: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { usage(); process.exit(0); }
    else if (a === '--project') { out.project = argv[++i]; }
    else if (a === '--preview' || a === '--dry-run') out.preview = true;
    else if (a === '--all' || a === '--force') out.force = true;
    else if (a === '--flat') out.flat = true;
    else if (a === '--no-pointer') out.noPointer = true;
    else if (a === '--plan-layout') out.planLayout = true;
    else if (a === '--reconcile') out.reconcile = true;
    else if (a === '--manifest') out.manifest = argv[++i];
    else if (a === '--json-out') out.jsonOut = argv[++i];
    else if (a === '--include') out.includes.push(argv[++i]);
    else if (a === '--exclude') out.excludes.push(argv[++i]);
    else if (!a.startsWith('-') && !out.root) out.root = a;
    else throw new Error(`未知参数：${a}`);
  }
  return out;
}
const ARGS = parseArgs(process.argv.slice(2));
const PLAN_MODE = ARGS.planLayout || ARGS.reconcile;
const ROOT = path.resolve(ARGS.root || process.cwd());
if (!fs.existsSync(ROOT) || !fs.statSync(ROOT).isDirectory()) {
  throw new Error(`目录不存在：${ROOT}`);
}

const cfgFile = path.join(ROOT, '.affine-docs.config.json');
let fileCfg = {};
if (fs.existsSync(cfgFile)) {
  try { fileCfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8')); } catch { fileCfg = {}; }
}
const PROJECT = String(ARGS.project || fileCfg.project || path.basename(ROOT)).trim() || 'project';
const FLAT = ARGS.flat ?? Boolean(fileCfg.flat);
// CLI --include 覆盖配置文件（而不是追加）：只想发一篇时不该仍然扫全项目
const INCLUDE = ARGS.includes.length ? ARGS.includes : (fileCfg.include || []);
const EXCLUDE = [...(fileCfg.exclude || []), ...ARGS.excludes];

const STATE_ID = sha(ROOT).slice(0, 16);
const MANIFEST = path.join(CONFIG.stateDir, 'manifests', `${STATE_ID}.json`);
const STATUS = path.join(CONFIG.stateDir, 'status', `${STATE_ID}.json`);
const LOCK = path.join(CONFIG.stateDir, 'locks', `${STATE_ID}.lock`);
for (const d of [path.dirname(MANIFEST), path.dirname(STATUS), path.dirname(LOCK)]) {
  fs.mkdirSync(d, { recursive: true });
}

function globToRegex(p) {
  let out = '^';
  const s = String(p).replace(/\\/g, '/');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '*') {
      if (s[i + 1] === '*') {
        out += '.*';
        i++;
        if (s[i + 1] === '/') i++;
      } else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(out + '$');
}
const INCLUDE_RX = INCLUDE.map(globToRegex);
const EXCLUDE_RX = EXCLUDE.map(globToRegex);

function excluded(rel) {
  return EXCLUDE_RX.some((rx) => rx.test(rel));
}
function included(rel) {
  return INCLUDE_RX.length === 0 || INCLUDE_RX.some((rx) => rx.test(rel));
}

function walk(dir, rel = '') {
  const found = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (DEFAULT_EXCLUDE_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      if (excluded(`${r}/`)) continue;
      found.push(...walk(path.join(dir, e.name), r));
    } else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
      if (excluded(r) || !included(r)) continue;
      const st = fs.statSync(path.join(dir, e.name));
      if (st.size > CONFIG.maxFileBytes) { log(`skip large ${r} (${st.size} bytes)`); continue; }
      found.push({ rel: r, abs: path.join(dir, e.name) });
    }
  }
  return found;
}

function readManifest() {
  try { return JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); } catch { return {}; }
}
function writeManifest(m) {
  fs.writeFileSync(MANIFEST, JSON.stringify(m, null, 2), 'utf8');
}
let tokenCache = null;
function getToken() {
  if (tokenCache) return tokenCache;
  if (process.env.AFFINE_TOKEN) { tokenCache = process.env.AFFINE_TOKEN.trim(); return tokenCache; }
  let line;
  try { line = fs.readFileSync(CONFIG.tokenFile, 'utf8').trim(); }
  catch { throw new Error(`读取 AFFiNE token 失败：${CONFIG.tokenFile} 不存在；请设置 AFFINE_TOKEN 或先写入该文件`); }
  const m = line.match(/^Authorization\s*[:=]\s*Bearer\s*(.+)$/i);
  tokenCache = (m ? m[1] : line.replace(/^Bearer\s*/i, '')).trim();
  if (!tokenCache) throw new Error(`AFFiNE token 为空：${CONFIG.tokenFile}`);
  return tokenCache;
}
function titleOf(md, rel) {
  const m = md.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : path.basename(rel, '.md');
}
function bodyOf(md) {
  return md.replace(/^#\s+.+\r?\n/, '').trimStart();
}
// 去掉 YAML frontmatter（source / generated_at 等元数据不发布到 AFFiNE）
function stripFrontmatter(md) {
  return md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
}
// 解析 frontmatter（只支持本项目用到的简单 YAML：标量、布尔、行内数组）
function parseFrontmatter(md) {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { meta: {}, body: md };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const mm = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!mm) continue;
    let v = mm[2].trim();
    if (v.startsWith('[') && v.endsWith(']')) {
      v = v.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    } else if (v === 'true' || v === 'false') {
      v = v === 'true';
    } else {
      v = v.replace(/^["']|["']$/g, '');
    }
    meta[mm[1]] = v;
  }
  return { meta, body: md.slice(m[0].length) };
}

// 生命周期目录：知识 / 过程记录 / 归档。默认值保持与现有发布行为兼容。
const LAYOUT = {
  knowledgeRoot: fileCfg.layout?.knowledgeRoot || CONFIG.rootFolder || 'AI/AI-Docs',
  logsRoot: fileCfg.layout?.logsRoot || 'AI/AI-Logs',
  archiveRoot: fileCfg.layout?.archiveRoot || 'AI/AI-Archive',
};
const KIND_LOG = new Set(['log', 'checkpoint', 'handoff', 'distill', 'auto-checkpoint', 'working-note']);
const KIND_KNOWLEDGE = new Set([
  'knowledge', 'design', 'runbook', 'reference', 'roadmap',
  // 本项目实际出现过的知识类 kind：结项、诊断、调研、计划、复测报告
  'closing', 'diagnosis', 'research', 'research-plan', 'plan',
  'report', 'analysis', 'spec', 'guide', 'manual', 'evaluation', 'eval',
]);
// 文件名像过程记录才归 log；notes/ 下混着日志和研究文档，不能只按目录判断
const LOG_NAME_RX = /checkpoint|handoff|自动\s*checkpoint|对话蒸馏|distill(?:ed)?[-_]?history/i;
function normalizeKind(rel, meta = {}) {
  const k = String(meta.kind || '').toLowerCase();
  if (KIND_LOG.has(k)) return 'log';
  if (['decision', 'adr'].includes(k)) return 'decision';
  if (KIND_KNOWLEDGE.has(k)) return 'knowledge';
  if (String(meta.source || '').toLowerCase() === 'auto-checkpoint') return 'log';
  const segments = rel.split('/');
  if (segments.includes('_state') || rel.startsWith('distill-history/')) return 'log';
  if (LOG_NAME_RX.test(path.posix.basename(rel))) return 'log';
  return 'knowledge';
}
function routeFor(rel, meta = {}) {
  const status = String(meta.status || 'active').toLowerCase();
  const kind = normalizeKind(rel, meta);
  if (['superseded', 'archived', 'obsolete', 'deprecated'].includes(status)) {
    return { root: LAYOUT.archiveRoot, kind: 'archive', reason: status };
  }
  if (kind === 'log') return { root: LAYOUT.logsRoot, kind: 'log', reason: 'log' };
  return { root: LAYOUT.knowledgeRoot, kind: 'knowledge', reason: 'knowledge' };
}
function targetSegments(rel, meta = {}) {
  const route = routeFor(rel, meta);
  const dir = FLAT ? '' : path.posix.dirname(rel);
  return [route.root, PROJECT, ...(dir && dir !== '.' ? dir.split('/') : [])];
}
function docUrl(docId) {
  return `${CONFIG.webBase.replace(/\/+$/, '')}/workspace/${CONFIG.workspaceId}/${docId}`;
}

let manifest = {};
function resolveDocId(fromRel, target) {
  const clean = String(target || '').split('#')[0].split('?')[0].trim();
  if (!clean || !clean.endsWith('.md')) return null;
  if (/^(https?:|affine:|mailto:|tel:)/i.test(clean)) return null;
  const fromDir = path.posix.dirname(String(fromRel).replace(/\\/g, '/'));
  const candidates = [
    path.posix.normalize(path.posix.join(fromDir, clean)),
    path.posix.normalize(clean),
  ];
  for (const c of candidates) {
    const key = c.replace(/^\.\//, '');
    if (manifest[key]?.docId) return manifest[key].docId;
  }
  return null;
}

function fixDocLinks(md, rel) {
  return md
    .split(/(```[\s\S]*?```)/g)
    .map((part, i) => {
      if (i % 2 === 1) return part;
      const links = [];
      const hold = (docId, name) => {
        links.push(`[${name}](${docUrl(docId)})`);
        return `@@AFFINELINK${links.length - 1}@@`;
      };
      part = part.replace(/\[([^\]]+)\]\(([^)\s]+\.md)(#[^)]*)?\)/g, (_m, _text, target) => {
        const id = resolveDocId(rel, target);
        const name = target.split('/').pop();
        return id ? hold(id, name) : `\`${name}\``;
      });
      part = part.replace(/`([^`\n]+?\.md)`/g, (m, target) => {
        const id = resolveDocId(rel, target);
        return id ? hold(id, target.split('/').pop()) : m;
      });
      part = part.replace(
        /(^|[^`\w\/.-])([A-Za-z0-9][A-Za-z0-9_.\/-]*\.md)(?![`\w\/.-])/g,
        (_m, pre, name) => {
          const id = resolveDocId(rel, name);
          return id ? pre + hold(id, name.split('/').pop()) : `${pre}\`${name}\``;
        }
      );
      part = part.replace(/@@AFFINELINK(\d+)@@/g, (_m, n) => links[Number(n)]);
      return part;
    })
    .join('');
}

// AFFiNE 的 create_doc_from_markdown 限制单表行数（1..20），超限会让整篇发布失败。
// 这里把超长表格切开并重复表头，保证内容不丢。
const TABLE_MAX_DATA_ROWS = 18;
function isTableLine(l) { return /^\s*\|/.test(l); }
function isSeparatorLine(l) {
  return /^\s*\|?[\s:|-]+\|?\s*$/.test(l) && l.includes('-') && (l.match(/\|/g) || []).length >= 1;
}
function splitTableBlock(block) {
  let header = block[0];
  let sep = null;
  let rows = block.slice(1);
  if (rows.length && isSeparatorLine(rows[0])) { sep = rows[0]; rows = rows.slice(1); }
  // 只处理标准 markdown 表格（首行有表头、次行是分隔线）
  if (!sep || rows.length <= TABLE_MAX_DATA_ROWS) return block;
  const out = [];
  for (let i = 0; i < rows.length; i += TABLE_MAX_DATA_ROWS) {
    if (i > 0) out.push('');
    out.push(header, sep, ...rows.slice(i, i + TABLE_MAX_DATA_ROWS));
  }
  return out;
}
function splitWideTables(md) {
  const lines = md.split('\n');
  const out = [];
  let inFence = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; out.push(line); i++; continue; }
    if (!inFence && isTableLine(line)) {
      const start = i;
      while (i < lines.length && isTableLine(lines[i])) i++;
      out.push(...splitTableBlock(lines.slice(start, i)));
      continue;
    }
    out.push(line);
    i++;
  }
  return out.join('\n');
}

/* ---------- 文档指针记忆 ---------- */
// 发布成功后往 mem0 写一条短记忆（infer=false，原文保存），让“有哪些文档”进入记忆召回。
const MEM0_CFG_PATH = path.join(os.homedir(), '.claude', 'mem0', 'config.json');
function readMem0Config() {
  const c = readJsonSafe(MEM0_CFG_PATH);
  if (!c.api_url || !c.api_key) return null;
  return { url: String(c.api_url).replace(/\/+$/, ''), key: c.api_key, userId: c.user_id || 'me' };
}
// 按 docId 精确查已有指针：manifest 可能被重置/换机器，只靠本地 hash 会重复写。
// 标题里带时间（如「自动 Handoff 14:39」）时正文每次不同，必须按 docId 找到旧条目再更新。
async function findPointer(cfg, docId) {
  try {
    const res = await fetch(`${cfg.url}/search`, {
      method: 'POST',
      headers: { 'X-API-Key': cfg.key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: `文档指针 ${docId}`,
        filters: { user_id: cfg.userId, doc_id: String(docId) },
        // 同一 docId 可能残留多条历史指针（已标 superseded），多取几条再挑未归档的
        top_k: 10,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    for (const hit of data.results || []) {
      const md = hit.metadata || {};
      if (String(md.doc_id || '') !== String(docId)) continue;
      if (String(md.status || '') === 'superseded') continue;
      return hit.id;
    }
  } catch {
    // 查重失败不阻塞发布，退回新增
  }
  return null;
}

async function writePointerMemory(rel, title, docId, folder) {
  if (ARGS.noPointer) return;
  const cfg = readMem0Config();
  if (!cfg) return;
  const text = `文档指针：${title}（${rel}）已发布到 AFFiNE ${folder}，docId=${docId}。URL：${docUrl(docId)}`;
  const h = sha(text);
  if (manifest[rel]?.pointerHash === h) return;
  const metadata = {
    project: PROJECT, source: 'doc_pointer', doc_path: rel,
    doc_id: docId, doc_url: docUrl(docId), folder,
  };
  const existingId = await findPointer(cfg, docId);
  try {
    if (existingId) {
      // 同一文档只保留一条指针：标题/目录变了就原地更新
      const res = await fetch(`${cfg.url}/memories/${existingId}`, {
        method: 'PUT',
        headers: { 'X-API-Key': cfg.key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, metadata }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      log(`pointer updated ${rel}`);
    } else {
      const res = await fetch(`${cfg.url}/memories`, {
        method: 'POST',
        headers: { 'X-API-Key': cfg.key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: text }],
          user_id: cfg.userId,
          infer: false,
          metadata,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      log(`pointer ${rel}`);
    }
    if (manifest[rel]) manifest[rel].pointerHash = h;
  } catch (e) {
    // 指针是增强项，失败不能影响发布结果
    log(`pointer skipped ${rel}: ${e.message}`);
  }
}

/* ---------- MCP ---------- */
let session = null;
let proto = '2025-06-18';

async function rpc(payload) {
  const res = await fetch(CONFIG.mcpUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${getToken()}`,
      ...(session ? { 'Mcp-Session-Id': session, 'MCP-Protocol-Version': proto } : {}),
    },
    body: JSON.stringify(payload),
  });
  const sid = res.headers.get('mcp-session-id');
  if (sid) session = sid;
  let text = await res.text();
  if (!text.trim()) {
    if (!('id' in payload)) return null;
    throw new Error(`MCP ${payload.method} 返回空响应（HTTP ${res.status}）`);
  }
  if (text.includes('data:')) {
    text = text.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
  }
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`MCP 响应无法解析: ${text.slice(0, 200)}`); }
  if (json.error) throw new Error(`MCP ${payload.method}: ${json.error.message || JSON.stringify(json.error)}`);
  return json.result;
}
async function connect() {
  if (!CONFIG.workspaceId) {
    throw new Error('缺少 AFFiNE workspaceId：请在 ~/.affine-docs/config.json 设置 workspaceId，或设 AFFINE_WORKSPACE_ID');
  }
  const init = await rpc({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: proto, capabilities: {}, clientInfo: { name: 'publish-project-docs', version: '1.0' } },
  });
  proto = init?.protocolVersion || proto;
  await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
}
// 懒连接：所有文档都没变化时不建立 MCP 会话（hook 每次写文件都会调用本脚本）
let connected = false;
async function ensureConnected() {
  if (connected) return;
  await connect();
  connected = true;
}
let idSeq = 2;
async function callTool(name, args) {
  const result = await rpc({ jsonrpc: '2.0', id: idSeq++, method: 'tools/call', params: { name, arguments: args } });
  if (result?.isError) throw new Error(`工具 ${name} 失败: ${JSON.stringify(result).slice(0, 300)}`);
  if (result?.structuredContent !== undefined) return result.structuredContent;
  const text = (result?.content || []).find((c) => c.type === 'text')?.text;
  if (!text) return result;
  try { return JSON.parse(text); } catch { return text; }
}

function nodeName(node) {
  const data = node?.data;
  if (typeof data === 'string') {
    const s = data.trim();
    if (s.startsWith('{')) { try { const o = JSON.parse(s); return o.name || o.title || ''; } catch {} }
    return s;
  }
  return data?.name || data?.title || node?.name || '';
}
let nodes = null;
async function loadNodes() {
  if (nodes) return;
  const res = await callTool('list_organize_nodes', { workspaceId: CONFIG.workspaceId });
  nodes = Array.isArray(res) ? res : res?.nodes || res?.items || res?.value || [];
}
async function ensureFolder(segments) {
  await loadNodes();
  let parentId = null;
  for (const name of segments) {
    const found = nodes.find((n) => n.type === 'folder' && (n.parentId ?? null) === parentId && nodeName(n) === name);
    if (found) { parentId = found.id; continue; }
    const created = await callTool('create_folder', {
      workspaceId: CONFIG.workspaceId, name, ...(parentId ? { parentId } : {}),
    });
    nodes.push({ id: created.id, parentId, type: 'folder', data: name });
    parentId = created.id;
    log(`created folder ${segments.join('/')}`);
  }
  return parentId;
}

// 只读预演：计算生命周期路由 + 源文件消失对账。不连接 MCP、不写 AFFiNE。
function planLayout() {
  const files = walk(ROOT).sort((a, b) => a.rel.localeCompare(b.rel));
  const manifestPath = ARGS.manifest ? path.resolve(ARGS.manifest) : MANIFEST;
  const manifest = readJsonSafe(manifestPath);
  const routes = { knowledge: [], log: [], archive: [] };
  for (const f of files) {
    const raw = fs.readFileSync(f.abs, 'utf8').replace(/^﻿/, '');
    const { meta } = parseFrontmatter(raw);
    const route = routeFor(f.rel, meta);
    routes[route.kind].push({
      rel: f.rel,
      target: targetSegments(f.rel, meta).join('/'),
      route_kind: route.kind,
      status: String(meta.status || 'active'),
      kind: normalizeKind(f.rel, meta),
    });
  }
  const missing = Object.keys(manifest)
    .filter((rel) => !fs.existsSync(path.join(ROOT, rel)))
    .map((rel) => ({
      rel,
      title: manifest[rel]?.title || '',
      last_published: manifest[rel]?.updatedAt || '',
      target: targetSegments(rel, { status: 'archived' }).join('/'),
      reason: 'source_missing',
    }));
  const report = {
    at: new Date().toISOString(),
    mode: ARGS.reconcile ? 'reconcile' : 'plan-layout',
    root: ROOT,
    project: PROJECT,
    layout: LAYOUT,
    manifest: manifestPath,
    counts: {
      files: files.length,
      knowledge: routes.knowledge.length,
      log: routes.log.length,
      archive: routes.archive.length,
      missing: missing.length,
    },
    routes,
    missing,
  };
  const outPath = ARGS.jsonOut
    ? path.resolve(ARGS.jsonOut)
    : path.join(CONFIG.stateDir, 'plan', `${STATE_ID}-layout.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');

  log(`[plan] roots knowledge=${LAYOUT.knowledgeRoot} logs=${LAYOUT.logsRoot} archive=${LAYOUT.archiveRoot}`);
  log(`[plan] files=${files.length} knowledge=${routes.knowledge.length} log=${routes.log.length} archive=${routes.archive.length} missing=${missing.length}`);
  const preview = [
    ...routes.knowledge.map((r) => ['knowledge', r]),
    ...routes.log.map((r) => ['log', r]),
    ...routes.archive.map((r) => ['archive', r]),
  ];
  for (const [kind, r] of preview.slice(0, 40)) log(`  [${kind}] ${r.rel} -> ${r.target}`);
  if (preview.length > 40) log(`  ... 还有 ${preview.length - 40} 条，见 JSON`);
  if (missing.length) {
    log(`[reconcile] 源文件已不存在 ${missing.length} 篇（建议归档，不删除）：`);
    for (const m of missing.slice(0, 20)) log(`  ${m.rel} -> ${m.target}`);
    if (missing.length > 20) log(`  ... 还有 ${missing.length - 20} 条，见 JSON`);
  }
  log(`[plan] 已写入 ${outPath}（本地只读，未改动 AFFiNE）`);
}

async function main() {
  if (PLAN_MODE) { planLayout(); return; }
  if (fs.existsSync(LOCK)) {
    const age = Date.now() - fs.statSync(LOCK).mtimeMs;
    if (age < 10 * 60 * 1000 && !ARGS.force) { log('另一个发布进程仍在运行，跳过'); return; }
  }
  fs.writeFileSync(LOCK, String(Date.now()));
  manifest = readManifest();
  const files = walk(ROOT).sort((a, b) => a.rel.localeCompare(b.rel));
  log(`project=${PROJECT} root=${ROOT} files=${files.length}`);
  if (files.length > CONFIG.maxFiles) {
    throw new Error(`md 文件过多（${files.length}），超过上限 ${CONFIG.maxFiles}；请用 --include 缩小范围`);
  }

  const changes = [];
  const errors = [];
  let created = 0, updated = 0, skipped = 0;

  try {
    for (const f of files) {
      const rawFull = fs.readFileSync(f.abs, 'utf8').replace(/^\uFEFF/, '');
      const raw = stripFrontmatter(rawFull);
      const { meta } = parseFrontmatter(rawFull);
      const suspicious = (raw.match(MOJIBAKE_RX) || []).length;
      if (suspicious >= MOJIBAKE_LIMIT) {
        const msg = `${f.rel}: 疑似 GBK/UTF-8 乱码（命中 ${suspicious} 处），请用 UTF-8 无 BOM 重新保存`;
        errors.push(msg);
        log(`SKIPPED ${msg}`);
        continue;
      }
      const title = titleOf(raw, f.rel);
      const body = splitWideTables(fixDocLinks(bodyOf(raw), f.rel));
      // hash 用解析后的正文：首轮发布时目标文档可能还没建好，.md 引用会退化成行内代码；
      // 等全部文档建好后，下一轮 hash 会变化并自动重写，链接最终收敛。
      // v2 前缀让早期清单强制重跑一次，避免沿用旧的 raw hash。
      const hash = sha(`project-docs-v2\n${body}`);
      const prev = manifest[f.rel];

      if (prev && prev.hash === hash && !ARGS.force) { skipped++; continue; }
      if (ARGS.preview) {
        const previewDir = FLAT ? '' : path.posix.dirname(f.rel);
        const previewTarget = prev?.docId
          ? (prev.folder || `${CONFIG.rootFolder}/${PROJECT}/${previewDir}`)
          : [routeFor(f.rel, meta).root, PROJECT, ...(previewDir && previewDir !== '.' ? [previewDir] : [])].join('/');
        changes.push(`${prev?.docId ? 'update' : 'create'} ${f.rel} -> ${previewTarget}`);
        continue;
      }

      const dir = FLAT ? '' : path.posix.dirname(f.rel);
      const isNew = !prev?.docId;
      // 新建文档按生命周期落位；存量文档只更新内容、不自动移动（搬迁交给 migrate-plan/apply）
      const segments = isNew
        ? [...routeFor(f.rel, meta).root.split('/'), PROJECT, ...(dir && dir !== '.' ? dir.split('/') : [])]
        : [...CONFIG.rootFolder.split('/'), PROJECT, ...(dir && dir !== '.' ? dir.split('/') : [])];
      try {
        await ensureConnected();
        let docId = prev?.docId;
        if (docId) {
          await callTool('replace_doc_with_markdown', { workspaceId: CONFIG.workspaceId, docId, markdown: body });
          if (prev.title !== title) {
            await callTool('update_doc_title', { workspaceId: CONFIG.workspaceId, docId, title });
          }
          updated++;
          changes.push(`更新：${f.rel}`);
        } else {
          const folderId = await ensureFolder(segments);
          const res = await callTool('create_doc_from_markdown', {
            workspaceId: CONFIG.workspaceId, title, markdown: body, folderId,
          });
          docId = res.docId || res.id;
          created++;
          changes.push(`上传：${f.rel}`);
        }
        const folderRecorded = isNew ? segments.join('/') : (prev.folder || segments.join('/'));
        manifest[f.rel] = {
          docId, folder: folderRecorded, title, hash, updatedAt: new Date().toISOString(),
        };
        await writePointerMemory(f.rel, title, docId, folderRecorded);
        writeManifest(manifest);
      } catch (e) {
        errors.push(`${f.rel}: ${e.message}`);
        log(`FAILED ${f.rel}: ${e.message}`);
      }
      await sleep(300);
    }
  } finally {
    if (!ARGS.preview && session) {
      try {
        await fetch(CONFIG.mcpUrl, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${getToken()}`, 'Mcp-Session-Id': session, 'MCP-Protocol-Version': proto },
        });
      } catch {}
    }
    try { fs.unlinkSync(LOCK); } catch {}
  }

  const summary = { at: new Date().toISOString(), project: PROJECT, root: ROOT, created, updated, skipped, errors, changes, preview: ARGS.preview };
  fs.writeFileSync(STATUS, JSON.stringify(summary, null, 2), 'utf8');
  log(`done created=${created} updated=${updated} skipped=${skipped} errors=${errors.length}${ARGS.preview ? ' (preview)' : ''}`);
  if (ARGS.preview && changes.length) {
    log('将要执行：');
    for (const c of changes) log('  ' + c);
  }
  if (errors.length) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
