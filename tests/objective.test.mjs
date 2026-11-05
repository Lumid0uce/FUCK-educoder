/**
 * 客观题（选择题 / 填空题）单测：
 *   - 选项解析
 *   - 答案 JSON 抽取（各种脏回复）
 *   - 判分（平台不回逐题对错，只能看 final_score / status）
 *   - 端到端编排（打桩，不碰真站）
 */

import assert from 'node:assert/strict';
import * as api from '../lib/educoder-api.mjs';
import * as ai from '../lib/ai.mjs';
import { solveUrl } from '../lib/solver.mjs';

/** 造一份选择题的 task 详情（形状照抄真站）。 */
function choiceTask() {
  return {
    game: { id: 243875113, myshixun_id: 70730205, status: 0, final_score: 0 },
    challenge: { id: 5549278, subject: '单项选择题', score: 150, path: '' },
    myshixun: { identifier: 'ajlk5ovpzr' },
    user: { login: 'pplrf5cx3', user_id: 3964377 },
    chooses: [
      {
        challenge_choose_id: 2089028,
        subject: '下列字符序列中，合法的标识符是（  ）。',
        position: 1,
        question_type: 0,
        question_name: '单选题/多选题',
        multi_count: 1,
        challenge_question: [
          { option_name: 'INT#', position: 0 },
          { option_name: '5ab', position: 1 },
          { option_name: 'unsigned', position: 2 },
          { option_name: '_unm2', position: 3 },
        ],
      },
      {
        challenge_choose_id: 2089029,
        subject: '下列各组字符序列中，全部为合法标识符的一组是(    )。',
        position: 2,
        question_type: 0,
        question_name: '单选题/多选题',
        multi_count: 1,
        challenge_question: [
          { option_name: 'S.B，sum，average，_above', position: 0 },
          { option_name: 'class，day，lotus_1，2day', position: 1 },
        ],
      },
    ],
  };
}

/** 造一份填空题的 task 详情。 */
function fillTask() {
  return {
    game: { id: 243875114, myshixun_id: 70730206, status: 0, final_score: 0 },
    challenge: { id: 5549279, subject: '填空题', score: 50 },
    myshixun: { identifier: 'ajlk5ovpzr' },
    user: { login: 'pplrf5cx3', user_id: 3964377 },
    chooses: [
      {
        challenge_choose_id: 2090001,
        subject: '转义字符中，（  ）表示换行，（  ）表示双引号。',
        position: 1,
        question_type: 3,
        question_name: '填空题',
        multi_count: 2,
      },
      {
        challenge_choose_id: 2090002,
        subject: '字符串："Good" 在内存中占用(   )字节。',
        position: 2,
        question_type: 3,
        question_name: '填空题',
        multi_count: 1,
      },
    ],
  };
}

export default async function run() {
  // ── 1. 选项解析 ──
  const ct = choiceTask();
  assert.equal(api.detectKind(ct).kind, 'choice');
  assert.equal(api.detectKind(fillTask()).kind, 'fill');

  const chooses = api.extractChooses(ct);
  assert.equal(chooses.length, 2);
  assert.deepEqual(
    chooses[0].options.map((o) => `${o.label}.${o.text}`),
    ['A.INT#', 'B.5ab', 'C.unsigned', 'D._unm2'],
    '选择题选项要从 challenge_question[].option_name 读出来',
  );
  assert.equal(chooses[0].multiCount, 1);

  const fills = api.extractChooses(fillTask());
  assert.equal(fills.length, 2);
  assert.equal(fills[0].multiCount, 2, '填空题空数要读 multi_count');
  assert.equal(fills[0].options.length, 0, '填空题没有选项');

  // ── 2. 答案抽取：各种脏回复 ──
  const want = ['A', 'B'];
  assert.deepEqual(ai.extractObjectiveAnswers('{"answers":["A","B"]}', 2), want);
  assert.deepEqual(ai.extractObjectiveAnswers('```json\n{"answers":["A","B"]}\n```', 2), want, '要能去围栏');
  assert.deepEqual(ai.extractObjectiveAnswers('好的，答案是：{"answers":["A","B"]} 希望有帮助', 2), want, '要能抠出 JSON');
  assert.deepEqual(ai.extractObjectiveAnswers('["A","B"]', 2), want, '允许直接是数组');
  assert.equal(ai.extractObjectiveAnswers('{"answers":["A"]}', 2), undefined, '长度不符必须拒绝');
  assert.equal(ai.extractObjectiveAnswers('我不知道', 2), undefined, '没有 JSON 必须拒绝');
  assert.equal(ai.extractObjectiveAnswers('', 2), undefined);

  // 填空题答案是二维数组
  const fillAns = ai.extractObjectiveAnswers('{"answers":[["\\n","\\""],["5"]]}', 2);
  assert.deepEqual(fillAns, [['\n', '"'], ['5']], '填空题答案要保留成数组');

  // ── 3. 判分：平台不回逐题对错 ──
  // 真实响应形状：test_sets[].result 全 null，只回 grade（满分）
  const realResp = {
    grade: 300,
    challenge_chooses_count: 11,
    choose_correct_num: null,
    test_sets: Array.from({ length: 11 }, (_, i) => ({
      result: null,
      actual_output: 'X',
      standard_answer: null,
      position: i + 1,
    })),
    had_all_submmit: true,
  };
  // 答对 4/11、得分 120/150 → 没过
  const failVerdict = api.readChoiceResult(realResp, {
    game: { status: 0, final_score: 120, score_radio: 0.8 },
    challenge: { score: 150 },
  });
  assert.equal(failVerdict.state, 'fail', '没拿满分要判 fail');
  assert.equal(failVerdict.finalScore, 120);
  assert.equal(failVerdict.maxScore, 150);
  assert.equal(failVerdict.radio, 0.8);

  // 拿满分 → pass
  const passVerdict = api.readChoiceResult(realResp, {
    game: { status: 2, final_score: 150, score_radio: 1 },
    challenge: { score: 150 },
  });
  assert.equal(passVerdict.state, 'pass');

  // 没有 final_score 但有 status===2 → pass
  assert.equal(api.readChoiceResult(realResp, { game: { status: 2 }, challenge: { score: 150 } }).state, 'pass');

  // 什么都没有 → unknown，绝不瞎猜 pass
  assert.equal(api.readChoiceResult({}, {}).state, 'unknown', '无信息时必须 unknown');

  // ── 4. 端到端编排（打桩） ──
  const calls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push(`${init.method ?? 'GET'} ${u.replace(/^https:\/\/data\.educoder\.net\/api/, '')}`);
    if (u.includes('/tasks/fph74o35rv6f.json')) {
      return jsonResponse(choiceTask());
    }
    if (u.includes('/choose_build.json')) {
      const body = JSON.parse(init.body ?? '{}');
      assert.deepEqual(body.answer, ['A', 'B'], '提交的答案要原样传上去');
      assert.equal(body.challenge_id, 5549278);
      assert.equal(body.homework_common_id, '4201563');
      return jsonResponse({ grade: 300, test_sets: [], had_all_submmit: true });
    }
    // 提交后重新拉的 task 详情：这次是满分
    if (u.includes('/tasks/fph74o35rv6f.json')) return jsonResponse(choiceTask());
    return jsonResponse({});
  };

  try {
    const stub = makeStub('{"answers":["A","B"]}');
    const out = await solveUrl({
      url: 'https://www.educoder.net/tasks/fph74o35rv6f?homework_common_id=4201563',
      llm: stub,
      aiConfig: {},
      submit: true,
      mode: 'api',
      humanize: false,
      styleMatch: false,
      vision: false,
      cookies: { _educoder_session: 'x', autologin_trustie: 'y' },
    });
    assert.equal(out.kind, 'choice');
    assert.deepEqual(out.answers, ['A', 'B']);
    assert.equal(out.channel, 'api');
    assert.ok(
      calls.some((c) => c.startsWith('POST') && c.includes('/choose_build.json')),
      '必须真的 POST 到 choose_build',
    );
  } finally {
    globalThis.fetch = origFetch;
  }

  // ── 5. dry-run 不提交 ──
  const dryCalls = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    dryCalls.push(u);
    if (u.includes('/tasks/fph74o35rv6f.json')) return jsonResponse(choiceTask());
    return jsonResponse({});
  };
  try {
    const stub = makeStub('{"answers":["A","B"]}');
    const out = await solveUrl({
      url: 'https://www.educoder.net/tasks/fph74o35rv6f?homework_common_id=4201563',
      llm: stub,
      aiConfig: {},
      submit: false,
      mode: 'api',
      humanize: false,
      styleMatch: false,
      vision: false,
      cookies: { _educoder_session: 'x', autologin_trustie: 'y' },
    });
    assert.equal(out.ok, true);
    assert.equal(out.passed, undefined);
    assert.equal(out.reason, 'dry-run（未提交）');
    assert.ok(!dryCalls.some((u) => u.includes('choose_build')), 'dry-run 不能提交');
  } finally {
    globalThis.fetch = origFetch;
  }

  // ── 6. 模型没给 JSON → 明确失败，不提交 ──
  const badCalls = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    badCalls.push(u);
    if (u.includes('/tasks/fph74o35rv6f.json')) return jsonResponse(choiceTask());
    return jsonResponse({});
  };
  try {
    const stub = makeStub('我觉得第一题选 A 吧');
    const out = await solveUrl({
      url: 'https://www.educoder.net/tasks/fph74o35rv6f?homework_common_id=4201563',
      llm: stub,
      aiConfig: {},
      submit: true,
      mode: 'api',
      humanize: false,
      styleMatch: false,
      vision: false,
      cookies: { _educoder_session: 'x', autologin_trustie: 'y' },
    });
    assert.equal(out.ok, false);
    assert.match(out.reason, /JSON/);
    assert.ok(!badCalls.some((u) => u.includes('choose_build')), '答案解析失败时不能提交');
  } finally {
    globalThis.fetch = origFetch;
  }

  return '客观题单测：选项解析 / 答案抽取 / 判分 / 编排 / dry-run 全过';
}

function jsonResponse(obj) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    text: async () => JSON.stringify(obj),
    json: async () => obj,
  };
}

function makeStub(text) {
  return {
    async listProviders() {
      return [{ id: 'stub' }];
    },
    async listModels() {
      return [{ provider: 'stub', id: 'stub' }];
    },
    async resolveModelInfo() {
      return { inputModalities: ['text'] };
    },
    stream() {
      return (async function* () {
        yield { type: 'text-delta', index: 0, text };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })();
    },
  };
}
