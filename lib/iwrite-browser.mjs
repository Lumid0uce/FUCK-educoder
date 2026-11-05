/**
 * lib/iwrite-browser.mjs —— iWrite 写作页的浏览器路。
 *
 * 实测页面结构（2026-10 版，Umi + antd，类名带 hash 随时会变，所以只靠语义属性定位）：
 *
 *   /student/daily/write?taskId=&uid=&classId=
 *     └─ 有 preWriteRequired 时先落到 /student/daily/prewrite
 *          · 写作构思智能体聊天页
 *          · 右上角 button[aria-label="我要写作"]，未聊过天时带 writeBtnLocked 类且
 *            title="请先与写作构思智能体完成至少一轮问答"
 *          · 往聊天 textarea 发一条消息后按钮解锁
 *     └─ 点「我要写作」→ 打开抽屉，真正的编辑区是：
 *          · input.ant-input-borderless[placeholder="请输入作文标题"]
 *          · textarea.ant-input.editor___*[placeholder="请在此撰写你的作文..."]   ← 不是 TinyMCE！
 *          · button「保存」/「提交」
 *
 * 早前逆向 umi.js 看到 tinymce 依赖，但线上这版写作页没启用它（`window.tinymce` 不存在、
 * 没有 iframe、没有 contenteditable），正文就是普通 textarea。
 * 所以这里按 textarea 写，同时保留 TinyMCE / contenteditable 的兜底分支，
 * 万一平台哪天切回去也不用改。
 *
 * 模块加载阶段不做任何 IO。
 */

import * as api from './iwrite-api.mjs';

const SEL_TITLE = 'input[placeholder="请输入作文标题"], input[placeholder*="标题"]';
const SEL_BODY = 'textarea[placeholder*="请在此撰写你的作文"], textarea.editor___Y7_5o, textarea.ant-input.editor___Y7_5o';
const SEL_WRITE_BTN = 'button[aria-label="我要写作"], .writeBtn___1qQjQ';
const SEL_CHAT_INPUT = 'textarea[placeholder*="理清思路再动笔"], .inputBox___1Q1Wn textarea';
const SEL_SEND_BTN = 'button[aria-label="发送"], .sendBtn___2nrxx';

/**
 * 正文编辑区的三种实现，按探测顺序试：
 *
 *   1. UEditor（/student/toSubmitTask 页）—— 真的 iframe，里面是
 *      `<iframe id="ueditor_0">` → `body[contenteditable="true"]`。
 *      这一页的标题是 `input.biaoti[placeholder="请输入作文标题"]`。
 *   2. TinyMCE（老版写作页）—— window.tinymce.editors[0]。
 *   3. 纯 textarea（/student/daily/write 抽屉）—— textarea.editor___*。
 *
 * 2026-10 实测：`daily/write` 用 textarea，`toSubmitTask` 用 UEditor，
 * 同一个作业从两个入口进去长得完全不一样，所以两种都得支持。
 */
async function findUEditorFrame(page) {
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    const ok = await frame
      .evaluate(() => {
        const b = document.body;
        return Boolean(b && b.getAttribute('contenteditable') === 'true');
      })
      .catch(() => false);
    if (ok) return frame;
  }
  return null;
}

/** 在页面里给元素赋值并派发 React 能收到的事件。 */
function setNativeValue(el, value) {
  const tag = el.tagName;
  const proto = tag === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return el.value;
}

/**
 * 打开写作页，必要时自动过「写前构思」这道门。
 *
 * @returns {Promise<{url:string, title:string, ready:boolean, editorKind:string, prewrite:boolean, snapshot:object}>}
 */
export async function openWritePage(session, url, opts = {}) {
  const { goto, pageSnapshot } = await import('./browser.mjs');
  const trace = opts.trace ?? (() => {});
  const nav = await goto(session, url, { timeoutMs: opts.timeoutMs ?? 60_000 });
  trace(`已打开写作页：${nav.title || '(无标题)'}`);
  await new Promise((r) => setTimeout(r, 2500));

  let page = session.page;
  let prewrite = false;

  // 落到了写前构思页 → 需要先和构思智能体聊一轮，「我要写作」才解锁。
  if (/\/prewrite/.test(page.url())) {
    prewrite = true;
    trace('落到写前构思页，先过这道门…');
    await passPrewrite(session, { trace, signal: opts.signal });
    // 点完「我要写作」URL 会回到 /write
    await new Promise((r) => setTimeout(r, 3000));
    trace(`现在在：${page.url()}`);
  }

  // 等编辑器挂上（textarea 是随抽屉一起渲染的）
  const deadline = Date.now() + (opts.editorTimeoutMs ?? 30_000);
  let ready = false;
  while (Date.now() < deadline) {
    ready = await page
      .evaluate(
        ([selBody, selTitle]) =>
          Boolean(
            document.querySelector(selBody) ||
              document.querySelector(selTitle) ||
              document.querySelector('iframe#ueditor_0') ||
              window.tinymce?.editors?.length
          ),
        [SEL_BODY, SEL_TITLE]
      )
      .catch(() => false);
    if (ready) break;
    await new Promise((r) => setTimeout(r, 700));
  }
  const snap = await pageSnapshot(session, { maxChars: 20_000 }).catch(() => null);
  if (ready) trace('编辑区已就绪');
  else trace('没等到编辑区（可能页面结构变了）');

  let editorKind = 'none';
  if (ready) {
    if (await findUEditorFrame(page)) editorKind = 'ueditor';
    else if (await page.evaluate(() => Boolean(window.tinymce?.editors?.length)).catch(() => false)) editorKind = 'tinymce';
    else if (await page.evaluate((sel) => Boolean(document.querySelector(sel)), SEL_BODY).catch(() => false)) editorKind = 'textarea';
    else editorKind = 'title-only';
    trace(`编辑区实现：${editorKind}`);
  }

  return {
    url: page.url(),
    title: nav.title,
    ready,
    editorKind,
    prewrite,
    snapshot: snap,
  };
}

/**
 * 过「写前构思」：往聊天框发一句话，等「我要写作」解锁，点它。
 * @returns {Promise<{ok:boolean, reason?:string}>}
 */
export async function passPrewrite(session, opts = {}) {
  const trace = opts.trace ?? (() => {});
  const page = session.page;
  if (!page) throw new Error('passPrewrite 需要已打开的浏览器会话');

  // 1) 填聊天输入框
  const filled = await page.evaluate(
    ([selInput, msg]) => {
      const el = document.querySelector(selInput);
      if (!el) return { ok: false, reason: '没找到聊天输入框' };
      const proto = window.HTMLTextAreaElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, msg);
      else el.value = msg;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, value: el.value };
    },
    [SEL_CHAT_INPUT, opts.message || 'My main idea is that smart technology makes us more knowledgeable, and I will support it with three points.']
  );
  if (!filled.ok) {
    trace(`写前构思：${filled.reason}`);
    return { ok: false, reason: filled.reason };
  }
  trace('写前构思：已填好一句构思');

  // 2) 点发送
  const sent = await page.evaluate((sel) => {
    const btn = document.querySelector(sel);
    if (!btn) return { ok: false };
    btn.click();
    return { ok: true };
  }, SEL_SEND_BTN);
  if (!sent.ok) {
    trace('写前构思：没找到发送按钮');
    return { ok: false, reason: '没找到发送按钮' };
  }

  // 3) 等「我要写作」解锁（最多 60 秒）
  const deadline = Date.now() + (opts.unlockTimeoutMs ?? 60_000);
  let unlocked = false;
  while (Date.now() < deadline) {
    const state = await page
      .evaluate((sel) => {
        const btn = document.querySelector(sel);
        if (!btn) return { found: false };
        return {
          found: true,
          locked: /Locked/.test(String(btn.className)) || btn.disabled === true,
          title: btn.getAttribute('title') || '',
        };
      }, SEL_WRITE_BTN)
      .catch(() => ({ found: false }));
    if (state.found && !state.locked) {
      unlocked = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (!unlocked) {
    trace('写前构思：「我要写作」一直没解锁，直接尝试点它');
  }

  // 4) 点「我要写作」
  const clicked = await page.evaluate((sel) => {
    const btn = document.querySelector(sel);
    if (!btn) return { ok: false, reason: '没找到「我要写作」按钮' };
    btn.click();
    return { ok: true };
  }, SEL_WRITE_BTN);
  if (!clicked.ok) {
    trace(`写前构思：${clicked.reason}`);
    return { ok: false, reason: clicked.reason };
  }
  trace(unlocked ? '写前构思：已解锁并点了「我要写作」' : '写前构思：已点「我要写作」');
  return { ok: true };
}

/** 从写作页读当前标题 / 正文 / 页面文字。 */
export async function readWritePage(session) {
  const page = session?.page;
  if (!page) throw new Error('readWritePage 需要已打开的浏览器会话');

  // UEditor 在 iframe 里，主文档读不到，得单独问那个 frame。
  const ue = await findUEditorFrame(page);
  if (ue) {
    const inner = await ue
      .evaluate(() => ({
        article: document.body?.innerText || '',
        html: document.body?.innerHTML || '',
      }))
      .catch(() => ({ article: '', html: '' }));
    const title = await page
      .evaluate((sel) => document.querySelector(sel)?.value || '', SEL_TITLE)
      .catch(() => '');
    const text = await page
      .evaluate(() => (document.body?.innerText || '').replace(/\n{3,}/g, '\n\n'))
      .catch(() => '');
    return {
      title,
      article: inner.article,
      source: 'ueditor',
      html: inner.html,
      text,
      words: api.countWords(inner.article),
    };
  }

  const got = await page.evaluate(
    ([selTitle, selBody]) => {
      // 正文：先 TinyMCE（老版），再 contenteditable，最后 textarea
      const tm = window.tinymce || window.tinyMCE;
      let article = '';
      let source = '';
      if (tm?.activeEditor?.getContent) {
        article = tm.activeEditor.getContent({ format: 'text' });
        source = 'tinymce';
      } else if (tm?.editors?.length && tm.editors[0]?.getContent) {
        article = tm.editors[0].getContent({ format: 'text' });
        source = 'tinymce';
      } else {
        const ce = document.querySelector('[contenteditable="true"]');
        const ta = document.querySelector(selBody) || document.querySelector('textarea.editor___Y7_5o');
        if (ce) {
          article = ce.innerText || '';
          source = 'contenteditable';
        } else if (ta) {
          article = ta.value || '';
          source = 'textarea';
        }
      }
      const titleEl = document.querySelector(selTitle);
      return {
        title: titleEl?.value || '',
        article,
        source,
        text: (document.body?.innerText || '').replace(/\n{3,}/g, '\n\n'),
      };
    },
    [SEL_TITLE, SEL_BODY]
  );

  return { ...got, words: api.countWords(got.article) };
}

/**
 * 把标题和正文写进页面。
 * @returns {Promise<{ok:boolean, titleOk:boolean, articleOk:boolean, verifiedWords:number, reason?:string}>}
 */
export async function fillEssay(session, { title, body }, opts = {}) {
  const page = session?.page;
  if (!page) throw new Error('fillEssay 需要已打开的浏览器会话');
  const trace = opts.trace ?? (() => {});

  // ── UEditor（/student/toSubmitTask 页）──
  // 正文在 iframe 的 body[contenteditable] 里，直接改 innerHTML 再派发 input。
  // 注意：不要用 Playwright 的 fill()/type()，逐字符输入会触发编辑器的自动缩进/换行规则。
  const ue = await findUEditorFrame(page);
  if (ue) {
    let titleOk = true;
    if (title) {
      titleOk = await page
        .evaluate(
          ([selTitle, wantTitle]) => {
            const el = document.querySelector(selTitle);
            if (!el) return false;
            const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
            if (d?.set) d.set.call(el, wantTitle);
            else el.value = wantTitle;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return el.value === wantTitle;
          },
          [SEL_TITLE, String(title)]
        )
        .catch(() => false);
      if (!titleOk) trace('标题没写进去');
    }
    const html = String(body || '')
      .split(/\n\s*\n/)
      .map((p) => `<p>${p.replace(/\n/g, ' ').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</p>`)
      .join('');
    const wrote = await ue
      .evaluate((h) => {
        const b = document.body;
        if (!b) return { ok: false, reason: 'iframe 里没有 body' };
        b.innerHTML = h;
        b.dispatchEvent(new Event('input', { bubbles: true }));
        b.dispatchEvent(new Event('keyup', { bubbles: true }));
        return { ok: true, words: (b.innerText || '').trim().split(/\s+/).filter(Boolean).length };
      }, html)
      .catch((e) => ({ ok: false, reason: e.message }));
    trace(`正文写入${wrote.ok ? '成功' : '失败'}（ueditor${wrote.ok ? `，${wrote.words} 词` : `：${wrote.reason}`}）`);
    const verified = await readWritePage(session).catch(() => ({ article: '', words: 0 }));
    return {
      ok: Boolean(wrote.ok && (!title || titleOk)),
      titleOk,
      articleOk: wrote.ok === true,
      method: 'ueditor',
      verifiedWords: verified.words,
      reason: wrote.ok ? undefined : wrote.reason || 'UEditor 写入失败',
    };
  }

  const r = await page.evaluate(
    ([selTitle, selBody, wantTitle, wantBody]) => {
      const setValue = (el, value) => {
        const proto =
          el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(el, value);
        else el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };

      // ── 标题 ──
      let titleOk = true;
      if (wantTitle) {
        const titleEl = document.querySelector(selTitle);
        if (titleEl) {
          setValue(titleEl, wantTitle);
          titleOk = titleEl.value === wantTitle;
        } else {
          titleOk = false;
        }
      }

      // ── 正文 ──
      let articleOk = false;
      let method = '';
      const tm = window.tinymce || window.tinyMCE;
      const ed = tm?.activeEditor || (tm?.editors?.length ? tm.editors[0] : null);
      if (ed?.setContent) {
        const html = wantBody
          .split(/\n\s*\n/)
          .map((p) => `<p>${p.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</p>`)
          .join('');
        ed.setContent(html);
        const back = ed.getContent({ format: 'text' });
        articleOk = back.replace(/\s+/g, ' ').trim() === wantBody.replace(/\s+/g, ' ').trim();
        method = 'tinymce';
      } else {
        const ta = document.querySelector(selBody) || document.querySelector('textarea.editor___Y7_5o');
        const ce = document.querySelector('[contenteditable="true"]');
        if (ta) {
          setValue(ta, wantBody);
          articleOk = ta.value === wantBody;
          method = 'textarea';
        } else if (ce) {
          ce.focus();
          ce.innerHTML = wantBody
            .split(/\n\s*\n/)
            .map((p) => `<p>${p}</p>`)
            .join('');
          ce.dispatchEvent(new Event('input', { bubbles: true }));
          articleOk = true;
          method = 'contenteditable';
        }
      }

      return { titleOk, articleOk, method };
    },
    [SEL_TITLE, SEL_BODY, String(title || ''), String(body || '')]
  );

  trace(`正文写入${r.articleOk ? '成功' : '失败'}（${r.method || '未找到编辑区'}）`);
  if (title && !r.titleOk) trace('标题没写进去');

  const verified = await readWritePage(session).catch(() => ({ article: '', words: 0 }));
  return {
    ok: Boolean(r.articleOk && (!title || r.titleOk)),
    titleOk: r.titleOk,
    articleOk: r.articleOk,
    method: r.method,
    verifiedWords: verified.words,
    reason: r.articleOk ? undefined : '没找到可写的作文编辑区',
  };
}

/**
 * 点提交并处理确认弹窗。
 *
 * 坑：提交按钮**没有文字**，它是
 *   `<button aria-label="提交" class="submitBtn___*"><img src="/figma-assets/writing/btn-submit-full.png" alt="提交"></button>`
 * 所以按文字找不到，必须按 `aria-label` 定位。
 * 点完会弹 antd confirm：「确认提交 / 提交后将进入批改流程，是否确认提交？」，要再点「确定」。
 *
 * @returns {Promise<{ok:boolean, reason?:string, url?:string, redirectedToReport?:boolean}>}
 */
export async function submitEssay(session, opts = {}) {
  const trace = opts.trace ?? (() => {});
  const page = session?.page;
  if (!page) throw new Error('submitEssay 需要已打开的浏览器会话');

  // 先保存一次，确保正文落盘（平台保存和提交是两个按钮，提交也会先存一遍）
  // 两种页面的「保存」不是同一种元素：
  //   daily/write（抽屉）    → <button>保存</button>
  //   toSubmitTask（整页）   → <a class="write-sumbit">保存</a>
  const saved = await page
    .evaluate(() => {
      const cands = Array.from(document.querySelectorAll('button, a'));
      const btn = cands.find((b) => b.offsetWidth && (b.innerText || '').trim() === '保存');
      if (!btn) return { ok: false };
      btn.click();
      return { ok: true, tag: btn.tagName };
    })
    .catch(() => ({ ok: false }));
  if (saved.ok) {
    trace(`已点「保存」（${saved.tag}）`);
    await new Promise((r) => setTimeout(r, 2500));
  }

  // 提交按钮：两种页面都不一样
  //   daily/write → <button aria-label="提交"> 里只有一张图片，没有文字
  //   toSubmitTask → <a class="write-sumbit">提交</a>，有文字
  const clicked = await page
    .evaluate(() => {
      const sel = ['button[aria-label="提交"]', 'button[class*="submitBtn"]', 'img[alt="提交"]'];
      for (const s of sel) {
        const el = document.querySelector(s);
        if (!el) continue;
        const btn = el.tagName === 'BUTTON' ? el : el.closest('button') || el;
        if (btn.disabled) return { ok: false, reason: '提交按钮是禁用状态（可能已过截止时间）' };
        btn.click();
        return { ok: true, via: s };
      }
      const textBtn = Array.from(document.querySelectorAll('a, button')).find(
        (b) => b.offsetWidth && (b.innerText || '').trim() === '提交'
      );
      if (textBtn) {
        textBtn.click();
        return { ok: true, via: `文字「提交」（${textBtn.tagName}）` };
      }
      return { ok: false, reason: '没找到提交按钮（button[aria-label="提交"] 或文字「提交」）' };
    })
    .catch((e) => ({ ok: false, reason: e.message }));
  if (!clicked.ok) return { ok: false, reason: clicked.reason };
  trace(`已点提交（${clicked.via}）`);

  // 确认弹窗：daily/write 用 antd confirm，toSubmitTask 用 layui
  //   antd：「确认提交 / 提交后将进入批改流程，是否确认提交？」→ .ant-btn-primary
  //   layui：「请仔细检查，确认作业已完成后再提交.」→ a.layui-layer-btn0 文案「确认并提交」
  await new Promise((r) => setTimeout(r, 1800));
  const confirmed = await page
    .evaluate(() => {
      const antd = document.querySelector('.ant-modal-confirm, .ant-modal');
      if (antd) {
        const okBtn = antd.querySelector('.ant-btn-primary, .ant-btn-dangerous');
        if (okBtn) {
          okBtn.click();
          return { ok: true, kind: 'antd', text: antd.innerText || '' };
        }
      }
      // layui：按钮文字「确认并提交」，别点成「返回修改」
      const exact = Array.from(document.querySelectorAll('a, button')).filter(
        (e) => e.offsetWidth && (e.innerText || '').trim() === '确认并提交'
      );
      const target = exact.find((e) => !Array.from(e.children).some((c) => (c.innerText || '').trim() === '确认并提交')) || exact[0];
      if (target) {
        const layer = target.closest('.layui-layer') || document.body;
        target.click();
        return { ok: true, kind: 'layui', text: (layer.innerText || '').replace(/\s+/g, ' ') };
      }
      return { ok: false, reason: '没弹确认框' };
    })
    .catch((e) => ({ ok: false, reason: e.message }));
  if (confirmed.ok) trace(`已确认提交（${confirmed.kind}：${(confirmed.text || '').replace(/\s+/g, ' ').slice(0, 40)}）`);
  else trace(`确认框：${confirmed.reason}`);

  // 等跳转或提示
  const deadline = Date.now() + (opts.timeoutMs ?? 25_000);
  let url = page.url();
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    url = page.url();
    // toSubmitTask 提交成功会跳到 showTask，daily/write 会跳 report
    if (/\/report|\/student\/daily\/report|\/student\/showTask/.test(url)) break;
    const done = await page
      .evaluate(() => /提交成功|批改|已提交/.test(document.body?.innerText || ''))
      .catch(() => false);
    if (done) break;
  }
  return {
    ok: true,
    url,
    redirectedToReport: /\/report/.test(url),
    redirectedToShowTask: /\/student\/showTask/.test(url),
  };
}
