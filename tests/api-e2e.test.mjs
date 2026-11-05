/**
 * API 路端到端测试（fetch 打桩，不碰真站）：
 * 验证「拉题 → 出码 → 保存 → 触发评测 → 轮询 game_status → 失败回喂重写 → 通过」的完整编排。
 *
 * 打桩数据照真实接口的形状来：
 *   - task 详情是顶层对象（无 data 包裹），带 myshixun.identifier / user.login / sec_key
 *   - game_status.json 的 test_sets[].result 是**布尔值**，还带 compile_success / output / actual_output
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import * as solver from '../lib/solver.mjs';

const GOOD = [
  'def reverse_list(head):',
  '    prev = None',
  '    while head:',
  '        head.next, prev, head = prev, head, head.next',
  '    return prev',
].join('\n');

const BAD = ['def reverse_list(head):', '    return None'].join('\n');

/** 真实 task 详情的形状（精简版）。 */
function taskPayload() {
  return {
    status: 200,
    game: { id: 243891938, status: 1, myshixun_id: 70736023 },
    challenge: {
      id: 5549217,
      subject: '第2关：链表反转',
      task_pass: '任务描述：给定一个单链表，将其反转并返回新的头节点。',
      path: 'solution.py；',
      shixun_id: 2096858,
    },
    myshixun: { id: 70736023, identifier: 'ajlk5ovpzr' },
    user: { login: 'pplrf5cx3', user_id: 3964377 },
    sec_key: 'ebkl76pj5o8n',
    shixun_environments: [{ shixun_environment_id: 1735677 }],
    test_sets: [],
  };
}

export default async function run() {
  const calls = [];
  let buildCount = 0;
  let statusPolls = 0;

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const method = init?.method ?? 'GET';
    calls.push({ method, path: u.replace('https://data.educoder.net/api', ''), body: init?.body });

    let payload = { status: 200, data: {} };
    if (u.includes('rep_content.json')) {
      // 真实返回：content 是对象，里面才是 base64
      payload = {
        status: 200,
        content: {
          content: Buffer.from('def reverse_list(head):\n    ————\n', 'utf8').toString('base64'),
          size: 40,
          filename: 'solution.py',
        },
        language: 'python',
      };
    } else if (u.includes('update_file.json')) {
      payload = { status: 200, message: 'ok', content_modified: 0 };
    } else if (u.includes('game_build.json')) {
      buildCount++;
      payload = { status: 200, data: { sec_key: `newkey${buildCount}` } };
    } else if (u.includes('game_status.json')) {
      // 第 1 次评测：1/2 失败（带实际输出）；第 2 次：2/2 通过
      statusPolls++;
      const sets =
        buildCount === 1
          ? [
              { result: true, compile_success: 1, output: 'ok', actual_output: 'ok' },
              {
                result: false,
                compile_success: 1,
                output: '[3,2,1]',
                actual_output: 'None',
              },
            ]
          : [
              { result: true, compile_success: 1, output: 'ok', actual_output: 'ok' },
              { result: true, compile_success: 1, output: '[3,2,1]', actual_output: '[3,2,1]' },
            ];
      payload = {
        status: 200,
        grade: buildCount === 1 ? 50 : 100,
        status_code: 0,
        test_sets: sets,
        last_compile_output: '',
        sec_key: `pollkey${statusPolls}`,
      };
    } else if (u.includes('/tasks/')) {
      payload = taskPayload();
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

  // 伪造登录态（测试期间临时写入，结束还原）
  const dir = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'educoder-auto');
  const sessionFile = join(dir, 'session.json');
  await mkdir(dir, { recursive: true });
  const previous = await readFile(sessionFile, 'utf8').catch(() => null);
  await writeFile(
    sessionFile,
    JSON.stringify({ cookies: { _educoder_session: 'FAKE' }, savedAt: new Date().toISOString() }),
    'utf8',
  );

  let round = 0;
  const fakeLlm = {
    async listProviders() {
      return [{ id: 'stub' }];
    },
    async listModels() {
      return [{ provider: 'stub', id: 'stub-model' }];
    },
    stream() {
      round++;
      return (async function* () {
        yield { type: 'text-delta', index: 0, text: '```python\n' + (round === 1 ? BAD : GOOD) + '\n```' };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })();
    },
  };

  try {
    const trace = solver.createTrace();
    const r = await solver.solveUrl({
      url: 'https://www.educoder.net/tasks/abc123def?homework_common_id=777',
      llm: fakeLlm,
      aiConfig: {},
      submit: true,
      mode: 'api',
      humanize: false,
      styleMatch: false,
      trace,
      // 这条测试只验 API 路；截图识题兜底会开浏览器、还会多消耗一次模型调用，
      // 单独由 vision 测试覆盖，这里显式关掉。
      vision: false,
      buildTimeoutMs: 20_000,
    });

    assert.equal(r.channel, 'api', '应走 API 通道');
    assert.equal(r.attempts.length, 2, `应重写 1 次，实际 ${r.attempts.length} 轮`);
    assert.equal(r.attempts[0].state, 'fail', '第 1 轮应失败');
    assert.equal(r.attempts[1].state, 'pass', '第 2 轮应通过');
    assert.equal(r.passed, true);
    assert.match(r.writes[0].code, /while head/);

    // 关键接口都被调到
    const paths = calls.map((c) => c.path);
    assert.ok(paths.some((p) => p.startsWith('/tasks/abc123def.json')), '应拉取 task 详情');
    assert.ok(paths.some((p) => p.includes('update_file.json')), '应保存文件');
    assert.ok(paths.some((p) => p.includes('game_status.json')), '应用 game_status 轮询评测');
    assert.equal(calls.filter((c) => c.path.includes('game_build.json')).length, 2, '应触发 2 次评测');
    assert.ok(
      calls
        .filter((c) => c.method === 'POST')
        .every((c) => c.path.includes('update_file') || c.path.includes('game_build')),
      'POST 只应打到保存与评测接口',
    );

    // 保存请求必须带真实前端那套参数（之前缺这些会被平台静默忽略）
    const save = calls.find((c) => c.path.includes('update_file.json'));
    assert.ok(save.path.includes('/myshixuns/ajlk5ovpzr/'), 'URL 里应是 myshixun.identifier');
    assert.ok(save.path.includes('zzud=pplrf5cx3'), 'query 里应带 zzud=用户 login');
    const saveBody = JSON.parse(save.body);
    assert.equal(saveBody.evaluate, 1, 'evaluate 应为数字 1');
    assert.equal(saveBody.tab_type, 1, 'tab_type 应为 1');
    assert.equal(saveBody.content, BAD, '代码应在 content 字段');
    assert.equal(saveBody.game_id, 243891938, 'game_id 应取 game.id');
    assert.equal(saveBody.homework_common_id, '777', 'homework_common_id 应是字符串');
    assert.equal(saveBody.extras.challenge_id, 5549217, 'extras 应带 challenge_id');
    assert.equal(saveBody.extras.currentUserId, 3964377, 'extras 应带 currentUserId');

    // 评测请求要带 sec_key 与 shixun_environment_id
    const build = JSON.parse(calls.find((c) => c.path.includes('game_build.json')).body);
    assert.equal(build.sec_key, 'ebkl76pj5o8n', 'game_build 应带 sec_key');
    assert.equal(build.shixun_environment_id, 1735677, 'game_build 应带 shixun_environment_id');
    assert.equal(build.extras.challenge_id, 5549217);

    return `API 路 e2e：2 轮（fail → pass），调用 ${calls.length} 次接口，保存/评测参数与真实前端一致`;
  } finally {
    globalThis.fetch = realFetch;
    await writeFile(sessionFile, previous ?? '{}', 'utf8');
  }
}
