/**
 * 插件装配测试：用假的 ctx 跑 apply()，检查工具/skill 注册形状是否合法。
 * 这是「插件能不能被宿主加载」的最近似模拟，不需要真宿主。
 */
import assert from 'node:assert/strict';
import { apply, name, inject } from '../index.js';

function makeFakeCtx() {
  const registered = [];
  const skills = [];
  const logs = [];
  return {
    registered,
    skills,
    logs,
    ctx: {
      logger: { info: (m) => logs.push('INFO ' + m), warn: (m) => logs.push('WARN ' + m) },
      get(service) {
        if (service === 'tools')
          return {
            register: (def) => {
              registered.push(def);
              return () => {};
            },
          };
        if (service === 'skills')
          return {
            register: (s) => {
              skills.push(s);
              return () => {};
            },
          };
        if (service === 'attachments')
          return {
            imageLimits: { maxImageBytes: 5_000_000, maxMessageImageBytes: 8_000_000 },
            saveImage: async () => ({ id: 'stub-image' }),
          };
        if (service === 'llm')
          return {
            listProviders: async () => [{ id: 'deepseek' }],
            listModels: async () => [{ provider: 'deepseek', id: 'deepseek-chat', name: 'DeepSeek Chat' }],
            stream: () =>
              (async function* () {
                yield { type: 'text-delta', index: 0, text: '```python\nprint(1)\n```' };
                yield { type: 'finish', reason: { kind: 'stop' } };
              })(),
          };
        return undefined;
      },
      effect(fn) {
        return fn();
      },
      tools: null,
    },
  };
}

export default async function run() {
  const { ctx, registered, skills, logs } = makeFakeCtx();

  assert.equal(name, 'educoder-auto');
  assert.deepEqual(inject, ['tools']);

  apply(ctx, {});

  const names = registered.map((t) => t.name).sort();
  assert.deepEqual(
    names,
    ['educoder_login', 'educoder_solve', 'educoder_status', 'iwrite_login', 'iwrite_solve', 'iwrite_status'],
    '应注册 6 个工具（头歌 3 + iWrite 3）',
  );

  // 每个工具的形状都要能过宿主校验
  for (const t of registered) {
    assert.ok(t.name, `${t.name}: 缺 name`);
    assert.ok(t.description, `${t.name}: 缺 description`);
    assert.equal(t.parameters?.type, 'object', `${t.name}: parameters 必须是 object schema`);
    assert.equal(t.parameters?.additionalProperties, false, `${t.name}: parameters 应禁止额外字段`);
    assert.equal(typeof t.output?.render, 'function', `${t.name}: 缺 output.render`);
    assert.equal(t.output.schema?.type, 'object', `${t.name}: output.schema 必须是 object`);
    assert.equal(typeof t.execute, 'function', `${t.name}: 缺 execute`);
    assert.ok(Number.isFinite(t.timeoutMs) && t.timeoutMs > 0, `${t.name}: timeoutMs 不合法`);

    // render 必须返回合法的 content block 数组
    const blocks = t.output.render({ url: 'https://x' }, { ok: true, channel: 'api', trace: 't', title: 'T' });
    assert.ok(Array.isArray(blocks) && blocks.length, `${t.name}: render 应返回非空数组`);
    for (const b of blocks) assert.ok(['text', 'image'].includes(b.type), `${t.name}: 非法 block 类型 ${b.type}`);
  }

  // 技能
  assert.equal(skills.length, 1, '应注册 1 个 skill');
  assert.equal(skills[0].name, 'educoder-auto');
  assert.ok(skills[0].description.length > 10);
  assert.ok(skills[0].content.includes('educoder_solve'), 'skill 正文应提到工具名');

  // status 工具真跑一遍
  const statusTool = registered.find((t) => t.name === 'educoder_status');
  const out = await statusTool.execute({}, {});
  assert.equal(typeof out.text, 'string');
  assert.ok(out.text.includes('登录：'), 'status 应报登录态');
  assert.ok(out.text.includes('AI：'), 'status 应报 AI 路由');
  assert.ok(out.text.includes('浏览器：'), 'status 应报浏览器');
  assert.equal(out.ai.ok, true, '假 llm 应让 AI 路由可用');

  assert.ok(logs.some((l) => l.includes('已注册')), '应有注册日志');

  // 返回值必须是「无损 JSON」：宿主会拒绝含 undefined 的工具输出
  const lossless = (v) => {
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return true;
    if (typeof v === 'number') return Number.isFinite(v) && !Object.is(v, -0);
    if (typeof v !== 'object') return false;
    if (Array.isArray(v)) return v.every(lossless);
    return Object.values(v).every(lossless);
  };
  assert.ok(lossless(out), 'status 返回含非 JSON 值');
  assert.equal(out.login.ok, true, 'status 登录态判定应读 ok 字段（旧版读 valid 导致永远显示无效）');

  // iWrite status 也跑一遍（没登录态时应报 ❌ 而不是崩）
  const iwStatus = registered.find((t) => t.name === 'iwrite_status');
  const iwOut = await iwStatus.execute({}, {});
  assert.equal(typeof iwOut.text, 'string');
  assert.ok(iwOut.text.includes('iWrite 登录：'), 'iwrite_status 应报登录态');
  assert.ok(iwOut.text.includes('AI：'), 'iwrite_status 应报 AI 路由');
  assert.ok(lossless(iwOut), 'iwrite_status 返回含非 JSON 值');

  return `插件装配：6 个工具 + 1 个 skill 形状全合法；educoder_status / iwrite_status 自检通过`;
}
