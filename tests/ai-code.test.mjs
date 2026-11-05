/**
 * AI 层单测：代码块提取（含多文件）、裸代码识别、prompt 拼接与截断。
 */
import assert from 'node:assert/strict';
import { extractCode, looksLikeCode, buildSolvePrompt, truncate } from '../lib/ai.mjs';

export default async function run() {
  let n = 0;

  // 代码块提取
  const single = extractCode('答案如下：\n```python\nprint(1)\n```\n用哈希表。');
  assert.equal(single.code, 'print(1)');
  assert.equal(single.language, 'python');
  assert.equal(single.note, '用哈希表。');
  n += 3;

  const multi = extractCode('### 文件: solution.py\n```python\nprint(1)\n```\n\n### 文件: helper.py\n```python\nprint(2)\n```');
  assert.deepEqual(Object.keys(multi.files).sort(), ['helper.py', 'solution.py']);
  assert.equal(multi.code, undefined, '多文件时不应再给单 code');
  n += 2;

  // 裸代码 vs 人话
  assert.equal(looksLikeCode('def f(x):\n    return x + 1'), true);
  assert.equal(looksLikeCode('echo hi\nexport A=1'), true);
  assert.equal(looksLikeCode('int main() {\n  return 0;\n}'), true);
  assert.equal(looksLikeCode('x = 1'), true);
  assert.equal(looksLikeCode('我不知道这道题怎么做'), false, '中文人话不该当代码');
  assert.equal(looksLikeCode('抱歉，我无法完成'), false);
  assert.equal(looksLikeCode('这道题需要用到哈希表，时间复杂度 O(n)。'), false);
  assert.equal(looksLikeCode(''), false);
  n += 8;

  assert.equal(extractCode('我不知道这道题怎么做').code, undefined, '人话不该被当成代码');
  assert.equal(extractCode('def f():\n    return 1').code, 'def f():\n    return 1', '裸代码应能提取');
  n += 2;

  // prompt 与截断
  const p = buildSolvePrompt({
    title: 'T',
    statement: 'S'.repeat(20000),
    files: [{ path: 'a.py', content: 'x', language: 'python' }],
    extra: '上次报错：NameError',
  });
  assert.ok(p.length < 20000, 'prompt 应被截断到合理长度');
  assert.ok(p.includes('中间省略'), '超长题干应带截断标记');
  assert.ok(p.includes('NameError'), 'extra 应被带上');
  assert.ok(p.includes('### 文件: a.py'), '文件清单应被带上');
  n += 4;

  const t = truncate('a'.repeat(100), 20);
  assert.ok(t.length > 20, '截断后应保留头尾');
  assert.ok(t.includes('中间省略'));
  assert.equal(truncate('short', 100), 'short', '不超长时原样返回');
  n += 3;

  return `AI 层单测：${n} 条断言全过`;
}
