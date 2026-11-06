/**
 * lib/chaoxing-ai.mjs —— 学习通作业的「问模型 + 把模型的话翻译成能提交的答案」。
 *
 * 为什么单独一层：模型返回的是人话（"选 A"、"对"、"第一空 xxx"），
 * 而提交接口只认页面控件的 value（"A"、true、"xxx"）。
 * 中间这层翻译做错，错得不明显——试卷会存进去一堆空或者错位答案，
 * 所以这里每个题型都有明确的归一化规则 + 对不上的时候明确报问题，不硬凑。
 */

import { KIND_LABELS } from './chaoxing-api.mjs';

/** 答题 system prompt。 */
export const ANSWER_SYSTEM = [
  '你是学习通（超星）作业的答题助手，替一名中国大学生完成作业题目。',
  '要求：',
  '1. 只输出 JSON，不要任何解释、不要代码块围栏。',
  '2. 输出格式：{"answers":[{"id":"题目id","answer":"答案"}]}，每道题一条，id 必须原样照抄。',
  '3. 单选题 answer 写选项字母，如 "A"。',
  '4. 多选题 answer 写全部正确选项字母，连写不空隔，如 "ACD"。',
  '5. 判断题 answer 写 "对" 或 "错"。',
  '6. 填空题 answer 写要填的内容；多空题用换行分隔，每个空一行，按空的顺序，不写"第一空："这种前缀。',
  '7. 简答/论述/计算题 answer 写完整作答文本，可以分段，不用写"答："。',
  '8. 编程题 answer 只写程序源码本身，不要 markdown 围栏、不要解释。',
  '9. 不许答"略"、"见教材"这类敷衍内容；实在拿不准就按最合理的答案写，不要留空。',
].join('\n');

/** 题型 → 给模型的一句话约束。 */
function kindRule(question) {
  const kind = question.kind;
  const values = (question.options || []).map((o) => o.value).filter(Boolean);
  switch (kind) {
    case 'single':
      return `这是单选题，只能选一个。可选值：${values.join(' / ') || '（页面没解析出选项）'}`;
    case 'multiple':
      return `这是多选题，可能不止一个正确答案。可选值：${values.join(' / ') || '（页面没解析出选项）'}`;
    case 'judge':
      return `这是判断题，只能答"对"或"错"。`;
    case 'blanks':
      return `这是多空填空题，共 ${question.blanks} 个空，答案按顺序每行一个。`;
    case 'blank':
      return '这是填空题，一个空，直接写要填的内容。';
    case 'text':
      return '这是主观题（简答/论述/计算/编程），写完整作答内容。';
    default:
      return '题型没认出来，按题目本身最合理的方式作答。';
  }
}

/**
 * 拼一次问答的 prompt。
 * @param {Array<object>} questions - fetchWork 拿到的题目
 * @param {string} [extra] - 用户额外要求
 */
export function buildAnswerPrompt(questions, extra) {
  const lines = [];
  lines.push(`下面是一份学习通作业，共 ${questions.length} 道题。逐题作答，按指定 JSON 格式返回。`);
  if (extra) lines.push(`额外要求：${extra}`);
  lines.push('');
  questions.forEach((q, i) => {
    lines.push(`### 第 ${i + 1} 题（id=${q.questionId}，${KIND_LABELS[q.kind] || q.typeName || '题目'}${q.score ? `，${q.score} 分` : ''}）`);
    lines.push(kindRule(q));
    const stem = String(q.stem || '').trim();
    lines.push('题目：');
    lines.push(stem || '（题干没抓到）');
    if (q.options?.length) {
      lines.push('选项：');
      for (const opt of q.options) {
        const label = String(opt.label || '').replace(/\s+/g, ' ').trim();
        lines.push(`  ${opt.value}${label ? `．${label}` : ''}`);
      }
    }
    lines.push('');
  });
  return lines.join('\n');
}

/** 从模型输出里抠出 JSON（容忍围栏、前后废话、单对象包数组）。 */
export function extractJson(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : raw;
  const tryParse = (s) => {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };
  const direct = tryParse(body.trim());
  if (direct) return direct;
  // 前后有废话时按「先出现的那个括号」截一段：
  // 先找 { 还是先找 [ 很重要——{"answers":[...]} 里数组也匹配，
  // 先试数组会只拿到内层那半截。
  const objAt = body.indexOf('{');
  const arrAt = body.indexOf('[');
  const ordered = [];
  if (objAt >= 0 && (arrAt < 0 || objAt < arrAt)) ordered.push(['{', '}']);
  if (arrAt >= 0) ordered.push(['[', ']']);
  if (!ordered.length) ordered.push(['{', '}']);
  for (const [open, close] of ordered) {
    const start = body.indexOf(open);
    const end = body.lastIndexOf(close);
    if (start < 0 || end <= start) continue;
    const parsed = tryParse(body.slice(start, end + 1));
    if (parsed) return parsed;
  }
  return null;
}

/** 把模型输出里的条目整理成 id → 原始答案串。 */
export function collectRawAnswers(parsed) {
  const out = {};
  if (!parsed) return out;
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed.answers) ? parsed.answers : [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const id = String(item.id ?? item.questionId ?? item.qid ?? '').trim();
    if (!id) continue;
    let ans = item.answer;
    if (Array.isArray(ans)) ans = ans.map((x) => String(x ?? '')).join('\n');
    out[id] = String(ans ?? '').trim();
  }
  return out;
}

/** 从一段文字里挑出选项字母（"A"、"A、C"、"答：ACD" 都认）。 */
export function pickLetters(text, validValues) {
  const s = String(text ?? '').toUpperCase();
  const valid = (validValues || []).map((v) => String(v).toUpperCase()).filter(Boolean);
  if (!valid.length) {
    const letters = s.match(/[A-Z]/g) || [];
    return [...new Set(letters)];
  }
  const out = [];
  for (const value of valid) {
    // 选项值可能是 "A" / "A." / "1"，统一按"出现在答案里"判断
    const key = value.replace(/[^A-Z0-9]/g, '');
    if (!key) continue;
    const re = new RegExp(`(^|[^A-Z0-9])${key}([^A-Z0-9]|$)`);
    if (re.test(s)) out.push(value);
  }
  if (out.length) return out;
  // 连写形态（"ACD"）里逐字符找
  const compact = s.replace(/[^A-Z0-9]/g, '');
  for (const value of valid) {
    const key = value.replace(/[^A-Z0-9]/g, '');
    if (key.length === 1 && compact.includes(key)) out.push(value);
  }
  return [...new Set(out)];
}

/** 判断题：模型说"对/正确/√/T"之类的，翻成页面上的某个 value。 */
export function pickJudge(text, validValues) {
  const s = String(text ?? '').trim();
  const positive = /(^|[^不])(对|正确|√|是|true|t|yes|ri)/i.test(s) && !/错误|错|×|false|否/i.test(s);
  const negative = /(错误|错|×|false|f|否|不对)/i.test(s);
  const values = (validValues || []).map(String);
  const lower = values.map((v) => v.toLowerCase());
  const trueIdx = lower.findIndex((v) => v === 'true');
  const falseIdx = lower.findIndex((v) => v === 'false');
  if (trueIdx >= 0 || falseIdx >= 0) {
    if (negative && falseIdx >= 0) return values[falseIdx];
    if (positive && trueIdx >= 0) return values[trueIdx];
    if (negative && trueIdx >= 0) return values[trueIdx];
    if (positive && falseIdx >= 0) return values[falseIdx];
  }
  // 页面用 A/B 表示对/错的情况：按选项文字里的对/错挑
  if (negative) return values.find((v) => /错|false|否|×/i.test(v)) ?? values[1] ?? values[0];
  return values.find((v) => /对|正确|true|是|√/i.test(v)) ?? values[0];
}

/** 多空填空：把模型的一段话拆成 N 个空。 */
export function splitBlanks(text, count) {
  const raw = String(text ?? '').trim();
  if (!raw) return Array.from({ length: count }, () => '');
  if (count <= 1) return [raw];
  // 先按明确的分空标记拆
  let parts = raw
    .split(/\r?\n+/)
    .map((s) => s.replace(/^(第\s*[0-9一二三四五六七八九十]+\s*空[:：]?|空\s*[0-9]+[:：]?|[0-9]+[.、)])\s*/g, '').trim())
    .filter((s) => s.length);
  if (parts.length === count) return parts;
  // 再试 □ / | / ； 这类分隔
  const bySep = raw.split(/[□|｜]|;\s*|；/).map((s) => s.trim()).filter(Boolean);
  if (bySep.length === count) return bySep;
  if (parts.length > count) return parts.slice(0, count);
  // 不够就补空，别错位
  while (parts.length < count) parts.push('');
  return parts;
}

/** 去掉模型偶尔套上的代码围栏。 */
export function stripFence(text) {
  return String(text ?? '')
    .replace(/^\s*```[a-zA-Z0-9+#-]*\s*\n?/, '')
    .replace(/\n?```\s*$/, '')
    .trim();
}

/**
 * 单题归一化：模型原始答案 → 能直接塞进表单的值。
 * @returns {{value: string|string[], note?: string}}
 */
export function normalizeAnswer(question, raw) {
  const kind = question.kind;
  const values = (question.options || []).map((o) => o.value).filter(Boolean);
  const text = String(raw ?? '').trim();

  if (kind === 'single') {
    const letters = pickLetters(text, values);
    if (letters.length === 1) return { value: letters[0] };
    if (letters.length > 1) return { value: letters[0], note: `模型给了多个选项（${letters.join(',')}），单选只取第一个` };
    return { value: values[0] ?? '', note: '没能把答案对上任何选项，取了第一个值兜底' };
  }

  if (kind === 'multiple') {
    const letters = pickLetters(text, values);
    if (letters.length) return { value: letters };
    return { value: [], note: '多选答案对不上任何选项' };
  }

  if (kind === 'judge') {
    return { value: pickJudge(text, values) };
  }

  if (kind === 'blanks') {
    const parts = splitBlanks(text, question.blanks || 1);
    return { value: parts };
  }

  if (kind === 'blank') {
    return { value: stripFence(text) };
  }

  // 主观题 / 认不出题型：原文照发
  return { value: stripFence(text) };
}

/**
 * 一批题目的归一化。
 * @returns {{answers: Record<string, string|string[]>, problems: string[]}}
 */
export function normalizeAll(questions, parsed) {
  const raw = collectRawAnswers(parsed);
  const answers = {};
  const problems = [];
  for (const q of questions) {
    const got = raw[q.questionId];
    if (got === undefined) {
      problems.push(`第 ${q.questionId} 题：模型没给答案`);
      continue;
    }
    const { value, note } = normalizeAnswer(q, got);
    const empty = Array.isArray(value) ? value.length === 0 || value.every((v) => !String(v).trim()) : !String(value).trim();
    if (empty) {
      problems.push(`第 ${q.questionId} 题：归一化后是空答案`);
      continue;
    }
    answers[q.questionId] = value;
    if (note) problems.push(`第 ${q.questionId} 题：${note}`);
  }
  return { answers, problems };
}
