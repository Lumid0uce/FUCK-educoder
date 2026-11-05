/**
 * 头歌（Educoder）平台 API 层。
 *
 * 走的是平台前端自己在用的 `data.educoder.net/api` 接口，签名算法是前端公开常量：
 *   X-EDU-Signature = md5( base64( "method=<M>&ak=<AK>&sk=<SK>&time=<ms>" ) )
 * 这不是破解，是把浏览器里已经在跑的那套请求原样搬到 Node 里，
 * 好处是拿到的题干/文件/评测结果都是结构化 JSON，比截图 + 视觉模型可靠得多。
 *
 * 登录态来自浏览器 profile 里抓的 cookie（_educoder_session），
 * 见 lib/session.mjs。
 */

import { createHash } from 'node:crypto';

export const API_BASE = 'https://data.educoder.net/api';
export const SITE_ORIGIN = 'https://www.educoder.net';

/** 平台前端公开常量（写在 umi bundle 里，任何人打开网页都能看到）。 */
const AK = 'e9dd5b4322f9f7d83d009de9bfa100c3';
const SK = '2e3da06ae26ba9f76a5d8d355746f2fe';

/** 平台用全角分号分隔多文件路径。 */
export const PATH_SEP = '；';

/** 计算一次请求签名。 */
export function sign(method, timestamp = Date.now()) {
  const raw = `method=${method}&ak=${AK}&sk=${SK}&time=${timestamp}`;
  const b64 = Buffer.from(raw, 'utf8').toString('base64');
  return createHash('md5').update(b64, 'utf8').digest('hex');
}

/**
 * 统一请求。
 * @param {object} opts
 * @param {string} opts.method - 'GET' | 'POST'
 * @param {string} opts.path - 以 / 开头的 api 路径
 * @param {Record<string,string>} [opts.query]
 * @param {object} [opts.body]
 * @param {Record<string,string>} opts.cookies - 浏览器里抓到的 cookie 名值对
 * @param {number} [opts.timeoutMs]
 * @param {AbortSignal} [opts.signal]
 */
export async function request({ method = 'GET', path, query, body, cookies = {}, timeoutMs = 30000, signal }) {
  const m = method.toUpperCase();
  const ts = Date.now();
  const signature = sign(m, ts);

  const url = new URL(API_BASE + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      url.searchParams.set(k, String(v));
    }
  }

  const session = cookies._educoder_session ?? '';
  const headers = {
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'X-EDU-Timestamp': String(ts),
    'X-EDU-Signature': signature,
    'X-EDU-Type': 'pc',
    'Pc-Authorization': session,
    Origin: SITE_ORIGIN,
    Referer: `${SITE_ORIGIN}/`,
    Cookie: Object.entries(cookies)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${k}=${v}`)
      .join('; '),
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json;charset=UTF-8';

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('请求超时')), timeoutMs);
  const onAbort = () => ctrl.abort(signal.reason);
  if (signal) {
    if (signal.aborted) ctrl.abort(signal.reason);
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  let res;
  try {
    res = await fetch(url, {
      method: m,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    if (error?.name === 'AbortError') throw new Error(`请求被取消：${m} ${path}`);
    throw new Error(`网络请求失败：${m} ${path} — ${error.message}`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
  }

  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`响应不是 JSON（HTTP ${res.status}）：${text.slice(0, 300)}`);
  }

  if (res.status === 401 || json?.status === 401) {
    const err = new Error(json?.message || '未登录或登录已过期');
    err.code = 'NEED_LOGIN';
    throw err;
  }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}：${json?.message ?? text.slice(0, 300)}`);
    err.code = 'HTTP_ERROR';
    err.status = res.status;
    throw err;
  }
  return json;
}

/** 是否已登录（拿一个需要登录态的轻接口探一下）。 */
export async function checkLogin(cookies) {
  try {
    const json = await request({
      path: '/courses.json',
      query: { page: 1, limit: 1, order: 'mine', search: '', zzud: '' },
      cookies,
    });
    // 未登录时这个接口也会返回游客数据，所以不能只看它。
    return { ok: true, sample: json };
  } catch (error) {
    if (error.code === 'NEED_LOGIN') return { ok: false, reason: error.message };
    throw error;
  }
}

/**
 * 我的课程列表。
 * @param {Record<string,string>} cookies
 * @param {{page?: number, limit?: number, order?: string}} [opts]
 */
export async function listCourses(cookies, opts = {}) {
  const json = await request({
    path: '/courses.json',
    query: {
      page: opts.page ?? 1,
      limit: opts.limit ?? 30,
      order: opts.order ?? 'mine',
      search: opts.search ?? '',
      zzud: '',
    },
    cookies,
    signal: opts.signal,
  });
  return normalizeList(json);
}

/** 某课程的作业/实训列表。 */
export async function listHomework(cookies, courseId, opts = {}) {
  const json = await request({
    path: `/courses/${encodeURIComponent(courseId)}/homework_commons.json`,
    query: {
      limit: opts.limit ?? 100,
      status: opts.status ?? 0,
      id: courseId,
      type: opts.type ?? 4,
      order: opts.order ?? 0,
      zzud: '',
    },
    cookies,
    signal: opts.signal,
  });
  // 作业条目的 id 字段叫 homework_id、关卡入口叫 shixun_identifier，
  // 不归一化的话调用方拿到的全是 undefined。
  const normalized = normalizeList(json);
  return { ...normalized, list: normalized.list.map(normalizeHomework) };
}

/** 作业下的关卡（入口 shixun）列表。 */
export async function listShixuns(cookies, shixunId, homeworkCommonId, opts = {}) {
  const json = await request({
    path: `/shixuns/${encodeURIComponent(shixunId)}/shixun_exec.json`,
    query: { homework_common_id: homeworkCommonId, zzud: '' },
    cookies,
    signal: opts.signal,
  });
  return json;
}

/**
 * 关卡详情：题干、文件结构、当前代码、评测配置。
 * @param {string} taskId - 关卡 id（路径里的那串）
 * @param {string|number} homeworkCommonId
 */
export async function getTask(cookies, taskId, homeworkCommonId, opts = {}) {
  const json = await request({
    path: `/tasks/${encodeURIComponent(taskId)}.json`,
    query: { homework_common_id: homeworkCommonId, zzud: '' },
    cookies,
    signal: opts.signal,
  });
  return json;
}

/**
 * 读关卡里的一个文件。
 * 真实响应形如：
 *   { content: { content: '<base64>', size: 120 }, language: 'c', file_type: 'txt', filename: 'sy10001.c' }
 * 所以这里直接把 base64 解开，返回 { path, content, language, size }，
 * 调用方拿到的 content 就是纯文本，不用再猜字段。
 * @param {object} opts - {taskId, homeworkCommonId, path, exerciseId}
 */
export async function readFile(cookies, opts) {
  const json = await request({
    path: `/tasks/${encodeURIComponent(opts.taskId)}/rep_content.json`,
    query: {
      path: opts.path ?? '',
      homework_common_id: opts.homeworkCommonId,
      exercise_id: opts.exerciseId,
      zzud: '',
    },
    cookies,
    signal: opts.signal,
  });

  const payload = json?.data ?? json ?? {};
  const raw = payload.content;
  // 三种可能：{content: base64, size} / 纯 base64 字符串 / 已是明文
  let content = '';
  let size;
  if (raw && typeof raw === 'object') {
    content = decodeMaybeBase64(raw.content);
    size = raw.size;
  } else if (typeof raw === 'string') {
    content = decodeMaybeBase64(raw);
    size = content.length;
  }

  return {
    path: opts.path,
    content,
    language: payload.language ?? guessLanguage(opts.path),
    size,
    filename: payload.filename,
    raw: json,
  };
}

/** 头歌的文件内容是 base64；解不出来就原样返回（可能是明文）。 */
export function decodeMaybeBase64(value) {
  if (typeof value !== 'string' || !value) return '';
  // base64 只含这些字符，且长度是 4 的倍数
  if (!/^[A-Za-z0-9+/=\r\n]+$/.test(value) || value.replace(/\s/g, '').length % 4 !== 0) return value;
  try {
    const text = Buffer.from(value, 'base64').toString('utf8');
    // 解出来如果是乱码就退回原文
    return /[\u0000-\u0008\u000e-\u001f]/.test(text) ? value : text;
  } catch {
    return value;
  }
}

/**
 * 保存文件（提交前必须先存）。
 *
 * 参数是照着真实前端请求抓下来的（2026-10 实测），几个关键点：
 *   - URL 里的 id 是 **myshixun.identifier**（如 `ajlk5ovpzr`），不是数字 id
 *   - `evaluate` 是数字 1（表示"这次保存要参与评测"），**代码内容在 `content`**
 *   - `tab_type` 是 1（代码文件标签页），不是 0
 *   - `extras` 是个对象，要带 challenge_id / homework_common_id / currentUserId
 *   - query 里的 `zzud` 是用户 login（如 `pplrf5cx3`），不是空串
 * 旧的实现把代码塞进 `evaluate`、zzud 传空、tab_type 传 0，平台会返回
 * `content_modified: 0` 静默不写盘 —— 这就是之前"保存成功但代码没变"的原因。
 *
 * @param {object} opts - {myshixunIdentifier, taskId, path, content, homeworkCommonId, gameId,
 *                          challengeId, zzud, tabType, extras}
 */
export async function saveFile(cookies, opts) {
  const extras = opts.extras ?? {
    exercise_id: '',
    question_id: '',
    challenge_id: opts.challengeId ?? '',
    subject_id: '',
    smart_plan_page_item_bank_id: '',
    homework_common_id: String(opts.homeworkCommonId ?? ''),
    competition_entry_id: '',
    currentUserId: opts.currentUserId ?? '',
  };
  const json = await request({
    method: 'POST',
    path: `/myshixuns/${encodeURIComponent(opts.myshixunIdentifier ?? opts.myshixunId)}/update_file.json`,
    query: { zzud: opts.zzud ?? '' },
    body: {
      path: opts.path,
      evaluate: 1,
      content: opts.content ?? '',
      game_id: opts.gameId ?? opts.taskId,
      tab_type: opts.tabType ?? 1,
      exercise_id: opts.exerciseId ?? null,
      homework_common_id: String(opts.homeworkCommonId ?? ''),
      extras,
    },
    cookies,
    signal: opts.signal,
  });
  return json;
}

/**
 * 触发评测（编程/实训题）。
 * 真实 body 需要 sec_key（task 详情里的 `sec_key` 字段）+ 完整的 extras，
 * 否则平台不会真的排队评测。
 * @param {object} opts - {taskId, secKey, challengeId, homeworkCommonId, zzud, currentUserId,
 *                          shixunEnvironmentId, first, resubmit, commitId, body}
 */
export async function buildTask(cookies, opts) {
  const body = opts.body ?? {
    sec_key: opts.secKey ?? '',
    resubmit: opts.resubmit ?? '',
    first: opts.first ?? 1,
    content_modified: 0,
    shixun_environment_id: opts.shixunEnvironmentId ?? null,
    tab_type: 1,
    extras: {
      exercise_id: '',
      question_id: '',
      challenge_id: opts.challengeId ?? '',
      subject_id: '',
      smart_plan_page_item_bank_id: '',
      homework_common_id: String(opts.homeworkCommonId ?? ''),
      competition_entry_id: '',
      commitID: opts.commitId ?? '',
      currentUserId: opts.currentUserId ?? '',
    },
    homework_common_id: String(opts.homeworkCommonId ?? ''),
  };
  const json = await request({
    method: 'POST',
    path: `/tasks/${encodeURIComponent(opts.taskId)}/game_build.json`,
    query: { zzud: opts.zzud ?? '' },
    body,
    cookies,
    signal: opts.signal,
  });
  return json;
}

/**
 * 评测状态（前端每 1~2 秒轮询一次的那个接口）。
 * 返回里 `test_sets[].result` 是布尔：true 通过 / false 未通过；
 * `compile_success: 0` + `actual_output: '编译失败…'` 表示编译挂了；
 * `last_compile_output` 是完整的编译器报错（含 `<br/>`，要还原成换行）。
 * `sec_key` 会变，每次轮询用最新的。
 * @param {object} opts - {taskId, secKey, challengeId, homeworkCommonId, zzud, resubmit, timeOut, port}
 */
export async function gameStatus(cookies, opts) {
  const json = await request({
    path: `/tasks/${encodeURIComponent(opts.taskId)}/game_status.json`,
    query: {
      resubmit: opts.resubmit ?? '',
      time_out: opts.timeOut ?? 'false',
      port: opts.port ?? 0,
      sec_key: opts.secKey ?? '',
      challenge_id: opts.challengeId ?? '',
      subject_id: '',
      homework_common_id: opts.homeworkCommonId,
      zzud: opts.zzud ?? '',
    },
    cookies,
    signal: opts.signal,
  });
  return json;
}

/**
 * 从 game_status.json 的返回里读评测结论。
 * 这个接口比重新拉 task 详情快，而且带 `last_compile_output` 完整报错。
 * @returns {{state:'pending'|'pass'|'fail'|'unknown', grade?:number, total:number, passed:number,
 *            cases:Array, compileOutput:string, secKey?:string, nextGame?:string, raw:object}}
 */
export function readGameStatus(json) {
  const d = json?.data ?? json ?? {};
  const sets = Array.isArray(d.test_sets) ? d.test_sets : [];
  const cases = sets.map((s, i) => {
    const has = s !== null && typeof s === 'object' && 'result' in s;
    const pending = !has || s.result === null || s.result === undefined;
    const passed = has && s.result === true;
    const compileFailed = s?.compile_success === 0;
    return {
      index: i,
      name: `用例${i + 1}`,
      pending,
      passed: !pending && passed,
      failed: !pending && !passed,
      compileSuccess: s?.compile_success,
      expected: s?.output ?? '',
      actual: s?.actual_output ?? '',
      message: pending ? '' : (s?.actual_output ?? '') || (passed ? '' : '未通过'),
      compileFailed,
    };
  });

  // last_compile_output 里的 <br/> 还原成换行
  const compileOutput = String(d.last_compile_output ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

  const total = sets.length;
  const passedCount = cases.filter((c) => c.passed).length;
  // 评测期间接口不返回 test_sets，只返回 {running_code_status, running_code_message}。
  // running_code_status 实测语义：有值就代表「还在跑」（2 = 服务启动完成，仍在等容器/执行）。
  const running =
    d.running_code_status !== undefined && d.running_code_status !== null
      ? { status: d.running_code_status, message: d.running_code_message ?? '' }
      : undefined;
  let state = 'unknown';
  if (cases.length) {
    if (cases.some((c) => c.pending)) state = 'pending';
    else if (passedCount === total) state = 'pass';
    else state = 'fail';
  } else if (running) {
    state = 'pending';
  } else if (d.status === 2 || d.grade === 100) {
    state = 'pass';
  }

  return {
    state,
    grade: d.grade,
    status: d.status,
    total,
    passed: passedCount,
    cases,
    compileOutput,
    running,
    secKey: d.sec_key,
    nextGame: d.next_game,
    recordConsumeTime: d.record_consume_time,
    raw: d,
  };
}

/**
 * 触发评测后轮询到出结果（打 game_status.json，和前端一致）。
 * @param {object} opts - {cookies, taskId, challengeId, homeworkCommonId, zzud, secKey,
 *                          timeoutMs, intervalMs, signal, onTick}
 */
export async function waitBuildResult(cookies, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const intervalMs = opts.intervalMs ?? 1500;
  const deadline = Date.now() + timeoutMs;
  let last;
  let secKey = opts.secKey;
  let lastError = '';
  let polls = 0;
  while (Date.now() < deadline) {
    if (opts.signal?.aborted) throw new Error('已取消');
    let json;
    polls += 1;
    try {
      json = await gameStatus(cookies, {
        taskId: opts.taskId,
        challengeId: opts.challengeId,
        homeworkCommonId: opts.homeworkCommonId,
        zzud: opts.zzud,
        secKey,
        signal: opts.signal,
      });
    } catch (error) {
      // 不要把错误吞掉：超时后调用方需要知道「一直没结果」到底是接口挂了还是真在排队
      lastError = error.message;
      last = { state: 'unknown', cases: [], error: lastError };
      opts.onTick?.(last);
      await new Promise((r) => setTimeout(r, intervalMs));
      continue;
    }
    last = readGameStatus(json);
    // sec_key 会随评测轮换，后面继续用它
    if (last.secKey) secKey = last.secKey;
    opts.onTick?.(last);
    if (last.state === 'pass' || last.state === 'fail') return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  const fallback = last ?? { state: 'unknown', cases: [] };
  return { ...fallback, polls, ...(lastError ? { error: lastError } : {}) };
}

/**
 * 客观题（选择题 / 填空题）提交。
 *
 * 实测真实前端请求：
 *   POST /api/tasks/<taskId>/choose_build.json?zzud=<user.login>
 *   选择题 body: {"answer":["A","B",...],"challenge_id":<id>,"subject_id":"","question_id":null,
 *                 "competition_entry_id":null,"smart_plan_page_item_bank_id":null,
 *                 "homework_common_id":"<hw>"}
 *   填空题 body 同形，但 answer 是二维数组：每道小题一个数组，一个空一个字符串。
 *
 * 选择题和填空题走的是同一个接口，区别只在 answer 的形状。
 */
export async function submitChoice(cookies, opts) {
  const json = await request({
    method: 'POST',
    path: `/tasks/${encodeURIComponent(opts.taskId)}/choose_build.json`,
    query: { zzud: opts.zzud ?? '' },
    body: opts.body ?? {},
    cookies,
    signal: opts.signal,
  });
  return json;
}

/**
 * 把客观题提交接口的返回归一成和编程题一样的 verdict 形状，
 * 这样上层渲染逻辑不用分叉。
 *
 * 平台返回的字段不固定（不同题型/版本给的不一样），所以这里只做「能读出来就读」，
 * 读不出来就返回 state:'unknown' 并带上原始响应，绝不瞎猜成 pass。
 * @param {object} json - choose_build 的响应
 * @param {object} [taskJson] - 提交后重新拉的 task 详情（可选，用来交叉验证 game.status）
 */
export function readChoiceResult(json, taskJson) {
  const d = json?.data ?? json ?? {};
  const raw = json ?? {};

  // 有的版本直接给 grade/score，有的给 test_sets 数组（每题一条）
  const sets = Array.isArray(d.test_sets) ? d.test_sets : Array.isArray(raw.test_sets) ? raw.test_sets : [];
  const cases = sets.map((s, i) => {
    const result = s?.result ?? s?.passed;
    return {
      index: i,
      name: s?.name ?? `题目${i + 1}`,
      pending: result === null || result === undefined,
      passed: result === true,
      failed: result === false,
      message: s?.message ?? s?.output ?? '',
      expected: s?.standard_answer ?? s?.output,
      actual: s?.actual_output,
    };
  });

  // 平台对客观题不回逐题对错（result / choose_correct_num 都是 null），
  // 只回总分。所以判分只能看 game.final_score 与 challenge.score 的比值：
  //   实测 选择题 challenge.score=150、答对 4/11 → final_score=120（0.8），game.status 仍 0
  //        编程题 challenge.score=100、全对 → final_score=100（1.0），game.status=2
  // 也就是说「通过」= 拿满本关分（score_radio >= 1）或 game.status === 2。
  const total = d.test_sets_count ?? raw.test_sets_count ?? (cases.length || undefined);
  const passedCount = cases.filter((c) => c.passed).length;
  const grade = d.grade ?? raw.grade;
  const game = taskJson?.game ?? {};
  const challenge = taskJson?.challenge ?? {};
  const maxScore = typeof challenge.score === 'number' ? challenge.score : undefined;
  const finalScore = typeof game.final_score === 'number' ? game.final_score : undefined;
  const radio =
    typeof game.score_radio === 'number' ? game.score_radio : maxScore ? finalScore / maxScore : undefined;

  let state = 'unknown';
  if (cases.length && !cases.some((c) => c.pending)) {
    state = cases.every((c) => c.passed) ? 'pass' : 'fail';
  } else if (game.status === 2) {
    // game.status === 2 是平台「已完成/通过」的标记
    state = 'pass';
  } else if (typeof radio === 'number' && radio >= 1) {
    state = 'pass';
  } else if (typeof finalScore === 'number' && maxScore) {
    // 交了但没拿满 → 没过（客观题没法只对一部分就算过）
    state = 'fail';
  } else if (cases.length) {
    state = 'pending';
  }

  return {
    state,
    grade,
    status: d.status ?? raw.status,
    total,
    passed: passedCount || (state === 'pass' && total ? total : 0),
    finalScore,
    maxScore,
    radio: typeof radio === 'number' ? Math.round(radio * 100) / 100 : undefined,
    cases,
    message: d.message ?? raw.message,
    raw,
  };
}

/**
 * 列表响应归一化：头歌不同接口把数组放在 data / list / homeworks / homework_commons 里。
 * 实测 /courses/<id>/homework_commons.json 的数组在顶层 `homeworks`，
 * 条目里 id 叫 `homework_id`，关卡入口叫 `shixun_identifier`。
 */
export function normalizeList(json) {
  const d = json?.data ?? json;
  const arr = Array.isArray(d)
    ? d
    : (d?.list ?? d?.homeworks ?? d?.homework_commons ?? d?.courses ?? d?.items ?? []);
  // 作业列表里 all_count 是"课程下全部作业数"，query_total_count 才是"本次查到的数"，
  // 直接拿 all_count 当 total 会显示成 27 个（实际只返回 2 个）。
  const total = d?.total ?? d?.query_total_count ?? d?.all_count ?? d?.count ?? arr.length;
  return { list: arr, total, allCount: d?.all_count, raw: json };
}

/** 作业条目归一化：把 homework_id / shixun_identifier 映射成统一的 id / shixunId。 */
export function normalizeHomework(hw = {}) {
  return {
    id: hw.homework_id ?? hw.id,
    name: hw.name ?? hw.title ?? '',
    shixunId: hw.shixun_identifier ?? hw.shixun_id,
    myshixunId: hw.myshixun_identifier ?? hw.myshixun_id,
    status: Array.isArray(hw.status) ? hw.status.join(',') : hw.status,
    challengeCount: hw.challenge_count,
    finishedCount: hw.finished_challenge_count,
    shixunStatus: hw.shixun_status,
    endTime: hw.end_time,
    canView: hw.can_view_details,
    raw: hw,
  };
}

/**
 * 从任务详情里提炼出「要填哪些文件、当前内容是什么」。
 * 头歌的 task 详情里，文件清单一般在 challenge.files / challenge.path，
 * 单文件时 challenge.path 就是那一个路径。
 */
export function extractFiles(taskJson) {
  const task = taskJson?.data ?? taskJson;
  const challenge = task?.challenge ?? task?.task ?? {};
  const out = [];
  const seen = new Set();

  const push = (path, content, language) => {
    if (!path || seen.has(path)) return;
    seen.add(path);
    out.push({ path, content: content ?? '', language: language ?? guessLanguage(path) });
  };

  // 形态 1：challenge.files 是 [{path, content, ...}]
  const files = challenge.files ?? challenge.file_list ?? task?.files;
  if (Array.isArray(files)) {
    for (const f of files) {
      if (typeof f === 'string') push(f, '');
      else push(f.path ?? f.name ?? f.file_name, f.content ?? f.code ?? f.evaluate ?? '', f.language);
    }
  }

  // 形态 2：challenge.path 用全角分号分隔
  if (!out.length && typeof challenge.path === 'string' && challenge.path.trim()) {
    for (const p of challenge.path.split(PATH_SEP)) {
      const path = p.trim();
      if (path) push(path, '');
    }
  }

  // 形态 3：challenge.code / evaluate 单文件
  if (!out.length) {
    const code = challenge.code ?? challenge.evaluate ?? challenge.content;
    const path = challenge.path || challenge.file_path || 'main';
    if (typeof code === 'string' && code) push(path, code, challenge.language);
  }

  return out;
}

/** 题干正文：优先 challenge.task_pass / description / task_desc。 */
export function extractStatement(taskJson) {
  const task = taskJson?.data ?? taskJson;
  const c = task?.challenge ?? task?.task ?? {};
  const parts = [
    c.task_pass,
    c.description,
    c.task_desc,
    c.content,
    c.introduction,
    task?.description,
  ].filter((x) => typeof x === 'string' && x.trim());
  return parts.join('\n\n');
}

/**
 * 标题。真实题目里 challenge.name / title 都是空的，
 * 关卡名在 `challenge.subject`（例："打印输出 Hello World"），再兜底到题干首行。
 */
export function extractTitle(taskJson) {
  const task = taskJson?.data ?? taskJson;
  const c = task?.challenge ?? task?.task ?? {};
  const direct = c.name ?? c.title ?? task?.name ?? task?.title;
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  if (typeof c.subject === 'string' && c.subject.trim()) return c.subject.trim();
  const firstLine = extractStatement(taskJson).split('\n').find((line) => line.trim());
  return (firstLine ?? '').trim().slice(0, 80);
}

/**
 * 这道题是什么题型。头歌把题型写在 challenge.subject 里：
 * 「单项选择题」「填空题」「打印输出 Hello World」（编程题用关卡名当 subject）。
 * 同时用 chooses 数组判断客观题。
 * @returns {{kind:'choice'|'fill'|'code'|'unknown', label:string, chooseCount:number}}
 */
export function detectKind(taskJson) {
  const task = taskJson?.data ?? taskJson;
  const c = task?.challenge ?? task?.task ?? {};
  const subject = String(c.subject ?? '');
  const chooses = Array.isArray(task?.chooses) ? task.chooses : [];
  if (chooses.length) {
    if (/单选|多选|选择/.test(subject)) return { kind: 'choice', label: subject || '选择题', chooseCount: chooses.length };
    if (/填空/.test(subject)) return { kind: 'fill', label: subject || '填空题', chooseCount: chooses.length };
    return { kind: 'choice', label: subject || '客观题', chooseCount: chooses.length };
  }
  if (/^单项选择|^多项选择|^选择题/.test(subject)) return { kind: 'choice', label: subject, chooseCount: 0 };
  if (/^填空/.test(subject)) return { kind: 'fill', label: subject, chooseCount: 0 };
  if (c.path || c.files) return { kind: 'code', label: subject || '编程题', chooseCount: 0 };
  return { kind: 'unknown', label: subject || '未知题型', chooseCount: 0 };
}

/** 客观题（选择/填空）的题目列表，统一成 {index, question, type, multi, id, options}。 */
export function extractChooses(taskJson) {
  const task = taskJson?.data ?? taskJson;
  const arr = Array.isArray(task?.chooses) ? task.chooses : [];
  return arr.map((item, index) => ({
    index,
    id: item.challenge_choose_id ?? item.id,
    question: item.subject ?? item.question ?? '',
    type: item.question_type,
    questionName: item.question_name,
    multiCount: item.multi_count,
    // 选择题的选项在 challenge_question 里，字段名叫 option_name；填空题没有这一项。
    options: (Array.isArray(item.challenge_question) ? item.challenge_question : [])
      .slice()
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
      .map((opt, i) => ({
        label: String.fromCharCode(65 + i),
        position: opt.position ?? i,
        text: opt.option_name ?? opt.text ?? '',
      })),
    raw: item,
  }));
}

/**
 * 从 URL 里抽 task id。
 *
 * 头歌有两种题目 URL：
 *   /tasks/<taskId>?homework_common_id=<hw>   —— 旧式
 *   /tasks/<course>/<hw>/<taskId>             —— 新式（三段式）
 * 新式第一段是课程 identifier（如 R9VAZCPK），**不是** task id，
 * 所以三段式必须优先匹配，否则会把课程号当成关卡号。
 */
export function parseTaskId(url) {
  if (!url) return undefined;
  const s = String(url);
  const three = /\/tasks\/[A-Za-z0-9_-]+\/\d+\/([A-Za-z0-9_-]+)/.exec(s);
  if (three?.[1]) return three[1];
  const m = /\/tasks\/([A-Za-z0-9_-]+)/.exec(s);
  return m?.[1];
}

/** 从 URL 里抽 shixun id（/shixuns/<id>/... 或 /paths/...）。 */
export function parseShixunId(url) {
  if (!url) return undefined;
  const m = /\/shixuns\/([A-Za-z0-9_-]+)/.exec(String(url));
  return m?.[1];
}

/**
 * 从 URL 里抽 homework_common_id。
 * 支持 `?homework_common_id=xxx` / `?homework_id=xxx`，
 * 以及三段式路径 `/tasks/<course>/<hw>/<taskId>` 里中间那段数字。
 */
export function parseHomeworkId(url) {
  if (!url) return undefined;
  const s = String(url);
  try {
    const u = new URL(s, SITE_ORIGIN);
    const q =
      u.searchParams.get('homework_common_id') ??
      u.searchParams.get('homework_id') ??
      u.searchParams.get('homeworkId');
    if (q) return q;
  } catch {
    /* 不是合法 URL 就退回正则 */
  }
  const three = /\/tasks\/[A-Za-z0-9_-]+\/(\d+)\/[A-Za-z0-9_-]+/.exec(s);
  return three?.[1];
}

/** 按扩展名猜语言，给模型提示用。 */
export function guessLanguage(path = '') {
  const ext = (path.split('.').pop() || '').toLowerCase();
  const map = {
    py: 'python', js: 'javascript', ts: 'typescript', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp',
    java: 'java', go: 'go', rs: 'rust', rb: 'ruby', php: 'php', sh: 'bash', sql: 'sql', json: 'json',
    html: 'html', css: 'css', md: 'markdown', txt: 'text', m: 'matlab', r: 'r', cs: 'csharp', kt: 'kotlin',
    swift: 'swift', scala: 'scala', lua: 'lua', pl: 'perl', yaml: 'yaml', yml: 'yaml', xml: 'xml',
  };
  return map[ext] ?? '';
}

/** 平台占位符：连续 U+2014。含它的代码必然编译失败。 */
export const PLACEHOLDER_RE = /\u2014{2,}/;

/** 判断一段代码是不是还没填（空、或只有占位符、或只有函数壳）。 */
export function looksUnsolved(code) {
  const s = String(code ?? '').trim();
  if (!s) return true;
  if (PLACEHOLDER_RE.test(s)) return true;
  if (/^\s*(\/\/|\/\*|#|<!--)/.test(s) && s.length < 400) return true;
  return false;
}

/**
 * 从 task 详情里读评测结果（备用路径）。
 *
 * 正常情况下用 `readGameStatus`（打 game_status.json，字段更全、更快）。
 * 这个函数保留给「只有 task 详情」的场景，比如从别处拿到的快照。
 * 注意 task 详情里的 test_sets 结构和 game_status 里的一样：
 * `result` 是布尔值，不是对象。
 *
 * @returns {{state: 'pending'|'pass'|'fail'|'unknown', gameStatus?: number, total?: number, passed?: number, cases: Array, raw?: object}}
 */
export function readBuildResult(taskJson) {
  const task = taskJson?.data ?? taskJson ?? {};
  const challenge = task.challenge ?? task.task ?? {};
  const game = task.game ?? challenge.game ?? {};
  const sets = challenge.test_sets ?? game.test_sets ?? task.test_sets ?? [];
  const cases = Array.isArray(sets)
    ? sets.map((s, i) => {
        // `result === null` / 缺失 → 还在跑；布尔值才是结论。
        const has = s !== null && typeof s === 'object' && 'result' in s;
        const pending = !has || s.result === null || s.result === undefined;
        const passed = has && s.result === true;
        return {
          index: i,
          name: s?.name ?? s?.title ?? `用例${i + 1}`,
          pending,
          passed: !pending && passed,
          failed: !pending && !passed,
          compileSuccess: s?.compile_success,
          expected: s?.output ?? '',
          actual: s?.actual_output ?? '',
          message: pending ? '' : (s?.actual_output ?? '') || (passed ? '' : '未通过'),
        };
      })
    : [];

  const gameStatus = game?.status ?? challenge?.game_status ?? task?.status;
  const total = cases.length;
  const passedCount = cases.filter((c) => c.passed).length;

  let state = 'unknown';
  if (cases.length) {
    if (cases.some((c) => c.pending)) state = 'pending';
    else if (passedCount === total) state = 'pass';
    else state = 'fail';
  } else if (gameStatus === 2) {
    state = 'pass';
  }
  return { state, gameStatus, total, passed: passedCount, cases, raw: { game, challengeKeys: Object.keys(challenge) } };
}
