/**
 * lib/iwrite-ai.mjs —— iWrite 作文生成（提示词 + 解析 + 校验）。
 *
 * 用户的核心要求是「严格按照其要求写作」，所以这里把平台的硬约束
 * 全部显式塞进提示词，并在拿到结果后**逐条校验**，不合格就打回重写：
 *   1. 体裁（genre）—— 决定文体、人称、时态、结构
 *   2. 词数区间（words / words2）—— 平台按空白分词，超出区间要扣分
 *   3. 题干（stem）里的具体要求 —— 三个要点是否都覆盖、有无指定格式
 *   4. 关键词（keyWord）—— 必须自然出现
 *   5. 标题（title）—— 平台要求标题与正文分开填，正文里不能再重复标题行
 *
 * 校验失败会带着「上一稿哪里不合格」回喂模型重写，最多 N 轮。
 */

import * as api from './iwrite-api.mjs';
import * as ai from './ai.mjs';

/**
 * 写作水平档位。
 *
 * 用户的要求是「按高三生水平写，词汇尽量在四级范围内」——这两件事在
 * 评分上其实是一致的：高考英语词汇量约 3500，四级约 4500，交集就是
 * 「高中核心词 + 少量四级常见词」。所以这里把档位做成显式预设，
 * 提示词里写死词汇边界，生成后再按同一套规则**反向检查**。
 */
export const LEVEL_PRESETS = {
  highschool: {
    id: 'highschool',
    label: '高三生（高考词汇 + 四级常见词）',
    vocabulary:
      'Use ONLY common high-school English vocabulary. Every word must be one that a Chinese senior-high ' +
      'student preparing for the National College Entrance Exam would know, and it must also fall inside ' +
      'the CET-4 word list. Prefer the simplest word that carries the meaning.',
    sentence:
      'Keep sentences short and plain: mostly 12-20 words, at most one long sentence per paragraph. ' +
      'Use basic linking words only (first, also, however, for example, in short).',
    structure:
      'Five-paragraph or four-paragraph structure with an obvious topic sentence in each body paragraph. ' +
      'No rhetorical flourish, no idioms that are rare, no cultural allusions.',
  },
  cet4: {
    id: 'cet4',
    label: '四级水平（大学非英语专业）',
    vocabulary:
      'Use CET-4 level vocabulary. Common CET-4 words are fine; avoid anything above CET-4.',
    sentence: 'Sentences of moderate length, 15-25 words, with standard academic connectives.',
    structure: 'Clear academic paragraphing with topic sentences and transitions.',
  },
  cet6: {
    id: 'cet6',
    label: '六级水平',
    vocabulary: 'CET-6 vocabulary is acceptable; keep it natural rather than ornate.',
    sentence: 'Varied sentence length with some complex structures.',
    structure: 'Well-developed academic structure.',
  },
};

/** 把任意输入归一成一个档位（默认高三）。 */
export function resolveLevel(level) {
  const key = String(level ?? '').trim().toLowerCase();
  if (!key) return LEVEL_PRESETS.highschool;
  const alias = {
    highschool: 'highschool', 'high-school': 'highschool', senior: 'highschool', gaokao: 'highschool',
    高三: 'highschool', 高中: 'highschool', 高中生: 'highschool',
    cet4: 'cet4', 'cet-4': 'cet4', 四级: 'cet4', band4: 'cet4',
    cet6: 'cet6', 'cet-6': 'cet6', 六级: 'cet6', band6: 'cet6',
  };
  return LEVEL_PRESETS[alias[key] || key] || LEVEL_PRESETS.highschool;
}

/**
 * 明显超出四级/高考范围、一眼就像 AI 写的词。
 * 检查用：出现一个就在重写提示里点出来，让模型换掉。
 */
export const TOO_ADVANCED_WORDS = [
  'delve', 'delves', 'delving', 'tapestry', 'multifaceted', 'paradigm', 'paradigms', 'ubiquitous',
  'proliferation', 'proliferate', 'ameliorate', 'exacerbate', 'notwithstanding', 'heretofore',
  'juxtaposition', 'plethora', 'myriad', 'synergy', 'synergies', 'leverage', 'leveraging',
  'utilize', 'utilizing', 'facilitate', 'facilitates', 'facilitating', 'indispensable', 'paramount',
  'unprecedented', 'revolutionize', 'revolutionizing', 'catalyst', 'nuanced', 'holistic', 'intricate',
  'comprehensive', 'endeavor', 'endeavours', 'endeavors', 'elucidate', 'substantiate', 'underscore',
  'underscores', 'bolster', 'bolsters', 'cognizant', 'detrimental', 'efficacious', 'myopic',
  'quintessential', 'resonance', 'scaffold', 'scaffolding', 'trajectory', 'vicissitude', 'zeitgeist',
  'inasmuch', 'whereby', 'thereby', 'henceforth', 'aforementioned', 'ostensibly', 'purportedly',
];

/** 缩写形式：高中作文一般不写 don't / can't。 */
const CONTRACTION_RE = /\b\w+['’](?:s|t|re|ve|ll|d|m)\b/i;

/** 构造系统提示词（按档位）。 */
export function buildEssaySystem(level) {
  const preset = resolveLevel(level);
  return [
    'You are an experienced Chinese senior-high English teacher who writes model essays for exam practice.',
    `Write at this level: ${preset.label}.`,
    preset.vocabulary,
    preset.sentence,
    preset.structure,
    '',
    'Voice: a real student writing an exam essay. Correct grammar, plain wording, no show-off vocabulary,',
    'never AI-flavoured (no "delve into", "tapestry", "in today\'s fast-paced world", no tri-colon',
    'rhetorical lists, no em-dash overuse, no "not only ... but also" in every paragraph).',
    '',
    'Hard rules:',
    '- Obey the genre, word range and every explicit instruction in the prompt.',
    '- Hit the required word count as counted by whitespace-separated tokens (the platform counts this way).',
    '- Cover every bullet point the task lists. Missing one bullet is a failure.',
    '- Do NOT write the title inside the body. The body is essay text only, starting from the first paragraph.',
    '- Use plain ASCII punctuation for quotes and apostrophes where possible; use standard English paragraphs',
    '  separated by a single blank line.',
    '- Output ONLY the essay body. No preamble, no explanation, no word count, no markdown fences.',
  ].join('\n');
}

/** 默认（高三档）系统提示词，保留旧导出名以兼容调用方。 */
export const ESSAY_SYSTEM = buildEssaySystem('highschool');

/** 润色用的系统提示词：只改措辞，不改内容与结构。 */
export const POLISH_SYSTEM = [
  'You are a careful English teacher polishing a student essay.',
  'You may only improve wording, grammar, and flow. Keep the same ideas, the same paragraph count,',
  'the same order of arguments, and stay inside the same vocabulary level.',
  'Do not add new arguments. Do not make it sound more advanced. If a word is above the allowed level,',
  'replace it with a simpler one.',
  'Output ONLY the polished essay body. No commentary, no title, no markdown.',
].join('\n');

/**
 * 组提示词。
 * @param {object} task - normalizeTask 的结果
 * @param {{previous?: {text:string, problems:string[]}, attempt?: number, level?: string}} [opts]
 */
export function buildEssayPrompt(task, opts = {}) {
  const lines = [];
  const preset = resolveLevel(opts.level ?? task.level);
  lines.push('## Task');
  if (task.title) lines.push(`Title to use (do NOT repeat it in the body): ${task.title}`);
  if (task.genre) lines.push(`Genre: ${task.genre} (${api.GENRE_GUIDE[task.genreId] || 'follow the prompt'})`);

  const range = describeWordRange(task.wordsFrom, task.wordsTo);
  if (range) lines.push(`Required length: ${range}`);

  if (task.keyWord) lines.push(`Keywords that must appear naturally: ${task.keyWord}`);

  lines.push('', '## Prompt / requirements (verbatim from the platform)');
  lines.push((task.stem || task.simpleStem || '(no prompt text provided)').trim());

  if (task.referenceAnswers) {
    lines.push('', '## Reference material supplied by the teacher');
    lines.push(ai.truncate(task.referenceAnswers, 3000));
  }
  if (task.referenceAnalysis) {
    lines.push('', '## Reference analysis supplied by the teacher');
    lines.push(ai.truncate(task.referenceAnalysis, 1500));
  }

  lines.push('', '## Language level (this is graded, follow it strictly)');
  lines.push(`- Target level: ${preset.label}`);
  lines.push(`- Vocabulary: ${preset.vocabulary}`);
  lines.push(`- Sentences: ${preset.sentence}`);
  lines.push(`- Structure: ${preset.structure}`);
  lines.push('- Write like a real student sitting an exam, not like a language model. Plain and correct beats fancy.');

  lines.push('', '## Checklist before you answer');
  lines.push(`- Genre matches: ${task.genre || 'as described in the prompt'}`);
  if (range) lines.push(`- Length lands inside: ${range}`);
  lines.push('- Every bullet/requirement in the prompt is explicitly addressed');
  lines.push('- Coherent paragraphs with clear topic sentences and transitions');
  lines.push(`- Every word is inside the ${preset.label} vocabulary band`);
  lines.push('- No title line, no markdown, no meta commentary');

  if (opts.previous?.text) {
    lines.push('', '## Your previous draft was rejected');
    for (const p of opts.previous.problems || []) lines.push(`- ${p}`);
    lines.push('', 'Previous draft (for reference only — rewrite it, do not just patch one sentence):');
    lines.push(ai.truncate(opts.previous.text, 4000));
    lines.push('', `This is attempt ${opts.attempt ?? 2}. Write the corrected essay now.`);
  }

  return lines.join('\n');
}

/** "between 150 and 200 words" 这类描述。 */
export function describeWordRange(from, to) {
  const f = Number(from) > 0 ? Number(from) : null;
  const t = Number(to) > 0 ? Number(to) : null;
  if (f && t) return `${f}-${t} words (aim for ${Math.round((f + t) / 2)}, never outside ${f}-${t})`;
  if (f) return `at least ${f} words (aim for ${f + Math.round(f * 0.1)})`;
  if (t) return `no more than ${t} words (aim for ${Math.round(t * 0.9)})`;
  return '';
}

/**
 * 从模型输出里抠出作文正文。
 * 模型偶尔会包 ``` 围栏、加 "Here is the essay:" 前缀、或重复标题行。
 */
export function extractEssay(text, task = {}) {
  let body = String(text == null ? '' : text).replace(/\r\n/g, '\n').trim();
  if (!body) return '';

  // 1) 去掉 markdown 围栏
  const fence = body.match(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/);
  if (fence) body = fence[1].trim();

  // 2) 去掉 "Here is ...:" 这类开场白（只删第一行，且该行很短、以冒号结尾或明显是说明）
  const firstNl = body.indexOf('\n');
  if (firstNl > 0) {
    const head = body.slice(0, firstNl).trim();
    if (
      head.length < 120 &&
      (/[:：]$/.test(head) || /^(here|below|sure|okay|certainly)\b/i.test(head)) &&
      !/[.!?]$/.test(head)
    ) {
      body = body.slice(firstNl + 1).trim();
    }
  }

  // 3) 若第一行就是标题本身，删掉（平台标题是单独字段）
  const title = String(task.title || '').trim();
  if (title) {
    const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const lines2 = body.split('\n');
    const head = lines2[0].replace(/^#+\s*/, '').replace(/^\*+|\*+$/g, '').trim();
    if (head && norm(head) === norm(title)) {
      body = lines2.slice(1).join('\n').trim();
    }
  }

  // 4) 去掉残留的 markdown 标题井号、行首多余空白
  body = body
    .split('\n')
    .map((l) => l.replace(/^#{1,6}\s+/, '').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return body;
}

/**
 * 词汇档位检查：找出明显超出四级/高考范围、或一眼像 AI 的词。
 * 只做「提示」不做「拦截」——单个词不构成不合格，但会写进重写提示里。
 */
export function findAdvancedWords(body) {
  const lower = String(body || '').toLowerCase();
  const hits = [];
  for (const w of TOO_ADVANCED_WORDS) {
    if (new RegExp(`\\b${w}\\b`, 'i').test(lower)) hits.push(w);
  }
  return hits;
}

/**
 * 校验一篇作文是否满足平台硬约束。
 * @param {object} [task] - normalizeTask 结果；task.level 决定词汇档位
 * @returns {{ok:boolean, problems:string[], words:number, level?:object, advanced?:string[]}}
 */
export function checkEssay(body, task = {}) {
  const problems = [];
  const words = api.countWords(body);
  const preset = resolveLevel(task.level);

  if (!body || words < 20) {
    problems.push(`正文太短（${words} 词），不像一篇完整作文`);
    return { ok: false, problems, words };
  }

  const from = Number(task.wordsFrom) > 0 ? Number(task.wordsFrom) : 0;
  const to = Number(task.wordsTo) > 0 ? Number(task.wordsTo) : 0;
  if (!api.wordCountOk(words, from, to)) {
    if (from && to) problems.push(`词数 ${words}，要求 ${from}-${to} 词`);
    else if (from) problems.push(`词数 ${words}，要求不少于 ${from} 词`);
    else if (to) problems.push(`词数 ${words}，要求不超过 ${to} 词`);
  }

  // 关键词覆盖
  const kws = String(task.keyWord || '')
    .split(/[,，;；\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (kws.length) {
    const lower = body.toLowerCase();
    const missing = kws.filter((k) => !lower.includes(k.toLowerCase()));
    if (missing.length) problems.push(`缺少指定关键词：${missing.join('、')}`);
  }

  // 中文混入（平台会提示"识别到中文内容"）
  if (/[\u4e00-\u9fff]/.test(body)) problems.push('正文里混入了中文，平台会拦截');

  // 空段落 / 单段长文（体裁上不合格）
  const paras = body.split(/\n\s*\n/).filter((p) => p.trim());
  if (paras.length < 2) problems.push('只有一个自然段，需要分段（议论文/说明文至少 3 段）');

  // 词汇档位：超出四级的词只在高三档追究
  const advanced = preset.id === 'highschool' ? findAdvancedWords(body) : [];
  if (advanced.length) {
    problems.push(`这些词超出高考/四级范围，换简单说法：${advanced.join(', ')}`);
  }
  if (preset.id === 'highschool' && CONTRACTION_RE.test(body)) {
    problems.push('出现了缩写形式（don\'t / can\'t 之类），考试作文里要写全称');
  }

  return { ok: problems.length === 0, problems, words, level: preset, advanced };
}

/**
 * 生成作文：调模型 → 抽正文 → 校验 → 不合格带着问题重写 → 可选润色。
 *
 * @param {object} opts
 * @param {object} opts.task - normalizeTask 结果
 * @param {object} [opts.llm] - ctx.get('llm')
 * @param {object} [opts.aiConfig]
 * @param {number} [opts.maxAttempts=3]
 * @param {string} [opts.level] - highschool / cet4 / cet6，默认取 task.level 再退回 highschool
 * @param {boolean} [opts.polish=true] - 定稿前再润色一遍
 * @param {(msg:string)=>void} [opts.trace]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{ok:boolean, body:string, title:string, words:number, attempts:number, problems:string[], level?:object, polished?:boolean, route?:object}>}
 */
export async function writeEssay(opts) {
  const { task, llm, aiConfig = {}, maxAttempts = 3, signal } = opts;
  const trace = opts.trace ?? (() => {});
  const attempts = Math.max(1, Number(maxAttempts) || 1);
  const preset = resolveLevel(opts.level ?? task.level);
  const system = buildEssaySystem(preset.id);

  let previous;
  let last = { body: '', words: 0, problems: ['还没有生成'] };
  let result;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (signal?.aborted) {
      const err = new Error('已取消');
      err.name = 'AbortError';
      throw err;
    }
    const prompt = buildEssayPrompt(task, {
      level: preset.id,
      ...(previous ? { previous, attempt } : {}),
    });
    trace(`第 ${attempt} 轮：请求模型写作文（${preset.label}）…`);
    const out = await ai.solve({
      llm,
      config: aiConfig,
      system,
      prompt,
      // 作文要长，词数上限 ×3 才够 token
      maxTokens: Math.min(8000, Math.max(1500, (Number(task.wordsTo) || 400) * 6)),
      temperature: attempt === 1 ? 0.65 : 0.45,
      signal,
    });
    const body = extractEssay(out.text, task);
    const check = checkEssay(body, { ...task, level: preset.id });
    trace(
      `第 ${attempt} 轮：${check.words} 词${check.ok ? '，符合要求' : `，不合格（${check.problems.join('；')}）`}`
    );
    last = { body, words: check.words, problems: check.problems };
    if (check.ok) {
      result = {
        ok: true,
        body,
        title: task.title || '',
        words: check.words,
        attempts: attempt,
        problems: [],
        level: preset,
        route: out.route,
      };
      break;
    }
    previous = { text: body, problems: check.problems };
  }

  if (!result) {
    return {
      ok: false,
      body: last.body,
      title: task.title || '',
      words: last.words,
      attempts,
      problems: last.problems,
      level: preset,
    };
  }

  // 润色：只改措辞不改内容，且必须仍然通过同一套校验，否则保留原稿
  if (opts.polish !== false && preset.id === 'highschool') {
    const polished = await polishEssay({
      task: { ...task, level: preset.id },
      body: result.body,
      llm,
      aiConfig,
      signal,
    }).catch(() => null);
    if (polished?.ok) {
      trace(`润色完成：${result.words} → ${polished.words} 词`);
      result = { ...result, body: polished.body, words: polished.words, polished: true };
    } else {
      trace('润色稿没通过校验，保留原稿');
    }
  }

  return result;
}

/**
 * 润色：把已有正文再打磨一遍，措辞更顺，但内容/结构/词汇档位不变。
 * 返回 ok=false 时调用方应保留原稿。
 */
export async function polishEssay(opts) {
  const { task, body, llm, aiConfig = {}, signal } = opts;
  const preset = resolveLevel(task.level);
  const prompt = [
    '## Original essay',
    body,
    '',
    '## Constraints (must all still hold after polishing)',
    `- Level: ${preset.label}. ${preset.vocabulary}`,
    `- Length: ${describeWordRange(task.wordsFrom, task.wordsTo) || 'keep the same length'}`,
    '- Keep the same arguments in the same order; do not add or remove ideas',
    '- Keep the same number of paragraphs',
    '- Fix awkward phrasing, repeated words, and grammar; smooth the flow between sentences',
    '- Do not make it sound more advanced or more "written by a machine"',
    '',
    'Output the polished essay body only.',
  ].join('\n');

  const out = await ai.solve({
    llm,
    config: aiConfig,
    system: POLISH_SYSTEM,
    prompt,
    maxTokens: Math.min(8000, Math.max(1500, (Number(task.wordsTo) || 400) * 6)),
    temperature: 0.35,
    signal,
  });
  const polished = extractEssay(out.text, task);
  const check = checkEssay(polished, task);
  return { ok: check.ok, body: polished, words: check.words, problems: check.problems };
}

/**
 * 根据题干给一个标题（平台标题字段必填，题干里通常不给标题）。
 * 只在前端没有标题时用，优先取题干首句的名词短语。
 */
export async function suggestTitle(opts) {
  const { task, llm, aiConfig = {}, signal } = opts;
  const prompt = [
    'Write ONE English title for the following essay task.',
    'Rules: 3-10 words, no quotes, no trailing period, Title Case, no colon unless necessary.',
    'Output the title only, on a single line.',
    '',
    `Genre: ${task.genre || 'essay'}`,
    `Prompt: ${ai.truncate(task.stem || task.simpleStem || task.title || '', 1500)}`,
  ].join('\n');
  const out = await ai.solve({
    llm,
    config: aiConfig,
    system: 'You are an editor who writes concise English essay titles.',
    prompt,
    maxTokens: 60,
    temperature: 0.4,
    signal,
  });
  const line = String(out.text || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)[0] || '';
  return line.replace(/^["'#*\s]+|["'#*\s]+$/g, '').slice(0, 120);
}
