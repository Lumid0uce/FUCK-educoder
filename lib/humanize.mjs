/**
 * 拟人化模块：让自动提交在「时间节奏」和「代码风格」两方面更像真人。
 *
 * 为什么需要：
 *   平台（和老师）能看到的信号里，最容易暴露自动化的不是答案本身，而是
 *     1) 提交时间——同一作业 6 关在 5 分钟内全部完成，且集中在凌晨；
 *     2) 代码风格——历史提交和本次提交的缩进、括号、include 写法完全不同。
 *   这个模块只做这两件事，不碰答案正确性。
 *
 * 设计原则：
 *   - 只增加等待，不改变逻辑；所有等待都可被 AbortSignal 打断。
 *   - 风格处理**只动空白字符**（缩进宽度、include 里的空格、花括号换行位置），
 *     绝不动任何 token；改完会用「抹掉所有空白后必须完全相同」做不变式自检，
 *     不通过就整体回退。多行字符串存在时直接跳过。
 */

/** 可中断的 sleep。被 abort 时抛 AbortError，让上层正常收尾。 */
export function sleep(ms, signal) {
  const delay = Math.max(0, Math.round(ms));
  if (!delay) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error('已取消'), { name: 'AbortError' }));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, delay);
    function onAbort() {
      clearTimeout(timer);
      reject(Object.assign(new Error('已取消'), { name: 'AbortError' }));
    }
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

/** 在 [ms*(1-ratio), ms*(1+ratio)] 之间随机取值，模拟人类的不稳定节奏。 */
export function jitter(ms, ratio = 0.35) {
  const r = Math.min(0.9, Math.max(0, ratio));
  const lo = ms * (1 - r);
  const hi = ms * (1 + r);
  return lo + Math.random() * (hi - lo);
}

/** 闭区间随机整数。 */
function randInt(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

/**
 * 规划一道题的各阶段等待时长（毫秒，未乘 speed）。
 *
 * 参考真实节奏（按"普通学生做一道 C 语言课后题"估）：
 *   - 打开题目、读完任务描述和编程要求：10~40 秒
 *   - 动手敲代码、边敲边改：1~4 分钟（代码越长越久）
 *   - 敲完自己看一遍、点「评测」：5~20 秒
 *   - 评测挂了改 bug：每轮 1~4 分钟，越往后越久（改第二遍比第一遍慢）
 *
 * 这几个区间是"总时长下限"，不是精确值——目的是别出现
 * 「6 道题 5 分钟全做完」这种一眼假的记录。
 *
 * @param {object} opts
 * @param {'code'|'choice'|'fill'} [opts.kind]
 * @param {number} [opts.fileCount] - 要改几个文件
 * @param {number} [opts.codeChars] - 模板代码总字符数
 * @param {'relaxed'|'normal'|'brisk'} [opts.profile] - 节奏档位
 */
export function planTiming({ kind = 'code', fileCount = 1, codeChars = 0, profile = 'normal' } = {}) {
  // 档位倍率：relaxed 更像"边玩手机边写"，brisk 像"熟练工快速刷题"
  const gear = profile === 'relaxed' ? 1.6 : profile === 'brisk' ? 0.55 : 1;

  if (kind === 'choice' || kind === 'fill') {
    // 客观题不用敲代码，但要看题、逐题想、逐题点。
    return {
      read: jitter(randInt(8000, 25_000) * gear, 0.25),
      think: jitter(randInt(20_000, 90_000) * gear, 0.3),
      beforeSave: 0,
      beforeBuild: jitter(randInt(5000, 15_000) * gear, 0.3),
      retryBackoff: () => 0,
    };
  }

  // 编程题：代码越长，敲得越久（每字符约 60ms ≈ 16 字符/秒，接近真人敲代码速度；上限 5 分钟）
  const typing =
    randInt(60_000, 240_000) + Math.min(300_000, Math.round(codeChars * 60)) + (fileCount - 1) * 45_000;
  return {
    read: jitter(randInt(10_000, 40_000) * gear, 0.25),
    think: 0, // 模型生成时间本身就是"思考"
    beforeSave: jitter(typing * gear, 0.3),
    beforeBuild: jitter(randInt(5000, 20_000) * gear, 0.3),
    // 第 1 轮改 bug 1~4 分钟，第 2 轮 1.5 倍（越改越慢更真实）
    retryBackoff: (attempt) => jitter(randInt(60_000, 240_000) * Math.max(1, attempt) * gear, 0.3),
  };
}

/**
 * 把计划好的时长套上 speed 与上限，得到真正要 sleep 的毫秒数。
 * speed=1 是拟人节奏；0.2 差不多是"快进 5 倍"；0 表示完全不等待。
 * 负数/非数字按 1 处理（配置写错时别把整题变成 0 等待，也别变成无限等）。
 */
export function scaleWait(ms, { speed = 1, maxWaitMs = 600_000 } = {}) {
  const n = Number(speed);
  if (Number.isFinite(n) && n === 0) return 0;
  const s = Number.isFinite(n) && n > 0 ? n : 1;
  return Math.min(maxWaitMs, Math.max(0, Math.round(ms * s)));
}

// ─────────────────────────── 代码风格 ───────────────────────────

/**
 * 从若干份代码里归纳风格。
 *
 * 用法上有两种取样：
 *   a) 本题的模板代码（Begin/End 之外的骨架）——最准，因为用户就该照着它写；
 *   b) 用户在本课程里已经提交过的文件——补充样本，看整体习惯。
 *
 * @param {Array<{path?:string, content:string}>} samples
 * @returns {object} 风格画像（字段可能为 undefined，代表没看出来）
 */
export function analyzeStyle(samples = []) {
  const texts = samples
    .map((s) => (typeof s === 'string' ? s : s?.content))
    .filter((t) => typeof t === 'string' && t.trim());

  const tabLines = [];
  const spaceIndents = [];
  let includeSpaced = 0;
  let includeTight = 0;
  let braceSameLine = 0;
  let braceNextLine = 0;
  let keywordSpaced = 0;
  let keywordTight = 0;

  for (const text of texts) {
    for (const line of text.split(/\r?\n/)) {
      if (/^\t+\S/.test(line)) tabLines.push(line);
      const m = /^( {2,})(?=\S)/.exec(line);
      if (m) spaceIndents.push(m[1].length);
      if (/^\s*#\s*include\s+</.test(line)) includeSpaced++;
      if (/^\s*#\s*include</.test(line)) includeTight++;
      if (/\)\s*\{\s*$/.test(line)) braceSameLine++;
      if (/^\s*\{\s*$/.test(line)) braceNextLine++;
      if (/\b(if|for|while|switch)\s+\(/.test(line)) keywordSpaced++;
      if (/\b(if|for|while|switch)\(/.test(line)) keywordTight++;
    }
  }

  // 缩进宽度：取出现最多的那个（限制在 2/3/4/8 里，其余归到最近的）
  let indentWidth;
  if (spaceIndents.length) {
    const counts = new Map();
    for (const n of spaceIndents) {
      const bucket = n <= 2 ? 2 : n <= 4 ? 4 : n <= 8 ? 8 : 4;
      counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
    }
    indentWidth = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  }

  const indent = tabLines.length > spaceIndents.length ? 'tab' : spaceIndents.length ? 'space' : undefined;

  return {
    indent,
    indentWidth: indentWidth ?? (indent === 'tab' ? undefined : 4),
    includeSpace: includeSpaced === includeTight ? undefined : includeSpaced > includeTight,
    brace: braceSameLine === braceNextLine ? undefined : braceSameLine > braceNextLine ? 'same-line' : 'next-line',
    keywordSpace: keywordSpaced === keywordTight ? undefined : keywordSpaced > keywordTight,
    samples: texts.length,
  };
}

/** 把风格画像写成给模型看的自然语言要求。 */
export function styleHints(profile) {
  if (!profile || !profile.samples) return '';
  const lines = [];
  if (profile.indent === 'tab') {
    lines.push('缩进用 Tab，不要用空格。');
  } else if (profile.indent === 'space' && profile.indentWidth) {
    lines.push(`缩进用 ${profile.indentWidth} 个空格，不要用 Tab。`);
  }
  if (profile.includeSpace === true) lines.push('预处理指令写成 `#include <stdio.h>`（#include 和尖括号之间有空格）。');
  if (profile.includeSpace === false) lines.push('预处理指令写成 `#include<stdio.h>`（#include 和尖括号之间没有空格）。');
  if (profile.brace === 'same-line') lines.push('左花括号跟在语句同一行末尾（K&R 风格）。');
  if (profile.brace === 'next-line') lines.push('左花括号单独占一行（Allman 风格）。');
  if (profile.keywordSpace === false) lines.push('关键字和左括号之间不加空格，写 `if(x)` 而不是 `if (x)`。');
  if (profile.keywordSpace === true) lines.push('关键字和左括号之间加空格，写 `if (x)` 而不是 `if(x)`。');
  if (!lines.length) return '';
  return ['必须严格沿用下面这套代码风格（这是本人一贯的写法，风格不一致会被看出来）：', ...lines.map((l) => `- ${l}`)].join('\n');
}

/**
 * 把风格画像套到生成的代码上。
 *
 * 只做两件安全的事：
 *   1) 行首缩进 tab ↔ 空格互换；
 *   2) `#include<` ↔ `#include <` 的空格。
 * 两者都只改空白字符，不改任何 token。
 *
 * 安全阀：如果代码里有跨行字符串（某一行未转义的双引号个数是奇数），
 * 说明行首空白可能落在字符串内部，直接原样返回，宁可风格不一致也不改坏代码。
 *
 * @param {string} code
 * @param {object} profile
 * @returns {{code: string, changed: boolean, reason?: string}}
 */
export function applyStyle(code, profile) {
  const src = String(code ?? '');
  if (!src.trim() || !profile) return { code: src, changed: false, reason: '没有风格画像' };

  // 跨行字符串检测：任一行的未转义 " 是奇数，说明字符串没在本行闭合。
  const lines = src.split(/\r?\n/);
  let unterminated = false;
  for (const line of lines) {
    const quotes = (line.match(/(?<!\\)"/g) ?? []).length;
    if (quotes % 2 === 1) {
      unterminated = true;
      break;
    }
  }
  if (unterminated) return { code: src, changed: false, reason: '代码里有跨行字符串，跳过缩进改写' };

  let out = src;
  const width = profile.indentWidth && profile.indentWidth > 0 ? profile.indentWidth : 4;

  if (profile.indent === 'tab') {
    // 行首每 width 个空格 → 1 个 Tab（余数保留，避免吃掉对齐）
    out = out
      .split('\n')
      .map((line) => {
        const m = /^( +)/.exec(line);
        if (!m) return line;
        const n = m[1].length;
        return '\t'.repeat(Math.floor(n / width)) + ' '.repeat(n % width) + line.slice(n);
      })
      .join('\n');
  } else if (profile.indent === 'space') {
    out = out
      .split('\n')
      .map((line) => {
        const m = /^(\t+)/.exec(line);
        if (!m) return line;
        return ' '.repeat(m[1].length * width) + line.slice(m[1].length);
      })
      .join('\n');
    // 空格缩进但宽度不对（模型常写 2 空格，本人是 4 空格）：按比例重排。
    out = rescaleIndent(out, width);
  }

  if (profile.includeSpace === true) {
    out = out.replace(/^(\s*)#\s*include\s*</gm, '$1#include <');
  } else if (profile.includeSpace === false) {
    out = out.replace(/^(\s*)#\s*include\s+</gm, '$1#include<');
  }

  // 花括号位置：只移动 `{`，不动其它 token（strip 不变式会兜底）。
  if (profile.brace === 'next-line') out = bracesToNextLine(out);
  else if (profile.brace === 'same-line') out = bracesToSameLine(out);

  // 关键字与左括号之间的空格：只加/删一个空格，同样是纯空白改动。
  // 只处理每行第一个引号之前的部分——否则会把字符串里的 "if (x)" 改成 "if(x)"，
  // 那是改内容不是改风格（strip 不变式会拦，但整段回退太浪费）。
  if (profile.keywordSpace === true || profile.keywordSpace === false) {
    const add = profile.keywordSpace === true;
    out = out
      .split('\n')
      .map((line) => {
        const q = firstQuoteIndex(line);
        const head = q < 0 ? line : line.slice(0, q);
        const tail = q < 0 ? '' : line.slice(q);
        const fixed = add
          ? head.replace(/\b(if|for|while|switch)\(/g, '$1 (')
          : head.replace(/\b(if|for|while|switch) \(/g, '$1(');
        return fixed + tail;
      })
      .join('\n');
  }

  // 不变式自检：把所有空白抹掉后必须完全一致，否则说明改到了非空白内容，回退。
  const strip = (s) => s.replace(/\s+/g, '');
  if (strip(out) !== strip(src)) {
    return { code: src, changed: false, reason: '风格改写会动到代码内容，已回退' };
  }

  return { code: out, changed: out !== src };
}

/** 返回一行里第一个未转义双引号的位置，没有就 -1。 */
function firstQuoteIndex(line) {
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\') {
      i++;
      continue;
    }
    if (line[i] === '"') return i;
  }
  return -1;
}

/** 推断一段代码用的缩进单位（取行首空格数的最小正值，限制在 2/3/4/8）。 */
function detectIndentUnit(code) {
  let unit = 0;
  for (const line of code.split('\n')) {
    const m = /^( +)\S/.exec(line);
    if (!m) continue;
    const n = m[1].length;
    if (!unit || n < unit) unit = n;
  }
  if (!unit) return 0;
  if (unit <= 2) return 2;
  if (unit <= 3) return 3;
  if (unit <= 4) return 4;
  return 8;
}

/** 把空格缩进按 source→target 的宽度比例重排。 */
function rescaleIndent(code, target) {
  const source = detectIndentUnit(code);
  if (!source || !target || source === target) return code;
  const ratio = target / source;
  return code
    .split('\n')
    .map((line) => {
      const m = /^( +)(\S.*)$/.exec(line);
      if (!m) return line;
      const level = m[1].length / source;
      // 不是整数倍说明是续行对齐，别动它
      if (!Number.isInteger(level)) return line;
      return ' '.repeat(level * target) + m[2];
    })
    .join('\n');
}

/** `... ) {` → `... )` + `{`（Allman）。只处理行尾的 `{`。 */
function bracesToNextLine(code) {
  const lines = code.split('\n');
  const out = [];
  for (const line of lines) {
    const m = /^(.*\S)\s*\{\s*$/.exec(line);
    // 别碰：已是单独一行 `{`、预处理指令、纯注释行（把 `{` 挪到注释后面会破坏注释）
    if (!m || /^\s*\{/.test(line) || /^\s*#/.test(line) || /^\s*(\/\/|\/\*|\*)/.test(line)) {
      out.push(line);
      continue;
    }
    const indent = /^\s*/.exec(line)[0];
    out.push(m[1]);
    out.push(indent + '{');
  }
  return out.join('\n');
}

/** 单独占一行的 `{` 并回上一行末尾（K&R）。 */
function bracesToSameLine(code) {
  const lines = code.split('\n');
  const out = [];
  for (const line of lines) {
    if (/^\s*\{\s*$/.test(line) && out.length) {
      const prev = out[out.length - 1];
      // 上一行是注释或预处理指令时不能拼，否则会把 `{` 拼进注释/宏里
      if (/^\s*#/.test(prev) || /^\s*(\/\/|\/\*|\*)/.test(prev)) {
        out.push(line);
        continue;
      }
      out[out.length - 1] = prev.replace(/\s*$/, '') + ' {';
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

/**
 * 从题目模板里抽出「骨架代码」——即去掉 Begin/End 之间待填区域后的部分。
 * 这些骨架是老师给的，最能代表本题期望的写法。
 */
export function extractSkeleton(content) {
  const src = String(content ?? '');
  if (!src.trim()) return '';
  // 头歌模板形如：/********* Begin *********/ ... /********* End *********/
  // 或者 ********* Begin ********* / ********* End *********
  const re = /[/*\s]*\**\s*Begin\s*\**\s*[/*]*([\s\S]*?)[/*\s]*\**\s*End\s*\**\s*[/*]*/i;
  const m = re.exec(src);
  if (!m) return src; // 没有占位符，整份都算骨架
  return (src.slice(0, m.index) + '\n' + src.slice(m.index + m[0].length)).trim();
}
