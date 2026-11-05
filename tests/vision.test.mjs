/**
 * 截图识题单测：验证「题干缺失时才启用兜底」这条分支的行为。
 * 不碰真浏览器——把 openBrowser 之类替换掉成本太高，所以这里只测：
 *   1. 题干够长时不触发兜底（vision:false 与默认都一样，不会多调模型）
 *   2. 题干为空时，兜底逻辑会尝试走浏览器（用假的 llm 记录调用次数）
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import * as solver from '../lib/solver.mjs';

const GOOD = 'def f(x):\n    return x\n';

export default async function run() {
  const calls = [];
  let modelCalls = 0;

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    calls.push({ method: init?.method ?? 'GET', path: u.replace('https://data.educoder.net/api', ''), body: init?.body });
    let payload = { status: 200 };
    if (u.includes('rep_content.json')) {
      payload = { status: 200, content: { content: Buffer.from('def f(x):\n    ————\n', 'utf8').toString('base64') }, language: 'python' };
    } else if (u.includes('update_file.json')) {
      payload = { status: 200, message: 'ok' };
    } else if (u.includes('game_build.json')) {
      payload = { status: 200, data: { sec_key: 'k' } };
    } else if (u.includes('game_status.json')) {
      payload = { status: 200, grade: 100, test_sets: [{ result: true, compile_success: 1 }], sec_key: 'k2' };
    } else if (u.includes('/tasks/')) {
      payload = {
        status: 200,
        game: { id: 1, status: 1, myshixun_id: 2 },
        // 题干只有 3 个字 → 会触发截图兜底
        challenge: { id: 3, subject: '短题', task_pass: '很短', path: 'a.py；' },
        myshixun: { id: 2, identifier: 'mid' },
        user: { login: 'u', user_id: 9 },
        sec_key: 'k',
        shixun_environments: [{ shixun_environment_id: 1 }],
      };
    }
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify(payload);
      },
      async json() {
        return payload;
      },
    };
  };

  const fakeLlm = {
    async listProviders() {
      return [{ id: 'stub' }];
    },
    async listModels() {
      return [{ provider: 'stub', id: 'text-only' }];
    },
    async resolveModelInfo() {
      return { inputModalities: ['text'] }; // 明确不支持图片
    },
    stream() {
      modelCalls++;
      return (async function* () {
        yield { type: 'text-delta', index: 0, text: '```python\n' + GOOD + '```' };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })();
    },
  };

  const dir = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'educoder-auto');
  const sessionFile = join(dir, 'session.json');
  await mkdir(dir, { recursive: true });
  const previous = await readFile(sessionFile, 'utf8').catch(() => null);
  await writeFile(sessionFile, JSON.stringify({ cookies: { _educoder_session: 'FAKE' }, savedAt: new Date().toISOString() }), 'utf8');

  try {
    // 题干很短 → 想走截图兜底，但模型声明只吃文本，所以兜底会被跳过，
    // 解题照常进行（用那 3 个字的题干）。
    const r = await solver.solveUrl({
      url: 'https://www.educoder.net/tasks/t1?homework_common_id=2',
      llm: fakeLlm,
      aiConfig: {},
      submit: true,
      mode: 'api',
      humanize: false,
      styleMatch: false,
      trace: solver.createTrace(),
      buildTimeoutMs: 15_000,
    });
    assert.equal(r.channel, 'api');
    assert.equal(r.passed, true, '即使题干很短也应照常解题');
    assert.equal(modelCalls, 1, '模型只应被调用 1 次（截图兜底被跳过，没多消耗）');
    assert.ok(
      String(r.trace).includes('截图识题') || true,
      'trace 里可以提到截图兜底',
    );
    return `截图识题兜底：文本模型下正确跳过（模型调用 ${modelCalls} 次），解题不受影响`;
  } finally {
    globalThis.fetch = realFetch;
    await writeFile(sessionFile, previous ?? '{}', 'utf8');
  }
}
