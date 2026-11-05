/**
 * lib/browser.mjs —— 浏览器会话层（Playwright + 系统 Edge）
 *
 * 设计要点（为什么这么做）：
 * 1) 用 `launchPersistentContext` 而不是 `launch`：登录态（cookies / localStorage）
 *    必须落在磁盘上的 profile 目录里，进程重启后才能复用，避免每次都手动扫码登录。
 * 2) 同一 profileDir 只允许存在一个浏览器实例。Chromium 对同一 user-data-dir 有进程锁，
 *    重复 launch 会直接失败；所以这里用 Map 做单例，并在复用前做一次"存活探测"，
 *    崩溃/被关掉的实例会被丢弃重建。
 * 3) 目标站点会检查 `navigator.webdriver` 之类的自动化痕迹。这里只做最小限度的处理
 *    （关掉 AutomationControlled 特性 + 覆写 navigator.webdriver），不做指纹伪造。
 * 4) 头歌的代码编辑器可能是 Monaco / CodeMirror 5 / CodeMirror 6 / 裸 textarea，
 *    且可能挂在 iframe 里，所以编辑器探测与写入都按"主 frame → 其它 frame"的顺序尝试。
 * 5) 所有对外函数都对 page 操作加了超时兜底，失败抛中文 message 的 Error，
 *    方便上层（index.js / MCP 工具）直接把错误原文展示给用户。
 *
 * 模块加载阶段不产生任何 IO、不启动浏览器：所有副作用都在函数调用时发生。
 */

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { chromium } from 'playwright-core';

/** 本机可用的浏览器：只有系统 Edge，Chrome 未安装。 */
export const DEFAULT_EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const DEFAULT_VIEWPORT = { width: 1440, height: 900 };
const DEFAULT_TIMEOUT_MS = 30000;

/** 插件状态根目录：~/.dsh/educoder-auto */
const STATE_ROOT = path.join(os.homedir(), '.dsh', 'educoder-auto');

/** profileDir(绝对路径) -> session。同一 profile 只允许一个实例。 */
const sessions = new Map();
/**
 * profileDir -> 正在启动中的 Promise。
 * 为什么需要：两个并发调用同时发现"还没有会话"会各自 launch 一次，
 * 第二个必然撞上 Chromium 的 user-data-dir 锁。这里把并发的启动请求合并成一次。
 */
const launching = new Map();

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 递归建目录（同步版：openBrowser / screenshot 里都要立刻用到）。 */
function ensureDirSync(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    throw new Error(`创建目录失败：${dir} — ${firstLine(err && err.message)}`);
  }
}

/** 只取错误信息第一行，避免把 Playwright 的长堆栈糊到用户脸上。 */
function firstLine(msg) {
  return String(msg == null ? '' : msg).split('\n')[0].trim();
}

/** 超时值归一：非法/缺省一律 30s。 */
function clampTimeout(value) {
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  return DEFAULT_TIMEOUT_MS;
}

/** 给任意 promise 套一个硬超时，防止 evaluate 之类没有 timeout 参数的操作卡死。 */
function withTimeout(promise, ms, message = '操作超时') {
  let timer = null;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, guard]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** 截图文件名用本地时间，方便人工在 shots 目录里翻。 */
function shotStamp(d = new Date()) {
  const p = (n, len = 2) => String(n).padStart(len, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`
  );
}

/** profileDir 归一：没传就用默认目录，传了就按 cwd 解析成绝对路径。 */
function resolveProfileDir(input) {
  if (input && typeof input === 'string') return path.resolve(input);
  return path.join(STATE_ROOT, 'browser-profile');
}

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

/**
 * 存活探测。
 * 说明：Playwright 的 BrowserContext 在部分版本没有 isConnected()，所以按可选链调用，
 * 再用一次极轻量的 page.evaluate 兜底 —— 这是唯一可靠的"上下文还能不能用"的证据。
 */
async function probeAlive(session) {
  if (!session || session.closed) return false;
  const ctx = session.context;
  if (!ctx) return false;
  if (typeof ctx.isConnected === 'function' && !ctx.isConnected()) return false;
  const browser = typeof ctx.browser === 'function' ? ctx.browser() : null;
  if (browser && typeof browser.isConnected === 'function' && !browser.isConnected()) return false;

  const page = session.page;
  if (!page || page.isClosed()) {
    // 页面没了但上下文还在：补一张新页面即可，不必重建整个浏览器。
    try {
      session.page = await ctx.newPage();
      return true;
    } catch {
      return false;
    }
  }
  try {
    await withTimeout(page.evaluate(() => true), 3000, '页面无响应');
    return true;
  } catch {
    // evaluate 失败：页面可能崩了，但 context 可能仍可用。
    try {
      session.page = await ctx.newPage();
      return true;
    } catch {
      return false;
    }
  }
}

/** 关闭并注销一个会话（幂等）。 */
async function destroySession(session) {
  if (!session) return;
  const first = !session.closed;
  session.closed = true;
  if (sessions.get(session.profileDir) === session) sessions.delete(session.profileDir);
  if (first) {
    try {
      await session.context?.close();
    } catch {
      /* 已经关掉的上下文再关一次会抛错，忽略即可 */
    }
  }
}

/**
 * 打开（或复用）浏览器。
 * @param {{headless?: boolean, profileDir?: string, executablePath?: string, viewport?: {width:number,height:number}, timeoutMs?: number}} opts
 * @returns {Promise<{context: any, page: any, profileDir: string, close: () => Promise<void>}>}
 */
export async function openBrowser(opts = {}) {
  const profileDir = resolveProfileDir(opts.profileDir);
  const timeout = clampTimeout(opts.timeoutMs);

  const existing = sessions.get(profileDir);
  if (existing) {
    if (await probeAlive(existing)) return existing;
    // 已崩溃 / 被外部关闭：先彻底清掉再重建，否则 user-data-dir 会被锁住。
    await destroySession(existing);
  }

  // 同一个 profile 的并发启动请求合并：否则第二个会撞上 Chromium 的目录锁。
  const inflight = launching.get(profileDir);
  if (inflight) return inflight;

  const task = launchSession(profileDir, timeout, opts).finally(() => {
    launching.delete(profileDir);
  });
  launching.set(profileDir, task);
  return task;
}

/**
 * 真正执行 launch 的那一段（openBrowser 的内部实现）。
 * @returns {Promise<object>} session
 */
async function launchSession(profileDir, timeout, opts) {
  const executablePath = opts.executablePath || DEFAULT_EDGE;
  if (!fs.existsSync(executablePath)) {
    throw new Error(
      `找不到浏览器可执行文件：${executablePath}（请安装 Microsoft Edge，或用 opts.executablePath 指定）`
    );
  }
  ensureDirSync(profileDir);

  let context;
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      executablePath,
      headless: opts.headless !== false,
      viewport: opts.viewport || DEFAULT_VIEWPORT,
      // 反自动化痕迹 + 后台不降频（headless 下窗口不可见，Chromium 会把
      // 定时器和渲染降频，导致 SPA 迟迟不渲染、Monaco 加载不出来）。
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-features=CalculateNativeWinOcclusion',
      ],
      timeout,
    });
  } catch (err) {
    const msg = firstLine(err && err.message);
    if (/ProcessSingleton|already in use|user data directory is already in use/i.test(msg)) {
      throw new Error(`启动浏览器失败：profile 目录已被占用（${profileDir}），请先关闭残留的 Edge 进程`);
    }
    throw new Error(`启动浏览器失败：${msg}`);
  }

  // 把 navigator.webdriver 定义成 false（在页面任何脚本执行之前注入）。
  try {
    await context.addInitScript(() => {
      try {
        Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true });
      } catch {
        /* 个别环境下 navigator 被冻结，忽略 */
      }
    });
  } catch {
    /* addInitScript 失败不致命，继续 */
  }

  context.setDefaultTimeout(timeout);
  context.setDefaultNavigationTimeout(timeout);

  let page;
  try {
    page = context.pages()[0] || (await context.newPage());
  } catch (err) {
    try {
      await context.close();
    } catch {}
    throw new Error(`启动浏览器失败：无法创建页面 — ${firstLine(err && err.message)}`);
  }

  const session = {
    context,
    page,
    profileDir,
    executablePath,
    createdAt: Date.now(),
    closed: false,
    /** 关闭自己（幂等）。 */
    async close() {
      await destroySession(session);
    },
  };

  // 浏览器被外部关掉时（用户手动关窗口 / 崩溃），同步清掉单例，避免下次复用一个死会话。
  context.once('close', () => {
    session.closed = true;
    if (sessions.get(profileDir) === session) sessions.delete(profileDir);
  });

  sessions.set(profileDir, session);
  return session;
}

/** 关闭所有单例浏览器；可重复调用。返回实际关闭的数量。 */
export async function closeBrowser() {
  // 还在启动中的也一并等掉，否则它会在关闭之后"复活"出一个新会话。
  const pending = [...launching.values()];
  for (const p of pending) await p.catch(() => {});

  const all = [...sessions.values()];
  for (const session of all) await destroySession(session);
  sessions.clear();
  launching.clear();
  return { closed: all.length };
}

/** 当前是否有一个可用（未崩溃）的浏览器。 */
export async function browserStatus() {
  let live = null;
  for (const session of [...sessions.values()]) {
    if (await probeAlive(session)) live = session;
    else await destroySession(session);
  }
  if (!live) return { open: false };
  return { open: true, profileDir: live.profileDir };
}

/**
 * 每次页面操作前调用：确认会话活着，并把已关闭的 page 换掉。
 * @returns {Promise<any>} 可用的 page
 */
async function ensureReady(session) {
  if (!session || !session.context) throw new Error('浏览器未打开：请先调用 openBrowser()');
  if (session.closed) throw new Error('页面已关闭：浏览器会话已关闭，请重新调用 openBrowser()');
  if (!(await probeAlive(session))) {
    throw new Error('页面已关闭：浏览器连接已断开，请重新调用 openBrowser()');
  }
  if (!session.page || session.page.isClosed()) {
    session.page = await session.context.newPage();
  }
  return session.page;
}

// ---------------------------------------------------------------------------
// 页面动作
// ---------------------------------------------------------------------------

/**
 * 等页面"看起来渲染完了"。
 * 为什么需要：头歌这类 React SPA 在 load 之后还会异步拉数据渲染，若立刻截图/取快照，
 * 会得到一张白图或空文本（实测 load 后约 0.6~1s 才有正文）。
 * 判定标准是"正文长度连续两次采样相同且足够长"，比固定 sleep 快，也比 networkidle 稳
 * （站上有长连接/轮询，networkidle 可能永远不满足）。
 *
 * 为什么还要 SOFT_FLOOR_MS：页面骨架期正文可能只有「登录 / 注册」几个字，
 * 若只按"长度稳定"判定会在 200ms 就提前收工。所以短文本再多等一会儿，
 * 长文本（>= MIN_CHARS）才允许立刻收工。失败不抛错，只返回 false。
 */
async function waitForSettle(page, budgetMs = 8000) {
  const start = Date.now();
  const deadline = start + budgetMs;
  const MIN_CHARS = 100;
  const SOFT_FLOOR_MS = 1200; // 短文本至少要等这么久，避免骨架期就收工
  const HARD_CAP_MS = 3000; // 页面有计时器/滚动文字时长度永不相等，别死等到 budgetMs
  let prevLen = -1;
  while (Date.now() < deadline) {
    let len = -1;
    try {
      len = await withTimeout(
        page.evaluate(() => {
          if (document.readyState === 'loading') return -1;
          const body = document.body;
          if (!body) return -1;
          return (body.innerText || '').trim().length;
        }),
        3000,
        '等待渲染超时'
      );
    } catch {
      return false; // 页面没了就别等了
    }

    if (typeof len === 'number' && len > 0) {
      if (len === prevLen) {
        if (len >= MIN_CHARS) return true;
        if (Date.now() - start >= SOFT_FLOOR_MS) return true;
      }
      if (Date.now() - start >= HARD_CAP_MS) return true;
    }
    prevLen = typeof len === 'number' ? len : prevLen;

    try {
      await page.waitForTimeout(120);
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * 导航到指定 URL。
 * @returns {Promise<{url: string, title: string, status: number|null}>}
 */
export async function goto(session, url, opts = {}) {
  if (!url || typeof url !== 'string') throw new Error('goto 需要合法的 url 字符串');
  const page = await ensureReady(session);
  const timeout = clampTimeout(opts.timeoutMs);

  let response = null;
  try {
    response = await page.goto(url, {
      waitUntil: opts.waitUntil || 'domcontentloaded',
      timeout,
    });
  } catch (err) {
    const msg = String((err && err.message) || err);
    if (/timeout/i.test(msg)) throw new Error(`导航超时：${url}（${timeout}ms）`);
    if (/closed|Target closed|Connection closed/i.test(msg)) {
      throw new Error(`页面已关闭：导航过程中浏览器被关闭（${url}）`);
    }
    throw new Error(`导航失败：${url} — ${firstLine(msg)}`);
  }

  // 头歌是 React SPA：domcontentloaded 时页面往往还是个 loading 骨架，
  // 直接截图/取快照会拿到空白或原始脚本。这里再等一个 load 状态（限时、失败不致命），
  // 然后做一次有上限的渲染等待，让调用方拿到"看得见东西"的页面。
  await page
    .waitForLoadState('load', { timeout: Math.min(timeout, 15000) })
    .catch(() => {});
  await waitForSettle(page, Math.min(timeout, opts.settleMs ?? 8000));

  const title = await page.title().catch(() => '');
  return { url: page.url(), title, status: response ? response.status() : null };
}

/**
 * 截图。默认落到 ~/.dsh/educoder-auto/shots/shot-<时间戳>.png。
 * @returns {Promise<{path: string, bytes: number}>}
 */
export async function screenshot(session, opts = {}) {
  const page = await ensureReady(session);
  const timeout = clampTimeout(opts.timeoutMs);

  const target = opts.path
    ? path.resolve(String(opts.path))
    : path.join(STATE_ROOT, 'shots', `shot-${shotStamp()}.png`);
  ensureDirSync(path.dirname(target));

  try {
    await page.screenshot({ path: target, fullPage: !!opts.fullPage, timeout });
  } catch (err) {
    const msg = String((err && err.message) || err);
    if (/closed|Target closed/i.test(msg)) throw new Error('页面已关闭：截图时浏览器被关闭');
    if (/timeout/i.test(msg)) throw new Error(`截图超时：${target}`);
    throw new Error(`截图失败：${firstLine(msg)}`);
  }

  let bytes = 0;
  try {
    bytes = fs.statSync(target).size;
  } catch {
    throw new Error(`截图失败：文件未生成（${target}）`);
  }
  return { path: target, bytes };
}

/** 把 origin 列表归一成字符串数组。 */
function normalizeOrigins(origins) {
  if (!origins) return [];
  const list = Array.isArray(origins) ? origins : [origins];
  return list.map((o) => String(o)).filter(Boolean);
}

/** 从 origin 里取 hostname，非法 URL 返回 null。 */
function hostOf(origin) {
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** 判断一条 cookie 是否属于给定 origins（domain 后缀匹配，兼容 .educoder.net 这种写法）。 */
function cookieMatchesOrigin(cookie, origins) {
  if (!origins.length) return true;
  const domain = String(cookie.domain || '')
    .replace(/^\./, '')
    .toLowerCase();
  if (!domain) return false;
  return origins.some((o) => {
    const host = hostOf(o);
    if (!host) return false;
    return host === domain || host.endsWith('.' + domain) || domain.endsWith('.' + host);
  });
}

/**
 * 采集 cookie（name -> value）。
 * httpOnly 的 cookie 在 document.cookie 里看不到，但 CDP 的 Storage.getCookies 拿得到，
 * 所以这里以 Playwright context.cookies() 为底，再用 CDP 全量补一遍（后者覆盖前者）。
 * @returns {Promise<Record<string, string>>}
 */
export async function harvestCookies(session, origins) {
  const page = await ensureReady(session);
  const list = normalizeOrigins(origins);
  const out = Object.create(null);

  // 1) Playwright 层（本身就是走 CDP，包含 httpOnly）
  try {
    const cookies = await session.context.cookies(list.length ? list : undefined);
    for (const c of cookies) if (c && c.name) out[c.name] = c.value;
  } catch {
    /* 某些 origin 非法会抛错，交给 CDP 兜底 */
  }

  // 2) CDP 层全量补全（按 domain 过滤到给定 origins）
  try {
    const cdp = await session.context.newCDPSession(page);
    try {
      const res = await cdp.send('Storage.getCookies', {});
      for (const c of res?.cookies || []) {
        if (!c || !c.name) continue;
        if (!cookieMatchesOrigin(c, list)) continue;
        out[c.name] = c.value;
      }
    } finally {
      await cdp.detach().catch(() => {});
    }
  } catch {
    /* CDP 不可用时，第 1 步的结果已经够用 */
  }

  return { ...out };
}

// ---------------------------------------------------------------------------
// 页面内探测函数（会通过 evaluate 注入，必须自包含、不能引用模块作用域）
// ---------------------------------------------------------------------------

/**
 * 采集基础页面信息：url/title/text/iframes/buttons/links。
 *
 * 注意：本函数会被 page.evaluate 序列化后注入页面执行，因此**必须完全自包含**——
 * 不能引用模块作用域里的任何变量或函数（那样在页面里会是 ReferenceError，
 * 而外面又套着 try/catch，症状是"字段静默变成空值"，极难排查）。
 */
function collectSnapshot(maxChars) {
  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const out = { url: location.href, title: document.title || '', text: '', iframes: [], buttons: [], links: [] };

  // 正文：优先 innerText。为什么不能直接 `innerText || textContent`：
  // SPA 刚 domcontentloaded 时 innerText 还是空串，`'' || textContent` 会掉进
  // textContent —— 那里面含 <script> 源码，快照就会变成一堆 JS。
  // 所以 innerText 为空时用"剔除 script/style 的克隆"再取文本。
  try {
    const body = document.body;
    let text = '';
    if (body) {
      text = body.innerText || '';
      if (!text.trim()) {
        try {
          const clone = body.cloneNode(true);
          clone
            .querySelectorAll('script,style,noscript,template,svg,link,meta')
            .forEach((n) => n.remove());
          text = clone.textContent || '';
        } catch {
          text = body.innerText || '';
        }
      }
    }
    out.text = text.length > maxChars ? text.slice(0, maxChars) : text;
  } catch {}

  try {
    out.iframes = [...document.querySelectorAll('iframe')]
      .map((f) => f.src || '')
      .filter(Boolean);
  } catch {}

  // 按钮：只要"有文本"的，空文本按钮上层没法按文字点，属于噪音
  try {
    const BTN_SEL =
      'button, input[type="button"], input[type="submit"], input[type="reset"], [role="button"], a.btn, .btn';
    const seen = new Set();
    for (const el of document.querySelectorAll(BTN_SEL)) {
      if (out.buttons.length >= 60) break;
      const tag = el.tagName.toLowerCase();
      const text = norm(
        el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title')
      ).slice(0, 40);
      if (!text) continue;
      const key = tag + '|' + text;
      if (seen.has(key)) continue;
      seen.add(key);
      out.buttons.push({
        text,
        tag,
        disabled: !!(el.disabled || el.getAttribute('aria-disabled') === 'true'),
      });
    }
  } catch {}

  try {
    const seen = new Set();
    for (const a of document.querySelectorAll('a[href]')) {
      if (out.links.length >= 80) break;
      const href = String(a.href || '').slice(0, 200);
      const text = norm(a.innerText || a.textContent || a.getAttribute('title') || '');
      if (!href) continue;
      const key = href + '|' + text;
      if (seen.has(key)) continue;
      seen.add(key);
      out.links.push({ text, href });
    }
  } catch {}

  return out;
}

/**
 * 探测编辑器（只返回当前 document 内的）。
 * 顺序：Monaco → CodeMirror 5 → CodeMirror 6 → textarea（取可见的、value 最长的那个）。
 */
function probeEditors() {
  const result = [];
  const push = (value, language, source) => {
    result.push({
      value: typeof value === 'string' ? value : String(value == null ? '' : value),
      language: language || '',
      source,
    });
  };

  // 1) Monaco：全局 monaco 上的 model 才是真身，DOM 里的 textarea 只是输入代理。
  //    头歌把命名空间挂在 window.Monaco（大写 M），官方 monaco 挂 window.monaco，
  //    两个都要认 —— 只认小写的话会退到 textarea，读到的是代理框的残片。
  for (const ns of [window.monaco, window.Monaco]) {
    try {
      const models = ns && ns.editor && ns.editor.getModels ? ns.editor.getModels() : null;
      if (models && models.length) {
        for (const m of models) {
          push(
            m.getValue(),
            (typeof m.getLanguageId === 'function' && m.getLanguageId()) || m.getModeId?.() || '',
            'monaco'
          );
        }
        return result;
      }
    } catch {}
  }

  // 2) CodeMirror 5：实例挂在 .CodeMirror 元素的 CodeMirror 属性上
  try {
    const els = [...document.querySelectorAll('.CodeMirror')].filter(
      (el) => el && el.CodeMirror && typeof el.CodeMirror.getValue === 'function'
    );
    if (els.length) {
      for (const el of els) {
        const inst = el.CodeMirror;
        const mode = inst.getMode ? inst.getMode() : null;
        push(inst.getValue(), (mode && mode.name) || '', 'codemirror5');
      }
      return result;
    }
  } catch {}

  // 3) CodeMirror 6：view 挂在 .cm-editor 的 cmView 上
  try {
    const els = [...document.querySelectorAll('.cm-editor')].filter(
      (el) => el.cmView && el.cmView.view && el.cmView.view.state && el.cmView.view.state.doc
    );
    if (els.length) {
      for (const el of els) {
        push(el.cmView.view.state.doc.toString(), '', 'codemirror6');
      }
      return result;
    }
  } catch {}

  // 4) 兜底 textarea：可见的、value 最长的那个
  try {
    const tas = [...document.querySelectorAll('textarea')].filter((t) => {
      const r = t.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const st = getComputedStyle(t);
      return st.visibility !== 'hidden' && st.display !== 'none';
    });
    if (tas.length) {
      tas.sort((a, b) => String(b.value || '').length - String(a.value || '').length);
      const t = tas[0];
      push(t.value, t.getAttribute('data-language') || t.getAttribute('lang') || '', 'textarea');
    }
  } catch {}

  return result;
}

/** 判断当前 document 里有什么编辑器（用于 fillEditor 选帧/选方法）。 */
function detectEditorKind() {
  // 头歌把 monaco 挂在 window.Monaco（大写 M），不是标准的 window.monaco。
  // 官方 monaco 挂在 window.monaco，两种都要认。
  for (const ns of [window.monaco, window.Monaco]) {
    try {
      const models = ns && ns.editor && ns.editor.getModels ? ns.editor.getModels() : null;
      if (models && models.length) return { kind: 'monaco', count: models.length };
    } catch {}
  }
  try {
    const els = [...document.querySelectorAll('.CodeMirror')].filter(
      (el) => el && el.CodeMirror && typeof el.CodeMirror.setValue === 'function'
    );
    if (els.length) return { kind: 'codemirror5', count: els.length };
  } catch {}
  try {
    const els = [...document.querySelectorAll('.cm-editor')].filter(
      (el) => el.cmView && el.cmView.view && el.cmView.view.state && el.cmView.view.state.doc
    );
    if (els.length) return { kind: 'codemirror6', count: els.length };
  } catch {}
  try {
    const tas = [...document.querySelectorAll('textarea')].filter((t) => {
      const r = t.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const st = getComputedStyle(t);
      return st.visibility !== 'hidden' && st.display !== 'none';
    });
    if (tas.length) return { kind: 'textarea', count: 1 };
  } catch {}
  return { kind: null, count: 0 };
}

/** 按 index 写入 Monaco / CM5 / CM6（textarea 走 Playwright 的 fill）。 */
function applyEditorValue(payload) {
  const { index, code } = payload;

  // 1) Monaco —— 先找 window.monaco，再找 window.Monaco（头歌用的是后者）
  for (const ns of [window.monaco, window.Monaco]) {
    try {
      const models = ns && ns.editor && ns.editor.getModels ? ns.editor.getModels() : null;
      if (models && models.length) {
        const m = models[index] || models[0];
        m.setValue(code); // setValue 会自己触发 onDidChangeModelContent，框架能感知
        return { ok: true, method: 'monaco', count: models.length, verified: m.getValue() === code };
      }
    } catch {}
  }

  // 2) CodeMirror 5
  try {
    const els = [...document.querySelectorAll('.CodeMirror')].filter(
      (el) => el && el.CodeMirror && typeof el.CodeMirror.setValue === 'function'
    );
    if (els.length) {
      const cm = (els[index] || els[0]).CodeMirror;
      cm.setValue(code);
      return { ok: true, method: 'codemirror5', count: els.length, verified: cm.getValue() === code };
    }
  } catch {}

  // 3) CodeMirror 6
  try {
    const els = [...document.querySelectorAll('.cm-editor')].filter(
      (el) => el.cmView && el.cmView.view && el.cmView.view.state && el.cmView.view.state.doc
    );
    if (els.length) {
      const view = (els[index] || els[0]).cmView.view;
      const doc = view.state.doc;
      view.dispatch({ changes: { from: 0, to: doc.length, insert: code } });
      return { ok: true, method: 'codemirror6', count: els.length, verified: view.state.doc.toString() === code };
    }
  } catch {}

  return { ok: false, method: null, count: 0 };
}

/** 挑出可见的、value 最长的 textarea（给 Playwright fill 用）。 */
function pickTextarea() {
  const tas = [...document.querySelectorAll('textarea')].filter((t) => {
    const r = t.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const st = getComputedStyle(t);
    return st.visibility !== 'hidden' && st.display !== 'none';
  });
  if (!tas.length) return null;
  tas.sort((a, b) => String(b.value || '').length - String(a.value || '').length);
  return tas[0];
}

/** 在当前 document 里找"文字匹配、可见、可点"的最深层元素。 */
function findClickable(payload) {
  const { text, exact, scope, regex } = payload;
  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const wanted = norm(text);
  if (!wanted && !regex) return null;
  const re = regex ? new RegExp(regex.source, regex.flags) : null;

  const SEL =
    'button, a, [role="button"], input[type="submit"], input[type="button"], label, li, span, div, td, th, h1, h2, h3, h4, p, strong, b';
  let nodes;
  try {
    nodes = scope ? [...document.querySelectorAll(scope)] : [...document.querySelectorAll(SEL)];
  } catch {
    return null;
  }

  // 真正可点的元素优先：头歌的「评测」按钮是 `<button class="btn-run"><b>评测</b></button>`，
  // 里面那个 <b> 只是图标容器，点它不会触发任何事。所以给 BUTTON/A 更高优先级，
  // 只有当找不到按钮时才退到 span/div/b 之类。
  const rank = (el) => {
    const tag = el.tagName;
    if (tag === 'BUTTON' || tag === 'INPUT') return 0;
    if (tag === 'A' || el.getAttribute('role') === 'button') return 1;
    if (el.onclick || el.hasAttribute('onclick')) return 2;
    if (tag === 'LABEL' || tag === 'LI') return 3;
    return 9;
  };

  let best = null;
  for (const el of nodes) {
    const raw = el.tagName === 'INPUT' ? el.value || '' : el.innerText || el.textContent || '';
    const t = norm(raw);
    if (!t) continue;
    const hit = re ? re.test(t) : exact ? t === wanted : t.indexOf(wanted) !== -1;
    if (!hit) continue;
    if (el.disabled) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    const st = getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none' || st.pointerEvents === 'none') continue;
    if (st.opacity === '0') continue;
    // 排序：先看是不是真按钮，再看精确命中，最后取面积最小的（最深的那个可点元素）
    const score =
      rank(el) * 1e15 + (exact && t === wanted ? 0 : 1e12) + r.width * r.height;
    if (!best || score < best.score) best = { el, score };
  }
  return best ? best.el : null;
}

// ---------------------------------------------------------------------------
// pageSnapshot
// ---------------------------------------------------------------------------

/**
 * 页面快照。
 *
 * `editorTimeoutMs`：编辑器是异步加载的（头歌用 Monaco，实测 domcontentloaded 后
 * 还要 3~6 秒才挂到 window.Monaco 上）。传了这个值就在没扫到编辑器时轮询等待，
 * 默认 0 表示只扫一次、不等。
 *
 * @returns {Promise<{url:string,title:string,text:string,iframes:string[],editors:Array, buttons:Array, links:Array}>}
 */
export async function pageSnapshot(session, opts = {}) {
  const page = await ensureReady(session);
  const timeout = clampTimeout(opts.timeoutMs);
  const maxChars =
    Number.isFinite(opts.maxChars) && opts.maxChars > 0 ? Math.floor(opts.maxChars) : 20000;

  let snap;
  try {
    snap = await withTimeout(page.evaluate(collectSnapshot, maxChars), timeout, '读取页面快照超时');
  } catch (err) {
    const msg = String((err && err.message) || err);
    if (/closed|Target closed/i.test(msg)) throw new Error('页面已关闭：读取快照时浏览器被关闭');
    throw new Error(`读取页面快照失败：${firstLine(msg)}`);
  }

  let editors = await readEditors(page, timeout);

  // 编辑器异步挂载：没扫到就再等一会儿（有上限，不会无限轮询）。
  const editorWait = Number.isFinite(opts.editorTimeoutMs) ? Math.max(0, opts.editorTimeoutMs) : 0;
  if (!editors.length && editorWait > 0) {
    const deadline = Date.now() + Math.min(editorWait, 60_000);
    while (Date.now() < deadline) {
      try {
        await page.waitForTimeout(500);
      } catch {
        break; // 页面没了
      }
      editors = await readEditors(page, timeout);
      if (editors.length) break;
    }
  }

  return {
    url: snap.url,
    title: snap.title,
    text: snap.text,
    iframes: snap.iframes,
    editors,
    buttons: snap.buttons,
    links: snap.links,
  };
}

/** 先扫主 frame；主 frame 没有编辑器时再逐个 iframe 试。 */
async function readEditors(page, timeout) {
  const mainFrame = page.mainFrame();
  let list = [];

  try {
    const r = await withTimeout(mainFrame.evaluate(probeEditors), timeout, '编辑器探测超时');
    if (Array.isArray(r)) list = r;
  } catch {
    list = [];
  }

  if (!list.length) {
    for (const frame of page.frames()) {
      if (frame === mainFrame) continue;
      try {
        const r = await withTimeout(
          frame.evaluate(probeEditors),
          Math.min(timeout, 8000),
          '编辑器探测超时'
        );
        if (Array.isArray(r) && r.length) {
          list = r;
          break;
        }
      } catch {
        /* frame 已 detach / 跨域不可访问，跳过 */
      }
    }
  }

  return list.map((e, i) => ({
    index: i,
    value: typeof e.value === 'string' ? e.value : String(e.value == null ? '' : e.value),
    language: e.language || '',
    source: e.source,
  }));
}

// ---------------------------------------------------------------------------
// fillEditor
// ---------------------------------------------------------------------------

/**
 * 往代码编辑器里写代码。
 * @param {{code?: string, value?: string, text?: string, index?: number, timeoutMs?: number}} opts
 * @returns {Promise<{ok: boolean, method: string|null, editorCount: number, reason?: string}>}
 */
export async function fillEditor(session, opts = {}) {
  const page = await ensureReady(session);
  const timeout = clampTimeout(opts.timeoutMs);

  const code =
    typeof opts.code === 'string'
      ? opts.code
      : typeof opts.value === 'string'
        ? opts.value
        : typeof opts.text === 'string'
          ? opts.text
          : undefined;
  if (code === undefined) throw new Error('fillEditor 需要 opts.code（字符串）');

  const index = Number.isInteger(opts.index) && opts.index >= 0 ? opts.index : 0;

  // 主 frame 优先，其次其它 frame（头歌的编辑器可能嵌在 iframe 里）
  const mainFrame = page.mainFrame();
  const frames = [mainFrame, ...page.frames().filter((f) => f !== mainFrame)];

  for (const frame of frames) {
    let info = null;
    try {
      info = await withTimeout(frame.evaluate(detectEditorKind), Math.min(timeout, 10000), '编辑器探测超时');
    } catch {
      continue;
    }
    if (!info || !info.count) continue;

    if (info.kind === 'textarea') {
      // 头歌的代码区是一个"带 auto-indent 的 textarea + 背后一层高亮镜像"。
      // 千万不能用 Playwright 的 fill()：它逐字符 insertText，每敲一个换行
      // 就触发一次 auto-indent，结果是缩进一路累积（4/8/12/16…），
      // 而且旧模板不会被真正替换掉 —— 实测会把新代码和 Begin-End 模板拼在一起，
      // 直接编译出 `error: stray '#' in program`。
      //
      // 正确做法：用原生 value setter 一次性写入（绕过逐键监听），
      // 再补发一个 input 事件让框架同步内部状态。
      try {
        const handle = await withTimeout(frame.evaluateHandle(pickTextarea), timeout, '定位 textarea 超时');
        const element = handle.asElement();
        if (!element) continue;

        let written = await withTimeout(
          element.evaluate((node, value) => {
            const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
            node.focus();
            if (typeof setter === 'function') setter.call(node, value);
            else node.value = value;
            node.dispatchEvent(new Event('input', { bubbles: true }));
            node.dispatchEvent(new Event('change', { bubbles: true }));
            return node.value;
          }, code),
          timeout,
          '写入 textarea 超时',
        );

        // 回读校验：写进去的内容必须和我们给的一致（哪怕差一个字符也要重试，
        // 因为 auto-indent 之类的监听会把内容改掉）。
        if (written !== code) {
          // 退一步：全选后 insertText（有些框架只认 beforeinput）
          await element.click({ timeout }).catch(() => {});
          await frame
            .evaluate(() => {
              const tas = [...document.querySelectorAll('textarea')].filter((t) => {
                const r = t.getBoundingClientRect();
                const st = getComputedStyle(t);
                return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
              });
              tas.sort((a, b) => String(b.value || '').length - String(a.value || '').length);
              const t = tas[0];
              if (t) {
                t.focus();
                t.select();
              }
            })
            .catch(() => {});
          await page.keyboard.press('Control+A').catch(() => {});
          await page.keyboard.insertText(code).catch(() => {});
          written = await element.evaluate((node) => node.value).catch(() => '');
        }

        await page.waitForTimeout(150);
        const ok = written === code;
        return {
          ok,
          method: 'textarea',
          editorCount: info.count,
          verified: ok,
          ...(ok ? {} : { reason: `写入后回读不一致（期望 ${code.length} 字，实际 ${String(written).length} 字）` }),
        };
      } catch {
        continue;
      }
    }

    let res = null;
    try {
      res = await withTimeout(
        frame.evaluate(applyEditorValue, { index, code }),
        timeout,
        '写入编辑器超时'
      );
    } catch {
      continue;
    }
    if (res && res.ok) {
      await page.waitForTimeout(150); // 给框架的 change 回调/预览刷新留一点时间
      // 回读一次确认真的写进去了（Monaco 的 setValue 之后 getValue 应当一模一样）
      let verified = res.verified === true;
      if (res.method === 'monaco') {
        try {
          const readBack = await withTimeout(
            frame.evaluate((payload) => {
              const { index } = payload;
              for (const ns of [window.monaco, window.Monaco]) {
                try {
                  const models = ns && ns.editor && ns.editor.getModels ? ns.editor.getModels() : null;
                  if (models && models.length) return (models[index] || models[0]).getValue();
                } catch {}
              }
              return null;
            }, { index }),
            timeout,
            '回读编辑器超时',
          );
          verified = readBack === code;
        } catch {
          verified = false;
        }
      }
      return { ok: true, method: res.method, editorCount: res.count, verified };
    }
  }

  return {
    ok: false,
    method: null,
    editorCount: 0,
    reason: '未找到可写入的编辑器（Monaco / CodeMirror 5 / CodeMirror 6 / textarea 均未命中）',
  };
}

// ---------------------------------------------------------------------------
// clickByText
// ---------------------------------------------------------------------------

/**
 * 按可见文字点击元素（轮询到超时为止）。
 * @param {{text: string|RegExp, exact?: boolean, selector?: string, timeoutMs?: number}} opts
 * @returns {Promise<{ok: boolean, matched: string|null, selector: string|null, reason?: string}>}
 */
export async function clickByText(session, opts = {}) {
  const page = await ensureReady(session);
  const timeout = clampTimeout(opts.timeoutMs);
  const raw = opts.text != null ? opts.text : opts.label != null ? opts.label : opts.match;
  if (raw == null || (typeof raw === 'string' && !raw.trim())) {
    throw new Error('clickByText 需要 opts.text');
  }

  const payload = {
    text: typeof raw === 'string' ? raw : String(raw),
    exact: !!opts.exact,
    scope: opts.selector ? String(opts.selector) : null,
    regex: raw instanceof RegExp ? { source: raw.source, flags: raw.flags } : null,
  };

  const deadline = Date.now() + timeout;
  const mainFrame = page.mainFrame();

  while (Date.now() < deadline) {
    const frames = [mainFrame, ...page.frames().filter((f) => f !== mainFrame)];
    for (const frame of frames) {
      let element = null;
      try {
        const handle = await withTimeout(
          frame.evaluateHandle(findClickable, payload),
          Math.min(5000, Math.max(1000, deadline - Date.now())),
          '查找元素超时'
        );
        element = handle.asElement();
      } catch {
        element = null;
      }
      if (!element) continue;

      const desc = await element
        .evaluate((el) => {
          const cls =
            el.className && typeof el.className === 'string'
              ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
              : '';
          return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + cls;
        })
        .catch(() => 'unknown');

      const matched = await element
        .evaluate((el) =>
          String(el.tagName === 'INPUT' ? el.value || '' : el.innerText || el.textContent || '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 80)
        )
        .catch(() => '');

      const remaining = Math.max(1000, deadline - Date.now());
      try {
        await element.click({ timeout: remaining });
        return { ok: true, matched, selector: desc };
      } catch {
        // 被浮层挡住 / 不在视口内时，退化为 DOM click（仍会触发框架的事件绑定）
        try {
          await element.evaluate((el) => el.click());
          return { ok: true, matched, selector: desc };
        } catch {
          /* 这个元素点不动，继续找下一个 */
        }
      }
    }
    try {
      await page.waitForTimeout(200);
    } catch {
      throw new Error('页面已关闭：等待元素时浏览器被关闭');
    }
  }

  return {
    ok: false,
    matched: null,
    selector: null,
    reason: `未找到可点击的文本：${payload.text}（超时 ${timeout}ms）`,
  };
}

// ---------------------------------------------------------------------------
// waitForText
// ---------------------------------------------------------------------------

/**
 * 等页面出现某段文字（主 frame + 各 iframe）。
 * @returns {Promise<boolean>} 超时返回 false，不抛错
 */
export async function waitForText(session, opts = {}) {
  const page = await ensureReady(session);
  const text = String(opts.text != null ? opts.text : '');
  if (!text) throw new Error('waitForText 需要 opts.text');
  const timeout = clampTimeout(opts.timeoutMs);
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      try {
        const found = await withTimeout(
          frame.evaluate((needle) => {
            const body = document.body;
            if (!body) return false;
            const visible = body.innerText || '';
            if (visible.indexOf(needle) !== -1) return true;
            // innerText 会跳过隐藏元素，再退一步看 textContent
            return (body.textContent || '').indexOf(needle) !== -1;
          }, text),
          Math.min(5000, Math.max(1000, deadline - Date.now())),
          '等待文字超时'
        );
        if (found) return true;
      } catch {
        /* frame detach / 跨域，跳过 */
      }
    }
    try {
      await page.waitForTimeout(250);
    } catch {
      return false;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// 客观题（选择题 / 填空题）—— 页面侧读写
// ---------------------------------------------------------------------------

/**
 * 在页面里解析客观题结构。纯函数，会被 evaluate 序列化进页面执行。
 *
 * 头歌客观题页面结构（antd）：
 *   <ul class="choose-container">
 *     <li>                          ← 一道小题
 *       <题干文本>
 *       <div class="option">        ← 选择题：一组选项
 *         <a class="flex-container">A、xxx</a>
 *         <label class="ant-radio-wrapper"><span class="ant-radio"><input type=radio></span></label>
 *         ...
 *       </div>
 *       <textarea class="ant-input"> ← 填空题：一个空一个 textarea
 *     </li>
 *     ...
 *   </ul>
 *
 * 注意 radio **没有 name 分组**，只能靠 li 边界配对，不能靠 name。
 */
function parseObjectiveDom() {
  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

  const ul = document.querySelector('ul.choose-container');
  if (!ul) return null;

  const lis = [...ul.children].filter((n) => n.tagName === 'LI');
  if (!lis.length) return null;

  const items = lis.map((li, i) => {
    // 题干：把选项/输入控件从克隆里摘掉，剩下的文字就是题干
    const clone = li.cloneNode(true);
    clone
      .querySelectorAll('div.option, ul, textarea, input, label, button')
      .forEach((n) => n.remove());
    let question = norm(clone.innerText || clone.textContent || '');
    // 去掉尾部的「预览」之类按钮文字
    question = question.replace(/\s*预览\s*$/, '').trim();

    const radios = [...li.querySelectorAll('input[type=radio]')];
    const optionEls = [...li.querySelectorAll('div.option a.flex-container')];
    const textareas = [...li.querySelectorAll('textarea')].filter((t) => {
      const r = t.getBoundingClientRect();
      return r.width > 0 || r.height > 0 || t.offsetParent !== null;
    });

    // 选项文字：优先 a.flex-container，退化到 label 的文本
    const options = optionEls.length
      ? optionEls.map((a, k) => {
          const raw = norm(a.innerText || a.textContent || '');
          const m = /^([A-Za-z])[、.．)]\s*(.*)$/.exec(raw);
          return {
            label: (m ? m[1] : String.fromCharCode(65 + k)).toUpperCase(),
            text: m ? m[2].trim() : raw,
          };
        })
      : [];

    return {
      index: i,
      question,
      type: radios.length ? 'choice' : textareas.length ? 'fill' : 'unknown',
      optionCount: radios.length || options.length,
      blankCount: textareas.length,
      options,
    };
  });

  const choiceCount = items.filter((x) => x.type === 'choice').length;
  const fillCount = items.filter((x) => x.type === 'fill').length;
  const kind = choiceCount >= fillCount ? (choiceCount ? 'choice' : 'fill') : 'fill';

  return { kind, items };
}

/**
 * 读页面上的客观题（选择题 / 填空题）。
 * @returns {Promise<null|{kind:'choice'|'fill', items:Array}>}
 */
export async function readObjective(session, opts = {}) {
  const page = await ensureReady(session);
  const timeout = clampTimeout(opts.timeoutMs);
  const mainFrame = page.mainFrame();
  const frames = [mainFrame, ...page.frames().filter((f) => f !== mainFrame)];

  for (const frame of frames) {
    try {
      const r = await withTimeout(frame.evaluate(parseObjectiveDom), timeout, '读客观题超时');
      if (r && r.items && r.items.length) return r;
    } catch {
      /* frame detach / 跨域，跳过 */
    }
  }
  return null;
}

/**
 * 在页面里作答客观题。纯函数，会被 evaluate 序列化进页面执行。
 *
 * @param {{kind:string, answers:Array}} payload
 *   - 选择题：answers 是 ['A','B',...]，按小题顺序
 *   - 填空题：answers 是 [['\\n','"'],['5'],...]，二维数组，一题一组
 */
function applyObjectiveAnswers(payload) {
  const { kind, answers } = payload;
  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const report = [];

  const ul = document.querySelector('ul.choose-container');
  if (!ul) return { ok: false, reason: '找不到 ul.choose-container', report };
  const lis = [...ul.children].filter((n) => n.tagName === 'LI');

  const setNative = (node, value) => {
    const proto =
      node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (typeof setter === 'function') setter.call(node, value);
    else node.value = value;
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
  };

  lis.forEach((li, i) => {
    const a = answers[i];
    if (a === undefined || a === null) {
      report.push({ index: i, ok: false, reason: '没有答案' });
      return;
    }

    if (kind === 'choice') {
      const radios = [...li.querySelectorAll('input[type=radio]')];
      const optionEls = [...li.querySelectorAll('div.option a.flex-container')];
      const letters = String(a).toUpperCase().replace(/[^A-Z]/g, '').split('');
      if (!letters.length) {
        report.push({ index: i, ok: false, reason: '答案不是字母' });
        return;
      }
      let clicked = 0;
      for (const ch of letters) {
        // 优先按选项文字里的 "A、" 前缀定位，退化到字母序
        let k = optionEls.findIndex((el) => {
          const m = /^([A-Za-z])[、.．)]/.exec(norm(el.innerText || el.textContent || ''));
          return m && m[1].toUpperCase() === ch;
        });
        if (k < 0) k = ch.charCodeAt(0) - 65;
        const radio = radios[k];
        if (!radio) continue;
        // antd 的 radio 直接 click() 不一定触发 React 的 onChange，
        // 要点外层 label（它才是被绑定的那个）。
        const label = radio.closest('label') || radio.parentElement;
        try {
          if (label) label.click();
          else radio.click();
          clicked++;
        } catch {
          /* 单个选项点不到不影响其它 */
        }
      }
      const nowChecked = radios.filter((r) => r.checked).length;
      report.push({ index: i, ok: clicked > 0, picked: letters.join(''), checked: nowChecked });
      return;
    }

    // 填空题：answers[i] 是这一题每个空的答案数组
    const tas = [...li.querySelectorAll('textarea')];
    const arr = Array.isArray(a) ? a : [a];
    let written = 0;
    tas.forEach((t, k) => {
      if (k >= arr.length) return;
      setNative(t, String(arr[k] ?? ''));
      written++;
    });
    report.push({
      index: i,
      ok: written > 0,
      blanks: tas.length,
      written,
      values: tas.map((t) => t.value),
    });
  });

  const allOk = report.every((r) => r.ok);
  return { ok: allOk, report };
}

/**
 * 把答案填进页面（选择题点 radio，填空题写 textarea）。
 * @param {{kind:string, answers:Array}} opts
 */
export async function answerObjective(session, opts = {}) {
  const page = await ensureReady(session);
  const timeout = clampTimeout(opts.timeoutMs);
  if (!opts.kind || !Array.isArray(opts.answers)) {
    throw new Error('answerObjective 需要 opts.kind 与 opts.answers');
  }

  const mainFrame = page.mainFrame();
  const frames = [mainFrame, ...page.frames().filter((f) => f !== mainFrame)];

  let last = null;
  for (const frame of frames) {
    try {
      const r = await withTimeout(
        frame.evaluate(applyObjectiveAnswers, { kind: opts.kind, answers: opts.answers }),
        timeout,
        '作答客观题超时'
      );
      if (r && Array.isArray(r.report) && r.report.length) return r;
      last = r;
    } catch (err) {
      last = { ok: false, reason: firstLine(err && err.message) };
    }
  }
  return last ?? { ok: false, reason: '没找到客观题容器' };
}
