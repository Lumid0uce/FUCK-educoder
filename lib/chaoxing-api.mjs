/**
 * lib/chaoxing-api.mjs —— 学习通（超星 chaoxing）作业接口层。
 *
 * 走的还是移动端那一套（mooc1-api.chaoxing.com），因为它是纯服务端渲染的 HTML，
 * 结构比 PC 端那坨 iframe + UEditor 稳得多：
 *
 *   1. 列作业   GET  /work/stu-work
 *      → HTML 里抓 .../android/mtaskmsgspecial?...type=work&taskrefId=...
 *   2. 解析入口 GET  上面那个 task 链接
 *      → 抓 /work/phone/doHomeWork?... 拼成绝对地址（缺 /mooc-ans 前缀时补上）
 *   3. 抓题     GET  doHomeWork?...&index=N （&knowledgeid=0）
 *      → 一页一题；每页带自己的隐藏域 + 表单控件
 *   4. 存/交    POST /mooc-ans/work/phone/doNormalHomeWorkSubmit?tempSave=true|false
 *      → 表单提交，响应 {status:true} 才算成功
 *
 * 关键坑（都踩过）：
 *   - 每题必须用「它自己那一页」的隐藏域。全用 index=0 的字段去提交，
 *     后面的题会存成空白。
 *   - 答案格式不要靠猜：单选的合法取值就是页面上 radio 的 value，
 *     判断题是 true/false。所以解析时把表单控件一起抓下来，提交时照着填。
 *   - 多空填空：页面上是一串 textarea，提交时用换行拼起来（学习通后台按行拆空）。
 *     这一条留了 verify 通道（存完再抓一遍页面比对），对不上会明确报出来。
 *
 * 模块加载阶段不做任何 IO。
 */

export const CX_ORIGIN = 'https://mooc1-api.chaoxing.com';
export const STU_WORK_URL = `${CX_ORIGIN}/work/stu-work`;
export const SUBMIT_URL = `${CX_ORIGIN}/mooc-ans/work/phone/doNormalHomeWorkSubmit`;

/** 移动端 UA：这套接口本来就是给 App 内嵌页用的，PC UA 反而会被塞进 PC 版页面。 */
export const MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

/** 拼 Cookie 头时要跳过的属性键（从浏览器导出的 cookie 串里常混进来）。 */
const SKIP_COOKIE_KEYS = new Set([
  'path',
  'domain',
  'expires',
  'max-age',
  'samesite',
  'secure',
  'httponly',
  'version',
  'priority',
]);

/** 题型编号 → 中文名。两套（App 内嵌 / PC 端）都用同一张表兜着。 */
export const TYPE_NAMES = {
  0: '单选题',
  1: '多选题',
  2: '填空题',
  3: '判断题',
  4: '简答题',
  5: '名词解释',
  6: '论述题',
  7: '计算题',
  8: '连线题',
  9: '排序题',
  10: '阅读理解',
  11: '完形填空',
  12: '其他',
};

function apiError(message, code, payload) {
  const err = new Error(message);
  err.code = code;
  err.payload = payload;
  return err;
}

/** cookie 对象 → Cookie 头。 */
export function cookieHeader(cookies) {
  if (!cookies || typeof cookies !== 'object') return '';
  return Object.entries(cookies)
    .filter(([k, v]) => k && v != null && v !== '')
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

/**
 * 从浏览器里抓来的 cookie 串/对象中挑出真正要发的键。
 * 支持 `a=1; b=2` 这种串，也支持 {a:1,b:2}。
 */
export function normalizeCookies(input) {
  if (!input) return {};
  if (typeof input === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(input)) {
      if (!k || v == null || v === '') continue;
      if (SKIP_COOKIE_KEYS.has(k.toLowerCase())) continue;
      out[k] = String(v);
    }
    return out;
  }
  const out = {};
  for (const part of String(input).split(/[;\n]/)) {
    const item = part.trim();
    if (!item || !item.includes('=')) continue;
    const idx = item.indexOf('=');
    const k = item.slice(0, idx).trim();
    const v = item.slice(idx + 1).trim();
    if (!k || SKIP_COOKIE_KEYS.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

/** 判断是不是被踢到登录页了。 */
export function isLoginUrl(url) {
  return /passport2\.chaoxing\.com|\/login|passport/i.test(String(url || ''));
}

/**
 * 发一个请求，返回 {status, finalUrl, text}。
 * 不做 JSON 假设——这套接口多数是 HTML，只有提交接口回 JSON。
 */
export async function request(cookies, url, opts = {}) {
  const method = (opts.method || 'GET').toUpperCase();
  const headers = {
    'User-Agent': opts.userAgent || MOBILE_UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    Referer: opts.referer || STU_WORK_URL,
    ...(opts.headers || {}),
  };
  const cookie = opts.cookieHeader ?? cookieHeader(cookies);
  if (cookie) headers.Cookie = cookie;

  let body;
  if (opts.form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
    body = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.form)) {
      if (v === undefined || v === null) continue;
      // 多选/多空的答案在表单里是「同名重复字段」，数组要逐项 append，
      // 拼成一个逗号串提交上去后台只会认第一项。
      if (Array.isArray(v)) {
        for (const item of v) body.append(k, String(item ?? ''));
      } else {
        body.append(k, String(v));
      }
    }
    body = body.toString();
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
  let finalUrl = url;
  try {
    // 学习通很多入口是 302 跳转（task 链接 → /work/phone/task-work，再 → doHomeWork），
    // 得自己跟，否则拿到的永远是一个空 body。
    let current = url;
    let hops = 0;
    for (;;) {
      res = await fetch(current, { method, headers, body, redirect: 'manual', signal: controller.signal });
      const isRedirect = res.status >= 300 && res.status < 400;
      if (!isRedirect) break;
      const loc = res.headers.get('location') || '';
      if (isLoginUrl(loc)) {
        throw apiError('被重定向到登录页，登录态已失效，请重新运行 chaoxing_login', 'NEED_LOGIN', { location: loc });
      }
      if (method !== 'GET' || !loc || hops >= 5) {
        // POST 不跟，交给调用方判断；GET 跟满 5 跳就停。
        return { status: res.status, finalUrl: loc || current, text: '' };
      }
      const next = new URL(loc, current);
      if (next.host !== new URL(current).host) {
        return { status: res.status, finalUrl: next.href, text: '' };
      }
      current = next.href;
      finalUrl = current;
      hops += 1;
    }
  } catch (error) {
    if (error?.name === 'AbortError') throw apiError(`请求超时或被取消：${url}`, 'TIMEOUT');
    if (error?.code === 'NEED_LOGIN') throw error;
    throw apiError(`网络错误：${error?.message ?? error}`, 'NETWORK');
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener?.('abort', onAbort);
  }

  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get('location') || '';
    if (isLoginUrl(loc)) {
      throw apiError('被重定向到登录页，登录态已失效，请重新运行 chaoxing_login', 'NEED_LOGIN', { location: loc });
    }
    // 普通跳转（有的接口 302 到目标页）——按成功处理，让调用方自己判断内容
    return { status: res.status, finalUrl: loc ? new URL(loc, finalUrl).href : finalUrl, text: '' };
  }
  if (res.status === 401 || res.status === 403) {
    throw apiError(`HTTP ${res.status}：登录态失效，请重新运行 chaoxing_login`, 'NEED_LOGIN');
  }
  if (!res.ok) throw apiError(`HTTP ${res.status}：${url}`, 'HTTP');

  const text = await res.text();
  if (isLoginUrl(text.slice(0, 4000)) && /passport2\.chaoxing\.com/.test(text.slice(0, 4000))) {
    throw apiError('接口返回了登录页，登录态已失效，请重新运行 chaoxing_login', 'NEED_LOGIN');
  }
  return { status: res.status, finalUrl, text };
}

// ---------------------------------------------------------------------------
// HTML 处理
// ---------------------------------------------------------------------------

const ENTITY_MAP = { '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ', '&amp;': '&' };

/** 解 HTML 实体（题干常被转义两三层）。 */
export function decodeEntities(input) {
  let s = String(input == null ? '' : input);
  for (let round = 0; round < 3; round += 1) {
    const next = s
      .replace(/&#(\d+);/g, (m, code) => safeFromCodePoint(Number(code), m))
      .replace(/&#x([0-9a-f]+);/gi, (m, hex) => safeFromCodePoint(parseInt(hex, 16), m))
      .replace(/&(lt|gt|quot|#39|apos|nbsp|amp);/g, (m) => ENTITY_MAP[m] ?? m);
    if (next === s) break;
    s = next;
  }
  return s;
}

function safeFromCodePoint(code, fallback) {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return fallback;
  try {
    return String.fromCodePoint(code);
  } catch {
    return fallback;
  }
}

/** HTML → 纯文本（保留段落换行）。 */
export function htmlToText(input) {
  const html = decodeEntities(input);
  if (!String(html).trim()) return '';
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 抽出页面里所有隐藏域（name → value）。 */
/**
 * 按标签名扫出整段标签文本（认引号、允许属性值跨行）。
 *
 * 为什么不能用 `/<input\b[^>]*>/`：简答题的答案就放在
 * `<input type="hidden" name="answer123" value='……一大段纯文本……'>` 里，
 * 单引号包裹、可以跨行、里面还可能有双引号。用 `[^>]*` 会在第一个 `>` 处截断，
 * 于是 value 抓成 ''，回读校验永远「对不上」——踩过的坑。
 */
export function scanTags(html, tagName) {
  const src = String(html ?? '');
  const re = new RegExp(`<${tagName}\\b`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(src))) {
    let i = re.lastIndex;
    let quote = '';
    let closed = false;
    for (; i < src.length; i += 1) {
      const ch = src[i];
      if (quote) {
        if (ch === quote) quote = '';
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        continue;
      }
      if (ch === '>') {
        out.push(src.slice(m.index, i + 1));
        re.lastIndex = i + 1;
        closed = true;
        break;
      }
    }
    if (!closed) break;
  }
  return out;
}

export function extractHiddenFields(html) {
  const fields = {};
  for (const tag of scanTags(html, 'input')) {
    if (!/type\s*=\s*["']?hidden["']?/i.test(tag)) continue;
    const name = attrOf(tag, 'name');
    if (!name) continue;
    fields[name] = decodeEntities(attrOf(tag, 'value') ?? '');
  }
  return fields;
}

/** 简答题编辑器里的「已作答」全文（手机端是 span#answerAria 的 aria-label）。 */
export function readEditorText(html) {
  for (const tag of scanTags(html, 'span')) {
    if (attrOf(tag, 'id') !== 'answerAria') continue;
    const aria = attrOf(tag, 'aria-label');
    if (aria) return aria.replace(/^已作答[：: ]?/, '').trim();
  }
  return '';
}

/** 读标签里的某个属性（单双引号都认，也认无引号）。 */
export function attrOf(tag, name) {
  const re = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const m = String(tag).match(re);
  if (!m) return undefined;
  return m[2] ?? m[3] ?? m[4] ?? '';
}

/**
 * 从作业任务页里找出 doHomeWork 路径。
 * 两种形态都见过： `/work/phone/doHomeWork?...` 和 `doHomeWork?courseId=...`。
 */
export function findDoHomeWorkPath(html) {
  const text = String(html ?? '');
  let m = text.match(/\/work\/phone\/doHomeWork\?[^"'\s<>\\]+/);
  if (!m) m = text.match(/doHomeWork\?courseId=\d+[^"'\s<>\\]+/);
  if (!m) return '';
  let path = m[0].replace(/&amp;/g, '&');
  if (!path.startsWith('/')) path = `/work/phone/${path}`;
  if (!path.startsWith('/mooc-ans')) {
    if (path.startsWith('/work/')) path = `/mooc-ans${path}`;
  }
  return path;
}

/** 把相对路径拼成绝对地址。 */
export function absoluteWorkUrl(path, origin = CX_ORIGIN) {
  const p = String(path || '').trim();
  if (!p) return '';
  if (/^https?:\/\//i.test(p)) return p;
  return `${origin}${p.startsWith('/') ? '' : '/'}${p}`;
}

/**
 * 列作业页里的 task 链接。
 * 只认带 type=work 且带 taskrefId 的 mtaskmsgspecial 链接——那是「作业」入口，
 * 考试/讨论用的是同域不同参数，混进来会抓错东西。
 */
export function parseTaskLinks(html) {
  const text = String(html ?? '');
  const out = [];
  const seen = new Set();
  const re = /https?:\/\/[^\s"'<>\\]+/g;
  let m;
  while ((m = re.exec(text))) {
    const url = m[0].replace(/&amp;/g, '&').replace(/[),.;]+$/, '');
    if (!url.includes('mtaskmsgspecial')) continue;
    if (!/[?&]type=work(&|$)/.test(url)) continue;
    if (!url.includes('taskrefId=')) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    // 作业名在链接**后面**：<li ... data="URL"><span/><div><p>作业名</p><span class="status">未提交</span>
    const block = liBlockAfter(text, m.index + m[0].length);
    const title = firstText(block, 'p') || nearbyText(text, m.index);
    const statusText = attrText(block, 'span', 'status');
    out.push({
      url,
      ...describeTaskUrl(url),
      title,
      status: statusText,
      submitted: /已提交|已完成|已批阅/.test(statusText),
      hint: title,
    });
  }
  return out;
}

/** 从 index 起，截到最近的 `</li>`（最长 maxLen）——作业列表里一条记录的范围。 */
export function liBlockAfter(text, index, maxLen = 1600) {
  const tail = String(text).slice(index, index + maxLen);
  const end = tail.search(/<\/li>/i);
  return end >= 0 ? tail.slice(0, end) : tail;
}

/** 取块里第一个 <tag ...>文字</tag> 的纯文本。 */
export function firstText(block, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
  const m = re.exec(String(block ?? ''));
  if (!m) return '';
  return htmlToText(m[1]).replace(/\s+/g, ' ').trim().slice(0, 120);
}

/** 取 class 命中 cls 的 <tag> 里的纯文本。 */
export function attrText(block, tag, cls) {
  const re = new RegExp(`<${tag}[^>]*class="[^"]*${cls}[^"]*"[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
  const m = re.exec(String(block ?? ''));
  if (!m) return '';
  return htmlToText(m[1]).replace(/\s+/g, ' ').trim().slice(0, 40);
}

/** 从一个 task 链接里解出可读参数（courseId / clazzid / taskrefId 等）。 */
export function describeTaskUrl(url) {
  let query = {};
  try {
    const u = new URL(url);
    query = Object.fromEntries(u.searchParams.entries());
  } catch {
    const q = String(url).split('?')[1] || '';
    for (const kv of q.split('&')) {
      const [k, v] = kv.split('=');
      if (k) query[k] = decodeURIComponent(v ?? '');
    }
  }
  const pick = (...keys) => {
    for (const key of keys) if (query[key]) return query[key];
    return '';
  };
  return {
    taskrefId: pick('taskrefId', 'taskRefId'),
    courseId: pick('courseid', 'courseId'),
    classId: pick('clazzid', 'classId', 'clazzId'),
    workId: pick('workid', 'workId', 'jobid', 'jobId'),
    type: pick('type'),
  };
}

/** 取链接前面一小段可读文字，当作业名用。 */
export function nearbyText(text, index, window = 600) {
  const start = Math.max(0, index - window);
  const slice = String(text).slice(start, index);
  // 截断处常常落在一个没闭合的标签里（<li … data="），htmlToText 去不掉，先手动切掉。
  const plain = htmlToText(slice.replace(/<[^>]*$/, ''));
  const lines = plain.split('\n').map((s) => s.trim()).filter(Boolean);
  const last = lines[lines.length - 1] ?? '';
  return last.replace(/^[-·\s"'>]+/, '').replace(/[<"]+$/, '').trim().slice(0, 80);
}

/**
 * 解析「一页一题」的作业页。
 *
 * 返回值里 answersKind 是从**表单控件**推出来的，不是靠题型编号猜：
 *   radio        → 单选（value 是 true/false 时判为判断）
 *   checkbox     → 多选
 *   textarea     → 填空（多个 textarea 就是多空）/ 简答（题干里没有"空"的提示）
 */
export function parseQuestionPage(html) {
  const text = String(html ?? '');
  const fields = extractHiddenFields(text);
  const qidMatch = text.match(/id\s*=\s*["']questionId["'][^>]*value\s*=\s*["'](\d+)["']/i);
  const qid = qidMatch ? qidMatch[1] : '';
  const type = qid && fields[`type${qid}`] != null ? String(fields[`type${qid}`]) : '';
  const score = qid && fields[`score${qid}`] != null ? String(fields[`score${qid}`]) : '';

  const controls = qid ? extractAnswerControls(text, qid) : { radios: [], checkboxes: [], textareas: [], hidden: [] };
  // 手机端作业页的选项不是 radio/checkbox，而是 div.Answer 里的 span[orichoice]，
  // 所以先看这种结构；老结构（真 radio）继续兜底，测试用例走的是那条路。
  const mobile = qid ? parseMobileChoices(text, qid) : [];
  let kind;
  let options = [];
  if (mobile.length) {
    options = mobile.map((o) => ({ value: o.value, label: o.label, checked: o.checked }));
    const typeNum = String(type);
    if (typeNum === '1') kind = 'multiple';
    else if (typeNum === '3') kind = 'judge';
    else if (typeNum === '2') kind = 'blank';
    else kind = 'single';
  } else {
    kind = classifyKind(controls);
    options = buildOptions(text, controls);
  }
  // 简答/名词解释/论述/计算题在页面上也是「一个输入框」，
  // 光看控件会误判成填空——按题型编号纠正（答案要求和填空完全不同）。
  if (['4', '5', '6', '7'].includes(String(type))) kind = 'text';
  if (String(type) === '2' && !mobile.length) {
    kind = (controls.hidden?.length ?? 0) > 1 || controls.textareas.length > 1 ? 'blanks' : 'blank';
  }
  const stem = extractStem(text);

  return {
    questionId: qid,
    type,
    typeName: TYPE_NAMES[type] ?? '',
    score,
    kind,
    stem,
    options,
    text: stem,
    blanks: controls.textareas.length,
    fields,
  };
}

/** 抽出名字是 answer{qid} 的所有表单控件。 */
export function extractAnswerControls(html, qid) {
  const text = String(html ?? '');
  const name = `answer${qid}`;
  const radios = [];
  const checkboxes = [];
  const textareas = [];
  const hidden = [];

  const inputRe = /<input\b[^>]*>/gi;
  let m;
  while ((m = inputRe.exec(text))) {
    const tag = m[0];
    if (attrOf(tag, 'name') !== name) continue;
    const type = String(attrOf(tag, 'type') || '').toLowerCase();
    const value = attrOf(tag, 'value') ?? '';
    if (type === 'radio') radios.push({ value, at: m.index });
    else if (type === 'checkbox') checkboxes.push({ value, at: m.index });
    else if (type === 'hidden') hidden.push({ value, at: m.index, id: attrOf(tag, 'id') || '' });
  }

  const taRe = /<textarea\b[^>]*>/gi;
  while ((m = taRe.exec(text))) {
    const tag = m[0];
    if (attrOf(tag, 'name') !== name) continue;
    textareas.push({ value: '', at: m.index });
  }

  return { radios, checkboxes, textareas, hidden };
}

/**
 * 手机端作业页的选项：`<span data="answer{qid}" class="choose check" orichoice="B">B</span>`
 * 后面紧跟 `<div class="centerSpan workWrap">选项文字</div>`。
 *
 * 注意：span 里显示的字母和 orichoice **不一定一致**（页面会打乱），
 * 提交值必须用 orichoice，选项文字取 centerSpan。
 */
export function parseMobileChoices(html, qid = '') {
  const text = String(html ?? '');
  const out = [];
  const re = /<span\b[^>]*\borichoice\s*=\s*["']([^"']*)["'][^>]*>/gi;
  let m;
  while ((m = re.exec(text))) {
    const tag = m[0];
    const cls = attrOf(tag, 'class') || '';
    const data = attrOf(tag, 'data') || '';
    if (qid && data && data !== `answer${qid}`) continue;
    if (!/choose|check/i.test(cls) && !/^answer\d+$/.test(data)) continue;
    const after = text.slice(m.index + tag.length, m.index + tag.length + 1200);
    const lab = /<div\b[^>]*class="[^"]*centerSpan[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(after);
    const aria = attrOf(tag, 'aria-label') || '';
    const label = lab ? htmlToText(lab[1]).replace(/\s+/g, ' ').trim() : aria.replace(/^选项\s*[A-Za-z0-9]+[.．、]?/, '');
    out.push({
      value: decodeEntities(m[1]).trim(),
      label: label.slice(0, 200),
      checked: /\bchecked\b/i.test(cls),
    });
  }
  return out;
}

/** 表单控件 → 题型大类。 */
export function classifyKind({ radios, checkboxes, textareas }) {
  if (checkboxes.length) return 'multiple';
  if (radios.length) {
    const values = radios.map((r) => String(r.value).toLowerCase());
    if (values.length === 2 && values.every((v) => v === 'true' || v === 'false')) return 'judge';
    if (values.sort().join(',') === 'false,true') return 'judge';
    return 'single';
  }
  if (textareas.length > 1) return 'blanks';
  if (textareas.length === 1) return 'blank';
  return 'unknown';
}

/** 从控件位置后面取选项文字，拼成 {value, label} 列表。 */
export function buildOptions(html, controls) {
  const text = String(html ?? '');
  const nodes = [...(controls.radios || []), ...(controls.checkboxes || [])].sort((a, b) => a.at - b.at);
  const out = [];
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i];
    const end = i + 1 < nodes.length ? nodes[i + 1].at : Math.min(text.length, node.at + 600);
    const chunk = text.slice(node.at, end);
    const plain = htmlToText(chunk)
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .join(' ')
      .slice(0, 200);
    out.push({ value: node.value, label: plain });
  }
  return out;
}

/** 抓题干。优先 ans-cc timuStyle 容器，退而求其次抓 questionLi 之后到第一个控件之前的文字。 */
export function extractStem(html) {
  const text = String(html ?? '');
  const block = text.match(/<div[^>]*class\s*=\s*["'][^"']*timuStyle[^"']*["'][^>]*>([\s\S]*?)<\/div>\s*(?:<div|<ul|<input)/i);
  if (block) {
    const plain = htmlToText(block[1]);
    if (plain) return plain.slice(0, 4000);
  }
  const alt = text.match(/<div[^>]*class\s*=\s*["'][^"']*questionLi[^"']*["'][^>]*>([\s\S]*?)<input/i);
  if (alt) {
    const plain = htmlToText(alt[1]);
    if (plain) return plain.slice(0, 4000);
  }
  const plain = htmlToText(text);
  return plain.slice(0, 1500);
}

// ---------------------------------------------------------------------------
// 接口
// ---------------------------------------------------------------------------

/** 登录态是否还活着：能把「我的作业」页拉下来且不是登录页。 */
export async function checkLogin(cookies, opts = {}) {
  if (!cookies || !Object.keys(cookies).length) return { ok: false, reason: '没有 cookie' };
  try {
    const res = await request(cookies, STU_WORK_URL, { ...opts, timeoutMs: 20_000 });
    const html = String(res.text || '');
    if (!html.trim()) return { ok: false, reason: '作业页返回空内容（登录态可能已失效）' };
    if (/passport2\.chaoxing\.com/.test(html)) return { ok: false, reason: '被踢回登录页，登录态已失效' };
    // _uid 是登录后才有的；页面上出现它基本就说明登上了
    if (!cookies._uid && !cookies.UID) {
      const uid = html.match(/_uid["']?\s*[:=]\s*["']?(\d+)/);
      if (!uid && !/我的作业|待做|作业/.test(html)) {
        return { ok: false, reason: '页面里没有登录用户的痕迹' };
      }
    }
    return { ok: true, user: { uid: cookies._uid || cookies.UID || '', name: cookies._uname || cookies.name || '' } };
  } catch (error) {
    if (error.code === 'NEED_LOGIN') return { ok: false, reason: error.message };
    return { ok: false, reason: error.message };
  }
}

/** 列作业。 */
export async function listWorks(cookies, opts = {}) {
  const res = await request(cookies, STU_WORK_URL, opts);
  const links = parseTaskLinks(res.text);
  return links.map((link, index) => ({
    index: index + 1,
    taskUrl: link.url,
    title: link.title || link.hint || `作业 ${index + 1}`,
    status: link.status || '',
    submitted: Boolean(link.submitted),
    courseId: link.courseId,
    classId: link.classId,
    taskrefId: link.taskrefId,
  }));
}

/** task 链接 → doHomeWork 绝对地址。 */
export async function resolveWorkUrl(cookies, taskUrl, opts = {}) {
  const res = await request(cookies, taskUrl, opts);
  const path = findDoHomeWorkPath(res.text);
  if (!path) throw apiError('任务页里没找到 doHomeWork 入口（页面结构可能变了，或者这个任务不是作业）', 'NO_WORK_ENTRY');
  return absoluteWorkUrl(path);
}

/** 给 doHomeWork 地址加上 index / knowledgeid 参数。 */
export function withIndex(workUrl, index) {
  const u = new URL(workUrl);
  u.searchParams.set('index', String(index));
  // 带了 checkIntegrity=true 的链接，服务端会忽略 index（永远返回第 1 题），必须摘掉。
  u.searchParams.delete('checkIntegrity');
  if (!u.searchParams.has('knowledgeid') && !u.searchParams.has('knowledgeId')) {
    u.searchParams.set('knowledgeid', '0');
  }
  return u.toString();
}

/**
 * 抓整份作业的题目。
 * 一页一题，一直翻到 questionId 重复两次（不是立刻停：偶尔会有空页）。
 */
export async function fetchWork(cookies, workUrl, opts = {}) {
  const maxIndex = Number.isFinite(opts.maxIndex) ? opts.maxIndex : 40;
  const questions = [];
  const seen = new Set();
  const baseFields = {};
  let dupStreak = 0;
  let pages = 0;

  for (let index = 0; index < maxIndex; index += 1) {
    if (opts.signal?.aborted) break;
    const res = await request(cookies, withIndex(workUrl, index), opts);
    pages += 1;
    const q = parseQuestionPage(res.text);
    if (!q.questionId) {
      // 首页就没有题：要么交过了，要么这活根本不是作业
      if (index === 0) break;
      dupStreak += 1;
      if (dupStreak >= 2) break;
      continue;
    }
    Object.assign(baseFields, q.fields);
    if (seen.has(q.questionId)) {
      dupStreak += 1;
      if (dupStreak >= 2) break;
      continue;
    }
    dupStreak = 0;
    seen.add(q.questionId);
    questions.push({ index, ...q });
  }

  return { workUrl, questions, baseFields, pages };
}

/**
 * 交一份答案。
 * @param {object} opts
 * @param {Record<string,string>} opts.answers  questionId → 答案串
 */
export async function submitAnswers(cookies, workUrl, opts = {}) {
  const tempSave = opts.tempSave !== false;
  const answers = opts.answers || {};
  const pages = opts.pages || null;
  const results = {};

  // 拿到了整份作业的页面字段就直接用；没有就按需现抓
  let fieldOf = (qid) => (pages?.byQid?.[qid] ? pages.byQid[qid].fields : null);
  if (!pages?.byQid) fieldOf = () => null;

  for (const [qid, answer] of Object.entries(answers)) {
    if (opts.signal?.aborted) break;
    let fields = fieldOf(qid);
    if (!fields) {
      const found = await locateQuestionPage(cookies, workUrl, qid, opts);
      fields = found?.fields ?? null;
    }
    if (!fields) {
      results[qid] = { ok: false, reason: '找不到这道题的页面隐藏域' };
      continue;
    }
    const payload = { ...fields, tempSave: tempSave ? 'true' : 'false', [`answer${qid}`]: answer ?? '' };
    const res = await request(cookies, `${SUBMIT_URL}?tempSave=${tempSave ? 'true' : 'false'}`, {
      method: 'POST',
      form: payload,
      referer: workUrl,
      headers: { 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json,*/*' },
      signal: opts.signal,
      timeoutMs: opts.timeoutMs,
    });
    let json;
    try {
      json = JSON.parse(res.text);
    } catch {
      json = { raw: String(res.text || '').slice(0, 300) };
    }
    results[qid] = { ok: json.status === true, response: json };
    if (opts.sleepMs) await new Promise((r) => setTimeout(r, opts.sleepMs));
  }

  const failed = Object.entries(results).filter(([, v]) => !v.ok);
  return { ok: failed.length === 0, tempSave, results, failed: failed.map(([qid, v]) => ({ questionId: qid, reason: v.response?.msg || v.reason || '未知' })) };
}

/** 翻页找出某个 questionId 所在的页面（取它的隐藏域）。 */
export async function locateQuestionPage(cookies, workUrl, qid, opts = {}) {
  const maxIndex = Number.isFinite(opts.maxIndex) ? opts.maxIndex : 40;
  for (let index = 0; index < maxIndex; index += 1) {
    const res = await request(cookies, withIndex(workUrl, index), opts);
    const q = parseQuestionPage(res.text);
    if (!q.questionId) break;
    if (q.questionId === qid) return q;
  }
  return null;
}

/**
 * 回读一份作业当前存着的答案，用来验证「暂存是否真的写进去了」。
 * 页面上 answer 一般出现在 textarea 的正文或已选 radio 的 checked 上，两种都抓。
 */
export async function readSavedAnswers(cookies, workUrl, opts = {}) {
  const saved = {};
  const maxIndex = Number.isFinite(opts.maxIndex) ? opts.maxIndex : 40;
  for (let index = 0; index < maxIndex; index += 1) {
    const res = await request(cookies, withIndex(workUrl, index), opts);
    const html = String(res.text || '');
    const q = parseQuestionPage(html);
    if (!q.questionId) break;
    const name = `answer${q.questionId}`;
    const picked = [];
    // 手机端选项是 span[orichoice]，选中态靠 class 里的 checked，不是 input[checked]
    for (const c of parseMobileChoices(html, q.questionId)) {
      if (c.checked && c.value) picked.push(c.value);
    }
    let m;
    if (!picked.length) {
      for (const tag of scanTags(html, 'input')) {
        if (attrOf(tag, 'name') !== name) continue;
        if (attrOf(tag, 'type') === 'hidden') continue;
        const cls = attrOf(tag, 'class') || '';
        if (/\bchecked\b/i.test(tag) || /\bchecked\b/i.test(cls)) {
          const v = attrOf(tag, 'value');
          if (v) picked.push(v);
        }
      }
    }
    // 单选/多选还可能用 <a class="check_answer" data="A"> 这种不落在 input 上的标记
    if (!picked.length) {
      const dataRe = /class\s*=\s*["'][^"']*check_answer[^"']*["'][^>]*data\s*=\s*["']([^"']+)["']/gi;
      while ((m = dataRe.exec(html))) picked.push(m[1]);
    }
    let text = '';
    const texts = [];
    if (!picked.length) {
      // 多空填空是多个同名 textarea，逐个收，验证时按位置比
      const taRe = new RegExp(`<textarea\\b[^>]*name\\s*=\\s*["']${name}["'][^>]*>([\\s\\S]*?)</textarea>`, 'gi');
      let ta;
      while ((ta = taRe.exec(html))) texts.push(htmlToText(ta[1]).trim());
      text = texts.join('\n');
    }
    if (!picked.length && !text.trim()) {
      // 简答题：优先用隐藏域里真正会提交的 value，拿不到再退回编辑器的 aria-label
      const hidden = extractHiddenFields(html)[name] ?? '';
      text = hidden.trim() || readEditorText(html);
    }
    saved[q.questionId] = { picked, text: String(text).trim(), texts };
  }
  return { workUrl, saved };
}

/** 题型大类 → 给模型看的中文说明。 */
export const KIND_LABELS = {
  single: '单选题',
  multiple: '多选题',
  judge: '判断题',
  blank: '填空题',
  blanks: '填空题（多空）',
  text: '简答题',
  unknown: '未知题型',
};
