/**
 * lib/iwrite-session.mjs —— iWrite 登录态管理。
 *
 * 和头歌不一样的地方：
 *   - iWrite 走 SSO（sso.unipus.cn），登录页带极验滑块，**没法自动填密码**，
 *     必须让用户在弹出的窗口里手动登一次。所以 loginInteractive 一律有头。
 *   - 登录成功后 cookie 分落在 iwrite.unipus.cn 和 sso.unipus.cn 两个域上，
 *     抓的时候两个域都要抓（缺 ssoUserId 时接口虽然也能通，但前端每次都带这个头）。
 *   - 判定"真的登上了"用 /api/common/currentUser：未登录返回 code 2002。
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import * as api from './iwrite-api.mjs';

/** 插件数据目录（和头歌共用同一个根，便于统一清理）。 */
export function dataDir() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'educoder-auto');
}

/** 登录态文件。 */
export function sessionFile() {
  return join(dataDir(), 'iwrite-session.json');
}

/** 浏览器 profile 目录（独立于头歌，避免两个站点互相踩 localStorage）。 */
export function profileDir() {
  return join(dataDir(), 'iwrite-profile');
}

/** 账号密码文件（自动登录用）。 */
export function credentialsFile() {
  return join(dataDir(), 'iwrite-credentials.json');
}

/** 读已保存的账号密码；没有返回 null。 */
export async function loadCredentials() {
  const file = credentialsFile();
  if (!existsSync(file)) return null;
  try {
    const json = JSON.parse(await readFile(file, 'utf8'));
    if (!json?.username || !json?.password) return null;
    return json;
  } catch {
    return null;
  }
}

/** 存账号密码（chmod 600）。 */
export async function saveCredentials(username, password) {
  await ensureDataDir();
  const file = credentialsFile();
  await writeFile(
    file,
    JSON.stringify({ username, password, savedAt: new Date().toISOString() }, null, 2),
    'utf8'
  );
  try {
    await chmod(file, 0o600);
  } catch {
    /* Windows 上基本无效 */
  }
  return file;
}

/** 清空账号密码。 */
export async function clearCredentials() {
  const file = credentialsFile();
  if (existsSync(file)) await writeFile(file, '{}', 'utf8');
}

async function ensureDataDir() {
  const dir = dataDir();
  await mkdir(dir, { recursive: true });
  return dir;
}

/** 读已保存的登录态；没有或坏了返回 null。 */
export async function loadSession() {
  const file = sessionFile();
  if (!existsSync(file)) return null;
  try {
    const json = JSON.parse(await readFile(file, 'utf8'));
    if (!json || typeof json.cookies !== 'object') return null;
    return json;
  } catch {
    return null;
  }
}

/** 存登录态（chmod 600，里面有会话 cookie）。 */
export async function saveSession(cookies, extra = {}) {
  await ensureDataDir();
  const file = sessionFile();
  const payload = { cookies, savedAt: new Date().toISOString(), ...extra };
  await writeFile(file, JSON.stringify(payload, null, 2), 'utf8');
  try {
    await chmod(file, 0o600);
  } catch {
    /* Windows 上基本无效 */
  }
  return payload;
}

/** 清空登录态。 */
export async function clearSession() {
  const file = sessionFile();
  if (existsSync(file)) await writeFile(file, '{}', 'utf8');
}

/**
 * 验证一份 cookie 能不能用。
 * @returns {Promise<{ok:boolean, user?:object, reason?:string}>}
 */
export async function validateCookies(cookies) {
  if (!cookies || !Object.keys(cookies).length) return { ok: false, reason: '没有 cookie' };
  try {
    const user = await api.currentUser(cookies, { timeoutMs: 20_000 });
    // currentUser 成功但 data 为空的情况没见过，保守按成功处理
    return { ok: true, user: user || {} };
  } catch (error) {
    if (error.code === 'NEED_LOGIN') return { ok: false, reason: error.message };
    return { ok: false, reason: error.message };
  }
}

/**
 * 拿一份能用的 cookie。优先读盘，没有就抛 NEED_LOGIN。
 */
export async function getCookies() {
  const saved = await loadSession();
  if (saved?.cookies && Object.keys(saved.cookies).length) return saved.cookies;
  const err = new Error('还没有 iWrite 登录态，请先运行 iwrite_login 在打开的浏览器里登录一次');
  err.code = 'NEED_LOGIN';
  throw err;
}

/**
 * 自动登录：用保存的账号密码直接填表提交。
 *
 * 为什么可以自动：Unipus SSO 的极验是**按风险触发**的，同一台机器、
 * 同一浏览器 profile、正常速度填表时实测不会弹；一旦弹了（说明被风控），
 * 这里会返回 needsManual=true，由调用方回落到 loginInteractive 让用户手动过。
 *
 * @param {{username?:string, password?:string, log?:Function, timeoutMs?:number, browserOpts?:object}} [opts]
 * @returns {Promise<{ok:boolean, cookies?:object, user?:object, needsManual?:boolean, reason?:string, screenshot?:string}>}
 */
export async function loginWithCredentials(opts = {}) {
  const log = opts.log ?? (() => {});
  const saved = await loadCredentials();
  const username = String(opts.username || saved?.username || '').trim();
  const password = String(opts.password || saved?.password || '');
  if (!username || !password) {
    return { ok: false, needsManual: true, reason: '没有保存账号密码，需要手动登录一次' };
  }

  const { openBrowser, goto, harvestCookies, pageSnapshot, screenshot, closeBrowser } = await import('./browser.mjs');
  const session = await openBrowser({
    ...opts.browserOpts,
    profileDir: opts.browserOpts?.profileDir || profileDir(),
    headless: opts.headless !== false,
  });

  try {
    log('打开 iWrite 登录页…');
    await goto(session, `${api.IWRITE_ORIGIN}/student`, { timeoutMs: 60_000, settleMs: 2500 }).catch(() => {});
    const page = session.page;
    if (!page) return { ok: false, needsManual: true, reason: '浏览器没起来' };

    // 可能已经登录了（profile 里的 cookie 还有效）
    let cookies = await harvestCookies(session, [api.IWRITE_ORIGIN, 'https://sso.unipus.cn']).catch(() => ({}));
    let valid = await validateCookies(cookies);
    if (valid.ok) {
      await saveSession(cookies, { loginAt: new Date().toISOString(), user: valid.user?.name });
      log('已有登录态，直接复用');
      return { ok: true, cookies, user: valid.user };
    }

    const hasForm = await page.evaluate(() => !!document.querySelector('input[name=username]'));
    if (!hasForm) {
      const snap = await pageSnapshot(session, { maxChars: 200 }).catch(() => ({}));
      return {
        ok: false,
        needsManual: true,
        reason: `没找到登录表单（当前页：${snap.title || page.url()}）`,
      };
    }

    log(`填账号密码（${username.replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2')}）…`);
    await page.evaluate(
      ({ u, p }) => {
        const set = (el, v) => {
          const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
          d.set.call(el, v);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        };
        const un = document.querySelector('input[name=username]');
        const pw = document.querySelector('input[name=password]');
        if (un) set(un, u);
        if (pw) set(pw, p);
        // 勾「我已阅读并同意」（那个没 name 的 checkbox）
        for (const b of document.querySelectorAll('input[type=checkbox]')) if (!b.name && !b.checked) b.click();
      },
      { u: username, p: password }
    );
    await new Promise((r) => setTimeout(r, 600));

    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button')).find(
        (x) => (x.innerText || '').trim() === '登录' && x.offsetWidth
      );
      if (b) b.click();
    });
    log('已点登录，等跳转…');

    // 等离开登录页（最多 45 秒）
    const deadline = Date.now() + 45_000;
    let leftLogin = false;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000));
      const u = page.url();
      if (!u.includes('/sso/login') && !u.includes('/login')) {
        leftLogin = true;
        break;
      }
    }

    cookies = await harvestCookies(session, [api.IWRITE_ORIGIN, 'https://sso.unipus.cn']).catch(() => ({}));
    valid = await validateCookies(cookies);
    if (valid.ok) {
      await saveSession(cookies, { loginAt: new Date().toISOString(), user: valid.user?.name });
      log('✅ 自动登录成功');
      return { ok: true, cookies, user: valid.user };
    }

    // 登录没成：可能是弹了极验，或者密码错了
    const snap = await pageSnapshot(session, { maxChars: 300 }).catch(() => ({}));
    const text = String(snap.text || '');
    const shot = await screenshot(session, {}).catch(() => undefined);
    const reason = /验证|滑块|拖动|安全/.test(text)
      ? '触发了极验验证，需要手动过滑块'
      : /密码|账号|错误|不正确/.test(text)
        ? '账号或密码不正确'
        : leftLogin
          ? '跳转了但登录态无效'
          : '登录后没有跳转，可能被风控拦了';
    return { ok: false, needsManual: true, reason, screenshot: shot?.path };
  } finally {
    await closeBrowser().catch(() => {});
  }
}

/**
 * 引导登录：开有头浏览器 → 等用户登完 → 抓 cookie → 验证 → 存盘 → 关浏览器。
 * @param {{log?:Function, timeoutMs?:number, browserOpts?:object}} [opts]
 */
export async function loginInteractive(opts = {}) {
  const log = opts.log ?? (() => {});
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const { openBrowser, goto, screenshot, closeBrowser, harvestCookies } = await import('./browser.mjs');

  log('正在打开浏览器…（iWrite 登录页有极验滑块，需要你自己登）');
  const session = await openBrowser({
    ...opts.browserOpts,
    profileDir: opts.browserOpts?.profileDir || profileDir(),
    headless: false,
  });

  let shot;
  try {
    await goto(session, `${api.IWRITE_ORIGIN}/student`, { timeoutMs: 60_000 }).catch(() => {});
    try {
      await session.page?.bringToFront?.();
    } catch {
      /* 无窗口可提 */
    }
    shot = await screenshot(session, {}).catch(() => undefined);
    log('请在打开的 Edge 窗口里登录（账号密码 + 极验滑块）。登录成功后会自动继续。');

    const deadline = Date.now() + timeoutMs;
    let cookies = {};
    let valid = { ok: false };
    let lastNote = 0;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2500));
      cookies = await harvestCookies(session, [api.IWRITE_ORIGIN, 'https://sso.unipus.cn']).catch(() => ({}));
      if (Object.keys(cookies).length) {
        valid = await validateCookies(cookies);
        if (valid.ok) break;
      }
      if (Date.now() - lastNote > 15_000) {
        lastNote = Date.now();
        log(`还在等登录…（剩 ${Math.round((deadline - Date.now()) / 1000)} 秒）`);
      }
    }

    if (!valid.ok) {
      const err = new Error(
        `等待登录超时（${Math.round(timeoutMs / 1000)} 秒），没有拿到可用的登录态。` +
          '请重新调用 iwrite_login，并在弹出的 Edge 窗口里完成登录（含极验滑块）。'
      );
      err.code = 'LOGIN_TIMEOUT';
      err.screenshot = shot?.path;
      throw err;
    }

    const payload = await saveSession(cookies, {
      loginAt: new Date().toISOString(),
      user: valid.user?.name || valid.user?.login || undefined,
    });
    shot = (await screenshot(session, {}).catch(() => undefined)) ?? shot;
    log(`登录态已保存到 ${sessionFile()}`);
    return { ...payload, user: valid.user, screenshot: shot?.path };
  } finally {
    await closeBrowser().catch(() => {});
  }
}

/**
 * 从已开着的浏览器会话里刷新 cookie（登录态过期时用，不用再弹一次窗口）。
 * 需要调用方自己 openBrowser。
 */
export async function refreshFromBrowser(session) {
  const { harvestCookies } = await import('./browser.mjs');
  const cookies = await harvestCookies(session, [api.IWRITE_ORIGIN, 'https://sso.unipus.cn']);
  const valid = await validateCookies(cookies);
  if (!valid.ok) return { ok: false, reason: valid.reason };
  await saveSession(cookies, { refreshedAt: new Date().toISOString() });
  return { ok: true, cookies, user: valid.user };
}
