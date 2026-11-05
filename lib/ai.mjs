/**
 * AI 解题层。
 *
 * 两条通道，按顺序尝试：
 *   1. 宿主内置 LLM（`ctx.get('llm')`）—— 不需要用户再配 key，走 DSH 已登录的模型路由。
 *   2. OpenAI 兼容 HTTP 接口 —— 用户自己填 baseURL / apiKey / model，作为兜底。
 *
 * 为什么不是直接读环境变量拿 key：DSH 的模型凭据存在它自己的 settings 里，
 * 插件拿不到明文；走 `llm.stream()` 才能复用宿主已经验证过的路由与鉴权。
 *
 * 图片输入（截图识题）走同一个 stream 接口：content 里塞 `{type:'image', attachment}`，
 * attachment 由宿主 `ctx.get('attachments').saveImage()` 生成。模型不支持图片时宿主会
 * 自己把图片降级成占位文字，所以我们先查 `inputModalities` 再决定要不要发。
 */

import { readFile } from 'node:fs/promises';

/**
 * 客观题（选择 / 填空）作答的 system prompt。
 * 这里要求模型只吐 JSON，因为答案要原样回给平台的 choose_build 接口。
 */
export const OBJECTIVE_SYSTEM = [
  '你是头歌（Educoder）实践教学平台的客观题作答助手，擅长 C/C++、数据结构、计算机基础。',
  '用户会给你若干道选择题或填空题的题干，以及选择题的选项。',
  '',
  '作答要求：',
  '1. 逐题认真分析。选择题要逐项排除，注意 C 语言里 `unsigned` 是关键字不能当标识符、',
  '   标识符只能由字母数字下划线组成且不能以数字开头、八进制不能含 8/9 这类细节。',
  '2. 填空题要精确到字符：换行是 \\n，双引号是 "，空格也算答案的一部分。',
  '   程序输出题要按代码逐行推演，注意 / 与 % 的整数运算、运算符优先级与结合性、前后缀自增的求值时机。',
  '3. 可以先用几行文字写下你的推理过程，但**最后必须输出一行 JSON**，格式：{"answers": [...]}。',
  '4. answers 数组长度必须等于题目数量，顺序与题目一致。',
  '5. 选择题填选项字母的大写字符串，如 "A"；多选按字母升序拼起来，如 "AC"。',
  '6. 填空题填数组，每个空一个字符串，如 ["\\n", "\\""]；空数必须与该题的空数一致。',
  '7. 不确定也要给一个最可能的答案，不要留空、不要写"不确定"。',
  '8. 答案里不要带题号，不要额外加引号或空格（除非答案本身要求）。',
].join('\n');

/**
 * 把客观题组装成给模型的 prompt。
 * @param {{kind: string, label: string, title?: string, chooses: Array<object>, statement?: string}} task
 */
export function buildObjectivePrompt(task) {
  const lines = [];
  lines.push(`题型：${task.label || task.kind}`);
  if (task.title) lines.push(`题目名：${task.title}`);
  if (task.statement) {
    lines.push('');
    lines.push('--- 题干 ---');
    lines.push(truncate(task.statement, 8000));
  }
  lines.push('');
  lines.push(`--- 共 ${task.chooses.length} 道小题 ---`);
  for (const c of task.chooses) {
    lines.push('');
    lines.push(`第 ${c.index + 1} 题${c.multiCount > 1 ? `（${c.multiCount} 个空）` : ''}：`);
    lines.push(truncate(c.question, 2000));
    if (c.options?.length) {
      for (const opt of c.options) lines.push(`  ${opt.label}. ${truncate(opt.text, 400)}`);
    }
  }
  lines.push('');
  lines.push('请按要求只输出 JSON。');
  return lines.join('\n');
}

/**
 * 解析模型返回的客观题答案。
 * 容错：允许 ```json 围栏、允许前后有杂字、允许 answers 直接是数组。
 * @param {string} text
 * @param {number} count - 题目数量
 * @returns {Array<string|string[]>|undefined}
 */
export function extractObjectiveAnswers(text, count) {
  const raw = String(text ?? '').trim();
  if (!raw) return undefined;

  // 去掉可能的代码围栏
  const unfenced = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  let parsed;
  for (const candidate of [unfenced, raw]) {
    try {
      parsed = JSON.parse(candidate);
      break;
    } catch {
      // 再从第一个 { 到最后一个 } 抠一次
      const start = candidate.indexOf('{');
      const end = candidate.lastIndexOf('}');
      if (start >= 0 && end > start) {
        try {
          parsed = JSON.parse(candidate.slice(start, end + 1));
          break;
        } catch {}
      }
      const aStart = candidate.indexOf('[');
      const aEnd = candidate.lastIndexOf(']');
      if (aStart >= 0 && aEnd > aStart) {
        try {
          parsed = JSON.parse(candidate.slice(aStart, aEnd + 1));
          break;
        } catch {}
      }
    }
  }
  if (parsed === undefined) return undefined;

  const answers = Array.isArray(parsed) ? parsed : parsed?.answers;
  if (!Array.isArray(answers) || answers.length !== count) return undefined;
  return answers.map((a) => {
    // 填空题的答案对空白敏感（"\n"、空格本身就是答案），所以数组元素绝不能 trim，
    // 否则换行会被吃成空串——实测就是这么把一道题判错的。
    if (Array.isArray(a)) return a.map((x) => String(x ?? ''));
    // 选择题的字母可以放心 trim
    return String(a ?? '').trim();
  });
}

/**
 * 解题默认的 system prompt：强调"只输出代码"，避免模型把解释塞进代码块外面。
 */
export const SOLVE_SYSTEM = [
  '你是头歌（Educoder）实践教学平台的解题助手。',
  '用户会给你一道编程/实训题的题干、文件结构和当前代码。',
  '你的任务是写出能通过评测的完整代码。',
  '',
  '输出要求（严格遵守）：',
  '1. 用 ``` 围栏输出代码，围栏语言标注写在 ``` 后面。',
  '2. 如果有多个文件需要改，每个文件用一行 `### 文件: <路径>` 开头，然后紧跟该文件的完整代码块。',
  '3. 不要输出任何与代码无关的客套话；必要的说明放在代码块之后，最多 3 行。',
  '4. 代码必须完整可运行，不要写 `// ... 其余不变` 这种省略。',
  '5. 注意平台占位符是连续的长破折号（—），出现它说明这里需要你填写。',
].join('\n');

/**
 * 把 llm.stream 的 chunk 流收敛成文本。
 * @param {AsyncIterable} stream
 * @returns {Promise<{text: string, reasoning: string, finish: any, usage: any}>}
 */
export async function collectStream(stream) {
  let text = '';
  let reasoning = '';
  let finish;
  let usage;
  for await (const chunk of stream) {
    switch (chunk.type) {
      case 'text-delta':
        text += chunk.text;
        break;
      case 'reasoning-delta':
        reasoning += chunk.text;
        break;
      case 'usage':
        usage = chunk.usage;
        break;
      case 'finish':
        finish = chunk.reason;
        break;
      default:
        break;
    }
  }
  return { text, reasoning, finish, usage };
}

/**
 * 挑一个可用的 provider/model。
 * 宿主里通常只有一个路由；配置里显式给了就用配置的。
 * @param {object} llm - ctx.get('llm')
 * @param {{provider?: string, model?: string}} config
 * @returns {Promise<{provider: string, model: string, inputModalities?: string[]}>}
 */
export async function pickRoute(llm, config = {}) {
  const describe = async (provider, model) => {
    // 模型能力（能不能吃图片）只有 resolveModelInfo 说得准；拿不到就当未知。
    let inputModalities;
    try {
      const info = await llm.resolveModelInfo?.(provider, model);
      if (Array.isArray(info?.inputModalities)) inputModalities = [...info.inputModalities];
    } catch {
      /* 能力未知，不影响文本解题 */
    }
    return { provider, model, ...(inputModalities ? { inputModalities } : {}) };
  };

  if (config.provider && config.model) {
    return describe(config.provider, config.model);
  }
  const providers = await llm.listProviders();
  if (!providers.length) throw new Error('宿主没有注册任何 LLM 路由，请检查 DSH 的模型设置');
  const ordered = config.provider
    ? providers.filter((p) => p.id === config.provider).concat(providers.filter((p) => p.id !== config.provider))
    : providers;
  const tried = [];
  for (const provider of ordered) {
    const models = await llm.listModels(provider.id).catch(() => []);
    if (!models.length) {
      tried.push(`${provider.id}: 无可用模型`);
      continue;
    }
    const chosen = config.model ? models.find((m) => m.id === config.model) : models[0];
    if (chosen) return describe(provider.id, chosen.id);
    tried.push(`${provider.id}: 没有模型 ${config.model}`);
  }
  throw new Error(`找不到可用的模型路由（${tried.join('；')}）`);
}

/** 该路由是否明确支持图片输入（未声明能力时返回 undefined，代表"不确定"）。 */
export function routeSupportsImages(route) {
  if (!route?.inputModalities) return undefined;
  return route.inputModalities.includes('image');
}

/** 把本地图片文件读成 { mediaType, data(base64) }，供 HTTP 通道拼 data URL。 */
export async function readImageAsBase64(path) {
  const buf = await readFile(path);
  const mediaType = /\.jpe?g$/i.test(path) ? 'image/jpeg' : /\.webp$/i.test(path) ? 'image/webp' : 'image/png';
  return { mediaType, data: buf.toString('base64'), bytes: buf.length };
}


/**
 * 走宿主内置 LLM 解题。
 * @param {object} opts
 * @param {object} opts.llm - ctx.get('llm')
 * @param {Array<object>} [opts.images] - 已保存的图片 attachment 引用（`{type:'image', attachment}` 的 attachment 部分）
 * @returns {Promise<{text: string, reasoning: string, route: object}>}
 */
export async function solveWithHostLlm({
  llm,
  config = {},
  system = SOLVE_SYSTEM,
  prompt,
  images = [],
  maxTokens = 8192,
  temperature = 0.2,
  signal,
}) {
  const route = await pickRoute(llm, config);
  const userContent = [{ type: 'text', text: prompt }];
  for (const attachment of images) userContent.push({ type: 'image', attachment });
  const stream = llm.stream({
    provider: route.provider,
    model: route.model,
    messages: [
      { role: 'system', content: [{ type: 'text', text: system }] },
      { role: 'user', content: userContent },
    ],
    maxTokens,
    temperature,
    signal,
  });
  const { text, reasoning, finish } = await collectStream(stream);
  if (finish?.kind === 'error') {
    throw new Error(`模型调用失败：${finish.failure?.message ?? '未知错误'}`);
  }
  if (!text.trim()) throw new Error('模型返回了空内容');
  return { text, reasoning, route };
}

/**
 * 走 OpenAI 兼容 HTTP 接口解题（兜底通道）。
 * @param {object} opts
 * @param {Array<{mediaType:string, data:string}>} [opts.images] - base64 图片
 */
export async function solveWithHttp({
  config,
  system = SOLVE_SYSTEM,
  prompt,
  images = [],
  maxTokens = 8192,
  temperature = 0.2,
  signal,
}) {
  const base = (config.baseURL || '').replace(/\/+$/, '');
  if (!base) throw new Error('没有配置 ai.baseURL，HTTP 兜底通道不可用');
  if (!config.apiKey) throw new Error('没有配置 ai.apiKey，HTTP 兜底通道不可用');
  const url = `${base}/chat/completions`;
  const userContent = images.length
    ? [
        { type: 'text', text: prompt },
        ...images.map((img) => ({
          type: 'image_url',
          image_url: { url: `data:${img.mediaType};base64,${img.data}` },
        })),
      ]
    : prompt;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model || 'gpt-4o-mini',
      temperature,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userContent },
      ],
    }),
    signal,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${body.slice(0, 400)}`);
  }
  const json = await res.json();
  const text = json?.choices?.[0]?.message?.content ?? '';
  if (!String(text).trim()) throw new Error('模型返回了空内容');
  return { text: String(text), reasoning: '', route: { provider: 'http', model: config.model || 'gpt-4o-mini' } };
}

/**
 * 统一入口：先宿主 LLM，失败再 HTTP 兜底。
 * @param {object} opts
 * @param {object} [opts.llm] - ctx.get('llm')，没有就跳过宿主通道
 * @param {object} opts.config - 插件配置（ai 段）
 * @param {Array<object>} [opts.images] - 宿主路用的 attachment 引用
 * @param {Array<{mediaType:string, data:string}>} [opts.httpImages] - HTTP 路用的 base64 图片
 */
export async function solve({ llm, config = {}, system, prompt, images, httpImages, maxTokens, temperature, signal }) {
  const errors = [];
  if (llm) {
    try {
      const out = await solveWithHostLlm({ llm, config, system, prompt, images, maxTokens, temperature, signal });
      return { ...out, channel: 'host' };
    } catch (error) {
      errors.push(`宿主模型：${error.message}`);
      if (signal?.aborted) throw error;
    }
  } else {
    // 在 CLI 里跑时没有宿主 llm 服务，说清楚原因，别让用户以为是模型挂了。
    errors.push('宿主模型：当前环境没有 llm 服务（CLI 下正常，请配 EDUC_AI_BASEURL / EDUC_AI_KEY，或在 DSH 里用工具调用）');
  }
  try {
    const out = await solveWithHttp({ config, system, prompt, images: httpImages, maxTokens, temperature, signal });
    return { ...out, channel: 'http' };
  } catch (error) {
    errors.push(`HTTP 通道：${error.message}`);
  }
  throw new Error(`所有解题通道都失败了：\n- ${errors.join('\n- ')}`);
}

/**
 * 截图识题的 system prompt。
 * 只做「把图上的题目读成文字」，不要求它解题——分开做，错在哪一步一眼能看出来。
 */
export const VISION_SYSTEM = [
  '你是 OCR 与题目结构化助手。用户给你一张头歌（Educoder）实训平台的页面截图。',
  '请把截图里的**题目内容**完整转写成文字，包括：关卡标题、任务描述、编程要求、测试说明、输入输出格式。',
  '只转写题目，不要抄代码编辑器里的代码，也不要给出解答。',
  '如果截图里某处看不清，用 [看不清] 标注，不要编造。',
].join('\n');

/**
 * 用截图让模型读题（视觉兜底）。
 * @param {object} opts
 * @param {object} [opts.llm]
 * @param {object} [opts.config]
 * @param {string} [opts.prompt] - 文字提示
 * @param {Array<object>} [opts.images] - 宿主 attachment 引用
 * @param {Array<{mediaType:string,data:string}>} [opts.httpImages]
 */
export async function readStatementFromImages({
  llm,
  config = {},
  prompt = '请把这张截图里的题目内容转写成文字。',
  images,
  httpImages,
  maxTokens = 4096,
  temperature = 0,
  signal,
}) {
  const out = await solve({
    llm,
    config,
    system: VISION_SYSTEM,
    prompt,
    images,
    httpImages,
    maxTokens,
    temperature,
    signal,
  });
  return { text: out.text.trim(), channel: out.channel, route: out.route };
}

/**
 * 从模型回复里抽出代码。
 * 支持两种形态：
 *   - 单个代码块 → { code }
 *   - `### 文件: path` + 代码块（可多段）→ { files: {path: code} }
 * @param {string} text
 * @returns {{ code?: string, files?: Record<string,string>, language?: string, note?: string }}
 */
export function extractCode(text) {
  const src = String(text ?? '');
  const blocks = [];
  const re = /```([^\n`]*)\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const before = src.slice(Math.max(0, m.index - 300), m.index);
    const fileMatch = /###\s*文件[:：]\s*(\S+)\s*$/m.exec(before.trimEnd().split('\n').slice(-3).join('\n'));
    blocks.push({
      language: (m[1] || '').trim(),
      code: m[2].replace(/\s+$/, ''),
      path: fileMatch?.[1]?.trim(),
    });
  }
  if (!blocks.length) {
    // 模型可能直接吐了裸代码（没围栏），兜底整段返回。
    // 但要防住「模型只回了句人话」的情况——那种不能当代码写进编辑器。
    const bare = src.trim();
    if (bare && !bare.includes('```') && looksLikeCode(bare)) return { code: bare };
    return {};
  }
  const named = blocks.filter((b) => b.path);
  if (named.length) {
    const files = {};
    for (const b of named) files[b.path] = b.code;
    return { files, language: named[0].language, note: tailNote(src) };
  }
  return { code: blocks[0].code, language: blocks[0].language, note: tailNote(src) };
}

/** 取最后一个代码块之后的说明文字。 */
function tailNote(src) {
  const idx = src.lastIndexOf('```');
  if (idx < 0) return undefined;
  const tail = src.slice(idx + 3).replace(/^[^\n]*\n/, '').trim();
  return tail ? tail.slice(0, 500) : undefined;
}

/**
 * 粗略判断一段裸文本像不像代码。
 * 目的只有一个：模型只回了「我不确定」这类人话时，别把它当代码写进编辑器。
 * 判据宁可宽松（漏判只是退回"没解析出代码块"这个更安全的失败），
 * 也不能把正常代码误判掉。
 */
export function looksLikeCode(text) {
  const s = String(text ?? '');
  if (!s.trim()) return false;

  // 强信号：这些符号/关键字基本只在代码里出现
  const strong = /[{};]|->|::|\bdef\b|\bfunction\b|\bclass\b|\bimport\b|\breturn\b|\bvar\b|\blet\b|\bconst\b|\bfor\b|\bwhile\b|\bprint\s*\(|^\s*(#|\/\/|\/\*)/m;
  if (strong.test(s)) return true;

  // 多行且行首有缩进，也算代码
  if (s.split('\n').length >= 3 && /^\s{2,}\S/m.test(s)) return true;

  // 没有强信号时：中文占比高的，多半是模型在说人话，不是代码
  const cjk = (s.match(/[\u4e00-\u9fff]/g) ?? []).length;
  if (cjk / s.length > 0.2) return false;

  // 剩下的短英文片段（如 x = 1 / print(x)）按代码处理
  return /[=()\[\]]/.test(s);
}

/**
 * 拼解题 prompt。
 * @param {object} task
 * @param {string} task.title
 * @param {string} [task.statement] - 题干正文
 * @param {Array<{path: string, content: string, language?: string}>} [task.files]
 * @param {string} [task.extra] - 额外上下文（评测报错、用户备注等）
 */
export function buildSolvePrompt(task) {
  const lines = [];
  lines.push(`题目：${task.title || '(未命名)'}`);
  lines.push('');
  if (task.statement) {
    lines.push('--- 题干 ---');
    lines.push(truncate(task.statement, 12000));
    lines.push('');
  }
  if (task.files?.length) {
    lines.push('--- 需要填写的文件 ---');
    for (const f of task.files) {
      lines.push(`### 文件: ${f.path}`);
      lines.push('```' + (f.language || ''));
      lines.push(truncate(f.content ?? '', 8000));
      lines.push('```');
      lines.push('');
    }
  }
  if (task.extra) {
    lines.push('--- 其他信息 ---');
    lines.push(truncate(task.extra, 4000));
    lines.push('');
  }
  lines.push('请给出完整可提交的代码。');
  return lines.join('\n');
}

/** 按字符上限截断，保留头尾。 */
export function truncate(text, max) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.7);
  const tail = max - head - 40;
  return `${s.slice(0, head)}\n...[中间省略 ${s.length - max} 字]...\n${s.slice(-tail)}`;
}
