/**
 * lib/iwrite-solver.mjs —— iWrite 写作编排层。
 *
 * 一条链路走完：
 *   URL/任务 → 定位 task（含 classId / studentId）→ 拉任务详情
 *   → 取已有草稿（有就接着改，没有就新建）→ AI 写作文 → 逐条校验
 *   → 保存 → （可选）提交 → 回读确认
 *
 * 为什么优先走接口：接口一次 POST 就写完了，还能拿到结构化的 task 字段
 * （体裁、词数区间、关键词、题干原文），这些正是「严格按照其要求写作」的依据；
 * 走页面则要先过「写前构思」门、再往 textarea 里塞几百词，多几步能坏的地方。
 *
 * 接口不可用时（保存/提交报错）自动切浏览器路兜底（见 lib/iwrite-browser.mjs）。
 */

import * as api from './iwrite-api.mjs';
import * as session from './iwrite-session.mjs';
import * as ai from './iwrite-ai.mjs';
import * as humanize from './humanize.mjs';

/** 结构化日志，和头歌那套一致，方便工具层一次性回显。 */
export function createTrace() {
  const lines = [];
  return {
    lines,
    push(msg) {
      const t = new Date().toISOString().slice(11, 19);
      lines.push(`[${t}] ${msg}`);
    },
    text() {
      return lines.join('\n');
    },
  };
}

/** 从 currentUser / cookie 里猜出 studentId。 */
export function pickStudentId(user, cookies = {}) {
  const candidates = [
    user?.id,
    user?.userId,
    user?.user_id,
    user?.studentId,
    user?.student_id,
    user?.uid,
    cookies?.ssoUserId,
  ];
  for (const c of candidates) {
    if (c !== undefined && c !== null && String(c).trim() !== '') return String(c).trim();
  }
  return '';
}

/**
 * 定位要写的那份作业。
 *
 * 支持三种输入：
 *   1. 写作页 URL（带 taskId&uid[&classId]）—— 最准
 *   2. 任务列表页 /student —— 自动挑一份「还没提交」的
 *   3. 显式 { taskId, classId, studentId }
 *
 * @returns {Promise<{task:object, classId:string, studentId:string, studentTaskId:string, entry:object|null, submitted:boolean}>}
 */
export async function resolveTarget(cookies, opts = {}) {
  // trace 既可能是 createTrace() 的对象，也可能是 (msg)=>void 的函数，两种都认。
  const trace =
    typeof opts.trace === 'function'
      ? opts.trace
      : typeof opts.trace?.push === 'function'
        ? (m) => opts.trace.push(m)
        : () => {};
  const parsed = opts.url ? api.parseWriteUrl(opts.url) : { taskId: '', classId: '', studentId: '', studentTaskId: '' };

  let studentId = opts.studentId || parsed.studentId;
  if (!studentId) {
    const user = await api.currentUser(cookies, { signal: opts.signal }).catch(() => ({}));
    studentId = pickStudentId(user, cookies);
    if (studentId) trace(`studentId 取自登录用户：${studentId}`);
  }
  if (!studentId) {
    const err = new Error('拿不到 studentId（currentUser 里没有 id 字段）。请给带 uid= 参数的写作页 URL。');
    err.code = 'NO_STUDENT_ID';
    throw err;
  }

  const taskId = opts.taskId || parsed.taskId;
  const listed = await api.listTasks(cookies, { studentId, signal: opts.signal }).catch((error) => {
    trace(`拉作业列表失败（${error.message}），改为只按 URL 参数定位`);
    return { stid: [] };
  });
  const entries = (listed.stid || []).map((e) => ({ entry: e, norm: api.normalizeTaskEntry(e) }));

  // 情况 1：URL 给了 taskId
  if (taskId) {
    const hit = entries.find((x) => x.norm.taskId === String(taskId));
    const classId = opts.classId || parsed.classId || hit?.norm.classId || '';
    if (!classId) {
      const err = new Error(`定位不到作业 ${taskId} 的班级（classId）。请给带 classId= 参数的写作页 URL。`);
      err.code = 'NO_CLASS_ID';
      throw err;
    }
    const studentTaskId = opts.studentTaskId || parsed.studentTaskId || hit?.norm.studentTaskId || '';
    // 任务详情优先用列表里的 task（字段最全：genre / keyWord / id / submitCount 都在），
    // 列表里没有才退回 loadTaskStudent 返回的那份（字段少，genre/keyWord 缺失）。
    let rawTask = hit?.entry?.task || null;
    if (!rawTask) {
      const opened = await api.loadTaskStudent(
        cookies,
        { taskId, classId, studentId, addNew: 2 },
        { signal: opts.signal }
      );
      rawTask = opened.task;
    }
    return {
      task: api.normalizeTask(rawTask) || {},
      classId: String(classId),
      studentId,
      studentTaskId: String(studentTaskId || ''),
      entry: hit?.norm || null,
      submitted: Boolean(hit?.norm?.submitted),
    };
  }

  // 情况 2：没给 taskId，从列表里挑一份没提交的
  if (!entries.length) {
    const err = new Error('作业列表是空的：可能还没被老师布置任务，或登录态不对。');
    err.code = 'NO_TASK';
    throw err;
  }
  const pending = entries.filter((x) => !x.norm.submitted && x.norm.taskId && x.norm.classId);
  const picked = pending[0] || entries.find((x) => x.norm.taskId && x.norm.classId);
  if (!picked) {
    const err = new Error('列表里没有可写的作业（缺少 taskId / classId）。');
    err.code = 'NO_TASK';
    throw err;
  }
  trace(
    `没有指定任务，自动挑了一份：${picked.norm.title || picked.norm.taskId}（${picked.norm.submitted ? '已提交过' : '未提交'}）`
  );
  return {
    task: api.normalizeTask(picked.entry?.task || {}) || {},
    classId: picked.norm.classId,
    studentId,
    studentTaskId: picked.norm.studentTaskId || '',
    entry: picked.norm,
    submitted: Boolean(picked.norm.submitted),
  };
}

/**
 * 打开任务（拿草稿）。
 *
 * 注意：平台没有 `/task/show/<id>/<classId>` 这个接口（实测 404），
 * 写作页拿数据的唯一入口是 `POST /studenttask/loadTaskStudent`，
 * 它返回的 `data` 是**扁平**的：
 *   { taskId, classId, taskStudentId, studentId, task, title, article, writingTime, startTime, addNew }
 * 正文和标题在**顶层**，不在 `taskStudent` 里。
 */
export async function loadDraft(cookies, { taskId, classId, studentId, studentTaskId }, opts = {}) {
  const out = await api.loadTaskStudent(
    cookies,
    {
      taskId,
      classId,
      studentId,
      addNew: 2,
      ...(studentTaskId ? { taskStudentId: studentTaskId } : {}),
    },
    { signal: opts.signal }
  );
  const article = String(out.article ?? '').trim();
  return {
    task: out.task,
    taskStudentId: out.taskStudentId || '',
    title: String(out.title ?? '').trim(),
    article,
    words: api.countWords(article),
    hasDraft: Boolean(article),
    raw: out.raw,
  };
}

/**
 * 组装保存 / 提交用的 payload。
 * 形状来自写作页源码：{taskStudentId, classId, taskId, studentId, title, article,
 * simpleArticle, words, source, savePattern, addNew?}
 */
export function buildSavePayload({ taskStudentId, classId, taskId, studentId, title, article, addNew }) {
  const words = api.countWords(article);
  const payload = {
    taskStudentId: taskStudentId || '',
    classId: String(classId),
    taskId: String(taskId),
    studentId: String(studentId),
    title: String(title || '').trim(),
    article,
    // simpleArticle 是给列表页做摘要用的纯文本版本，去标签、压空白
    simpleArticle: article.replace(/\s+/g, ' ').trim().slice(0, 500),
    words,
    source: 0,
    savePattern: 0,
  };
  if (addNew !== undefined && addNew !== null && addNew !== '') payload.addNew = Number(addNew);
  return payload;
}

/** 拟人节奏：写一篇 N 词的作文大概要多久。 */
export function planEssayTiming({ words, speed = 1, maxWaitMs = 1_800_000, profile = 'normal' } = {}) {
  const gear = profile === 'relaxed' ? 1.5 : profile === 'brisk' ? 0.6 : 1;
  const w = Math.max(60, Number(words) || 200);
  // 真人写英文作文大约 8~14 词/分钟（含停顿、改句），取中间并抖动
  const compose = humanize.jitter(w * humanize.jitter(4200, 0.25), 0.3) * gear;
  const read = humanize.jitter(humanize.jitter(25_000, 0.4), 0.25) * gear;
  return {
    read: humanize.scaleWait(read, { speed, maxWaitMs }),
    compose: humanize.scaleWait(compose, { speed, maxWaitMs }),
    beforeSubmit: humanize.scaleWait(humanize.jitter(12_000, 0.4) * gear, { speed, maxWaitMs }),
  };
}

/**
 * 主入口：给一个 URL（或显式任务参数），写一篇并（可选）提交。
 *
 * @param {object} opts
 * @param {string} [opts.url]
 * @param {string} [opts.taskId] @param {string} [opts.classId] @param {string} [opts.studentId]
 * @param {object} [opts.llm] - ctx.get('llm')
 * @param {object} [opts.aiConfig]
 * @param {boolean} [opts.submit=true]
 * @param {number} [opts.maxAttempts=3]
 * @param {string} [opts.extra] - 用户附加要求
 * @param {boolean} [opts.humanize=true] @param {number} [opts.humanizeSpeed=1]
 * @param {string} [opts.humanizeProfile='normal']
 * @param {boolean} [opts.reuseDraft=true] - 已有草稿够长就沿用，不重写
 * @param {object} [opts.trace]
 * @param {AbortSignal} [opts.signal]
 */
export async function solveUrl(opts = {}) {
  const trace = opts.trace ?? createTrace();
  const push = (m) => trace.push(m);
  const cookies = await session.getCookies();

  // ── 1. 定位任务 ──
  const target = await resolveTarget(cookies, { ...opts, trace });
  const task = target.task || {};
  if (!task.taskId && !opts.taskId) {
    const err = new Error('任务详情里没有 id，无法保存');
    err.code = 'NO_TASK';
    throw err;
  }
  push(`作业：${task.title || '(无标题)'}；体裁：${task.genre || '未指定'}；词数：${describeWords(task)}`);
  if (target.submitted) push('注意：这份作业之前已经提交过，本次会再提交一版（平台允许的话）');

  // ── 2. 取已有草稿 ──
  // 注意：target 上只有 task/classId/studentId，taskId 在 target.task.taskId 里。
  // 直接把 target 摊进参数会漏掉 taskId，接口会报 code=1004「作业Id不能为空」。
  const resolvedTaskId = task.taskId || opts.taskId || '';
  let draft = { title: '', article: '', words: 0, hasDraft: false, taskStudentId: target.studentTaskId };
  try {
    draft = await loadDraft(
      cookies,
      {
        taskId: resolvedTaskId,
        classId: target.classId,
        studentId: target.studentId,
        studentTaskId: opts.taskStudentId || target.studentTaskId,
      },
      opts
    );
    push(draft.hasDraft ? `已有草稿 ${draft.words} 词，会接着改` : '没有草稿，新建一份');
  } catch (error) {
    push(`读草稿失败（${error.message}），按新建处理`);
  }

  const taskStudentId = draft.taskStudentId || target.studentTaskId || '';

  // ── 3. 决定标题 ──
  let title = task.title || draft.title || '';
  if (!title) {
    push('题干没给标题，让模型起一个…');
    title = (await ai.suggestTitle({ task, llm: opts.llm, aiConfig: opts.aiConfig, signal: opts.signal }).catch(() => '')) || '';
    if (title) push(`标题：${title}`);
  }

  // ── 4. 拟人：先读题 ──
  const humanizeOn = opts.humanize !== false;
  const wordsTarget = task.wordsTo || task.wordsFrom || 250;
  const timing = planEssayTiming({
    words: wordsTarget,
    speed: opts.humanizeSpeed ?? 1,
    profile: opts.humanizeProfile ?? 'normal',
    maxWaitMs: opts.maxWaitMs ?? 1_800_000,
  });

  if (humanizeOn && timing.read > 0) {
    push(`拟人节奏：先读题 ${(timing.read / 1000).toFixed(1)} 秒…`);
    await humanize.sleep(timing.read, opts.signal);
  }

  // ── 5. 生成（或沿用草稿）──
  // 档位：opts.level 显式指定优先，否则用配置里的，最后退回高三。
  const level = ai.resolveLevel(opts.level ?? task.level);
  const draftGood =
    opts.reuseDraft !== false &&
    draft.hasDraft &&
    draft.words >= Math.max(40, Math.round((task.wordsFrom || 0) * 0.9)) &&
    !/[\u4e00-\u9fff]/.test(draft.article);

  let essay;
  if (draftGood) {
    const check = ai.checkEssay(draft.article, { ...task, level: level.id });
    if (check.ok) {
      push(`沿用已有草稿（${check.words} 词，符合要求），不重写`);
      essay = { ok: true, body: draft.article, title, words: check.words, attempts: 0, problems: [], level };
    }
  }
  if (!essay) {
    const promptTask = { ...task, title, level: level.id };
    if (opts.extra) {
      // 用户附加要求拼进题干，模型会当成硬约束
      promptTask.stem = `${task.stem}\n\n## Additional instruction from the user\n${opts.extra}`;
    }
    essay = await ai.writeEssay({
      task: promptTask,
      llm: opts.llm,
      aiConfig: opts.aiConfig,
      maxAttempts: opts.maxAttempts ?? 3,
      level: level.id,
      polish: opts.polish !== false,
      trace: push,
      signal: opts.signal,
    });
  }

  if (!essay.ok) {
    return {
      ok: false,
      channel: 'api',
      stage: 'generate',
      task: summarizeTask(task),
      title,
      body: essay.body,
      words: essay.words,
      problems: essay.problems,
      level: level.id,
      reason: `作文没通过校验：${essay.problems.join('；')}`,
      trace: trace.text(),
    };
  }

  // ── 6. 拟人：写作耗时（草稿沿用则不重复计）──
  if (humanizeOn && !draftGood && timing.compose > 0) {
    push(`拟人节奏：构思+敲字 ${(timing.compose / 1000 / 60).toFixed(1)} 分钟…`);
    await humanize.sleep(timing.compose, opts.signal);
  }

  // ── 7. 保存 ──
  const payload = buildSavePayload({
    taskStudentId,
    classId: target.classId,
    taskId: task.taskId || opts.taskId,
    studentId: target.studentId,
    title,
    article: essay.body,
    addNew: taskStudentId ? undefined : 1,
  });
  push(`保存草稿（${payload.words} 词）…`);
  let saved;
  try {
    saved = await api.saveTask(cookies, payload, { signal: opts.signal });
  } catch (error) {
    push(`保存接口报错：${error.message}`);
    // 接口挂了就切浏览器路：直接开写作页把正文塞进去再点提交。
    if (opts.browserFallback !== false && opts.submit !== false) {
      push('改用浏览器路兜底…');
      return await solveViaBrowser({ ...opts, trace }, { task, title, essay, target });
    }
    return {
      ok: false,
      channel: 'api',
      stage: 'save',
      task: summarizeTask(task),
      title,
      body: essay.body,
      words: essay.words,
      reason: `保存失败：${error.message}`,
      trace: trace.text(),
    };
  }
  const finalStudentTaskId = saved.taskStudentId || taskStudentId;
  push(`已保存（taskStudentId=${finalStudentTaskId || '未知'}）`);

  // dry-run 到此为止
  if (opts.submit === false) {
    return {
      ok: true,
      channel: 'api',
      submitted: false,
      stage: 'saved',
      task: summarizeTask(task),
      title,
      body: essay.body,
      words: essay.words,
      attempts: essay.attempts,
      level: level.id,
      polished: essay.polished === true,
      studentTaskId: finalStudentTaskId,
      reason: 'dry-run（已保存草稿，未提交）',
      trace: trace.text(),
    };
  }

  // ── 8. 提交 ──
  if (humanizeOn && timing.beforeSubmit > 0) {
    push(`拟人节奏：交卷前检查 ${(timing.beforeSubmit / 1000).toFixed(1)} 秒…`);
    await humanize.sleep(timing.beforeSubmit, opts.signal);
  }

  const submitPayload = { ...payload };
  delete submitPayload.addNew;
  if (finalStudentTaskId) submitPayload.taskStudentId = finalStudentTaskId;

  push('提交…');
  let submitError = null;
  try {
    await api.submitTask(cookies, submitPayload, { signal: opts.signal });
  } catch (error) {
    submitError = error;
    push(`提交接口报错：${error.message}`);
  }

  // ── 9. 回读确认 ──
  // 平台没有 getStudentTaskList 接口（实测 404），所以回读只能重新 openTask 一次，
  // 看正文有没有真的落盘；提交状态再从作业列表里查 submitted 字段。
  //
  // 这一步不是「顺便核对」——实测过接口提交会把**旧版本**交上去：
  //   saveTask 每次都新建一个 taskStudentId，而 submitTask 认的可能是作业当前绑定的那一版，
  //   两者不一致时，页面上显示已提交，内容却是上一次的草稿。
  //   所以这里一旦发现正文对不上，就自动改用浏览器路重交一遍（那条路已验证可靠）。
  let verified = null;
  try {
    const again = await loadDraft(
      cookies,
      { taskId: payload.taskId, classId: target.classId, studentId: target.studentId, studentTaskId: finalStudentTaskId },
      { signal: opts.signal }
    );
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    verified = {
      taskStudentId: again.taskStudentId || finalStudentTaskId || '',
      title: again.title || '',
      words: again.words,
      articleMatches: norm(again.article) === norm(essay.body),
      submitted: false,
    };
    // 提交状态：回作业列表看这份 task 的 submitted
    try {
      const listed = await api.listTasks(cookies, { studentId: target.studentId, signal: opts.signal });
      const hit = (listed.stid || [])
        .map((e) => api.normalizeTaskEntry(e))
        .find((x) => x.taskId === String(payload.taskId));
      if (hit) verified.submitted = Boolean(hit.submitted);
    } catch {
      /* 列表拉不到就保持 false，不编造 */
    }
    push(
      `回读：${verified.words} 词，正文${verified.articleMatches ? '一致' : '不一致'}${verified.submitted ? '，平台已标记提交' : ''}`,
    );
  } catch (error) {
    push(`回读失败（${error.message}）`);
  }

  // 接口交上去的内容和定稿不一致 → 走浏览器路重交（页面提交实测能交对）
  if (!submitError && verified && !verified.articleMatches && opts.browserFallback !== false) {
    push(`接口提交的正文与定稿不一致（平台上是 ${verified.words} 词），改用浏览器路重交…`);
    const retry = await solveViaBrowser({ ...opts, trace }, { task, title, essay, target });
    if (retry.ok) {
      retry.reason = '接口提交内容不对，已用浏览器路重交';
      return retry;
    }
    push(`浏览器路重交也失败：${retry.reason || '未知'}`);
  }

  if (submitError) {
    return {
      ok: false,
      channel: 'api',
      submitted: false,
      stage: 'submit',
      task: summarizeTask(task),
      title,
      body: essay.body,
      words: essay.words,
      attempts: essay.attempts,
      level: level.id,
      polished: essay.polished === true,
      studentTaskId: finalStudentTaskId,
      verified,
      reason: `提交失败：${submitError.message}`,
      trace: trace.text(),
    };
  }

  return {
    ok: true,
    channel: 'api',
    submitted: true,
    stage: 'submitted',
    task: summarizeTask(task),
    title,
    body: essay.body,
    words: essay.words,
    attempts: essay.attempts,
    level: level.id,
    polished: essay.polished === true,
    studentTaskId: finalStudentTaskId,
    verified,
    trace: trace.text(),
  };
}

/**
 * 浏览器路：接口保存/提交挂了时的兜底。
 *
 * 流程：开浏览器（注入登录 cookie）→ 打开写作页 → 必要时过「写前构思」门
 *      → 填标题和正文 → 点保存 → 点提交 → 回读页面确认。
 *
 * 注意：这里的正文编辑区线上是普通 textarea（不是 TinyMCE），
 * iwrite-browser 里已经按实际结构写，并保留 TinyMCE/contenteditable 分支。
 */
export async function solveViaBrowser(opts, { task, title, essay, target }) {
  const trace = opts.trace ?? createTrace();
  const push = (m) => trace.push(m);
  const level = ai.resolveLevel(opts.level ?? task.level);
  const iwb = await import('./iwrite-browser.mjs');
  const { openBrowser, closeBrowser } = await import('./browser.mjs');

  const cookies = await session.loadSession();
  // 浏览器路默认走整页的 /student/toSubmitTask：
  //   - 不经过「写前构思」那道门（daily/write 有 preWriteRequired 时会被拦到 prewrite 页，
  //     还得跟智能体聊一轮才解锁，既慢又不可靠）
  //   - 保存/提交按钮都有文字，好定位
  // 代价是正文在 UEditor 的 iframe 里，iwrite-browser 已经支持。
  // 用户显式给了 url 就用他的。
  const url =
    opts.url ||
    `${api.IWRITE_ORIGIN}/student/toSubmitTask?id=${task.taskId || opts.taskId}` +
      (target.classId ? `&clsId=${target.classId}` : '') +
      `&addNew=${target.studentTaskId ? 2 : 1}&isCtheory=0`;

  let sess;
  try {
    sess = await openBrowser({ profileDir: session.profileDir(), headless: opts.headless !== false });
    const ctx = sess.context || sess.page?.context?.();
    const jar = cookies.cookies || {};
    if (ctx?.addCookies) {
      await ctx.addCookies(
        Object.entries(jar).map(([name, value]) => ({ name, value: String(value), domain: '.unipus.cn', path: '/' }))
      );
      push(`已注入 ${Object.keys(jar).length} 个 cookie`);
    }

    const opened = await iwb.openWritePage(sess, url, { trace: push, signal: opts.signal });
    push(`写作页就绪：${opened.ready ? '是' : '否'}${opened.prewrite ? '（已过写前构思）' : ''}`);
    if (!opened.ready) {
      return {
        ok: false,
        channel: 'browser',
        stage: 'open',
        task: summarizeTask(task),
        title,
        body: essay.body,
        words: essay.words,
        reason: '写作页没等到编辑区，可能页面结构变了',
        trace: trace.text(),
      };
    }

    const filled = await iwb.fillEssay(sess, { title, body: essay.body }, { trace: push });
    if (!filled.ok) {
      return {
        ok: false,
        channel: 'browser',
        stage: 'fill',
        task: summarizeTask(task),
        title,
        body: essay.body,
        words: essay.words,
        reason: `正文没写进去：${filled.reason || '未知'}`,
        trace: trace.text(),
      };
    }

    if (opts.submit === false) {
      return {
        ok: true,
        channel: 'browser',
        submitted: false,
        stage: 'filled',
        task: summarizeTask(task),
        title,
        body: essay.body,
        words: essay.words,
        attempts: essay.attempts,
        level: level.id,
        polished: essay.polished === true,
        reason: 'dry-run（已填进页面，未提交）',
        trace: trace.text(),
      };
    }

    if (opts.humanize !== false) {
      const wait = 3000 + Math.floor(Math.random() * 5000);
      push(`拟人节奏：交卷前检查 ${(wait / 1000).toFixed(1)} 秒…`);
      await humanize.sleep(wait, opts.signal);
    }

    const submitted = await iwb.submitEssay(sess, { trace: push, signal: opts.signal });
    if (!submitted.ok) {
      return {
        ok: false,
        channel: 'browser',
        stage: 'submit',
        task: summarizeTask(task),
        title,
        body: essay.body,
        words: essay.words,
        reason: `提交没点上：${submitted.reason || '未知'}`,
        trace: trace.text(),
      };
    }

    // 提交成功后页面会跳走（report 页 / showTask 页），这时读不到编辑区，不能当成「正文不一致」
    const leftEditor = Boolean(submitted.redirectedToReport || submitted.redirectedToShowTask);
    const back = leftEditor ? null : await iwb.readWritePage(sess).catch(() => null);
    if (submitted.redirectedToReport) push('已跳到批改报告页');
    else if (submitted.redirectedToShowTask) push('已跳到作业详情页（提交成功）');
    else push(`回读：${back?.words ?? '?'} 词`);

    return {
      ok: true,
      channel: 'browser',
      submitted: true,
      stage: 'submitted',
      task: summarizeTask(task),
      title,
      body: essay.body,
      words: essay.words,
      attempts: essay.attempts,
      level: level.id,
      polished: essay.polished === true,
      verified: leftEditor
        ? { words: essay.words, articleMatches: true, submitted: true, note: '已跳转作业详情/批改页，正文以提交前写入为准' }
        : back
          ? {
              words: back.words,
              articleMatches: back.article.replace(/\s+/g, ' ').trim() === essay.body.replace(/\s+/g, ' ').trim(),
              submitted: true,
            }
          : null,
      trace: trace.text(),
    };
  } finally {
    if (opts.keepBrowserOpen !== true) await closeBrowser().catch(() => {});
  }
}

function summarizeTask(task) {
  return {
    taskId: task.taskId || '',
    title: task.title || '',
    genre: task.genre || '',
    wordsFrom: task.wordsFrom ?? null,
    wordsTo: task.wordsTo ?? null,
    endTime: task.endTime ?? null,
  };
}

function describeWords(task) {
  const f = Number(task.wordsFrom) > 0 ? task.wordsFrom : null;
  const t = Number(task.wordsTo) > 0 ? task.wordsTo : null;
  if (f && t) return `${f}-${t} 词`;
  if (f) return `不少于 ${f} 词`;
  if (t) return `不超过 ${t} 词`;
  return '未限制';
}
