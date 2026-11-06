/**
 * lib/chaoxing-session.mjs —— 学习通登录态管理。
 *
 * 和学习通相关的登录事实：
 *   - 主站 cookie 是一个大杂烩（_uid / _d / UID / fid / vc3 / uf ...），
 *     分布在 .chaoxing.com 与 mooc1-api.chaoxing.com 两个域上，得全抓。
 *   - 学习通登录必然要过人机验证（滑块/点选），**没法自动填密码**，
 *     所以一律让用户在弹出的 Edge 窗口里手动登一次。
 *   - 登成功后把 cookie 存盘（chmod 600），以后直接复用；失效了再登。
 *
 * 和 iwrite-session.mjs 同一个套路，只是站点不同、判定方式不同。
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import * as api from './chaoxing-api.mjs';

/** 插件数据目录（和头歌/iWrite 共用根目录）。 */
export function dataDir() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'educoder-auto');
}

/** 登录态文件。 */
export function sessionFile() {
  return join(dataDir(), 'chaoxing-session.json');
}

/** 浏览器 profile 目录（独立一份，别和头歌/iWrite 混）。 */
export function profileDir() {
  return join(dataDir(), 'chaoxing-profile');
}

/** 要抓 cookie 的域。 */
export const COOKIE_ORIGINS = [
  'https://mooc1-api.chaoxing.com',
  'https://mooc1.chaoxing.com',
  'https://i.chaoxing.com',
  'https://passport2.chaoxing.com',
];

async function ensureDataDir() {
  const dir = dataDir();
  await mkdir(dir, { recursive: true });
  return dir;
}

/** 读登录态；没有或坏了返回 null。 */
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

/** 存登录态（里面有会话 cookie，chmod 600）。 */
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

/** 验证一份 cookie 还能不能用。 */
export async function validateCookies(cookies) {
  const normalized = api.normalizeCookies(cookies);
  if (!Object.keys(normalized).length) return { ok: false, reason: '没有 cookie' };
  return api.checkLogin(normalized, { timeoutMs: 20_000 });
}

/** 拿一份能用的 cookie，没有就抛 NEED_LOGIN。 */
export async function getCookies() {
  const saved = await loadSession();
  const cookies = api.normalizeCookies(saved?.cookies || {});
  if (Object.keys(cookies).length) return cookies;
  const err = new Error('还没有学习通登录态，请先运行 chaoxing_login 在打开的浏览器里登录一次');
  err.code = 'NEED_LOGIN';
  throw err;
}

/**
 * 引导登录：开有头浏览器 → 等用户自己登完 → 抓 cookie → 验证 → 存盘 → 关浏览器。
 * @param {{log?:Function, timeoutMs?:number, browserOpts?:object}} [opts]
 */
export async function loginInteractive(opts = {}) {
  const log = opts.log ?? (() => {});
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const { openBrowser, goto, screenshot, closeBrowser, harvestCookies } = await import('./browser.mjs');

  log('正在打开浏览器…（学习通登录有人机验证，需要你自己登）');
  const session = await openBrowser({
    ...opts.browserOpts,
    profileDir: opts.browserOpts?.profileDir || profileDir(),
    headless: false,
  });

  let shot;
  try {
    await goto(session, api.STU_WORK_URL, { timeoutMs: 60_000 }).catch(() => {});
    try {
      await session.page?.bringToFront?.();
    } catch {
      /* 没有窗口可提 */
    }
    shot = await screenshot(session, {}).catch(() => undefined);
    log('请在打开的 Edge 窗口里登录学习通（手机号/扫码 + 人机验证）。登成功后会自动继续。');

    const deadline = Date.now() + timeoutMs;
    let cookies = {};
    let valid = { ok: false };
    let lastNote = 0;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2500));
      cookies = api.normalizeCookies(await harvestCookies(session, COOKIE_ORIGINS).catch(() => ({})));
      // 已经有 profile 里的登录态也可能直接可用（复登场景）
      if (Object.keys(cookies).length) {
        valid = await api.checkLogin(cookies, { timeoutMs: 15_000 }).catch((e) => ({ ok: false, reason: e.message }));
        if (valid.ok) break;
      }
      if (Date.now() - lastNote > 15_000) {
        lastNote = Date.now();
        log(`还在等登录…（剩 ${Math.round((deadline - Date.now()) / 1000)} 秒）`);
      }
    }

    if (!valid.ok) {
      const err = new Error(
        `等待登录超时（${Math.round(timeoutMs / 1000)} 秒），没拿到可用的登录态。` +
          '请重新调用 chaoxing_login，并在弹出的 Edge 窗口里完成登录（含人机验证）。'
      );
      err.code = 'LOGIN_TIMEOUT';
      err.screenshot = shot?.path;
      throw err;
    }

    const payload = await saveSession(cookies, {
      loginAt: new Date().toISOString(),
      user: valid.user?.name || valid.user?.uid || undefined,
    });
    shot = (await screenshot(session, {}).catch(() => undefined)) ?? shot;
    log(`登录态已保存到 ${sessionFile()}`);
    return { ...payload, user: valid.user, screenshot: shot?.path };
  } finally {
    await closeBrowser().catch(() => {});
  }
}

/**
 * 从一个已经开着的浏览器会话里刷新 cookie（登录态过期时用，不用再弹一次窗口）。
 * 调用方自己负责 openBrowser。
 */
export async function refreshFromBrowser(session) {
  const { harvestCookies } = await import('./browser.mjs');
  const cookies = api.normalizeCookies(await harvestCookies(session, COOKIE_ORIGINS));
  const valid = await api.checkLogin(cookies);
  if (!valid.ok) return { ok: false, reason: valid.reason };
  await saveSession(cookies, { refreshedAt: new Date().toISOString() });
  return { ok: true, cookies, user: valid.user };
}
