/**
 * lib/chaoxing-solver.mjs —— 学习通作业总流程。
 *
 * 流程：定位作业 → 抓题 → 问模型 → 归一化 → 暂存 → 回读校验 → （可选）交卷。
 *
 * 默认「先暂存、再回读、确认无误才交卷」，因为作业提交是单向的：
 * 交错了老师那边直接看到，撤不回来。想省事可以 submit 时直接交（verify=false）。
 */

import * as api from './chaoxing-api.mjs';
import * as ai from './chaoxing-ai.mjs';
import * as session from './chaoxing-session.mjs';
import { solve as solveWithModel } from './ai.mjs';

/** 带时间戳的流程记录（工具输出里原样带给用户看）。 */
export function createTrace() {
  const lines = [];
  const started = Date.now();
  return {
    push(message) {
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      lines.push(`[${secs}s] ${message}`);
    },
    text() {
      return lines.join('\n');
    },
    lines,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 定位要做的作业。
 * 优先级：显式 workUrl > taskUrl > 列表里按标题/序号挑。
 */
export async function resolveTarget(cookies, opts = {}) {
  const trace = opts.trace ?? createTrace();
  const signal = opts.signal;

  // url 位置收到「关键词/序号」的情况很常见（用户直接说「做第三章那次」），
  // 不是网址就别当网址用，退化成 pick。
  const rawUrl = opts.workUrl ? String(opts.workUrl).trim() : '';
  const looksLikeUrl = /^https?:\/\//i.test(rawUrl) || /doHomeWork|mtaskmsgspecial|taskrefId=/i.test(rawUrl);
  const pick = opts.pick ?? (rawUrl && !looksLikeUrl ? rawUrl : undefined);

  if (rawUrl && looksLikeUrl) {
    // 用户经常直接把作业列表里的 task 链接贴进来，那种要再解析一层
    if (/mtaskmsgspecial|taskrefId=/.test(opts.workUrl) && !/doHomeWork/i.test(opts.workUrl)) {
      trace.push(`给的是任务链接，先解析作业入口：${opts.workUrl}`);
      const workUrl = await api.resolveWorkUrl(cookies, opts.workUrl, { signal });
      return { workUrl, source: 'taskUrl' };
    }
    trace.push(`用给定地址：${opts.workUrl}`);
    return { workUrl: opts.workUrl, source: 'workUrl' };
  }

  const works = await api.listWorks(cookies, { signal });
  trace.push(`列到 ${works.length} 份作业入口`);
  if (!works.length) throw new Error('作业列表是空的（可能没有待做作业，或者登录态看到的页面不对）');

  if (opts.taskUrl) {
    trace.push(`用给定 task 地址：${opts.taskUrl}`);
    const workUrl = await api.resolveWorkUrl(cookies, opts.taskUrl, { signal });
    return { workUrl, source: 'taskUrl', works };
  }

  if (pick) {
    const needle = String(pick).trim();
    const hit =
      works.find((w) => w.title && w.title.includes(needle)) ||
      (Number(needle) >= 1 && Number(needle) <= works.length ? works[Number(needle) - 1] : null);
    if (!hit) {
      const list = works.map((w) => `  ${w.index}. ${w.title}`).join('\n');
      throw new Error(`列表里没找到「${needle}」对应的作业，现有：\n${list}`);
    }
    trace.push(`按「${needle}」选中：${hit.title}`);
    const workUrl = await api.resolveWorkUrl(cookies, hit.taskUrl, { signal });
    return { workUrl, source: 'pick', works, chosen: hit };
  }

  const first = works[0];
  trace.push(`没指定作业，取列表第一份：${first.title}`);
  const workUrl = await api.resolveWorkUrl(cookies, first.taskUrl, { signal });
  return { workUrl, source: 'first', works, chosen: first };
}

/**
 * 主流程。
 * @param {object} opts
 * @param {object} [opts.cookies]
 * @param {string} [opts.workUrl] - doHomeWork 地址
 * @param {string} [opts.taskUrl] - mtaskmsgspecial 地址
 * @param {string|number} [opts.pick] - 标题关键词或序号
 * @param {object} [opts.llm] - ctx.get('llm')
 * @param {object} [opts.aiConfig]
 * @param {boolean} [opts.submit] - 是否交卷（false = 只暂存）
 * @param {boolean} [opts.verify=true] - 暂存后回读校验
 * @param {string} [opts.extra] - 额外作答要求
 * @param {number} [opts.gapMs] - 每题之间的间隔（拟人节奏）
 */
export async function solveWork(opts = {}) {
  const trace = opts.trace ?? createTrace();
  const signal = opts.signal;
  const submit = opts.submit !== false;
  const verify = opts.verify !== false;
  const gapMs = Number.isFinite(opts.gapMs) ? opts.gapMs : 0;

  const cookies = opts.cookies ?? (await session.getCookies());

  // 1. 定位
  const target = await resolveTarget(cookies, { ...opts, trace });

  // 2. 抓题
  trace.push('抓题…');
  const work = await api.fetchWork(cookies, target.workUrl, { maxIndex: 60, signal });
  const questions = work.questions || [];
  trace.push(`抓到 ${questions.length} 道题（翻了 ${work.pages} 页）`);
  if (!questions.length) {
    return {
      ok: false,
      reason: '这份作业里没抓到题目：可能已经交过，或者这个入口不是作业',
      workUrl: target.workUrl,
      questions: [],
      answers: {},
      problems: [],
      trace: trace.text(),
    };
  }

  const kindStat = questions.reduce((acc, q) => {
    const key = api.KIND_LABELS[q.kind] ?? q.kind;
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  trace.push(`题型：${Object.entries(kindStat).map(([k, v]) => `${k}×${v}`).join('、')}`);

  const unknown = questions.filter((q) => q.kind === 'unknown');
  if (unknown.length) {
    trace.push(`⚠️ 有 ${unknown.length} 道题没认出题型（题号 ${unknown.map((q) => q.questionId).join(',')}），仍会按题意作答`);
  }

  // 3. 问模型
  trace.push('问模型要答案…');
  const prompt = ai.buildAnswerPrompt(questions, opts.extra);
  const out = await solveWithModel({
    llm: opts.llm,
    config: opts.aiConfig ?? {},
    system: ai.ANSWER_SYSTEM,
    prompt,
    maxTokens: opts.aiConfig?.maxTokens ?? 8192,
    temperature: opts.aiConfig?.temperature ?? 0.2,
    signal,
  });
  trace.push(`模型回来了（${out.channel}，${String(out.text || '').length} 字）`);

  const parsed = ai.extractJson(out.text);
  if (!parsed) {
    return {
      ok: false,
      reason: '模型输出不是合法 JSON，没法解析答案',
      workUrl: target.workUrl,
      questions: summarizeQuestions(questions),
      answers: {},
      problems: ['模型输出解析失败'],
      raw: String(out.text || '').slice(0, 2000),
      trace: trace.text(),
    };
  }

  const { answers, problems } = ai.normalizeAll(questions, parsed);
  trace.push(`归一化出 ${Object.keys(answers).length}/${questions.length} 道题的答案`);
  if (problems.length) trace.push(`有 ${problems.length} 条待注意：${problems.slice(0, 6).join('；')}`);

  if (!Object.keys(answers).length) {
    return {
      ok: false,
      reason: '一道题都没拿到可用答案',
      workUrl: target.workUrl,
      questions: summarizeQuestions(questions),
      answers: {},
      problems,
      trace: trace.text(),
    };
  }

  // 4. 暂存
  trace.push('暂存答案（tempSave=true）…');
  const byQid = {};
  for (const q of questions) byQid[q.questionId] = q;
  const saved = await api.submitAnswers(cookies, target.workUrl, {
    answers,
    tempSave: true,
    pages: { byQid },
    sleepMs: gapMs,
    signal,
  });
  trace.push(saved.ok ? '✅ 暂存全部成功' : `⚠️ 暂存有 ${saved.failed.length} 道没过：${saved.failed.map((f) => f.questionId).join(',')}`);

  // 5. 回读校验
  let verified = null;
  if (verify) {
    trace.push('回读页面核对已存答案…');
    try {
      const re = await api.readSavedAnswers(cookies, target.workUrl, { maxIndex: 60, signal });
      verified = compareSaved(questions, answers, re.saved);
      trace.push(
        verified.mismatch.length
          ? `⚠️ 回读有 ${verified.mismatch.length} 道对不上：${verified.mismatch.map((m) => m.questionId).join(',')}`
          : '✅ 回读一致',
      );
    } catch (error) {
      verified = { ok: false, reason: error.message, mismatch: [] };
      trace.push(`回读失败（不影响暂存结果）：${error.message}`);
    }
  }

  // 6. 交卷
  let submitted = false;
  if (submit) {
    if (!saved.ok) {
      trace.push('暂存都没全过，先不交卷');
    } else {
      trace.push('交卷（tempSave=false）…');
      const final = await api.submitAnswers(cookies, target.workUrl, {
        answers,
        tempSave: false,
        pages: { byQid },
        sleepMs: gapMs,
        signal,
      });
      submitted = final.ok;
      trace.push(
        submitted
          ? '✅ 交卷成功'
          : `⚠️ 交卷有 ${final.failed.length} 道没过：${final.failed
              .map((f) => `${f.questionId}（${f.reason}）`)
              .join('、')}`,
      );
      if (!submitted) {
        problems.push(...final.failed.map((f) => `第 ${f.questionId} 题交卷失败：${f.reason}`));
      }
    }
  } else {
    trace.push('按配置只暂存、没交卷');
  }

  const ok = saved.ok && (!submit || submitted);
  return {
    ok,
    submitted,
    reason: ok ? '' : saved.ok ? '交卷没成功' : '暂存没成功',
    workUrl: target.workUrl,
    courseId: target.chosen?.courseId ?? '',
    classId: target.chosen?.classId ?? '',
    title: target.chosen?.title ?? '',
    count: questions.length,
    questions: summarizeQuestions(questions),
    answers: describeAnswers(questions, answers),
    problems,
    verified,
    trace: trace.text(),
  };
}

/** 题目摘要（给工具输出用，题干太长就截断）。 */
export function summarizeQuestions(questions) {
  return questions.map((q, i) => ({
    no: i + 1,
    questionId: q.questionId,
    kind: q.kind,
    kindLabel: api.KIND_LABELS[q.kind] ?? q.kind,
    score: q.score || '',
    stem: String(q.stem || '').replace(/\s+/g, ' ').slice(0, 200),
    optionCount: (q.options || []).length,
  }));
}

/** 答案摘要（多空多选把数组拼成可读串）。 */
export function describeAnswers(questions, answers) {
  return questions
    .filter((q) => answers[q.questionId] !== undefined)
    .map((q, i) => {
      const value = answers[q.questionId];
      const text = Array.isArray(value) ? value.join(' ｜ ') : String(value);
      return {
        no: i + 1,
        questionId: q.questionId,
        kind: q.kind,
        answer: text.slice(0, 300),
        truncated: text.length > 300,
      };
    });
}

/**
 * 回读比对：把「提交的值」和「页面上现在显示的」逐题比。
 * 不追求字符串完全相等（页面会加空格、把多选排序），只求能看出「存进去了」。
 */
export function compareSaved(questions, answers, saved) {
  const mismatch = [];
  const matched = [];
  for (const q of questions) {
    const want = answers[q.questionId];
    if (want === undefined) continue;
    const got = saved?.[q.questionId];
    if (!got) {
      mismatch.push({ questionId: q.questionId, reason: '页面上找不到这道题' });
      continue;
    }
    if (q.kind === 'single' || q.kind === 'judge') {
      const wantValue = String(Array.isArray(want) ? want[0] : want);
      const ok = got.picked.some((v) => String(v).toLowerCase() === wantValue.toLowerCase());
      (ok ? matched : mismatch).push({ questionId: q.questionId, ...(ok ? {} : { reason: `期望 ${wantValue}，页面选中 ${got.picked.join(',') || '无'}` }) });
      continue;
    }
    if (q.kind === 'multiple') {
      const wantList = (Array.isArray(want) ? want : [want]).map((v) => String(v).toLowerCase()).sort();
      const gotList = got.picked.map((v) => String(v).toLowerCase()).sort();
      const ok = wantList.length === gotList.length && wantList.every((v, i) => v === gotList[i]);
      (ok ? matched : mismatch).push({ questionId: q.questionId, ...(ok ? {} : { reason: `期望 ${wantList.join(',')}，页面选中 ${gotList.join(',') || '无'}` }) });
      continue;
    }
    if (q.kind === 'blanks') {
      const wantList = Array.isArray(want) ? want : [want];
      const gotList = got.texts?.length ? got.texts : [got.text];
      const ok = wantList.length === gotList.length && wantList.every((v, i) => norm(v) === norm(gotList[i]));
      (ok ? matched : mismatch).push({ questionId: q.questionId, ...(ok ? {} : { reason: `期望 ${wantList.length} 空，页面 ${gotList.length} 空` }) });
      continue;
    }
    const wantText = Array.isArray(want) ? want.join('\n') : want;
    const ok = norm(wantText) === norm(got.text);
    (ok ? matched : mismatch).push({
      questionId: q.questionId,
      ...(ok ? {} : { reason: diffReason(wantText, got.text) }),
    });
  }
  return { ok: mismatch.length === 0, matched: matched.length, mismatch };
}

function norm(value) {
  return String(value ?? '')
    .replace(/\s+/g, '')
    .replace(/[，。；：、"'（）()]/g, '')
    .toLowerCase();
}

/** 回读对不上时给一句能定位的话：差多少字、从第几个字开始岔。 */
function diffReason(want, got) {
  const a = norm(want);
  const b = norm(got);
  if (!b) return '页面上这道题是空的（没存进去）';
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  const tail = i < a.length && i < b.length ? `，从第 ${i + 1} 字开始不同（提交「${a.slice(i, i + 12)}」/ 页面「${b.slice(i, i + 12)}」）` : '';
  return `页面 ${b.length} 字 / 提交 ${a.length} 字${tail}`;
}
