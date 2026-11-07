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
 *   --help, -h            显示帮助
 *
 * 项目根可用 .affine-docs.config.json 覆盖（字段：project / include / exclude / flat）。
 */
// 配置示例：{ "project": "名称", "include": ["docs/**/*.md"], "exclude": ["draft/**"], "flat": false }
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const STATE_DIR = path.join(os.homedir(), '.affine-docs');
function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; }
}
// 优先级：环境变量 > ~/.affine-docs/config.json > 内置默认值
const FILE_CFG = readJsonSafe(path.join(STATE_DIR, 'config.json'));
const CONFIG = {
  mcpUrl: process.env.AFFINE_MCP_URL || FILE_CFG.mcpUrl || 'https://affinemcp.shm.fun:4430/mcp',
  tokenFile: process.env.AFFINE_TOKEN_FILE || FILE_CFG.tokenFile || path.join(os.homedir(), '.secrets', 'affine_mcp_token.txt'),
  workspaceId: process.env.AFFINE_WORKSPACE_ID || FILE_CFG.workspaceId || 'c98ccc82-d368-4a3c-ac2d-1cd6bab61b02',
  webBase: process.env.AFFINE_WEB_BASE || FILE_CFG.webBase || 'https://wiki.shm.fun:4430',
  rootFolder: process.env.AFFINE_ROOT_FOLDER || FILE_CFG.rootFolder || 'AI-Docs',
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
  --help, -h            显示帮助`);
}

function parseArgs(argv) {
  const out = { root: null, project: null, preview: false, force: false, flat: null, noPointer: false, includes: [], excludes: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { usage(); process.exit(0); }
    else if (a === '--project') { out.project = argv[++i]; }
    else if (a === '--preview' || a === '--dry-run') out.preview = true;
    else if (a === '--all' || a === '--force') out.force = true;
    else if (a === '--flat') out.flat = true;
    else if (a === '--no-pointer') out.noPointer = true;
    else if (a === '--include') out.includes.push(argv[++i]);
    else if (a === '--exclude') out.excludes.push(argv[++i]);
    else if (!a.startsWith('-') && !out.root) out.root = a;
    else throw new Error(`未知参数：${a}`);
  }
  return out;
}
const ARGS = parseArgs(process.argv.slice(2));
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
async function writePointerMemory(rel, title, docId, folder) {
  if (ARGS.noPointer) return;
  const cfg = readMem0Config();
  if (!cfg) return;
  const text = `文档指针：${title}（${rel}）已发布到 AFFiNE ${folder}，docId=${docId}。URL：${docUrl(docId)}`;
  const h = sha(text);
  if (manifest[rel]?.pointerHash === h) return;
  try {
    const res = await fetch(`${cfg.url}/memories`, {
      method: 'POST',
      headers: { 'X-API-Key': cfg.key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: text }],
        user_id: cfg.userId,
        infer: false,
        metadata: {
          project: PROJECT, source: 'doc_pointer', doc_path: rel,
          doc_id: docId, doc_url: docUrl(docId), folder,
        },
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (manifest[rel]) manifest[rel].pointerHash = h;
    log(`pointer ${rel}`);
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

async function main() {
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
      const raw = stripFrontmatter(fs.readFileSync(f.abs, 'utf8').replace(/^\uFEFF/, ''));
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
        changes.push(`${prev ? 'update' : 'create'} ${f.rel} -> AI-Docs/${PROJECT}/${FLAT ? '' : path.posix.dirname(f.rel)}`);
        continue;
      }

      const dir = FLAT ? '' : path.posix.dirname(f.rel);
      const segments = [CONFIG.rootFolder, PROJECT, ...(dir && dir !== '.' ? dir.split('/') : [])];
      try {
        await ensureConnected();
        const folderId = await ensureFolder(segments);
        let docId = prev?.docId;
        if (docId) {
          await callTool('replace_doc_with_markdown', { workspaceId: CONFIG.workspaceId, docId, markdown: body });
          if (prev.title !== title) {
            await callTool('update_doc_title', { workspaceId: CONFIG.workspaceId, docId, title });
          }
          updated++;
          changes.push(`更新：${f.rel}`);
        } else {
          const res = await callTool('create_doc_from_markdown', {
            workspaceId: CONFIG.workspaceId, title, markdown: body, folderId,
          });
          docId = res.docId || res.id;
          created++;
          changes.push(`上传：${f.rel}`);
        }
        manifest[f.rel] = {
          docId, folder: segments.join('/'), title, hash, updatedAt: new Date().toISOString(),
        };
        await writePointerMemory(f.rel, title, docId, segments.join('/'));
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
