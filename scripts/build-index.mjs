#!/usr/bin/env node
/**
 * 生成 / 校验人格库索引（独立仓库版）。
 *
 *   node scripts/build-index.mjs            # 重算并写回 index.json + packs/
 *   node scripts/build-index.mjs --check    # 只校验，不写；不一致退出码 1
 *
 * 这份脚本和主仓 `dsh-roost/scripts/build-persona-index.mjs` 产出的字节
 * **必须完全一致**——客户端是拿 index.json 里的 sha256 和它下载到的正文比的，
 * 两边哈希规则不一样，就会「每次都判改过 / 永远更新不了」。
 *
 * 所以这里的两个关键函数是**从主仓逐字抄来的**，改动时两边要同步：
 *   · `hashText` —— 先 CRLF→LF 归一，再 sha256（见 dsh-roost/src/catalog.js）
 *   · `parsePersona` 的头部解析 —— 这里只内联「取 label/name/tags」的最小子集
 *
 * 为什么独立仓库不放主仓那份脚本：主仓版 `import` 了 `src/personas.js` 和
 * `src/catalog.js`，而本仓库只有 `.md` 文件，没有 `src/`。内联这两个纯函数，
 * 让本仓库 clone 下来就能直接跑，不依赖主仓。
 */
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIR = path.join(ROOT, '.');
const TARGET = path.join(DIR, 'index.json');

/** 这批人格要求的最低 dsh-roost 版本（跟着主仓走，这里照抄） */
const MIN_VERSION = '0.11.0';

/** pack 数量永久固定 16，改了就全量重排、增量同步失效 */
const PACK_N = 16;

/** 索引上限 512 KB（老版本 getText 的硬上限） */
const INDEX_MAX_BYTES = 512 * 1024;

/* ---------------- 从主仓逐字抄来的两个函数 ---------------- */

// dsh-roost/src/catalog.js:28
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
// dsh-roost/src/catalog.js:37 —— CRLF 归一后哈希，Windows/GitHub 检出字节不同但内容一样
const hashText = (text) => sha256(Buffer.from(String(text ?? '').replace(/\r\n/g, '\n'), 'utf8'));

/**
 * 头部解析的最小子集（只取 label / name / tags）。
 *
 * 和主仓 `parsePersona` 的头部规则一致：容忍缩进、大小写、前导空行。
 * 只内联索引需要的三个字段，正文四段切分（demos/lore 等）这里用不上。
 */
function parseHead(raw) {
  const text = String(raw ?? '').replace(/^\uFEFF/, '');
  const m = text.match(/^\s*---[ \t]*\r?\n([\s\S]*?)(?:\r?\n)?---[ \t]*(?:\r?\n|$)/);
  const out = { label: '', name: '', tags: [] };
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^\s*([A-Za-z_]\w*)\s*:\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    if (key === 'label') out.label = kv[2].trim();
    if (key === 'name') out.name = kv[2].trim();
    if (key === 'tags') {
      out.tags = kv[2]
        .replace(/^\[|\]$/g, '')
        .split(/[,，]/)
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }
  return out;
}

const packOf = (id) => parseInt(hashText(id).slice(0, 8), 16) % PACK_N;

const checkOnly = process.argv.includes('--check');

async function build() {
  /**
   * 只扫人格文件：排除 README（仓库根目录的说明文档不是人格）。
   * 主仓的脚本扫的是 `personas/` 子目录、天然不含 README；本仓库的
   * 人格和 README 都平铺在根目录，必须显式排除。
   */
  const names = (await fs.readdir(DIR)).filter((n) => n.endsWith('.md') && n !== 'README.md').sort();

  const personas = [];
  const buckets = Array.from({ length: PACK_N }, () => []);
  for (const file of names) {
    const raw = await fs.readFile(path.join(DIR, file), 'utf8');
    const id = file.slice(0, -3);
    const head = parseHead(raw);
    if (/^\s*name\s*:/m.test(raw)) {
      console.warn(`  ⚠ ${file} 还在用 name:，0.11 起请改成 label:（name 只作兼容别名）`);
    }
    const pack = packOf(id);
    buckets[pack].push({ id, text: raw });
    personas.push({
      id,
      label: head.label || head.name,
      name: head.label || head.name,
      tags: head.tags,
      file,
      chars: raw.replace(/\r\n/g, '\n').length,
      sha256: hashText(raw),
      pack,
    });
  }

  const packs = [];
  const packFiles = new Map();
  for (let n = 0; n < PACK_N; n += 1) {
    if (!buckets[n].length) continue;
    buckets[n].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const body = buckets[n].map((x) => JSON.stringify(x)).join('\n') + '\n';
    const file = `packs/p${n}.jsonl`;
    packFiles.set(file, body);
    packs.push({ n, file, count: buckets[n].length, bytes: Buffer.byteLength(body, 'utf8') });
  }

  return {
    packFiles,
    index: {
      schema: 3,
      repo: 'tdcq9594/dsh-roost-personas',
      branch: 'main',
      minVersion: MIN_VERSION,
      packs,
      personas,
    },
  };
}

const { index, packFiles } = await build();

/** 先把 packs 写成字节、算总大小，和索引一起判断要不要动 */
const json = JSON.stringify(index, null, 2) + '\n';
if (Buffer.byteLength(json, 'utf8') > INDEX_MAX_BYTES) {
  console.error(`✗ index.json ${Buffer.byteLength(json, 'utf8')} 字节，超过 ${INDEX_MAX_BYTES} 上限`);
  process.exit(1);
}

if (checkOnly) {
  const problems = [];
  try {
    const cur = JSON.parse(await fs.readFile(TARGET, 'utf8'));
    if (JSON.stringify(cur) !== JSON.stringify(index)) problems.push('index.json 和目录对不上');
    for (const [file, body] of packFiles) {
      if (!existsSync(path.join(ROOT, file))) {
        problems.push(`缺分片 ${file}`);
        continue;
      }
      if ((await fs.readFile(path.join(ROOT, file), 'utf8')) !== body) problems.push(`分片 ${file} 内容不一致`);
    }
  } catch (e) {
    problems.push(`读 index.json 失败：${e.message}`);
  }
  if (problems.length) {
    console.error('索引和人格目录对不上：');
    for (const p of problems) console.error(`  ✗ ${p}`);
    console.error('\n跑 node scripts/build-index.mjs 重新生成。');
    process.exit(1);
  }
  console.log(`✓ 索引一致（${index.personas.length} 份人格）`);
  process.exit(0);
}

await fs.writeFile(TARGET, json, 'utf8');
for (const [file, body] of packFiles) {
  await fs.mkdir(path.dirname(path.join(ROOT, file)), { recursive: true });
  await fs.writeFile(path.join(ROOT, file), body, 'utf8');
}
console.log(`已生成 index.json（${index.personas.length} 份人格，${packFiles.size} 个分片）`);
for (const p of index.personas) {
  console.log(`  - ${p.id}（${p.chars} 字）`);
}
