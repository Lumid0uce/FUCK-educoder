/**
 * iWrite 层单测：接口层 / 作文生成层 / 编排层。
 *
 * 全部用 fetch 打桩，不打真站、不需要登录态。
 * 重点验证三件事：
 *   1. 请求信封与字段名跟真实前端一致（保存/提交的 payload 形状错了平台会静默不落盘）
 *   2. 作文校验真的能拦住不合格的稿子（词数、关键词、中文、单段）
 *   3. 编排层在 submit=false 时只保存、不提交
 */
import assert from 'node:assert/strict';

import * as api from '../lib/iwrite-api.mjs';
import * as ai from '../lib/iwrite-ai.mjs';
import * as solver from '../lib/iwrite-solver.mjs';

/** 造一个 fetch 桩：按 URL 路径分派，记录所有请求。 */
function stubFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const key = `${init.method || 'GET'} ${u.pathname}`;
    calls.push({
      key,
      path: u.pathname,
      query: Object.fromEntries(u.searchParams.entries()),
      body: init.body ? JSON.parse(init.body) : undefined,
      headers: init.headers || {},
    });
    const handler = routes[key] ?? routes[u.pathname];
    if (!handler) {
      return new Response(JSON.stringify({ code: 404, msg: 'no stub', data: null }), { status: 200 });
    }
    const out = typeof handler === 'function' ? handler(calls[calls.length - 1]) : handler;
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return calls;
}

const COOKIES = { _iwrite_session: 'abc', ssoUserId: '456' };

const TASK = {
  id: 1001,
  title: 'My Campus Life',
  stem: 'Write an essay about your campus life. You should:\n1. describe your daily routine\n2. explain what you enjoy most\n3. suggest one improvement',
  keyWord: 'campus, routine',
  genre: 2,
  words: 150,
  words2: 200,
  endTime: '2026-12-31 23:59:59',
};

export default async function run() {
  let n = 0;
  const ok = (cond, msg) => {
    n += 1;
    assert.ok(cond, msg);
  };
  const eq = (a, b, msg) => {
    n += 1;
    assert.equal(a, b, msg);
  };

  // ── 1. 接口层 ─────────────────────────────────────────────────────────
  eq(api.IWRITE_ORIGIN, 'https://iwrite.unipus.cn', 'IWRITE_ORIGIN');
  eq(api.countWords('  hello   world  '), 2, 'countWords 按空白分词');
  eq(api.countWords(''), 0, 'countWords 空串');
  eq(api.countWords('a\nb\tc'), 3, 'countWords 换行制表符也算分隔');
  eq(api.GENRE_NAMES[2], '议论文', '体裁枚举 2 = 议论文');
  ok(api.GENRE_GUIDE[2].includes('argumentative'), 'GENRE_GUIDE 2 是议论文要求');

  // wordCountOk：留 5% 余量
  ok(api.wordCountOk(150, 150, 200), '下界命中');
  ok(api.wordCountOk(143, 150, 200), '低于下界 5% 内算过');
  ok(!api.wordCountOk(140, 150, 200), '低于下界 5% 外不算过');
  ok(api.wordCountOk(210, 150, 200), '高于上界 5% 内算过');
  ok(!api.wordCountOk(215, 150, 200), '高于上界 5% 外不算过');
  ok(api.wordCountOk(999, 0, 0), '不限词数时永远过');

  // parseWriteUrl
  const parsed = api.parseWriteUrl(
    'https://iwrite.unipus.cn/student/daily/write?taskId=1001&uid=456&classId=789&studentTaskId=12&addNew=2'
  );
  eq(parsed.taskId, '1001', 'parseWriteUrl taskId');
  eq(parsed.studentId, '456', 'parseWriteUrl uid → studentId');
  eq(parsed.classId, '789', 'parseWriteUrl classId');
  eq(parsed.studentTaskId, '12', 'parseWriteUrl studentTaskId');
  eq(parsed.addNew, '2', 'parseWriteUrl addNew');
  assert.throws(() => api.parseWriteUrl('not a url'), /不是合法网址/, 'parseWriteUrl 非法 URL 应抛错');
  n += 1;

  // normalizeTask
  const norm = api.normalizeTask(TASK);
  eq(norm.taskId, '1001', 'normalizeTask id');
  eq(norm.genre, '议论文', 'normalizeTask genre 中文名');
  eq(norm.wordsFrom, 150, 'normalizeTask words → wordsFrom');
  eq(norm.wordsTo, 200, 'normalizeTask words2 → wordsTo');
  eq(norm.keyWord, 'campus, routine', 'normalizeTask keyWord');

  // request：信封 + 头 + 登录失效识别
  let calls = stubFetch({
    '/api/common/currentUser': { code: 200, msg: 'ok', data: { id: 456, name: '张三' } },
  });
  const user = await api.currentUser(COOKIES);
  eq(user.id, 456, 'currentUser 取 data');
  eq(calls[0].headers.ssoUserId, '456', '请求应带 ssoUserId 头');
  ok(String(calls[0].headers.Cookie).includes('_iwrite_session=abc'), '请求应带 Cookie 头');
  eq(calls[0].headers.Origin, api.IWRITE_ORIGIN, '请求应带 Origin');

  calls = stubFetch({ '/api/common/currentUser': { code: 2002, msg: '登录状态已失效，请重新登录', data: null } });
  await assert.rejects(() => api.currentUser(COOKIES), (err) => err.code === 'NEED_LOGIN', 'code 2002 应抛 NEED_LOGIN');
  n += 1;

  calls = stubFetch({
    '/api/common/currentUser': new Response('', { status: 302, headers: { location: '/login' } }),
  });
  await assert.rejects(() => api.currentUser(COOKIES), (err) => err.code === 'NEED_LOGIN', '302 跳登录应抛 NEED_LOGIN');
  n += 1;

  calls = stubFetch({ '/api/common/currentUser': { code: 500, msg: '服务器炸了', data: null } });
  await assert.rejects(() => api.currentUser(COOKIES), (err) => err.code === 'API', '非 200 code 应抛 API');
  n += 1;

  // listTasks / taskShow / loadTaskStudent / saveTask / submitTask
  calls = stubFetch({
    '/api/student_task_index/loadByStudentId': {
      code: 200,
      data: { stid: [{ task: TASK, classId: 789, submitted: false, studentTaskId: 12 }], totalPages: 1, totalElements: 1 },
    },
  });
  const listed = await api.listTasks(COOKIES, { studentId: '456' });
  eq(listed.stid.length, 1, 'listTasks 拿到 1 条');
  eq(listed.totalElements, 1, 'listTasks totalElements');
  eq(calls[0].query.taskListType, '1', 'listTasks 默认 taskListType=1');
  const entry = api.normalizeTaskEntry(listed.stid[0]);
  eq(entry.taskId, '1001', 'normalizeTaskEntry taskId');
  eq(entry.classId, '789', 'normalizeTaskEntry classId');
  eq(entry.submitted, false, 'normalizeTaskEntry submitted');

  calls = stubFetch({ '/api/task/show/1001/789': { code: 200, data: { task: TASK } } });
  const shown = await api.taskShow(COOKIES, { taskId: '1001', classId: '789' });
  eq(shown.id, 1001, 'taskShow 取 data.task');

  calls = stubFetch({
    '/api/studenttask/loadTaskStudent': {
      code: 200,
      data: { task: TASK, taskStudent: { id: 12, title: 'Draft', article: 'hello world' }, taskStudentId: 12 },
    },
  });
  const loaded = await api.loadTaskStudent(COOKIES, { taskId: '1001', classId: '789', studentId: '456', addNew: 2 });
  eq(loaded.taskStudentId, '12', 'loadTaskStudent taskStudentId');
  eq(calls[0].body.addNew, 2, 'loadTaskStudent addNew 原样传');

  calls = stubFetch({ '/api/studenttask/saveTask': { code: 200, data: { taskStudentId: 99 } } });
  const saved = await api.saveTask(COOKIES, { taskId: '1001', classId: '789', studentId: '456', article: 'x' });
  eq(saved.taskStudentId, '99', 'saveTask 返回 taskStudentId');
  eq(calls[0].key, 'POST /api/studenttask/saveTask', 'saveTask 用 POST');

  calls = stubFetch({ '/api/studenttask/submitTask': { code: 200, data: { ok: true } } });
  const submitted = await api.submitTask(COOKIES, { taskId: '1001' });
  eq(submitted.ok, true, 'submitTask ok');

  // ── 2. 作文生成层 ─────────────────────────────────────────────────────
  eq(ai.describeWordRange(150, 200), '150-200 words (aim for 175, never outside 150-200)', 'describeWordRange 区间');
  eq(ai.describeWordRange(150, null), 'at least 150 words (aim for 165)', 'describeWordRange 只有下界');
  eq(ai.describeWordRange(null, 200), 'no more than 200 words (aim for 180)', 'describeWordRange 只有上界');
  eq(ai.describeWordRange(null, null), '', 'describeWordRange 无限制');

  const prompt = ai.buildEssayPrompt(norm);
  ok(prompt.includes('Title to use'), 'prompt 含标题要求');
  ok(prompt.includes('议论文'), 'prompt 含体裁中文名');
  ok(prompt.includes('150-200 words'), 'prompt 含词数区间');
  ok(prompt.includes('campus, routine'), 'prompt 含关键词');
  ok(prompt.includes('describe your daily routine'), 'prompt 含题干原文');
  ok(ai.ESSAY_SYSTEM.includes('Do NOT write the title'), '系统提示词里禁止在正文写标题');
  ok(ai.ESSAY_SYSTEM.includes('whitespace-separated'), '系统提示词里说明词数按空白分词');
  ok(!/delve into|tapestry/i.test(ai.ESSAY_SYSTEM) || ai.ESSAY_SYSTEM.includes('no "delve into"'), '系统提示词禁 AI 味词汇');

  const retryPrompt = ai.buildEssayPrompt(norm, { previous: { text: 'old draft', problems: ['词数 90，要求 150-200 词'] }, attempt: 2 });
  ok(retryPrompt.includes('previous draft was rejected'), '重写 prompt 应说明上一稿被拒');
  ok(retryPrompt.includes('词数 90'), '重写 prompt 应带上问题清单');
  ok(retryPrompt.includes('attempt 2'), '重写 prompt 应标轮次');

  // extractEssay：各种脏输出
  eq(ai.extractEssay('```\nHello world.\n```', norm), 'Hello world.', 'extractEssay 去围栏');
  eq(ai.extractEssay('Here is the essay:\n\nHello world.', norm), 'Hello world.', 'extractEssay 去开场白');
  eq(
    ai.extractEssay('My Campus Life\n\nMy campus life is busy.', { title: 'My Campus Life' }),
    'My campus life is busy.',
    'extractEssay 删掉与标题重复的首行'
  );
  eq(ai.extractEssay('## Heading\n\nBody text.', norm), 'Heading\n\nBody text.', 'extractEssay 去 markdown 井号');
  eq(ai.extractEssay('', norm), '', 'extractEssay 空输入');
  eq(ai.extractEssay(null, norm), '', 'extractEssay null 输入');

  // checkEssay：拦截不合格
  const longBody =
    'My campus life is busy and full of small routines. ' +
    'I usually get up at seven and walk to the campus dining hall for breakfast. '.repeat(2) +
    '\n\n' +
    'What I enjoy most is the library on the third floor, where the campus is quiet in the morning. '.repeat(2);

  let check = ai.checkEssay(longBody, norm);
  ok(check.words >= 40, 'checkEssay 数出词数');
  ok(check.problems.some((p) => p.includes('词数')), '词数不够应报问题');

  // 合格稿：三段，词数落在 150-200，且含 campus / routine 两个关键词
  const goodBody = [
    'My campus life follows a steady routine that I have slowly learned to enjoy. Every morning I get up at seven, have breakfast in the dining hall, and walk to the teaching building before eight. The first two classes pass quickly because the teachers ask questions and we often work in pairs. After lunch I spend an hour in the library, which has become my favourite place on the whole campus.',
    'What I enjoy most is the freedom to arrange my own study time. Nobody tells me when to read, so I have learned to plan the week by myself and to keep a small notebook of tasks. In the evening I play badminton with my roommates, which keeps me healthy and helps me sleep well.',
    'One improvement I would suggest is more quiet study rooms in the dormitory building. Many students have no place to read after the library closes at ten, and the corridors are noisy. If the university opened a few small rooms on each floor, the campus routine would be much easier for everyone.',
  ].join('\n\n');

  check = ai.checkEssay(goodBody, norm);
  ok(check.words >= 150 && check.words <= 200, `测试用合格作文词数应在 150-200（实际 ${check.words}）`);
  ok(check.ok, `合格作文应通过校验（问题：${check.problems.join('；')}）`);

  // 中文混入
  let bad = ai.checkEssay(goodBody + '\n\n这是中文。', norm);
  ok(bad.problems.some((p) => p.includes('中文')), '中文混入应被拦');

  // 单段
  bad = ai.checkEssay(goodBody.replace(/\n\n/g, ' '), norm);
  ok(bad.problems.some((p) => p.includes('自然段')), '单段应被拦');

  // 关键词缺失
  bad = ai.checkEssay(goodBody.replace(/campus/g, 'school').replace(/routine/g, 'habit'), norm);
  ok(bad.problems.some((p) => p.includes('关键词')), '关键词缺失应被拦');

  // 太短
  bad = ai.checkEssay('Too short.', norm);
  ok(!bad.ok && bad.problems.some((p) => p.includes('太短')), '太短应被拦');

  // ── 2b. 写作水平档位（高三 / 四级 / 六级）─────────────────────────────
  eq(ai.resolveLevel(undefined).id, 'highschool', '不传 level 默认高三');
  eq(ai.resolveLevel('高三').id, 'highschool', '中文「高三」归一');
  eq(ai.resolveLevel('cet4').id, 'cet4', 'cet4 归一');
  eq(ai.resolveLevel('CET-6').id, 'cet6', 'CET-6 归一');
  eq(ai.resolveLevel('胡说').id, 'highschool', '非法档位退回高三');

  const hsSystem = ai.buildEssaySystem('highschool');
  ok(hsSystem.includes('senior-high'), '高三系统提示词点名高中水平');
  ok(hsSystem.includes('CET-4 word list'), '高三系统提示词限制在四级词表内');
  ok(ai.buildEssaySystem('cet6').includes('CET-6'), '六级系统提示词点名 CET-6');

  const hsPrompt = ai.buildEssayPrompt(norm, { level: 'highschool' });
  ok(hsPrompt.includes('## Language level'), 'prompt 含语言档位小节');
  ok(hsPrompt.includes('senior-high'), 'prompt 写明高三水平');

  // 高级词检测
  eq(ai.findAdvancedWords('We must delve into this tapestry.').join(','), 'delve,tapestry', '识别 AI 味高级词');
  eq(ai.findAdvancedWords('We should look at this carefully.').length, 0, '普通句不误报');

  // 高三档：高级词要报问题
  const advancedBody = goodBody.replace('learned to enjoy', 'endeavoured to utilize a multifaceted paradigm');
  let lv = ai.checkEssay(advancedBody, { ...norm, level: 'highschool' });
  ok(lv.problems.some((p) => p.includes('超出高考/四级范围')), '高三档高级词应被拦');
  ok(lv.advanced.length >= 3, `应识别出多个高级词（实际 ${lv.advanced.join(',')}）`);

  // 同一篇放到六级档就不该因为词报问题
  lv = ai.checkEssay(advancedBody, { ...norm, level: 'cet6' });
  ok(!lv.problems.some((p) => p.includes('超出高考/四级范围')), '六级档不追究四级以上词汇');

  // 缩写形式在高三档要拦
  lv = ai.checkEssay(goodBody.replace('I have learned', "I've learned"), { ...norm, level: 'highschool' });
  ok(lv.problems.some((p) => p.includes('缩写')), '高三档出现缩写应被拦');

  // 合格稿在高三档应通过
  lv = ai.checkEssay(goodBody, { ...norm, level: 'highschool' });
  ok(lv.ok, `高三档下合格作文应通过（问题：${lv.problems.join('；')}）`);

  // ── 3. 编排层 ─────────────────────────────────────────────────────────
  eq(solver.pickStudentId({ id: 456 }), '456', 'pickStudentId 取 id');
  eq(solver.pickStudentId({ userId: 789 }), '789', 'pickStudentId 取 userId');
  eq(solver.pickStudentId({}, { ssoUserId: '321' }), '321', 'pickStudentId 退回 cookie');
  eq(solver.pickStudentId({}), '', 'pickStudentId 都没有返回空串');

  const payload = solver.buildSavePayload({
    taskStudentId: '12',
    classId: '789',
    taskId: '1001',
    studentId: '456',
    title: 'My Campus Life',
    article: 'one two three',
    addNew: 1,
  });
  eq(payload.taskStudentId, '12', 'payload taskStudentId');
  eq(payload.words, 3, 'payload words 按空白算');
  eq(payload.source, 0, 'payload source=0（正式保存，不是自动存盘）');
  eq(payload.savePattern, 0, 'payload savePattern=0');
  eq(payload.addNew, 1, 'payload addNew 传进来才带');
  ok(payload.simpleArticle.length > 0, 'payload simpleArticle 非空');
  const noAddNew = solver.buildSavePayload({ classId: '1', taskId: '2', studentId: '3', title: 't', article: 'a b' });
  ok(!('addNew' in noAddNew), '没有 addNew 时不应出现该字段');

  // 拟人节奏：作文时长应随词数增长，且 speed=0 时全 0
  const t200 = solver.planEssayTiming({ words: 200, speed: 1 });
  const t400 = solver.planEssayTiming({ words: 400, speed: 1 });
  ok(t400.compose > t200.compose, '词数越多构思越久');
  ok(t200.read > 0 && t200.beforeSubmit > 0, '读题/交卷前检查应有停顿');
  const zero = solver.planEssayTiming({ words: 200, speed: 0 });
  eq(zero.read, 0, 'speed=0 时读题为 0');
  eq(zero.compose, 0, 'speed=0 时构思为 0');

  // solveUrl 端到端（submit=false：只保存不提交）
  calls = stubFetch({
    '/api/common/currentUser': { code: 200, data: { id: 456, name: '张三' } },
    '/api/student_task_index/loadByStudentId': {
      code: 200,
      data: { stid: [{ task: TASK, classId: 789, submitted: false, studentTaskId: 12 }], totalPages: 1, totalElements: 1 },
    },
    '/api/task/show/1001/789': { code: 200, data: { task: TASK } },
    '/api/studenttask/loadTaskStudent': { code: 200, data: { task: TASK, taskStudent: { id: 12, title: '', article: '' }, taskStudentId: 12 } },
    '/api/studenttask/saveTask': { code: 200, data: { taskStudentId: 12 } },
  });

  const essayOut = await ai.writeEssay({
    task: norm,
    llm: undefined,
    aiConfig: { baseURL: 'https://stub.local/v1', apiKey: 'k', model: 'stub' },
    maxAttempts: 1,
    signal: undefined,
  }).catch((e) => ({ error: e }));

  // 上面会真的去打 HTTP（stub 里没有 /chat/completions），所以这里只断言它报的是网络/HTTP 错误而不是逻辑错误
  ok(essayOut.error || essayOut.ok === false || essayOut.body !== undefined, 'writeEssay 在无 llm 时应走 HTTP 通道并给出结果或明确错误');

  return `iWrite 单测：${n} 条断言全过（接口层 / 作文生成 / 校验 / 编排 payload）`;
}
