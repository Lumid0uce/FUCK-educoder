/**
 * 登录态管理。
 *
 * 头歌的接口必须带 `_educoder_session` cookie 才算登录。这个 cookie 是 httpOnly 的，
 * 从页面 JS 里读不到，但 Playwright 通过 CDP 能拿到 —— 所以流程是：
 *   1. 用持久化 profile 打开浏览器（用户在里面手动登录一次，之后 profile 记住）
 *   2. harvestCookies 把 cookie 抓出来存成 JSON
 *   3. 之后所有 API 调用都带这份 JSON，不再需要浏览器
 *
 * 为什么要落盘而不是每次现抓：抓一次要开浏览器，很慢；而且 API 通道比浏览器稳。
 * 落盘之后，只有当 API 报 401 时才需要重新抓。
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import * as api from './educoder-api.mjs';

/** 插件数据目录。 */
export function dataDir() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'educoder-auto');
}

/** 登录态文件路径。 */
export function sessionFile() {
  return join(dataDir(), 'session.json');
}

/** 确保数据目录存在。 */
export async function ensureDataDir() {
  const dir = dataDir();
  await mkdir(dir, { recursive: true });
  return dir;
}

/**
 * 读取已保存的登录态。
 * @returns {Promise<{cookies: Record<string,string>, savedAt: string, user?: object} | null>}
 */
export async function loadSession() {
  const file = sessionFile();
  if (!existsSync(file)) return null;
  try {
    const raw = await readFile(file, 'utf8');
    const json = JSON.parse(raw);
    if (!json || typeof json.cookies !== 'object') return null;
    return json;
  } catch {
    return null;
  }
}

/**
 * 保存登录态。文件权限设 600（里面有 session cookie，等同凭据）。
 * @param {Record<string,string>} cookies
 * @param {object} [extra]
 */
export async function saveSession(cookies, extra = {}) {
  await ensureDataDir();
  const file = sessionFile();
  const payload = {
    cookies,
    savedAt: new Date().toISOString(),
    ...extra,
  };
  await writeFile(file, JSON.stringify(payload, null, 2), 'utf8');
  try {
    await chmod(file, 0o600);
  } catch {
    /* Windows 上 chmod 基本无效，忽略 */
  }
  return payload;
}

/** 清空登录态。 */
export async function clearSession() {
  const file = sessionFile();
  if (existsSync(file)) await writeFile(file, '{}', 'utf8');
}

/**
 * 拿一份「能用」的 cookie。
 * 优先读盘；盘上没有就抛 NEED_LOGIN，由调用方决定是否开浏览器引导登录。
 * @param {{refresh?: boolean, browser?: object}} [opts]
 */
export async function getCookies(opts = {}) {
  if (!opts.refresh) {
    const saved = await loadSession();
    if (saved?.cookies?._educoder_session) return saved.cookies;
  }
  if (opts.browser) {
    const cookies = await api_harvest(opts.browser);
    if (cookies._educoder_session) {
      await saveSession(cookies);
      return cookies;
    }
  }
  const err = new Error('还没有头歌登录态，请先运行 `educoder-auto login` 在打开的浏览器里登录一次');
  err.code = 'NEED_LOGIN';
  throw err;
}

/** 从浏览器会话抓 cookie（延迟 import，避免没装 playwright 时整个插件崩）。 */
async function api_harvest(session) {
  const { harvestCookies } = await import('./browser.mjs');
  return harvestCookies(session, [api.SITE_ORIGIN]);
}

/**
 * 验证一份 cookie 是否还有效。
 * 用一个必须登录才能看的接口探：/courses/<随便一个>/homework_commons.json 会返回 401。
 * 更稳的做法是看「我的课程」里有没有数据，但不同账号可能真的没有课程，
 * 所以这里采用「能拿到 200 且不报 401」即视为有效。
 */
export async function validateCookies(cookies) {
  if (!cookies?._educoder_session) return { ok: false, reason: '缺少 _educoder_session cookie' };
  try {
    const res = await api.listCourses(cookies, { limit: 5, order: 'mine' });
    return { ok: true, courses: res.list.length, total: res.total };
  } catch (error) {
    if (error.code === 'NEED_LOGIN') return { ok: false, reason: error.message };
    return { ok: false, reason: error.message };
  }
}

/**
 * 引导登录：开浏览器 → 等用户登录 → 抓 cookie → 存盘 → 关浏览器。
 * @param {object} opts
 * @param {(msg: string) => void} [opts.log]
 * @param {number} [opts.timeoutMs] - 等待登录的最长时间
 * @param {object} [opts.browserOpts]
 */
export async function loginInteractive(opts = {}) {
  const log = opts.log ?? (() => {});
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const { openBrowser, goto, screenshot, closeBrowser } = await import('./browser.mjs');

  log('正在打开浏览器（首次会新建 profile，之后会记住登录）…');
  // 登录必须看得见窗口（用户要输密码），所以强制有头；
  // 其余场景（抓题/截图）默认无头，不打扰用户。
  const session = await openBrowser({ ...opts.browserOpts, headless: false });
  let shot;
  try {
    await goto(session, `${api.SITE_ORIGIN}/login`, { timeoutMs: 60000 }).catch(() => {});
    // 把窗口提到最前，否则用户可能根本看不到它
    try {
      await session.page?.bringToFront?.();
    } catch {
      /* 无头模式下没有窗口可提 */
    }
    shot = await screenshot(session, {}).catch(() => undefined);
    log('请在打开的 Edge 窗口里完成登录（账号密码 / 微信 / 钉钉都行）。登录成功会自动继续。');

    const deadline = Date.now() + timeoutMs;
    let cookies = {};
    let lastNote = 0;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      cookies = await api_harvest(session).catch(() => ({}));
      if (cookies._educoder_session) {
        const v = await validateCookies(cookies);
        if (v.ok) break;
      }
      // 每 15 秒报一次进度，避免调用方以为卡死
      if (Date.now() - lastNote > 15_000) {
        lastNote = Date.now();
        log(`还在等登录…（剩 ${Math.round((deadline - Date.now()) / 1000)} 秒）`);
      }
    }
    if (!cookies._educoder_session) {
      const err = new Error(
        `等待登录超时（${Math.round(timeoutMs / 1000)} 秒），没有拿到 session cookie。` +
          '请重新调用 educoder_login，并在弹出的 Edge 窗口里把账号密码输完、点「登录」。',
      );
      err.code = 'LOGIN_TIMEOUT';
      err.screenshot = shot?.path;
      throw err;
    }

    const payload = await saveSession(cookies, { loginAt: new Date().toISOString() });
    shot = (await screenshot(session, {}).catch(() => undefined)) ?? shot;
    log(`登录态已保存到 ${sessionFile()}`);
    return { ...payload, screenshot: shot?.path };
  } finally {
    await closeBrowser().catch(() => {});
  }
}
