/**
 * 学习通层单测：接口层 / 答案解析层 / 编排层。
 *
 * 全程 fetch 打桩，不打真站、不需要登录态。
 * 重点盯三件真的会出错的事：
 *   1. 每题必须用它自己那一页的隐藏域（用错页 → 后面的题存成空白）
 *   2. 多选/多空在表单里必须是「同名重复字段」（拼成逗号串后台只认第一项）
 *   3. 模型给的人话要能翻译成页面控件的 value（"对" → true、"AC" → A+C 各一个字段）
 */
import assert from 'node:assert/strict';

import * as api from '../lib/chaoxing-api.mjs';
import * as ai from '../lib/chaoxing-ai.mjs';
import * as solver from '../lib/chaoxing-solver.mjs';

// ---------------------------------------------------------------------------
// 打桩：一份 5 题的作业（单选 / 多选 / 判断 / 多空填空 / 简答）
// ---------------------------------------------------------------------------

const WORK_PATH = '/mooc-ans/work/phone/doHomeWork';

const PAGES = {
  0: {
    qid: '1001',
    type: '0',
    tag: 'p0',
    stem: '下列哪个是合法的 C 语言标识符？',
    html: `
      <div class="ans-cc timuStyle"><p>下列哪个是合法的 C 语言标识符？</p></div>
      <ul>
        <li><input type="radio" name="answer1001" value="A"><span>A．1abc</span></li>
        <li><input type="radio" name="answer1001" value="B"><span>B．_sum</span></li>
        <li><input type="radio" name="answer1001" value="C"><span>C．int</span></li>
        <li><input type="radio" name="answer1001" value="D"><span>D．a-b</span></li>
      </ul>`,
  },
  1: {
    qid: '1002',
    type: '1',
    tag: 'p1',
    stem: '以下哪些是面向对象的基本特征？',
    html: `
      <div class="ans-cc timuStyle"><p>以下哪些是面向对象的基本特征？</p></div>
      <ul>
        <li><input type="checkbox" name="answer1002" value="A"><span>A．封装</span></li>
        <li><input type="checkbox" name="answer1002" value="B"><span>B．编译</span></li>
        <li><input type="checkbox" name="answer1002" value="C"><span>C．继承</span></li>
        <li><input type="checkbox" name="answer1002" value="D"><span>D．链接</span></li>
      </ul>`,
  },
  2: {
    qid: '1003',
    type: '3',
    tag: 'p2',
    stem: 'C 语言的数组下标从 1 开始。',
    html: `
      <div class="ans-cc timuStyle"><p>C 语言的数组下标从 1 开始。</p></div>
      <ul>
        <li><input type="radio" name="answer1003" value="true"><span>对</span></li>
        <li><input type="radio" name="answer1003" value="false"><span>错</span></li>
      </ul>`,
  },
  3: {
    qid: '1004',
    type: '2',
    tag: 'p3',
    stem: 'C 语言中整型 int 通常占 __ 个字节，字符型 char 占 __ 个字节。',
    html: `
      <div class="ans-cc timuStyle"><p>C 语言中整型 int 通常占 __ 个字节，字符型 char 占 __ 个字节。</p></div>
      <div>
        <textarea name="answer1004"></textarea>
        <textarea name="answer1004"></textarea>
      </div>`,
  },
  4: {
    qid: '1005',
    type: '4',
    tag: 'p4',
    stem: '简述什么是递归，并说明递归必须满足的两个条件。',
    html: `
      <div class="ans-cc timuStyle"><p>简述什么是递归，并说明递归必须满足的两个条件。</p></div>
      <div><textarea name="answer1005"></textarea></div>`,
  },
};

const LAST_INDEX = Object.keys(PAGES).length; // 5 之后是空页

/** 造一个页面 HTML（带上「这一页」自己的隐藏域 + 已存答案的回显）。 */
function pageHtml(index, saved) {
  const page = PAGES[index];
  if (!page) return '<html><body><div class="empty">已经是最后一题</div></body></html>';
  const { qid } = page;
  const value = saved[qid];
  const hidden = `
    <input type="hidden" name="questionId" value="${qid}">
    <input type="hidden" id="questionId" value="${qid}">
    <input type="hidden" name="type${qid}" value="${page.type}">
    <input type="hidden" name="score${qid}" value="5">
    <input type="hidden" name="pageTag" value="${page.tag}">`;

  let body = page.html;
  if (page.type === '0' || page.type === '3') {
    if (value) body = body.replace(`value="${value}">`, `value="${value}" checked>`);
  } else if (page.type === '1') {
    for (const v of value || []) body = body.replace(`value="${v}">`, `value="${v}" checked>`);
  } else if (page.type === '2') {
    let i = 0;
    body = body.replace(/<textarea name="answer\d+"><\/textarea>/g, () => `<textarea name="answer${qid}">${(value || [])[i++] ?? ''}</textarea>`);
  } else {
    body = body.replace(/<textarea name="answer\d+"><\/textarea>/g, `<textarea name="answer${qid}">${value ?? ''}</textarea>`);
  }
  return `<html><body><form>${hidden}${body}</form></body></html>`;
}

const MODEL_ANSWERS = JSON.stringify({
  answers: [
    { id: '1001', answer: 'B' },
    { id: '1002', answer: 'AC' },
    { id: '1003', answer: '对' },
    { id: '1004', answer: '4\n1' },
    { id: '1005', answer: '递归是函数自己调用自己。必须满足：有终止条件；每次递归都向终止条件靠近。' },
  ],
});

/** 双向打桩：作业接口 + 模型接口。 */
function stubAll() {
  const state = { saved: {}, posts: [], calls: [] };
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const method = (init.method || 'GET').toUpperCase();
    const entry = { method, path: u.pathname, query: Object.fromEntries(u.searchParams.entries()), body: init.body };
    state.calls.push(entry);

    // 模型接口
    if (u.pathname === '/v1/chat/completions') {
      return new Response(JSON.stringify({ choices: [{ message: { content: MODEL_ANSWERS } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 作业列表
    if (u.pathname === '/work/stu-work') {
      return new Response(
        `<html><body>
          <div class="work">第一次作业
            <a href="https://mooc1-api.chaoxing.com/android/mtaskmsgspecial?type=work&amp;taskrefId=w1&amp;courseid=111&amp;clazzid=222">进入</a>
          </div>
          <div class="work">期中考试
            <a href="https://mooc1-api.chaoxing.com/android/mtaskmsgspecial?type=exam&amp;taskrefId=w2&amp;courseid=111">进入</a>
          </div>
        </body></html>`,
        { status: 200, headers: { 'Content-Type': 'text/html' } },
      );
    }

    // 任务页 → doHomeWork 入口
    if (u.pathname === '/android/mtaskmsgspecial') {
      return new Response(
        `<html><body><a class="in" href="/work/phone/doHomeWork?courseId=111&amp;workId=333&amp;clazzid=222">开始作业</a></body></html>`,
        { status: 200, headers: { 'Content-Type': 'text/html' } },
      );
    }

    // 作业页（一页一题）
    if (u.pathname === WORK_PATH) {
      return new Response(pageHtml(Number(u.searchParams.get('index') || 0), state.saved), {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      });
    }

    // 提交
    if (u.pathname === '/mooc-ans/work/phone/doNormalHomeWorkSubmit') {
      const form = new URLSearchParams(String(init.body || ''));
      const qid = [...form.keys()].filter((k) => k.startsWith('answer')).map((k) => k.replace('answer', ''))[0];
      const values = form.getAll(`answer${qid}`);
      state.posts.push({ qid, form: Object.fromEntries(form.entries()), all: [...form.entries()], values });
      if (qid) {
        const page = Object.values(PAGES).find((p) => p.qid === qid);
        if (page.type === '1' || page.type === '2') state.saved[qid] = values;
        else state.saved[qid] = values[0] ?? '';
      }
      return new Response(JSON.stringify({ status: true, msg: 'ok' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('not found', { status: 404 });
  };
  return state;
}

const COOKIES = { _uid: '9527', _d: 'xyz', fid: '1', vc3: 'abc' };

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

  // ── 1. 接口层纯函数 ───────────────────────────────────────────────────
  eq(api.CX_ORIGIN, 'https://mooc1-api.chaoxing.com', 'CX_ORIGIN');
  ok(api.SUBMIT_URL.endsWith('/mooc-ans/work/phone/doNormalHomeWorkSubmit'), 'SUBMIT_URL 路径');

  const cookies = api.normalizeCookies('_uid=9527; path=/; domain=.chaoxing.com; _d=xyz; expires=Wed');
  eq(cookies._uid, '9527', 'normalizeCookies 留 _uid');
  eq(cookies._d, 'xyz', 'normalizeCookies 留 _d');
  ok(!('path' in cookies) && !('domain' in cookies) && !('expires' in cookies), 'normalizeCookies 丢掉属性键');
  ok(api.cookieHeader(cookies).includes('_uid=9527'), 'cookieHeader 拼串');

  eq(api.decodeEntities('&lt;p&gt;A&amp;B&nbsp;'), '<p>A&B ', 'decodeEntities 多层实体');
  eq(api.htmlToText('<p>第一行</p><p>第二行</p>').split('\n').filter(Boolean).length, 2, 'htmlToText 保留段落');

  const fields = api.extractHiddenFields('<input type="hidden" name="a" value="1"><input type="hidden" name="b">');
  eq(fields.a, '1', 'extractHiddenFields 有值');
  eq(fields.b, '', 'extractHiddenFields 缺 value 当空串');

  eq(api.findDoHomeWorkPath('<a href="/work/phone/doHomeWork?courseId=1&amp;workId=2">x</a>'), '/mooc-ans/work/phone/doHomeWork?courseId=1&workId=2', 'findDoHomeWorkPath 补 /mooc-ans');
  eq(api.findDoHomeWorkPath('<a href="/mooc-ans/work/phone/doHomeWork?courseId=1">x</a>'), '/mooc-ans/work/phone/doHomeWork?courseId=1', 'findDoHomeWorkPath 已带前缀不重复');
  eq(api.findDoHomeWorkPath('<a href="doHomeWork?courseId=9&amp;workId=8">x</a>'), '/mooc-ans/work/phone/doHomeWork?courseId=9&workId=8', 'findDoHomeWorkPath 相对形态兜底');
  eq(api.findDoHomeWorkPath('<div>没有入口</div>'), '', 'findDoHomeWorkPath 找不到返回空');

  const stripped = api.withIndex('https://mooc1-api.chaoxing.com/mooc-ans/work/phone/doHomeWork?courseId=1', 3);
  ok(stripped.includes('index=3'), 'withIndex 写入 index');
  ok(stripped.includes('knowledgeid=0'), 'withIndex 补 knowledgeid=0');
  const kept = api.withIndex('https://mooc1-api.chaoxing.com/x?knowledgeid=77', 1);
  ok(kept.includes('knowledgeid=77'), 'withIndex 已有 knowledgeid 不覆盖');

  const links = api.parseTaskLinks(`<a href="https://mooc1-api.chaoxing.com/android/mtaskmsgspecial?type=work&amp;taskrefId=w1&amp;courseid=1">作业一</a>
    <a href="https://mooc1-api.chaoxing.com/android/mtaskmsgspecial?type=exam&amp;taskrefId=w2&amp;courseid=1">考试</a>`);
  eq(links.length, 1, 'parseTaskLinks 只挑 type=work');
  eq(links[0].taskrefId, 'w1', 'parseTaskLinks 解出 taskrefId');
  eq(links[0].courseId, '1', 'parseTaskLinks 解出 courseId');

  // ── 2. 题目解析（题型靠控件推，不是靠编号猜）───────────────────────────
  eq(api.parseQuestionPage(pageHtml(0, {})).kind, 'single', 'radio × 4 → 单选');
  eq(api.parseQuestionPage(pageHtml(1, {})).kind, 'multiple', 'checkbox → 多选');
  eq(api.parseQuestionPage(pageHtml(2, {})).kind, 'judge', 'true/false radio → 判断');
  eq(api.parseQuestionPage(pageHtml(3, {})).kind, 'blanks', '两个 textarea → 多空填空');
  eq(api.parseQuestionPage(pageHtml(4, {})).kind, 'text', '单个 textarea + 题型 4 → 简答');
  eq(api.parseQuestionPage(pageHtml(3, {})).blanks, 2, '多空数出 2 个空');

  const p0 = api.parseQuestionPage(pageHtml(0, {}));
  eq(p0.questionId, '1001', '解析 questionId');
  eq(p0.typeName, '单选题', 'type 0 → 单选题');
  eq(p0.score, '5', '解析 score');
  eq(p0.options.length, 4, '单选解析出 4 个选项');
  eq(p0.options[1].value, 'B', '选项 value 取控件 value');
  ok(p0.options[1].label.includes('_sum'), '选项文字从控件后面取');
  ok(p0.stem.includes('合法的 C 语言标识符'), '题干解析');

  // ── 3. 答案解析层 ─────────────────────────────────────────────────────
  eq(ai.extractJson('```json\n{"answers":[{"id":"1","answer":"A"}]}\n```').answers.length, 1, 'extractJson 去围栏');
  eq(ai.extractJson('好的，答案如下：{"answers":[{"id":"1","answer":"B"}]}').answers[0].answer, 'B', 'extractJson 容忍开场白');
  eq(ai.extractJson('[{"id":"1","answer":"A"}]').length, 1, 'extractJson 接受裸数组');
  eq(ai.extractJson('这不是 JSON'), null, 'extractJson 垃圾返回 null');

  eq(ai.pickLetters('B', ['A', 'B', 'C']).join(''), 'B', 'pickLetters 单字母');
  eq(ai.pickLetters('AC', ['A', 'B', 'C', 'D']).join(''), 'AC', 'pickLetters 连写');
  eq(ai.pickLetters('答：A、C', ['A', 'B', 'C']).join(''), 'AC', 'pickLetters 带标点');

  eq(ai.pickJudge('对', ['true', 'false']), 'true', 'pickJudge 对 → true');
  eq(ai.pickJudge('错误', ['true', 'false']), 'false', 'pickJudge 错误 → false');
  eq(ai.pickJudge('正确', ['A', 'B']), 'A', 'pickJudge 落到 A/B 页面取 A');

  eq(ai.splitBlanks('4\n1', 2).join('|'), '4|1', 'splitBlanks 按行拆');
  eq(ai.splitBlanks('第1空：4\n第2空：1', 2).join('|'), '4|1', 'splitBlanks 去「第N空」前缀');
  eq(ai.splitBlanks('只有一个', 2).length, 2, 'splitBlanks 不足补空，不错位');
  eq(ai.splitBlanks('a|b', 2).join('|'), 'a|b', 'splitBlanks 支持竖线分隔');

  eq(ai.stripFence('```c\nint main(){}\n```'), 'int main(){}', 'stripFence 去围栏');

  const questions = Object.values(PAGES).map((p) => api.parseQuestionPage(pageHtml(p.qid === '1001' ? 0 : p.qid === '1002' ? 1 : p.qid === '1003' ? 2 : p.qid === '1004' ? 3 : 4, {})));
  const normalized = ai.normalizeAll(questions, JSON.parse(MODEL_ANSWERS));
  eq(Object.keys(normalized.answers).length, 5, 'normalizeAll 五题全有答案');
  eq(normalized.answers['1001'], 'B', '单选归一成 value');
  eq(normalized.answers['1002'].join(''), 'AC', '多选归一成 value 数组');
  eq(normalized.answers['1003'], 'true', '判断归一成 true');
  eq(normalized.answers['1004'].join('|'), '4|1', '多空归一成数组');
  ok(normalized.answers['1005'].includes('递归'), '简答原文保留');
  eq(normalized.problems.length, 0, `正常答案不应有问题（实际：${normalized.problems.join('；')}）`);

  const missing = ai.normalizeAll(questions, { answers: [{ id: '1001', answer: 'B' }] });
  eq(Object.keys(missing.answers).length, 1, 'missing：只落 1 题');
  eq(missing.problems.length, 4, 'missing：其余 4 题报问题');

  // ── 4. 回读比对 ───────────────────────────────────────────────────────
  const cmp = solver.compareSaved(
    questions,
    { 1001: 'B', 1002: ['A', 'C'], 1003: 'true', 1004: ['4', '1'], 1005: '递归' },
    {
      1001: { picked: ['B'], text: '', texts: [] },
      1002: { picked: ['A', 'C'], text: '', texts: [] },
      1003: { picked: ['true'], text: '', texts: [] },
      1004: { picked: [], text: '4\n1', texts: ['4', '1'] },
      1005: { picked: [], text: '递归', texts: ['递归'] },
    },
  );
  eq(cmp.ok, true, '回读一致应 ok');
  eq(cmp.matched, 5, '回读一致 5 题');

  const cmpBad = solver.compareSaved(questions, { 1001: 'B' }, { 1001: { picked: ['A'], text: '', texts: [] } });
  eq(cmpBad.ok, false, '回读不一致应报错');
  eq(cmpBad.mismatch[0].questionId, '1001', '不一致题目号');

  // ── 5. 端到端（打桩）──────────────────────────────────────────────────
  let state = stubAll();
  const result = await solver.solveWork({
    cookies: COOKIES,
    llm: undefined,
    aiConfig: { baseURL: 'https://stub.local/v1', apiKey: 'k', model: 'stub' },
    submit: true,
    verify: true,
  });

  ok(result.ok, `solveWork 应成功（reason：${result.reason}）`);
  eq(result.submitted, true, 'submit=true 时应交卷');
  eq(result.count, 5, '抓到 5 道题');
  eq(result.verified?.ok, true, '回读校验通过');
  eq(result.trace.includes('抓到 5 道题'), true, 'trace 记下抓题数量');

  // 每题都用了「自己那一页」的隐藏域（这是最容易错、也最致命的点）
  const postOf = (qid) => state.posts.find((p) => p.qid === qid);
  eq(postOf('1001').form.pageTag, 'p0', '第一题用第 0 页隐藏域');
  eq(postOf('1002').form.pageTag, 'p1', '第二题用第 1 页隐藏域');
  eq(postOf('1003').form.pageTag, 'p2', '第三题用第 2 页隐藏域');
  eq(postOf('1004').form.pageTag, 'p3', '第四题用第 3 页隐藏域');
  eq(postOf('1005').form.pageTag, 'p4', '第五题用第 4 页隐藏域');
  eq(postOf('1004').form.questionId, '1004', 'payload 里带对的 questionId');

  // 多选 / 多空：同名重复字段
  eq(postOf('1002').values.join(','), 'A,C', '多选提交为同名重复字段');
  eq(state.posts.find((p) => p.qid === '1002').all.filter(([k]) => k === 'answer1002').length, 2, '多选出现 2 次 answer 字段');
  eq(postOf('1004').values.join('|'), '4|1', '多空提交为同名重复字段（2 个空）');

  // 单选 / 判断是单值
  eq(postOf('1001').values.length, 1, '单选只发一个值');
  eq(postOf('1003').values[0], 'true', '判断发 true');

  // 先暂存、后交卷：两次提交的 tempSave 不一样，且暂存在前
  const anyTempTrue = state.posts.some((p) => p.form.tempSave === 'true');
  const anyTempFalse = state.posts.some((p) => p.form.tempSave === 'false');
  ok(anyTempTrue && anyTempFalse, '既有 tempSave=true 也有 tempSave=false');
  const firstFalse = state.posts.findIndex((p) => p.form.tempSave === 'false');
  const lastTrue = state.posts.map((p) => p.form.tempSave).lastIndexOf('true');
  ok(firstFalse > lastTrue, '暂存全部走完才交卷');

  // submit=false：只暂存
  state = stubAll();
  const dry = await solver.solveWork({
    cookies: COOKIES,
    llm: undefined,
    aiConfig: { baseURL: 'https://stub.local/v1', apiKey: 'k', model: 'stub' },
    submit: false,
    verify: true,
  });
  ok(dry.ok, 'submit=false 时暂存成功也算 ok');
  eq(dry.submitted, false, 'submit=false 不应交卷');
  ok(state.posts.every((p) => p.form.tempSave === 'true'), 'submit=false 时只有 tempSave=true');
  eq(state.posts.length, 5, 'submit=false 时只提交一轮');

  // 题目列表为空 → 明确报错而不是静默成功
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    if (u.pathname === '/v1/chat/completions') {
      return new Response(JSON.stringify({ choices: [{ message: { content: MODEL_ANSWERS } }] }), { status: 200 });
    }
    if (u.pathname === '/work/stu-work') {
      return new Response('<a href="https://mooc1-api.chaoxing.com/android/mtaskmsgspecial?type=work&taskrefId=w1">x</a>', { status: 200 });
    }
    if (u.pathname === '/android/mtaskmsgspecial') {
      return new Response('<a href="/work/phone/doHomeWork?courseId=1">x</a>', { status: 200 });
    }
    if (u.pathname === WORK_PATH) return new Response('<html><body>已提交</body></html>', { status: 200 });
    return new Response('', { status: 200 });
  };
  const empty = await solver.solveWork({ cookies: COOKIES, aiConfig: { baseURL: 'https://stub.local/v1', apiKey: 'k' } });
  eq(empty.ok, false, '没有题目时 ok=false');
  ok(empty.reason.includes('没抓到题目'), '没有题目时说明原因');

  // 登录态失效 → NEED_LOGIN 透传
  globalThis.fetch = async () => new Response('', { status: 302, headers: { location: 'https://passport2.chaoxing.com/login' } });
  await assert.rejects(() => api.listWorks(COOKIES), (err) => err.code === 'NEED_LOGIN', '302 跳登录应抛 NEED_LOGIN');
  n += 1;

  return `学习通单测：${n} 条断言全过（接口解析 / 题型识别 / 答案归一 / 逐题隐藏域 / 暂存-回读-交卷）`;
}
