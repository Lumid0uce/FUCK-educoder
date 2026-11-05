/**
 * 浏览器路端到端测试：用本地 fixture 页面模拟头歌关卡，
 * 跑完整链路：打开页面 → 抓编辑器 → AI 出码 → 写回 → 点评测 → 轮询结论。
 *
 * 不碰真实平台，所以可以随便跑。
 *
 * 注意：solver 默认跑完会关浏览器（避免占住 profile 目录）。要复核 DOM，
 * 就得用 keepBrowserOpen: true 把窗口留着，否则重新打开只会看到一个空白页。
 */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as solver from '../lib/solver.mjs';
import { openBrowser, pageSnapshot, closeBrowser, browserStatus } from '../lib/browser.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const fixtureUrl = new URL(`file://${join(HERE, 'fixture', 'task.html').replace(/\\/g, '/')}`).href;
const profileDir = join(HERE, '.profile-e2e');

/** 假的宿主 LLM：吐出跟真模型一样格式的回复。 */
function makeFakeLlm(code) {
  return {
    async listProviders() {
      return [{ id: 'stub' }];
    },
    async listModels() {
      return [{ provider: 'stub', id: 'stub-model', name: 'Stub' }];
    },
    stream() {
      return (async function* () {
        yield { type: 'text-delta', index: 0, text: '答案如下：\n\n```python\n' + code + '\n```\n\n用哈希表。' };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })();
    },
  };
}

const GOOD_CODE = [
  'def two_sum(nums, target):',
  '    seen = {}',
  '    for i, n in enumerate(nums):',
  '        if target - n in seen:',
  '            return [seen[target - n], i]',
  '        seen[n] = i',
  '    return []',
].join('\n');

const BAD_CODE = ['def two_sum(nums, target):', '    return None'].join('\n');

export default async function run() {
  await closeBrowser().catch(() => {});

  // ── 正例：好代码应该判 pass，并且窗口留着让我们复核 DOM ──────────────
  const trace = solver.createTrace();
  const result = await solver.solveUrl({
    url: fixtureUrl,
    llm: makeFakeLlm(GOOD_CODE),
    aiConfig: {},
    submit: true,
    mode: 'browser',
    humanize: false,
    styleMatch: false,
    trace,
    buildTimeoutMs: 20_000,
    browserOpts: { profileDir },
    keepBrowserOpen: true,
  });

  assert.equal(result.channel, 'browser', '应走浏览器通道');
  assert.equal(result.filled.ok, true, '代码应写入编辑器');
  assert.equal(result.evaluated, true, '应点击到评测按钮');
  assert.equal(result.verdict?.state, 'pass', `页面应判定通过，实际 ${result.verdict?.state}`);
  assert.equal(result.passed, true);
  assert.match(result.code, /def two_sum/);

  // 复核：keepBrowserOpen 之后会话还在，页面 DOM 就是刚才那份
  assert.equal((await browserStatus()).open, true, 'keepBrowserOpen 时应保留浏览器');
  const s = await openBrowser({ profileDir });
  const snap = await pageSnapshot(s, { maxChars: 4000 });
  assert.equal(snap.editors.length, 1, '应有 1 个编辑器');
  assert.ok(!snap.editors[0].value.includes('————'), '占位符应已被替换');
  assert.match(snap.editors[0].value, /def two_sum/);
  assert.match(snap.text, /评测通过/, '页面文字应显示评测通过');
  await closeBrowser();

  // ── 反例：坏代码应判 fail，且默认会自己关掉浏览器 ──────────────────
  const trace2 = solver.createTrace();
  const bad = await solver.solveUrl({
    url: fixtureUrl,
    llm: makeFakeLlm(BAD_CODE),
    aiConfig: {},
    submit: true,
    mode: 'browser',
    humanize: false,
    styleMatch: false,
    trace: trace2,
    buildTimeoutMs: 20_000,
    browserOpts: { profileDir },
  });
  assert.equal(bad.verdict?.state, 'fail', `坏代码应判定失败，实际 ${bad.verdict?.state}`);
  assert.equal(bad.passed, false);
  assert.equal((await browserStatus()).open, false, '默认应在跑完后关闭浏览器，别占住 profile');

  return `浏览器路 e2e：正例 PASS、反例 FAIL，keepOpen 与自动关闭都正确`;
}
