/**
 * lib/iwrite-api.mjs —— iWrite（外研社 iWrite 英语写作平台）接口层。
 *
 * 站点结构（逆向自 /newfe/umi.js）：
 *   - 前端是 Umi/React SPA，静态资源在 /newfe/，接口统一走 `window.CTX + /api/...`，
 *     线上 CTX 为空串，所以接口根就是 https://iwrite.unipus.cn/api
 *   - 登录走 SSO（sso.unipus.cn），登录态是 cookie，axios 里 `withCredentials` 默认带上；
 *     另外每个请求都带一个 `ssoUserId` 头，值直接取自同名 cookie
 *   - 响应统一信封 { code, msg, data }，code === 200 才算成功；
 *     code 2002 / 100 / 400 表示登录态失效
 *
 * 为什么走接口而不是点页面：iWrite 的作文正文是 TinyMCE，挂在 iframe 里，
 * 用鼠标键盘往里敲一篇 300 词的作文又慢又容易漏字；接口一次 POST 就写完了。
 * 浏览器路只在接口不可用时兜底（见 lib/iwrite-browser.mjs）。
 *
 * 模块加载阶段不做任何 IO。
 */

export const IWRITE_ORIGIN = 'https://iwrite.unipus.cn';
export const IWRITE_API_BASE = `${IWRITE_ORIGIN}/api`;

/** 体裁枚举（teacher createTask 表单里的同一套）。 */
export const GENRE_NAMES = {
  0: '通用公式',
  1: '应用文',
  2: '议论文',
  3: '说明文',
  4: '记叙文',
  5: '学术写作',
  6: '雅思作文',
};

/** 体裁对应的英文写作要求（喂给模型的硬约束）。 */
export const GENRE_GUIDE = {
  0: 'general-purpose essay with a clear introduction, body and conclusion',
  1: 'practical/applied writing (e.g. letter, notice, email, poster) — follow the exact format the prompt asks for, including salutation and sign-off when relevant',
  2: 'argumentative essay — take a clear position, support it with reasons and evidence, and address at least one counter-argument',
  3: 'expository essay — explain or describe a topic objectively, organised by clear logical categories or a process order',
  4: 'narrative essay — tell a story with a clear setting, characters, conflict and resolution, in past tense',
  5: 'academic writing — formal register, hedged claims, citation-style in-text references when the prompt provides sources, no colloquialisms',
  6: 'IELTS Writing Task 2 style — 4-5 paragraphs, state a position, develop two well-supported body paragraphs, finish with a conclusion',
};

/** 词数统计口径与前端一致：按空白切分。 */
export function countWords(text) {
  const s = String(text == null ? '' : text).trim();
  if (!s) return 0;
  return s.split(/\s+/).filter(Boolean).length;
}

/** 登录失效类错误码。 */
const AUTH_CODES = new Set([100, 400, 401, 2002]);

/** 把 cookie 对象拼成 Cookie 头。 */
function cookieHeader(cookies) {
  if (!cookies || typeof cookies !== 'object') return '';
  return Object.entries(cookies)
    .filter(([k, v]) => k && v != null && v !== '')
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

/** 统一的错误对象，带上 code 方便上层判断是不是登录失效。 */
function apiError(message, code, payload) {
  const err = new Error(message);
  err.code = code;
  err.payload = payload;
  return err;
}

/**
 * 发一个请求。
 * @param {Record<string,string>} cookies
 * @param {string} path - 以 / 开头，如 '/common/currentUser'
 * @param {{method?: string, query?: object, body?: object, timeoutMs?: number, signal?: AbortSignal}} [opts]
 */
export async function request(cookies, path, opts = {}) {
  const method = (opts.method || 'GET').toUpperCase();
  const url = new URL(`${IWRITE_API_BASE}${path}`);
  for (const [k, v] of Object.entries(opts.query || {})) {
    if (v === undefined || v === null || v === '') continue;
    url.searchParams.set(k, String(v));
  }

  const headers = {
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    Origin: IWRITE_ORIGIN,
    Referer: `${IWRITE_ORIGIN}/student`,
    // 前端 axios 会给每个请求带这个头，值取自同名 cookie。
    ssoUserId: String(cookies?.ssoUserId ?? ''),
  };
  const cookie = cookieHeader(cookies);
  if (cookie) headers.Cookie = cookie;

  let bodyText;
  if (method !== 'GET' && method !== 'HEAD' && opts.body !== undefined) {
    headers['Content-Type'] = 'application/json; charset=utf-8';
    bodyText = JSON.stringify(opts.body);
  }

  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : 30_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener('abort', onAbort, { once: true });
  }

  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: bodyText,
      redirect: 'manual',
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw apiError(`请求超时或被取消：${path}`, 'TIMEOUT');
    throw apiError(`网络错误：${error?.message ?? error}（${path}）`, 'NETWORK');
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener?.('abort', onAbort);
  }

  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get('location') || '';
    throw apiError(`被重定向到登录页（${loc || '未知地址'}），登录态已失效，请重新运行 iwrite_login`, 'NEED_LOGIN');
  }
  if (res.status === 401 || res.status === 403) {
    throw apiError(`HTTP ${res.status}：登录态失效，请重新运行 iwrite_login`, 'NEED_LOGIN');
  }
  if (!res.ok) {
    throw apiError(`HTTP ${res.status}：${path}`, 'HTTP');
  }

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    const head = text.trim().slice(0, 80).replace(/\s+/g, ' ');
    throw apiError(`返回的不是 JSON（${path}）：${head}`, 'BAD_JSON');
  }

  const code = json?.code;
  if (AUTH_CODES.has(Number(code))) {
    throw apiError(`登录态失效（code=${code}，${json?.msg || '请重新登录'}）`, 'NEED_LOGIN', json);
  }
  // 有的接口（如 /student_task_index/loadByStudentId）不走 {code,msg,data} 信封，
  // 直接返回裸对象 {totalPages, stid, ...}。没有 code 字段就当成功。
  if (code === undefined || code === null) return json;
  if (Number(code) !== 200) {
    throw apiError(`接口报错（code=${code}）：${json?.msg || '未知错误'}（${path}）`, 'API', json);
  }
  return json;
}

// ---------------------------------------------------------------------------
// HTML 处理
// ---------------------------------------------------------------------------

/** 解码 HTML 实体（题干是双重转义过的，所以要反复解几次）。 */
function decodeEntities(input) {
  let s = String(input == null ? '' : input);
  const map = { '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ', '&amp;': '&' };
  for (let round = 0; round < 3; round += 1) {
    const next = s.replace(/&(lt|gt|quot|#39|nbsp|amp);/g, (m) => map[m] ?? m);
    if (next === s) break;
    s = next;
  }
  return s;
}

/**
 * 把题干 HTML 转成纯文本（段落之间留空行）。
 * 平台的 stem 是「HTML 再被实体转义一层」的，所以要解实体 → 再去标签。
 */
export function htmlToText(input) {
  const html = decodeEntities(input);
  if (!html.trim()) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------------------------------------------------------------------------
// 具体接口
// ---------------------------------------------------------------------------

/** 当前登录用户。 */
export async function currentUser(cookies, opts = {}) {
  const json = await request(cookies, '/common/currentUser', opts);
  return json.data || {};
}

/**
 * 我的作业列表。
 * 前端：loadByStudentId({ studentId, taskListType: 1, pageNum: 1 })
 *
 * 注意：这个接口**不走 {code,msg,data} 信封**，直接返回
 * `{totalPages, stid:[...], totalElements, pageNum}`，所以这里 `json.data || json`。
 * @returns {{stid: object[], totalPages: number, totalElements: number}}
 */
export async function listTasks(cookies, opts = {}) {
  const json = await request(cookies, '/student_task_index/loadByStudentId', {
    query: {
      studentId: opts.studentId,
      taskListType: opts.taskListType ?? 1,
      pageNum: opts.pageNum ?? 1,
      pageSize: opts.pageSize,
    },
    ...opts,
  });
  const data = json.data || json;
  return {
    stid: Array.isArray(data.stid) ? data.stid : [],
    totalPages: Number(data.totalPages ?? 1),
    totalElements: Number(data.totalElements ?? (data.stid?.length ?? 0)),
    raw: data,
  };
}

/**
 * 学生首页的作业索引（另一条入口，字段与 listTasks 同构）。
 */
export async function studentIndex(cookies, opts = {}) {
  const json = await request(cookies, '/studentIndex', { query: opts.query, ...opts });
  const data = json.data || json;
  return { stid: Array.isArray(data.stid) ? data.stid : [], raw: data };
}

/** 我的班级列表。 */
export async function myClass(cookies, opts = {}) {
  const json = await request(cookies, '/studenttask/myClass', opts);
  const data = json.data || json;
  return Array.isArray(data.studentClassList) ? data.studentClassList : [];
}

/**
 * 老师布置的任务本体。
 *
 * ⚠️ `/task/show/<taskId>/<classId>` 实测 **404**（Tomcat 直接报错，后端没这个路径）。
 * 任务详情只能从 `/student_task_index/loadByStudentId` 的 `stid[].task` 里取，
 * 那个字段最全（含 genre / keyWord / id / submitCount）。
 * 这里保留函数只为兼容，实际调用会退化成 loadTaskStudent。
 */
export async function taskShow(cookies, { taskId, classId, studentId }, opts = {}) {
  try {
    const json = await request(
      cookies,
      `/task/show/${encodeURIComponent(taskId)}/${encodeURIComponent(classId)}`,
      opts
    );
    const task = json.data?.task || json.task || null;
    if (task) return task;
  } catch {
    /* 走下面的兜底 */
  }
  if (!studentId) return null;
  const out = await loadTaskStudent(cookies, { taskId, classId, studentId, addNew: 2 }, opts);
  return out.task;
}

/**
 * 打开写作页时拉的数据：{ task, taskStudent }。
 * addNew: 1 = 新建空白作答，2 = 接着已有作答写。
 */
/**
 * 打开写作页时拉的数据。
 *
 * 实测真实返回（`data` 是扁平的，正文/标题在顶层，**没有 taskStudent 这个键**）：
 *   { taskId, classId, taskStudentId, studentId, task, taskAnnexeList,
 *     title, article, writingTime, startTime, addNew }
 * 而且 `task` 里只有部分字段（没有 genre / keyWord / id），
 * 完整字段要用 `/student_task_index/loadByStudentId` 里那份。
 *
 * addNew: 1 = 新建空白作答，2 = 接着已有作答写。
 */
export async function loadTaskStudent(cookies, payload, opts = {}) {
  const json = await request(cookies, '/studenttask/loadTaskStudent', {
    method: 'POST',
    body: payload,
    ...opts,
  });
  const data = json.data || {};
  const taskStudentId = data.taskStudentId != null ? String(data.taskStudentId) : '';
  return {
    task: data.task || null,
    taskStudentId,
    title: String(data.title ?? ''),
    article: String(data.article ?? ''),
    writingTime: data.writingTime ?? null,
    startTime: data.startTime ?? null,
    addNew: data.addNew ?? null,
    // 兼容旧形状（万一某个版本真的包了 taskStudent）
    taskStudent: data.taskStudent || null,
    raw: data,
  };
}

/**
 * 某班级某任务下我的所有作答版本。
 *
 * 实测 `/studenttask/getStudentTaskList/<classId>/<taskId>` 是 **404**（Tomcat 报的，
 * 说明后端根本没这个路径）。所以这里改成走 loadTaskStudent 拿当前那份，
 * 失败就返回空列表 —— 调用方本来也只用它做「回读确认」，拿不到不影响主流程。
 */
export async function studentTaskList(cookies, { classId, taskId, studentId }, opts = {}) {
  try {
    const out = await loadTaskStudent(cookies, { taskId, classId, studentId, addNew: 2 }, opts);
    const one = {
      id: out.taskStudentId,
      title: out.title,
      article: out.article,
      writingTime: out.writingTime,
    };
    return { taskStudent: out.article ? [one] : [], taskName: out.title || '', raw: out.raw };
  } catch {
    return { taskStudent: [], taskName: '', raw: null };
  }
}

/** 保存草稿。返回 taskStudentId。 */
export async function saveTask(cookies, payload, opts = {}) {
  const json = await request(cookies, '/studenttask/saveTask', {
    method: 'POST',
    body: payload,
    ...opts,
  });
  const id = json.data?.taskStudentId;
  return { taskStudentId: id != null ? String(id) : null, raw: json.data };
}

/** 正式提交（提交后进入批改流程）。 */
export async function submitTask(cookies, payload, opts = {}) {
  const json = await request(cookies, '/studenttask/submitTask', {
    method: 'POST',
    body: payload,
    ...opts,
  });
  return { ok: true, raw: json.data };
}

// ---------------------------------------------------------------------------
// 归一化
// ---------------------------------------------------------------------------

/** 把接口返回的 task 归一成插件内部用的形状。 */
export function normalizeTask(task) {
  if (!task || typeof task !== 'object') return null;
  const wordsFrom = Number(task.words) > 0 ? Number(task.words) : null;
  const wordsTo = Number(task.words2) > 0 ? Number(task.words2) : null;
  const genreId = task.genre != null ? Number(task.genre) : null;
  // stem / simpleStem / referenceAnswers 都是「HTML 再被实体转义一层」的，
  // 直接丢给模型会看到一堆 &lt;p&gt;。这里统一转成纯文本。
  const stemText = htmlToText(task.stem) || htmlToText(task.simpleStem);
  return {
    taskId: task.id != null ? String(task.id) : task.taskId != null ? String(task.taskId) : '',
    title: String(task.title || '').trim(),
    stem: stemText,
    stemHtml: String(task.stem || '').trim(),
    simpleStem: htmlToText(task.simpleStem),
    keyWord: String(task.keyWord || '').trim(),
    genreId,
    genre: genreId != null ? GENRE_NAMES[genreId] || `体裁#${genreId}` : '',
    wordsFrom,
    wordsTo,
    submitCount: task.submitCount != null ? Number(task.submitCount) : null,
    startTime: task.startTime || null,
    endTime: task.endTime || null,
    referenceAnswers: htmlToText(task.referenceAnswers),
    referenceAnalysis: htmlToText(task.referenceAnalysis),
    referenceWay: task.referenceWay != null ? Number(task.referenceWay) : null,
    score: task.score != null ? Number(task.score) : null,
    correctingWay: task.correctingWay != null ? Number(task.correctingWay) : null,
    isOverdueSet: task.isOverdueSet != null ? Number(task.isOverdueSet) : null,
    preWriteRequired: task.preWriteRequired != null ? Number(task.preWriteRequired) : null,
    aiCompareEnabled: Boolean(task.aiCompareEnabled),
    raw: task,
  };
}

/** 把 listTasks 的一条 stid 归一成便于展示的形状。 */
export function normalizeTaskEntry(entry) {
  const task = normalizeTask(entry?.task || entry) || {};
  const submitted = Boolean(entry?.submitted);
  return {
    taskId: task.taskId || (entry?.taskId != null ? String(entry.taskId) : ''),
    classId: entry?.classId != null ? String(entry.classId) : entry?.clsId != null ? String(entry.clsId) : '',
    className: entry?.className || entry?.clsName || '',
    title: task.title,
    genre: task.genre,
    wordsFrom: task.wordsFrom,
    wordsTo: task.wordsTo,
    endTime: task.endTime,
    submitted,
    studentTaskId: entry?.studentTaskId != null ? String(entry.studentTaskId) : '',
    score: entry?.score ?? null,
    raw: entry,
  };
}

/**
 * 从写作页 URL 里解析参数。
 * 形如 /student/daily/write?taskId=123&uid=456&classId=789&addNew=1
 */
export function parseWriteUrl(url) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    const err = new Error(`不是合法网址：${url}`);
    err.code = 'BAD_URL';
    throw err;
  }
  const q = u.searchParams;
  const pick = (...keys) => {
    for (const k of keys) {
      const v = q.get(k);
      if (v) return v;
    }
    return '';
  };
  return {
    origin: u.origin,
    path: u.pathname,
    taskId: pick('taskId', 'task_id', 'id'),
    classId: pick('classId', 'clsId', 'class_id'),
    studentId: pick('uid', 'studentId', 'userId'),
    studentTaskId: pick('studentTaskId'),
    addNew: pick('addNew'),
  };
}

/** 词数是否落在要求区间内（留 5% 余量）。 */
export function wordCountOk(count, from, to) {
  if (!from && !to) return true;
  const lo = from ? Math.max(1, Math.round(from * 0.95)) : 0;
  const hi = to ? Math.round(to * 1.05) : Number.MAX_SAFE_INTEGER;
  return count >= lo && count <= hi;
}
