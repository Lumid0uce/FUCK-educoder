/**
 * 解题编排层：把「一个 URL」变成「一份可提交的答案」。
 *
 * 两条路，按题目形态自动选：
 *   A. API 路（首选）：解析 URL → 拉 task 详情 JSON → 拿题干和文件 → AI 出代码
 *      → 保存文件 → 触发评测 → 轮询结果。全程结构化，最稳。
 *   B. 浏览器路（兜底）：API 拿不到（比如题型特殊、页面是纯前端渲染），
 *      就开浏览器截图 + 抓 DOM，把题干和编辑器内容喂给 AI，再把代码写回编辑器，
 *      最后点「评测」按钮。
 *
 * 之所以两路都留：头歌题型很多（编程题、选择题、命令行题、远程桌面题），
 * 单一路线覆盖不全；但 API 路对编程题又快又准，所以优先。
 */

import * as api from './educoder-api.mjs';
import * as session from './session.mjs';
import * as ai from './ai.mjs';
import * as humanize from './humanize.mjs';

/** 简易结构化日志收集器，便于工具层一次性回显。 */
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

/**
 * 从任意头歌 URL 里提取定位信息。
 * 支持：
 *   https://www.educoder.net/tasks/<taskId>?homework_common_id=<hw>
 *   https://www.educoder.net/classrooms/<cid>/homework/<hw>/tasks/<taskId>
 *   https://www.educoder.net/shixuns/<sid>/challenges
 */
export function parseTarget(url) {
  const taskId = api.parseTaskId(url);
  const shixunId = api.parseShixunId(url);
  const homeworkCommonId = api.parseHomeworkId(url);
  const courseMatch = /\/classrooms\/([A-Za-z0-9_-]+)/.exec(String(url ?? ''));
  return {
    url,
    taskId,
    shixunId,
    homeworkCommonId,
    courseId: courseMatch?.[1],
  };
}

/**
 * 从同一作业里已经做过的关卡捞几份用户提交过的代码，用来归纳代码风格。
 *
 * 为什么只读已完成/有内容的文件：还没做的关卡里只有老师给的模板，
 * 拿模板当"个人风格"会把 AI 往模板写法上带，反而更可疑。
 *
 * 全程 try/catch 包住——捞样本失败不该影响正常解题。
 *
 * @returns {Promise<Array<{path:string, content:string}>>}
 */
async function collectStyleSamples(opts, target, taskJson, { trace, limit = 4 } = {}) {
  const samples = [];
  try {
    // 走 prev_game 链往回找同一作业里做过的关卡
    let cursor = taskJson?.prev_game;
    const visited = new Set();
    let fetched = 0;
    while (cursor && visited.size < limit && fetched < limit * 2) {
      const id = typeof cursor === 'string' ? cursor : cursor?.identifier ?? cursor?.id;
      if (!id || visited.has(id)) break;
      visited.add(id);
      fetched++;
      let prev;
      try {
        prev = await api.getTask(opts.cookies, id, target.homeworkCommonId, { signal: opts.signal });
      } catch {
        break;
      }
      // 只挑已经通过的关卡（status===2），未通过的是半成品，风格不可靠
      const passed = prev?.game?.status === 2 || prev?.game?.final_score > 0;
      if (passed) {
        for (const f of api.extractFiles(prev)) {
          if (samples.length >= limit) break;
          try {
            const res = await api.readFile(opts.cookies, {
              taskId: id,
              homeworkCommonId: target.homeworkCommonId,
              path: f.path,
              signal: opts.signal,
            });
            const content = res?.content ?? '';
            // 太短的文件（空模板）没有风格信息量
            if (content.trim().length >= 60) samples.push({ path: f.path, content });
          } catch {
            /* 单个文件读不到就算了 */
          }
        }
      }
      cursor = prev?.prev_game;
    }
    if (samples.length) trace.push(`代码风格：从历史关卡捞到 ${samples.length} 份本人代码作样本`);
  } catch (error) {
    trace.push(`代码风格：捞历史样本失败（${error.message}），只用模板骨架`);
  }
  return samples;
}

/**
 * 走 API 路解一道题。
 * @param {object} opts
 * @param {string} opts.url
 * @param {Record<string,string>} opts.cookies
 * @param {object} [opts.llm] - ctx.get('llm')
 * @param {object} [opts.aiConfig]
 * @param {boolean} [opts.submit] - 是否真的提交评测
 * @param {object} [opts.trace]
 * @param {AbortSignal} [opts.signal]
 */
export async function solveViaApi(opts) {
  const trace = opts.trace ?? createTrace();
  const target = parseTarget(opts.url);
  if (!target.taskId) throw new Error(`URL 里找不到任务 id：${opts.url}`);
  trace.push(`目标：task=${target.taskId} hw=${target.homeworkCommonId ?? '(无)'} shixun=${target.shixunId ?? '(无)'}`);

  const taskJson = await api.getTask(opts.cookies, target.taskId, target.homeworkCommonId, { signal: opts.signal });
  const title = api.extractTitle(taskJson);
  const statement = api.extractStatement(taskJson);
  const kind = api.detectKind(taskJson);
  trace.push(`已拉取题目：${title || '(无标题)'}［${kind.label}］，题干 ${statement.length} 字`);
  // 选择题 / 填空题走不了「写代码 + 评测」这条路，但有自己的一套：AI 出答案 → choose_build 提交。
  if (kind.kind === 'choice' || kind.kind === 'fill') {
    return await solveViaApiObjective(opts, target, taskJson, kind, { title, statement, trace });
  }

  const files = api.extractFiles(taskJson);
  trace.push(`题目文件 ${files.length} 个：${files.map((f) => f.path).join(', ') || '(无)'}`);

  // 题干太短（或干脆没有）时，说明这个题型/版本的题干不在 API 里。
  // 这时候开一次浏览器截图，让视觉模型把题读出来——这就是「截图兜底」。
  let vision = null;
  if (opts.vision !== false && statement.trim().length < 40) {
    trace.push(`API 题干只有 ${statement.trim().length} 字，启用截图识题兜底…`);
    vision = await readStatementViaScreenshot(opts, target, { trace });
    if (vision?.text) {
      trace.push(`截图识题：拿到 ${vision.text.length} 字题干（${vision.channel}）`);
    } else {
      trace.push(`截图识题没拿到内容${vision?.reason ? '：' + vision.reason : ''}`);
    }
  }
  const effectiveStatement = vision?.text ? `${statement}\n\n${vision.text}`.trim() : statement;

  // 文件内容可能不在 task 详情里，要单独读一次
  const exerciseId = taskJson?.data?.challenge?.exercise_id ?? taskJson?.data?.exercise_id;
  for (const f of files) {
    if (f.content && f.content.trim()) continue;
    try {
      const res = await api.readFile(opts.cookies, {
        taskId: target.taskId,
        homeworkCommonId: target.homeworkCommonId,
        path: f.path,
        exerciseId,
        signal: opts.signal,
      });
      f.content = res?.content ?? '';
      trace.push(`  读取 ${f.path}：${String(f.content).length} 字`);
    } catch (error) {
      trace.push(`  读取 ${f.path} 失败：${error.message}`);
    }
  }

  // ── 拟人化：先像真人一样"读一会儿题"再动手 ──
  const humanizeOn = opts.humanize !== false;
  const timing = humanize.planTiming({
    kind: 'code',
    fileCount: files.length,
    codeChars: files.reduce((n, f) => n + String(f.content ?? '').length, 0),
    profile: opts.humanizeProfile,
  });
  if (humanizeOn) {
    const wait = humanize.scaleWait(timing.read, {
      speed: opts.humanizeSpeed ?? 1,
      maxWaitMs: opts.maxWaitMs ?? 600_000,
    });
    if (wait > 0) {
      trace.push(`拟人节奏：先读题 ${(wait / 1000).toFixed(1)} 秒…`);
      await humanize.sleep(wait, opts.signal);
    }
  }

  // ── 代码风格画像：从本题模板骨架 + 本课程历史提交里归纳 ──
  let style = null;
  if (opts.styleMatch !== false) {
    const skeletons = files
      .map((f) => ({ path: f.path, content: humanize.extractSkeleton(f.content ?? '') }))
      .filter((s) => s.content && s.content.trim());
    const styleSamples = [...skeletons];
    // 历史样本由调用方（工具层）传进来，因为要额外发请求，不该在这里隐式做。
    for (const s of opts.styleSamples ?? []) {
      if (s?.content && s.content.trim()) styleSamples.push(s);
    }
    // 没显式给就自己从同一作业里已完成的关卡捞几份（只读，不改任何东西）。
    if (!opts.styleSamples?.length && opts.collectStyleSamples !== false) {
      const history = await collectStyleSamples(opts, target, taskJson, { trace, limit: opts.styleSampleTasks ?? 4 });
      styleSamples.push(...history);
    }
    if (styleSamples.length) {
      style = humanize.analyzeStyle(styleSamples);
      const hints = humanize.styleHints(style);
      if (hints) trace.push(`代码风格：已归纳（${style.samples} 份样本）并写进提示词`);
    }
  }

  const styleBlock = humanize.styleHints(style);
  const prompt = ai.buildSolvePrompt({
    title,
    statement: effectiveStatement,
    files,
    extra: [opts.extra, styleBlock].filter(Boolean).join('\n\n') || undefined,
  });
  trace.push('正在请求模型生成代码…');
  const solved = await ai.solve({
    llm: opts.llm,
    config: opts.aiConfig ?? {},
    prompt,
    signal: opts.signal,
  });
  trace.push(`模型返回（${solved.channel}/${solved.route.model}），${solved.text.length} 字`);

  const myshixunId =
    taskJson?.myshixun?.id ??
    taskJson?.data?.myshixun?.id ??
    taskJson?.data?.game?.myshixun_id ??
    taskJson?.game?.myshixun_id;
  // 真实字段是 game.id（关卡实例 id），不是 challenge.game_id —— 后者不存在。
  const gameId =
    taskJson?.game?.id ??
    taskJson?.data?.game?.id ??
    taskJson?.data?.challenge?.game_id ??
    target.taskId;

  // ── 保存 / 评测要的那一堆真实参数 ──
  // 头歌的保存接口 URL 里要的是 myshixun 的 identifier（字符串，如 `ajlk5ovpzr`），
  // 不是数字 id；query 里的 zzud 要用户的 login。少一个平台就静默不写盘。
  const myshixunIdentifier =
    taskJson?.myshixun?.identifier ?? taskJson?.data?.myshixun?.identifier ?? null;
  const zzud = taskJson?.user?.login ?? taskJson?.data?.user?.login ?? '';
  const currentUserId = taskJson?.user?.user_id ?? taskJson?.data?.user?.user_id ?? '';
  const challengeId = taskJson?.challenge?.id ?? taskJson?.data?.challenge?.id ?? '';
  const secKey = taskJson?.sec_key ?? taskJson?.data?.sec_key ?? '';
  const shixunEnvironmentId =
    taskJson?.shixun_environments?.[0]?.shixun_environment_id ??
    taskJson?.data?.shixun_environments?.[0]?.shixun_environment_id ??
    null;
  trace.push(
    `关卡参数：myshixun=${myshixunIdentifier ?? '(无)'} game=${gameId} challenge=${challengeId || '(无)'} ` +
      `zzud=${zzud || '(无)'}`,
  );

  // 最多试 maxAttempts 轮：评测失败就把报错回喂给模型重写。
  // 头歌的报错通常很有用（编译错误 / 用例期望值），不利用就白瞎了。
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
  const attempts = [];
  let currentText = solved.text;
  let finalWrites = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const parsed = ai.extractCode(currentText);
    const writes = [];
    if (parsed.files) {
      for (const [path, code] of Object.entries(parsed.files)) writes.push({ path, code });
    } else if (parsed.code) {
      writes.push({ path: files[0]?.path ?? 'main', code: parsed.code });
    }
    if (!writes.length) throw new Error('模型回复里没解析出代码块');

    // 把风格画像套上去（只改缩进和 #include 空格，改坏了会自动回退）。
    if (style && opts.styleMatch !== false) {
      for (const w of writes) {
        const r = humanize.applyStyle(w.code, style);
        if (r.changed) {
          trace.push(`第 ${attempt} 轮：${w.path} 已按个人风格调整（缩进/${style.indent ?? '原样'}）`);
          w.code = r.code;
        } else if (r.reason) {
          trace.push(`第 ${attempt} 轮：${w.path} 风格未调整（${r.reason}）`);
        }
      }
    }
    finalWrites = writes;

    const results = [];
    for (const w of writes) {
      if (!opts.submit) {
        results.push({ path: w.path, saved: false, reason: 'dry-run（未提交）', code: w.code });
        continue;
      }
      if (!myshixunIdentifier && !myshixunId) {
        results.push({ path: w.path, saved: false, reason: '拿不到 myshixun identifier，无法保存文件' });
        continue;
      }
      // 拟人化：真人敲完代码不会立刻点保存/评测，中间有停顿。
      if (humanizeOn) {
        const wait = humanize.scaleWait(timing.beforeSave, {
          speed: opts.humanizeSpeed ?? 1,
          maxWaitMs: opts.maxWaitMs ?? 600_000,
        });
        if (wait > 0) {
          trace.push(`拟人节奏：写完停 ${(wait / 1000).toFixed(1)} 秒再提交…`);
          await humanize.sleep(wait, opts.signal);
        }
      }
      try {
        await api.saveFile(opts.cookies, {
          myshixunIdentifier,
          myshixunId,
          taskId: target.taskId,
          path: w.path,
          content: w.code,
          homeworkCommonId: target.homeworkCommonId,
          gameId,
          challengeId,
          zzud,
          currentUserId,
          signal: opts.signal,
        });
        trace.push(`第 ${attempt} 轮：已保存 ${w.path}`);
        results.push({ path: w.path, saved: true, code: w.code });
      } catch (error) {
        trace.push(`第 ${attempt} 轮：保存 ${w.path} 失败：${error.message}`);
        results.push({ path: w.path, saved: false, reason: error.message });
      }
    }

    if (!opts.submit || !results.some((r) => r.saved)) {
      attempts.push({ attempt, results, build: null });
      break;
    }

    // 保存和评测之间也有停顿：真人会再看一眼代码。
    if (humanizeOn) {
      const wait = humanize.scaleWait(timing.beforeBuild, {
        speed: opts.humanizeSpeed ?? 1,
        maxWaitMs: opts.maxWaitMs ?? 600_000,
      });
      if (wait > 0) {
        trace.push(`拟人节奏：自查 ${(wait / 1000).toFixed(1)} 秒再点评测…`);
        await humanize.sleep(wait, opts.signal);
      }
    }

    let build;
    try {
      build = await api.buildTask(opts.cookies, {
        taskId: target.taskId,
        secKey,
        challengeId,
        homeworkCommonId: target.homeworkCommonId,
        zzud,
        currentUserId,
        shixunEnvironmentId,
        first: attempt === 1 ? 1 : '',
        signal: opts.signal,
      });
      trace.push(`第 ${attempt} 轮：已触发评测`);
    } catch (error) {
      trace.push(`第 ${attempt} 轮：触发评测失败：${error.message}`);
      attempts.push({ attempt, results, build: { error: error.message } });
      break;
    }

    // 轮询评测结果（打 game_status.json，和前端一致）
    let verdict;
    try {
      verdict = await api.waitBuildResult(opts.cookies, {
        taskId: target.taskId,
        challengeId,
        homeworkCommonId: target.homeworkCommonId,
        zzud,
        secKey: build?.data?.sec_key ?? build?.sec_key ?? secKey,
        timeoutMs: opts.buildTimeoutMs ?? 240_000,
        signal: opts.signal,
        onTick: (v) => {
          if (v.state !== 'pending') return;
          // 评测期间接口只回 running_code_status/running_code_message，没有用例数，
          // 所以别硬拼 "0/0"，直接把平台的原话透出来。
          const msg = v.running?.message ? `（${v.running.message}）` : '';
          trace.push(`  评测中…${v.total ? `${v.passed}/${v.total}` : ''}${msg}`);
        },
      });
    } catch (error) {
      trace.push(`第 ${attempt} 轮：等待评测结果失败：${error.message}`);
      attempts.push({ attempt, results, build, verdict: { state: 'unknown', error: error.message } });
      break;
    }

    attempts.push({ attempt, results, build, verdict });
    trace.push(`第 ${attempt} 轮结果：${verdict.state}${verdict.total ? `（${verdict.passed}/${verdict.total}）` : ''}`);

    if (verdict.state === 'pass') break;
    if (attempt === maxAttempts) break;

    // 失败 → 把报错回喂给模型重写
    const feedback = [
      verdict.cases
        .filter((c) => !c.passed)
        .map((c) => `用例 ${c.index + 1} ${c.name}：${c.message || '(无输出)'}`)
        .join('\n'),
      verdict.compileOutput ? `编译器输出：\n${verdict.compileOutput}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    trace.push(`正在把评测报错回喂给模型（第 ${attempt + 1} 轮重写）…`);
    // 拟人化：改 bug 是慢活，真人不会 3 秒就改完重交。
    if (humanizeOn && typeof timing.retryBackoff === 'function') {
      const wait = humanize.scaleWait(timing.retryBackoff(attempt), {
        speed: opts.humanizeSpeed ?? 1,
        maxWaitMs: opts.maxWaitMs ?? 600_000,
      });
      if (wait > 0) {
        trace.push(`拟人节奏：改 bug 停 ${(wait / 1000).toFixed(1)} 秒…`);
        await humanize.sleep(wait, opts.signal);
      }
    }
    const retryPrompt = ai.buildSolvePrompt({
      title,
      statement,
      files,
      extra: [
        `上一轮提交的代码：\n\`\`\`\n${finalWrites[0]?.code ?? ''}\n\`\`\`\n\n评测没有通过，报错如下：\n${feedback || '(平台没有给出具体报错)'}\n\n请针对报错修正，重新给出完整代码。`,
        styleBlock,
      ]
        .filter(Boolean)
        .join('\n\n'),
    });
    const retried = await ai.solve({
      llm: opts.llm,
      config: opts.aiConfig ?? {},
      prompt: retryPrompt,
      signal: opts.signal,
    });
    currentText = retried.text;
    trace.push(`重写返回 ${retried.text.length} 字`);
  }

  const last = attempts[attempts.length - 1] ?? {};
  const verdict = last.verdict;
  return {
    ok: verdict ? verdict.state === 'pass' || verdict.state === 'unknown' : true,
    passed: verdict?.state === 'pass',
    channel: 'api',
    target,
    title,
    statement: ai.truncate(statement, 2000),
    files: files.map((f) => ({ path: f.path, chars: String(f.content ?? '').length })),
    writes: last.results ?? finalWrites.map((w) => ({ ...w, saved: false })),
    build: last.build ?? null,
    verdict,
    attempts: attempts.map((a) => ({ attempt: a.attempt, state: a.verdict?.state ?? 'no-build', passed: a.verdict?.passed })),
    modelText: currentText,
    trace: trace.text(),
  };
}

/**
 * 客观题（选择题 / 填空题）的 API 路。
 *
 * 和编程题的区别：不用写文件、不用 buildTask，直接 POST choose_build.json 交答案。
 * 但两者共用同一个提交接口，区别只在 answer 的形状：
 *   - 选择题：["A","B","C",...]          每题一个选项字母（多选拼起来，如 "AC"）
 *   - 填空题：[["\n","\""],["5"],...]     每题一个数组，一个空一个字符串
 */
async function solveViaApiObjective(opts, target, taskJson, kind, { title, statement, trace }) {
  const chooses = api.extractChooses(taskJson);
  const challengeId = taskJson?.challenge?.id ?? taskJson?.data?.challenge?.id ?? '';
  const zzud = taskJson?.user?.login ?? taskJson?.data?.user?.login ?? '';

  trace.push(`这是${kind.label}，共 ${chooses.length} 道小题；走 choose_build 接口作答。`);
  if (!chooses.length) {
    return {
      ok: false,
      passed: false,
      channel: 'api',
      target,
      title,
      kind: kind.kind,
      reason: '接口里没有解析出小题，可能是题型不支持或页面需要手动加载。',
      trace,
    };
  }
  if (!challengeId) {
    return {
      ok: false,
      passed: false,
      channel: 'api',
      target,
      title,
      kind: kind.kind,
      reason: '拿不到 challenge_id，无法提交客观题。',
      trace,
    };
  }

  const prompt = ai.buildObjectivePrompt({
    kind: kind.kind,
    label: kind.label,
    title,
    chooses,
    statement,
  });

  // 拟人化：客观题也要"看题 + 想一会儿"，不能 1 秒交卷。
  const humanizeOn = opts.humanize !== false;
  const timing = humanize.planTiming({ kind: kind.kind, profile: opts.humanizeProfile });
  if (humanizeOn) {
    const readWait = humanize.scaleWait(timing.read, {
      speed: opts.humanizeSpeed ?? 1,
      maxWaitMs: opts.maxWaitMs ?? 600_000,
    });
    if (readWait > 0) {
      trace.push(`拟人节奏：先看题 ${(readWait / 1000).toFixed(1)} 秒…`);
      await humanize.sleep(readWait, opts.signal);
    }
  }

  trace.push('正在请求模型给出答案…');
  const solved = await ai.solve({
    llm: opts.llm,
    config: opts.aiConfig ?? {},
    system: ai.OBJECTIVE_SYSTEM,
    prompt,
    maxTokens: opts.aiConfig?.maxTokens ?? 8192,
    temperature: 0.1,
    signal: opts.signal,
  });
  trace.push(`模型返回（${solved.channel}/${solved.route.model}），${solved.text.length} 字`);

  const answers = ai.extractObjectiveAnswers(solved.text, chooses.length);
  if (!answers) {
    trace.push('模型回复里没解析出合法答案（要求 JSON 数组，长度与题目数一致）');
    return {
      ok: false,
      passed: false,
      channel: 'api',
      target,
      title,
      kind: kind.kind,
      chooses: chooses.map((c) => ({ index: c.index, question: ai.truncate(c.question, 160) })),
      reason: '模型没按要求输出 JSON 答案，无法提交。可以重跑一次，或把题干和选项贴给模型手动作答。',
      modelText: ai.truncate(solved.text, 2000),
      trace,
    };
  }

  // 填空题的答案形状校验：一个空一个字符串，空数要和 multi_count 对上
  if (kind.kind === 'fill') {
    for (let i = 0; i < answers.length; i++) {
      if (!Array.isArray(answers[i])) answers[i] = [String(answers[i])];
      const want = chooses[i]?.multiCount;
      if (want && answers[i].length !== want) {
        trace.push(`第 ${i + 1} 题应有 ${want} 个空，模型给了 ${answers[i].length} 个（照提交，平台可能判错）`);
      }
    }
  }

  const answerPreview = answers
    .map((a, i) => `  ${i + 1}. ${Array.isArray(a) ? JSON.stringify(a) : a}`)
    .join('\n');
  trace.push(`答案：\n${answerPreview}`);

  if (!opts.submit) {
    return {
      ok: true,
      passed: undefined,
      channel: 'api',
      target,
      title,
      kind: kind.kind,
      chooses: chooses.map((c) => ({
        index: c.index,
        question: ai.truncate(c.question, 160),
        options: c.options?.map((o) => `${o.label}. ${ai.truncate(o.text, 80)}`),
      })),
      answers,
      reason: 'dry-run（未提交）',
      trace,
    };
  }

  const body = {
    answer: answers,
    challenge_id: challengeId,
    subject_id: '',
    question_id: null,
    competition_entry_id: null,
    smart_plan_page_item_bank_id: null,
    homework_common_id: String(target.homeworkCommonId ?? ''),
  };

  let result;
  try {
    // 拟人化：答案想好了，也要停一下再交，别和"看题"无缝衔接。
    if (humanizeOn) {
      const thinkWait = humanize.scaleWait(timing.think, {
        speed: opts.humanizeSpeed ?? 1,
        maxWaitMs: opts.maxWaitMs ?? 600_000,
      });
      if (thinkWait > 0) {
        trace.push(`拟人节奏：想 ${(thinkWait / 1000).toFixed(1)} 秒再交卷…`);
        await humanize.sleep(thinkWait, opts.signal);
      }
    }
    result = await api.submitChoice(opts.cookies, {
      taskId: target.taskId,
      zzud,
      body,
      signal: opts.signal,
    });
    trace.push(`已提交答案（choose_build 返回 status=${result?.status ?? '(无)'}）`);
  } catch (error) {
    trace.push(`提交答案失败：${error.message}`);
    return {
      ok: false,
      passed: false,
      channel: 'api',
      target,
      title,
      kind: kind.kind,
      answers,
      reason: `提交失败：${error.message}`,
      trace,
    };
  }

  // 交完重新拉一次 task 详情，用 game.status 交叉验证（有的版本 choose_build 不回成绩）
  let refreshed;
  try {
    refreshed = await api.getTask(opts.cookies, target.taskId, target.homeworkCommonId, { signal: opts.signal });
  } catch {}
  const verdict = api.readChoiceResult(result, refreshed);
  trace.push(
    `结果：${verdict.state}` +
      (verdict.maxScore ? `（得分 ${verdict.finalScore ?? '?'}/${verdict.maxScore}，得分率 ${verdict.radio ?? '?'}）` : '') +
      `${verdict.message ? `；平台说：${verdict.message}` : ''}`,
  );

  return {
    ok: verdict.state !== 'fail',
    passed: verdict.state === 'pass' ? true : verdict.state === 'fail' ? false : undefined,
    channel: 'api',
    target,
    title,
    kind: kind.kind,
    statement: ai.truncate(statement, 2000),
    chooses: chooses.map((c) => ({
      index: c.index,
      question: ai.truncate(c.question, 160),
      options: c.options?.map((o) => `${o.label}. ${ai.truncate(o.text, 80)}`),
    })),
    answers,
    verdict,
    reason:
      verdict.state === 'unknown'
        ? '已提交，但平台没回可判定的成绩。去网页上看一眼「测试结果」面板确认。'
        : undefined,
    trace,
  };
}

/**
 * 截图识题兜底：开一次浏览器，把页面截下来，交给视觉模型读成文字。
 *
 * 只在 API 题干明显缺失时才走这条路（题干是准确的文本，截图反而有 OCR 误差），
 * 所以它是兜底，不是主路径。跑完立刻关浏览器，避免占住 profile。
 *
 * @param {object} opts - solveUrl 的 opts（要 llm / aiConfig / browserOpts）
 * @param {object} target - parseTarget 的结果
 * @param {{trace: object}} ctx
 * @returns {Promise<{text?: string, channel?: string, screenshot?: string, reason?: string}>}
 */
export async function readStatementViaScreenshot(opts, target, { trace }) {
  const { openBrowser, closeBrowser, goto, screenshot } = await import('./browser.mjs');
  let sess;
  try {
    sess = await openBrowser(opts.browserOpts);
    await goto(sess, opts.url, { timeoutMs: 60_000 });
    // 头歌是 SPA，正文渲染要时间；浏览器层已内置 settle，这里再稳一下
    await new Promise((r) => setTimeout(r, 2000));
    const shot = await screenshot(sess, {});
    trace.push(`截图识题：已截图 ${Math.round(shot.bytes / 1024)} KB`);

    const { prepareImages } = await import('./images.mjs');
    const prepared = await prepareImages({
      llm: opts.llm,
      aiConfig: opts.aiConfig ?? {},
      attachments: opts.attachments,
      paths: [shot.path],
      maxImages: 1,
    });
    for (const note of prepared.notes) trace.push(`  截图识题：${note}`);

    if (!prepared.images.length && !prepared.httpImages.length) {
      return { screenshot: shot.path, reason: '没有可用的图像通道（宿主模型不支持图片，也没配 HTTP 兜底）' };
    }
    // 宿主模型吃不了图、又没配 HTTP 兜底时，图片实际发不出去。
    // 这时候硬调一次模型只会拿到一段瞎编的"题干"，必须提前止损。
    const httpReady = Boolean((opts.aiConfig?.baseURL || '').trim() && (opts.aiConfig?.apiKey || '').trim());
    if (!prepared.images.length && !httpReady) {
      return { screenshot: shot.path, reason: '宿主模型不支持图片输入，且没有配置 ai.baseURL/apiKey，无法识题' };
    }

    const out = await ai.readStatementFromImages({
      llm: opts.llm,
      config: opts.aiConfig ?? {},
      prompt: `这是头歌（Educoder）的关卡页面截图，题目在左侧栏。请把题目内容转写成文字。`,
      images: prepared.images,
      httpImages: prepared.httpImages,
      signal: opts.signal,
    });
    return { text: out.text, channel: out.channel, screenshot: shot.path };
  } catch (error) {
    return { reason: error.message };
  } finally {
    if (sess) await closeBrowser().catch(() => {});
  }
}

/**
 * 走浏览器路：截图 + 抓 DOM + 写编辑器 + 点评测。
 * 适合 API 拿不到结构的题，或者用户就是想「看着它做」。
 * @param {object} opts - {url, llm, aiConfig, submit, trace, signal, browserOpts}
 */
export async function solveViaBrowser(opts) {
  const trace = opts.trace ?? createTrace();
  const { openBrowser, closeBrowser } = await import('./browser.mjs');

  const sess = await openBrowser(opts.browserOpts);
  // 解完就关窗口：否则每次 solve 都在桌面上留一个 Edge，而且它占着 profile 目录，
  // 下次 CLI / 另一个进程启动会直接撞上 Chromium 的 user-data-dir 锁。
  try {
    return await solveViaBrowserInner(opts, { trace, sess });
  } finally {
    if (opts.keepBrowserOpen !== true) await closeBrowser().catch(() => {});
  }
}

async function solveViaBrowserInner(opts, { trace, sess }) {
  const { goto, pageSnapshot, screenshot, fillEditor, clickByText, readObjective } = await import(
    './browser.mjs'
  );
  await goto(sess, opts.url, { timeoutMs: 60000 });
  await new Promise((r) => setTimeout(r, 2500));
  trace.push(`已打开 ${opts.url}`);

  const snap = await pageSnapshot(sess, { maxChars: 20000, editorTimeoutMs: 30000 });
  trace.push(`页面标题：${snap.title}；正文 ${snap.text.length} 字；编辑器 ${snap.editors.length} 个`);

  const shot = await screenshot(sess, {});
  trace.push(`截图：${shot.path}（${Math.round(shot.bytes / 1024)} KB）`);

  // 先看是不是客观题（选择题/填空题）。
  // 注意：必须先于编辑器判断 —— 填空题的页面就是一堆 textarea，
  // probeEditors 的 textarea 兜底会把它当成"有 1 个编辑器"，
  // 先判编辑器就会把填空题误当成编程题去写代码。
  const objective = await readObjective(sess, { timeoutMs: 15000 }).catch(() => null);
  if (objective?.items?.length) {
    return await solveViaBrowserObjective(opts, { trace, sess, objective, snap, shot });
  }

  if (!snap.editors.length) {
    return {
      ok: false,
      channel: 'browser',
      reason: '页面上既没有代码编辑器，也没有选择题/填空题的答题区，可能是命令行题或尚未进入关卡',
      snapshot: { url: snap.url, title: snap.title, buttons: snap.buttons.slice(0, 20) },
      screenshot: shot.path,
      trace: trace.text(),
    };
  }

  // ── 拟人化（浏览器路）：读题停顿 + 风格对齐 ──
  const humanizeOn = opts.humanize !== false;
  const timing = humanize.planTiming({
    kind: 'code',
    fileCount: snap.editors.length,
    codeChars: snap.editors.reduce((n, e) => n + String(e.value ?? '').length, 0),
    profile: opts.humanizeProfile,
  });
  if (humanizeOn) {
    const wait = humanize.scaleWait(timing.read, {
      speed: opts.humanizeSpeed ?? 1,
      maxWaitMs: opts.maxWaitMs ?? 600_000,
    });
    if (wait > 0) {
      trace.push(`拟人节奏：先读题 ${(wait / 1000).toFixed(1)} 秒…`);
      await humanize.sleep(wait, opts.signal);
    }
  }

  // 风格画像：浏览器路拿不到历史提交（要走 API），只从编辑器里的模板骨架归纳。
  let style = null;
  if (opts.styleMatch !== false) {
    const skeletons = snap.editors
      .map((e) => ({ content: humanize.extractSkeleton(e.value ?? '') }))
      .filter((s) => s.content && s.content.trim());
    if (skeletons.length) {
      style = humanize.analyzeStyle(skeletons);
      if (humanize.styleHints(style)) trace.push(`代码风格：已从编辑器模板归纳（${style.samples} 份）`);
    }
  }

  const prompt = ai.buildSolvePrompt({
    title: snap.title,
    statement: snap.text,
    files: snap.editors.map((e, i) => ({
      path: `editor[${i}]${e.language ? '.' + e.language : ''}`,
      content: e.value,
      language: e.language,
    })),
    extra: [opts.extra, humanize.styleHints(style)].filter(Boolean).join('\n\n') || undefined,
  });
  // 正文太短说明题目没渲染进 DOM（纯图、canvas、或还没加载完），
  // 这时候把截图一起喂给模型，让它直接看图。
  let images = [];
  let httpImages = [];
  if (snap.text.trim().length < 200) {
    const { prepareImages } = await import('./images.mjs');
    const prepared = await prepareImages({
      llm: opts.llm,
      aiConfig: opts.aiConfig ?? {},
      attachments: opts.attachments,
      paths: [shot.path],
      maxImages: 1,
    });
    images = prepared.images;
    httpImages = prepared.httpImages;
    for (const note of prepared.notes) trace.push(`  截图辅助：${note}`);
    if (images.length || httpImages.length) trace.push('页面正文偏少，把截图一起交给模型看');
  }

  trace.push('正在请求模型生成代码…');
  const solved = await ai.solve({
    llm: opts.llm,
    config: opts.aiConfig ?? {},
    prompt,
    images,
    httpImages,
    signal: opts.signal,
  });
  const parsed = ai.extractCode(solved.text);
  let code = parsed.code ?? Object.values(parsed.files ?? {})[0];
  if (!code) throw new Error('模型回复里没解析出代码块');

  // 风格对齐（只改空白，改坏了自动回退）
  if (style && opts.styleMatch !== false) {
    const r = humanize.applyStyle(code, style);
    if (r.changed) {
      trace.push('已按个人风格调整缩进/花括号');
      code = r.code;
    } else if (r.reason) {
      trace.push(`风格未调整（${r.reason}）`);
    }
  }

  // 拟人化：写完停一下再点提交
  if (humanizeOn) {
    const wait = humanize.scaleWait(timing.beforeSave, {
      speed: opts.humanizeSpeed ?? 1,
      maxWaitMs: opts.maxWaitMs ?? 600_000,
    });
    if (wait > 0) {
      trace.push(`拟人节奏：写完停 ${(wait / 1000).toFixed(1)} 秒…`);
      await humanize.sleep(wait, opts.signal);
    }
  }

  const filled = await fillEditor(sess, { code, index: 0 });
  if (!filled.ok) {
    trace.push(`写入编辑器失败：${filled.reason ?? '未知原因'}`);
  } else {
    trace.push(`已写入编辑器：${filled.method}${filled.verified ? '（回读一致）' : '（未校验）'}`);
  }

  let evaluated = false;
  let verdict;
  if (opts.submit) {
    // 拟人化：自查一会儿再点评测
    if (humanizeOn) {
      const wait = humanize.scaleWait(timing.beforeBuild, {
        speed: opts.humanizeSpeed ?? 1,
        maxWaitMs: opts.maxWaitMs ?? 600_000,
      });
      if (wait > 0) {
        trace.push(`拟人节奏：自查 ${(wait / 1000).toFixed(1)} 秒再点评测…`);
        await humanize.sleep(wait, opts.signal);
      }
    }
    // 头歌不同版本的按钮文案不一样，逐个试；clickByText 自己会轮询等元素出现。
    let clicked = { ok: false };
    for (const label of ['评测', '运行', '提交评测', '提交', '编译运行']) {
      clicked = await clickByText(sess, { text: label, timeoutMs: 8000 });
      if (clicked.ok) {
        trace.push(`点击「${label}」按钮：${clicked.selector}`);
        break;
      }
    }
    if (!clicked.ok) {
      trace.push('没找到评测/运行按钮，代码已写入但未提交');
    } else {
      evaluated = true;
      // 等结果。优先用接口读（浏览器里已有登录态，比页面文字准得多），
      // 接口拿不到再退回页面文字判定。
      verdict = await pollVerdictViaApi(sess, opts, trace);
      if (!verdict) {
        verdict = await pollPageVerdict(sess, { trace, timeoutMs: opts.buildTimeoutMs ?? 120_000, signal: opts.signal });
      }
    }
  }

  const after = await screenshot(sess, {});
  return {
    ok: verdict ? verdict.state !== 'fail' : true,
    passed: verdict?.state === 'pass' ? true : verdict?.state === 'fail' ? false : undefined,
    channel: 'browser',
    title: snap.title,
    code,
    filled,
    evaluated,
    verdict,
    screenshot: after.path,
    modelText: solved.text,
    trace: trace.text(),
  };
}

/**
 * 浏览器路的客观题（选择题 / 填空题）：读 DOM 出题 → AI 作答 → 点页面填 → 点评测。
 *
 * 和 API 路的区别：这里不碰 choose_build 接口，完全模拟人在页面上点选/输入，
 * 再点「评测」交卷。适合 API 拿不到 chooses、或者用户就是要"看着它做"的场景。
 */
async function solveViaBrowserObjective(opts, { trace, sess, objective, snap, shot }) {
  const { answerObjective, clickByText, screenshot } = await import('./browser.mjs');

  const isChoice = objective.kind === 'choice';
  const label = isChoice ? '选择题' : '填空题';
  const items = objective.items;

  trace.push(`页面是${label}，共 ${items.length} 道小题（页面直接解析，不走接口）`);
  if (items.some((x) => x.type === 'unknown')) {
    trace.push(`注意：有 ${items.filter((x) => x.type === 'unknown').length} 道小题没认出题型，可能答不上`);
  }

  // 转成和 API 路一样的 chooses 结构，复用同一个提示词
  const chooses = items.map((it) => ({
    index: it.index,
    question: it.question,
    multiCount: isChoice ? 1 : it.blankCount,
    options: it.options,
  }));

  const prompt = ai.buildObjectivePrompt({
    kind: objective.kind,
    label,
    title: snap.title,
    chooses,
    statement: '',
  });

  const humanizeOn = opts.humanize !== false;
  const timing = humanize.planTiming({ kind: objective.kind, profile: opts.humanizeProfile });
  if (humanizeOn) {
    const readWait = humanize.scaleWait(timing.read, {
      speed: opts.humanizeSpeed ?? 1,
      maxWaitMs: opts.maxWaitMs ?? 600_000,
    });
    if (readWait > 0) {
      trace.push(`拟人节奏：先看题 ${(readWait / 1000).toFixed(1)} 秒…`);
      await humanize.sleep(readWait, opts.signal);
    }
  }

  trace.push('正在请求模型给出答案…');
  const solved = await ai.solve({
    llm: opts.llm,
    config: opts.aiConfig ?? {},
    system: ai.OBJECTIVE_SYSTEM,
    prompt,
    maxTokens: opts.aiConfig?.maxTokens ?? 8192,
    temperature: 0.1,
    signal: opts.signal,
  });
  trace.push(`模型返回（${solved.channel}/${solved.route.model}），${solved.text.length} 字`);

  const answers = ai.extractObjectiveAnswers(solved.text, items.length);
  if (!answers) {
    return {
      ok: false,
      passed: false,
      channel: 'browser',
      kind: objective.kind,
      title: snap.title,
      chooses: chooses.map((c) => ({ index: c.index, question: ai.truncate(c.question, 160) })),
      reason: '模型没按要求输出 JSON 答案，无法作答。',
      modelText: ai.truncate(solved.text, 2000),
      screenshot: shot.path,
      trace: trace.text(),
    };
  }

  // 填空题：统一成「一题一个数组」
  if (!isChoice) {
    for (let i = 0; i < answers.length; i++) {
      if (!Array.isArray(answers[i])) answers[i] = [String(answers[i])];
      const want = items[i]?.blankCount;
      if (want && answers[i].length !== want) {
        trace.push(`第 ${i + 1} 题有 ${want} 个空，模型给了 ${answers[i].length} 个（照填，可能判错）`);
      }
    }
  }

  trace.push(
    `答案：\n${answers
      .map((a, i) => `  ${i + 1}. ${Array.isArray(a) ? JSON.stringify(a) : a}`)
      .join('\n')}`,
  );

  if (!opts.submit) {
    return {
      ok: true,
      passed: undefined,
      channel: 'browser',
      kind: objective.kind,
      title: snap.title,
      chooses: chooses.map((c) => ({
        index: c.index,
        question: ai.truncate(c.question, 160),
        options: c.options?.map((o) => `${o.label}. ${ai.truncate(o.text, 80)}`),
      })),
      answers,
      reason: 'dry-run（未提交）',
      screenshot: shot.path,
      trace: trace.text(),
    };
  }

  // 拟人化：想一会儿再动手填
  if (humanizeOn) {
    const thinkWait = humanize.scaleWait(timing.think, {
      speed: opts.humanizeSpeed ?? 1,
      maxWaitMs: opts.maxWaitMs ?? 600_000,
    });
    if (thinkWait > 0) {
      trace.push(`拟人节奏：想 ${(thinkWait / 1000).toFixed(1)} 秒再填…`);
      await humanize.sleep(thinkWait, opts.signal);
    }
  }

  const filled = await answerObjective(sess, { kind: objective.kind, answers });
  const okCount = (filled.report ?? []).filter((r) => r.ok).length;
  trace.push(
    `已在页面上作答：${okCount}/${items.length} 题` +
      (filled.ok ? '（全部填好）' : `（有 ${items.length - okCount} 题没填成功）`),
  );
  for (const r of filled.report ?? []) {
    if (!r.ok) trace.push(`  第 ${r.index + 1} 题没填成功：${r.reason ?? '未知原因'}`);
    else if (r.picked) trace.push(`  第 ${r.index + 1} 题选了 ${r.picked}（已勾选 ${r.checked} 个）`);
    else if (r.written) trace.push(`  第 ${r.index + 1} 题填了 ${r.written}/${r.blanks} 个空`);
  }

  if (!okCount) {
    return {
      ok: false,
      passed: false,
      channel: 'browser',
      kind: objective.kind,
      title: snap.title,
      answers,
      reason: '页面上一个答案都没填进去，可能 DOM 结构和预期不符',
      screenshot: shot.path,
      trace: trace.text(),
    };
  }

  // 点「评测」交卷
  if (humanizeOn) {
    const wait = humanize.scaleWait(timing.beforeBuild, {
      speed: opts.humanizeSpeed ?? 1,
      maxWaitMs: opts.maxWaitMs ?? 600_000,
    });
    if (wait > 0) {
      trace.push(`拟人节奏：检查一遍 ${(wait / 1000).toFixed(1)} 秒再交…`);
      await humanize.sleep(wait, opts.signal);
    }
  }

  let clicked = { ok: false };
  for (const btn of ['评测', '提交', '交卷', '保存']) {
    clicked = await clickByText(sess, { text: btn, timeoutMs: 8000 });
    if (clicked.ok) {
      trace.push(`点击「${btn}」按钮：${clicked.selector}`);
      break;
    }
  }
  if (!clicked.ok) {
    trace.push('没找到评测/提交按钮，答案已填但未提交');
    return {
      ok: false,
      passed: undefined,
      channel: 'browser',
      kind: objective.kind,
      title: snap.title,
      answers,
      filled: filled.report,
      reason: '答案已填进页面，但没找到提交按钮',
      screenshot: shot.path,
      trace: trace.text(),
    };
  }

  // 客观题平台不回逐题对错，只能靠接口看 final_score / status。
  let verdict = await pollVerdictViaApi(sess, opts, trace).catch(() => undefined);
  if (!verdict || verdict.state === 'unknown') {
    // 再等几秒重试一次：交卷后成绩是异步算的
    await new Promise((r) => setTimeout(r, 4000));
    verdict = (await pollVerdictViaApi(sess, opts, trace).catch(() => undefined)) ?? verdict;
  }
  if (!verdict || verdict.state === 'unknown') {
    const pageVerdict = await pollPageVerdict(sess, {
      trace,
      timeoutMs: Math.min(opts.buildTimeoutMs ?? 60_000, 30_000),
      signal: opts.signal,
    }).catch(() => undefined);
    verdict = pageVerdict && pageVerdict.state !== 'unknown' ? pageVerdict : verdict;
  }

  const after = await screenshot(sess, {});
  return {
    ok: verdict ? verdict.state !== 'fail' : true,
    passed: verdict?.state === 'pass' ? true : verdict?.state === 'fail' ? false : undefined,
    channel: 'browser',
    kind: objective.kind,
    title: snap.title,
    chooses: chooses.map((c) => ({
      index: c.index,
      question: ai.truncate(c.question, 160),
      options: c.options?.map((o) => `${o.label}. ${ai.truncate(o.text, 80)}`),
    })),
    answers,
    filled: filled.report,
    verdict,
    evaluated: true,
    screenshot: after.path,
    modelText: solved.text,
    trace: trace.text(),
  };
}

/**
 * 从页面文字里读评测结论。
 * 头歌的结果区文案五花八门（"评测通过" / "恭喜你，本关通过" / "编译错误"…），
 * 所以用一组正则在正文里找结论；找不到就返回 unknown，不瞎猜。
 */
export function judgeVerdictText(text) {
  const s = String(text ?? '');

  // 1) 编译器报错（最硬的信号）：`file.c:12:30: error: stray '#' in program`
  if (/:\d+:\d+:\s*(error|fatal error)\s*:/i.test(s)) return 'fail';
  if (/\b(error|fatal error)\s*:\s/i.test(s)) return 'fail';

  // 2) 通过数 / 总数，例如 `0/3`、`3/3`、`测试集 2/3`
  const ratio = /(?:^|\s)(\d+)\s*\/\s*(\d+)(?:\s|$)/g;
  let m;
  while ((m = ratio.exec(s))) {
    const got = Number(m[1]);
    const total = Number(m[2]);
    if (!Number.isFinite(got) || !Number.isFinite(total) || total <= 0 || total > 99) continue;
    if (got >= total) return 'pass';
    return 'fail';
  }

  const failPatterns = [
    /评测失败/, /编译错误/, /运行错误/, /答案错误/, /未通过/, /测试用例[^\n]{0,20}失败/,
    /Wrong Answer/i, /Compilation Error/i, /Runtime Error/i, /FAILED/i, /段错误/, /超时/,
  ];
  const passPatterns = [/评测通过/, /恭喜[^\n]{0,10}通过/, /全部通过/, /测试用例[^\n]{0,20}全部/, /compile successfully/i];
  if (failPatterns.some((r) => r.test(s))) return 'fail';
  if (passPatterns.some((r) => r.test(s))) return 'pass';
  return 'unknown';
}

/**
 * 浏览器路拿结论的首选方式：从浏览器里掏 cookie，直接问 game_status.json。
 * 页面文字判定太脆（英文编译报错、0/3 这种计数、异步刷新都能骗过它），
 * 而浏览器里已经有登录态了，用 API 读结论既准又快。
 */
async function pollVerdictViaApi(sess, opts, trace) {
  const { harvestCookies } = await import('./browser.mjs');
  const target = parseTarget(opts.url);
  if (!target.taskId) {
    trace.push('接口读结论：URL 里没有 task id');
    return undefined;
  }

  let cookies;
  try {
    cookies = await harvestCookies(sess, [api.SITE_ORIGIN]);
  } catch (error) {
    trace.push(`接口读结论：抓 cookie 失败（${error.message}）`);
    return undefined;
  }
  if (!cookies?._educoder_session) {
    trace.push(`接口读结论：浏览器里没有 _educoder_session（拿到 ${Object.keys(cookies ?? {}).join(',') || '空'}）`);
    return undefined;
  }

  // 先拉一次 task 详情，拿到 challenge_id / sec_key（浏览器里 cookie 有效，这一步很稳）
  let taskJson;
  try {
    taskJson = await api.getTask(cookies, target.taskId, target.homeworkCommonId, { signal: opts.signal });
  } catch (error) {
    trace.push(`接口读结论：拉 task 详情失败（${error.message}）`);
    return undefined;
  }
  const challengeId = taskJson?.challenge?.id ?? taskJson?.data?.challenge?.id ?? '';
  const secKey = taskJson?.sec_key ?? taskJson?.data?.sec_key ?? '';
  if (!challengeId) {
    trace.push('接口读结论：task 详情里没有 challenge_id');
    return undefined;
  }

  trace.push(`改用 game_status 接口读评测结论（challenge=${challengeId}，比页面文字准）…`);
  try {
    const verdict = await api.waitBuildResult(cookies, {
      taskId: target.taskId,
      challengeId,
      homeworkCommonId: target.homeworkCommonId,
      zzud: taskJson?.user?.login ?? taskJson?.data?.user?.login ?? '',
      secKey,
      timeoutMs: opts.buildTimeoutMs ?? 240_000,
      signal: opts.signal,
      onTick: (v) => {
        if (v.state !== 'pending') return;
        const msg = v.running?.message ? `（${v.running.message}）` : '';
        trace.push(`  评测中…${v.total ? `${v.passed}/${v.total}` : ''}${msg}`);
      },
    });
    if (verdict && (verdict.state === 'pass' || verdict.state === 'fail')) {
      trace.push(`接口判定：${verdict.state}（${verdict.passed}/${verdict.total}）`);
      return { ...verdict, source: 'api' };
    }
    trace.push(`接口没给出明确结论（state=${verdict?.state}），退回页面文字判定`);
  } catch (error) {
    trace.push(`接口读结论失败：${error.message}`);
  }
  return undefined;
}

/** 轮询页面直到评测结论稳定。 */
async function pollPageVerdict(sess, { trace, timeoutMs = 120_000, signal } = {}) {
  const { pageSnapshot } = await import('./browser.mjs');
  const deadline = Date.now() + timeoutMs;
  let last = 'unknown';
  let stable = 0;
  while (Date.now() < deadline) {
    if (signal?.aborted) break;
    await new Promise((r) => setTimeout(r, 3000));
    const snap = await pageSnapshot(sess, { maxChars: 20000, editorTimeoutMs: 10000 }).catch(() => undefined);
    const v = judgeVerdictText(snap?.text ?? '');
    if (v === last && v !== 'unknown') {
      stable++;
      if (stable >= 2) {
        trace.push(`页面评测结论：${v}`);
        return { state: v, source: 'page-text' };
      }
    } else {
      stable = 0;
      last = v;
    }
    if (v !== 'unknown') trace.push(`  评测中…（当前看到 ${v}）`);
  }
  trace.push(`没有从页面文字里读到明确的评测结论（最后：${last}）`);
  return { state: last, source: 'page-text' };
}

/**
 * 统一入口：按 URL 自动选路。
 * @param {object} opts
 * @param {string} opts.url
 * @param {object} [opts.llm]
 * @param {object} [opts.aiConfig]
 * @param {boolean} [opts.submit=false]
 * @param {'auto'|'api'|'browser'} [opts.mode='auto']
 * @param {AbortSignal} [opts.signal]
 */
export async function solveUrl(opts) {
  const trace = opts.trace ?? createTrace();
  const mode = opts.mode ?? 'auto';
  const target = parseTarget(opts.url);
  trace.push(`模式：${mode}；URL：${opts.url}`);

  const canApi = Boolean(target.taskId);

  if (mode === 'browser' || (mode === 'auto' && !canApi)) {
    return solveViaBrowser({ ...opts, trace });
  }

  // API 路：先要登录态
  let cookies;
  try {
    cookies = await session.getCookies({ refresh: opts.refreshLogin, browser: opts.browserSession });
  } catch (error) {
    if (mode === 'api') throw error;
    trace.push(`没有登录态（${error.message}），改走浏览器路`);
    return solveViaBrowser({ ...opts, trace });
  }

  const check = await session.validateCookies(cookies);
  if (!check.ok) {
    trace.push(`登录态可能已失效（${check.reason}）`);
    if (mode === 'api') throw new Error(`登录态失效：${check.reason}；请先运行 \`educoder-auto login\``);
  }

  try {
    return await solveViaApi({ ...opts, cookies, trace });
  } catch (error) {
    if (mode === 'api') throw error;
    trace.push(`API 路失败（${error.message}），改走浏览器路`);
    return solveViaBrowser({ ...opts, trace });
  }
}
