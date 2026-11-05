#!/usr/bin/env node
/**
 * 测试入口：`node tests/run.mjs`
 *
 * 分两档：
 *   快测（默认）—— 纯函数 + 插件装配，不起浏览器，几百毫秒跑完
 *   全测（--all）—— 加上浏览器路 e2e（会真的开一个 Edge 窗口）
 *
 * 任何一档失败都以非 0 退出，方便接 CI。
 */
import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ALL = process.argv.includes('--all');

/** 会开浏览器的用例单独拎出来，默认不跑。 */
const SLOW = new Set(['browser-e2e.test.mjs']);

const files = (await readdir(HERE))
  .filter((f) => f.endsWith('.test.mjs'))
  .filter((f) => ALL || !SLOW.has(f))
  .sort();

let passed = 0;
const failures = [];

for (const file of files) {
  const label = file.replace(/\.test\.mjs$/, '');
  process.stdout.write(`\n▶ ${label}\n`);
  const started = Date.now();
  try {
    const mod = await import(pathToFileURL(join(HERE, file)).href);
    const detail = await mod.default();
    const ms = Date.now() - started;
    passed++;
    console.log(`  ✅ ${detail ?? '通过'}（${ms}ms）`);
  } catch (error) {
    const ms = Date.now() - started;
    failures.push({ label, error });
    console.log(`  ❌ 失败（${ms}ms）：${error?.message ?? error}`);
  }
}

console.log(`\n${'─'.repeat(50)}`);
if (failures.length) {
  console.log(`❌ ${failures.length} 个用例失败，${passed} 个通过`);
  for (const f of failures) {
    console.log(`\n--- ${f.label} ---`);
    console.log(f.error?.stack ?? f.error);
  }
  process.exit(1);
}
console.log(`✅ 全部通过（${passed} 个用例）${ALL ? '' : '　（浏览器 e2e 未跑，加 --all 开启）'}`);
