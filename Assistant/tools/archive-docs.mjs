#!/usr/bin/env node
/**
 * 把已发布到 AFFiNE 的文档按年/月归档（原地移动，docId 不变）。
 *
 * 用法：
 *   node archive-docs.mjs [项目根] [--project <名称>] [--pattern <前缀>] [--dry-run] [--force]
 *
 * 行为：
 *   - 读取项目根的 .affine-docs.config.json 与发布清单；
 *   - 日期优先取 md frontmatter 的 date:，其次文件名 YYYY-MM-DD，最后文件 mtime；
 *   - 在 AI-Docs/<项目>/ 下创建 YYYY/MM 文件夹；
 *   - 用 move_organize_node 移动文档节点，同步移动本地文件；
 *   - 更新 manifest 的 key/folder 与蒸馏台账的 note 路径。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const HOME = os.homedir();
const MANIFEST_DIR = path.join(HOME, '.affine-docs', 'manifests');
const INDEX_PATH = path.join(HOME, '.affine-docs', 'distill', 'index.json');
const CONFIG = {
  mcpUrl: process.env.AFFINE_MCP_URL || 'https://affinemcp.shm.fun:4430/mcp',
  workspaceId: process.env.AFFINE_WORKSPACE_ID || 'c98ccc82-d368-4a3c-ac2d-1cd6bab61b02',
  tokenFile: process.env.AFFINE_TOKEN_FILE || path.join(HOME, '.secrets', 'affine_mcp_token.txt'),
};

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function parseArgs(argv) {
  const out = { root: null, project: null, pattern: null, dryRun: false, force: false, byMtime: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { usage(); process.exit(0); }
    else if (a === '--project') out.project = argv[++i];
    else if (a === '--pattern') out.pattern = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--force') out.force = true;
    else if (a === '--by-mtime') out.byMtime = true;
    else if (!a.startsWith('-') && !out.root) out.root = a;
    else throw new Error(`未知参数：${a}`);
  }
  return out;
}
function usage() {
  console.log(`用法: node archive-docs.mjs [项目根] [选项]

  --project <名称>   项目文件夹名（默认读 .affine-docs.config.json 或目录名）
  --pattern <前缀>   只归档 key 以此开头的文档（如 notes/）
  --dry-run          只打印计划，不移动
  --force            已按年/月归档的也重新计算（通常不需要）
  --by-mtime         忽略 frontmatter/文件名，按文件修改时间归档`);
}

const ARGS = parseArgs(process.argv.slice(2));
const ROOT = path.resolve(ARGS.root || process.cwd());
const CFG_FILE = path.join(ROOT, '.affine-docs.config.json');
let fileCfg = {};
if (fs.existsSync(CFG_FILE)) { try { fileCfg = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')); } catch {} }
const PROJECT = String(ARGS.project || fileCfg.project || path.basename(ROOT)).trim();
const STATE_ID = sha(ROOT).slice(0, 16);
const MANIFEST = path.join(MANIFEST_DIR, `${STATE_ID}.json`);

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
function writeJson(p, v) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}
function shaFile(p) { return sha(fs.readFileSync(p)); }

function dateOf(key, entry) {
  const local = path.join(ROOT, ...key.split('/'));
  if (!ARGS.byMtime && fs.existsSync(local)) {
    try {
      const txt = fs.readFileSync(local, 'utf8');
      const m = txt.match(/^date:\s*(\d{4})-(\d{2})/m);
      if (m) return [m[1], m[2]];
    } catch {}
  }
  const m = path.basename(key).match(/^(\d{4})-(\d{2})/);
  if (m && !ARGS.byMtime) return [m[1], m[2]];
  if (fs.existsSync(local)) {
    const d = new Date(fs.statSync(local).mtimeMs);
    return [String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0')];
  }
  if (entry?.updatedAt) {
    const d = new Date(entry.updatedAt);
    if (!Number.isNaN(d.getTime())) return [String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0')];
  }
  return null;
}

/* ---------- MCP ---------- */
let session = null, proto = '2025-06-18';
function getToken() {
  if (process.env.AFFINE_TOKEN) return process.env.AFFINE_TOKEN.trim();
  const line = fs.readFileSync(CONFIG.tokenFile, 'utf8').trim();
  const m = line.match(/^Authorization\s*[:=]\s*Bearer\s*(.+)$/i);
  return (m ? m[1] : line.replace(/^Bearer\s*/i, '')).trim();
}
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
  const sid = res.headers.get('mcp-session-id'); if (sid) session = sid;
  let text = await res.text();
  if (!text.trim()) return null;
  if (text.includes('data:')) text = text.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
  const json = JSON.parse(text);
  if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
  return json.result;
}
async function connect() {
  const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: proto, capabilities: {}, clientInfo: { name: 'archive-docs', version: '1.0' } } });
  proto = init?.protocolVersion || proto;
  await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
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
function nodeName(n) {
  const d = n?.data;
  if (typeof d === 'string') {
    const s = d.trim();
    if (s.startsWith('{')) { try { const o = JSON.parse(s); return o.name || o.title || ''; } catch {} }
    return s;
  }
  return d?.name || d?.title || n?.name || '';
}

async function main() {
  const manifest = readJson(MANIFEST, {});
  if (!Object.keys(manifest).length) throw new Error(`清单为空或不存在：${MANIFEST}`);
  const planned = [];
  const skipped = [];
  for (const [key, entry] of Object.entries(manifest)) {
    if (key === '_meta') continue;
    if (!key.endsWith('.md')) continue;
    if (key.startsWith('_')) continue;
    if (ARGS.pattern && !key.startsWith(ARGS.pattern)) continue;
    if (/^\d{4}\/\d{2}\//.test(key) && !ARGS.force) { skipped.push(`${key}（已归档）`); continue; }
    const date = dateOf(key, entry);
    if (!date) { skipped.push(`${key}（无法确定日期）`); continue; }
    const base = path.basename(key);
    const newKey = `${date[0]}/${date[1]}/${base}`;
    if (newKey === key) { skipped.push(`${key}（已在目标位置）`); continue; }
    if (manifest[newKey] && manifest[newKey].docId !== entry.docId) {
      skipped.push(`${key}（目标 key 已存在：${newKey}）`); continue;
    }
    planned.push({ key, newKey, entry, date });
  }

  if (!planned.length) {
    log(`没有需要归档的文档（project=${PROJECT}, root=${ROOT}）`);
    for (const s of skipped) log('  skip ' + s);
    return;
  }
  if (ARGS.dryRun) {
    log(`[dry-run] ${planned.length} 篇将归档：`);
    for (const p of planned) log(`  ${p.key} -> ${p.newKey}`);
    return;
  }

  await connect();
  const res = await callTool('list_organize_nodes', { workspaceId: CONFIG.workspaceId });
  const nodes = Array.isArray(res) ? res : res?.nodes || res?.items || res?.value || [];
  const rootFolder = nodes.find((n) => n.type === 'folder' && nodeName(n) === 'AI-Docs' && !(n.parentId ?? null));
  if (!rootFolder) throw new Error('找不到 AI-Docs 根文件夹');
  const projectFolder = nodes.find((n) => n.type === 'folder' && (n.parentId ?? null) === rootFolder.id && nodeName(n) === PROJECT);
  if (!projectFolder) throw new Error(`找不到项目文件夹 AI-Docs/${PROJECT}`);

  const folderCache = new Map();
  async function ensureFolder(yyyy, mm) {
    const key = `${yyyy}/${mm}`;
    if (folderCache.has(key)) return folderCache.get(key);
    let y = nodes.find((n) => n.type === 'folder' && (n.parentId ?? null) === projectFolder.id && nodeName(n) === yyyy);
    if (!y) {
      y = await callTool('create_folder', { workspaceId: CONFIG.workspaceId, name: yyyy, parentId: projectFolder.id });
      nodes.push({ id: y.id, parentId: projectFolder.id, type: 'folder', data: yyyy });
      log(`created folder ${PROJECT}/${yyyy}`);
    }
    let m = nodes.find((n) => n.type === 'folder' && (n.parentId ?? null) === y.id && nodeName(n) === mm);
    if (!m) {
      m = await callTool('create_folder', { workspaceId: CONFIG.workspaceId, name: mm, parentId: y.id });
      nodes.push({ id: m.id, parentId: y.id, type: 'folder', data: mm });
      log(`created folder ${PROJECT}/${yyyy}/${mm}`);
    }
    folderCache.set(key, m.id);
    return m.id;
  }

  const docNodes = new Map();
  for (const n of nodes) {
    if (n.type !== 'doc') continue;
    docNodes.set(nodeName(n), n);
    if (n.docId) docNodes.set(n.docId, n);
  }

  const index = readJson(INDEX_PATH, null);
  let moved = 0, errors = 0;
  for (const p of planned) {
    try {
      const folderId = await ensureFolder(p.date[0], p.date[1]);
      const node = docNodes.get(p.entry.docId);
      if (!node) throw new Error(`找不到文档的组织节点：${p.entry.docId}`);
      if ((node.parentId ?? null) !== folderId) {
        await callTool('move_organize_node', { workspaceId: CONFIG.workspaceId, nodeId: node.id, parentId: folderId });
      }
      const oldLocal = path.join(ROOT, ...p.key.split('/'));
      const newLocal = path.join(ROOT, ...p.newKey.split('/'));
      if (fs.existsSync(oldLocal) && oldLocal !== newLocal) {
        fs.mkdirSync(path.dirname(newLocal), { recursive: true });
        if (fs.existsSync(newLocal)) fs.unlinkSync(newLocal);
        fs.renameSync(oldLocal, newLocal);
      }
      delete manifest[p.key];
      manifest[p.newKey] = { ...p.entry, folder: `AI-Docs/${PROJECT}/${p.date[0]}/${p.date[1]}` };
      if (index?.sessions) {
        for (const rec of Object.values(index.sessions)) {
          if (rec?.note && path.resolve(rec.note) === path.resolve(oldLocal)) rec.note = path.resolve(newLocal);
        }
      }
      moved++;
      log(`moved ${p.key} -> ${p.newKey}`);
    } catch (e) {
      errors++;
      log(`FAILED ${p.key}: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  writeJson(MANIFEST, manifest);
  if (index) writeJson(INDEX_PATH, index);
  log(`done moved=${moved} errors=${errors} skipped=${skipped.length}`);
  if (errors) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
