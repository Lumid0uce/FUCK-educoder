/**
 * dsh-educoder-auto —— 头歌（Educoder）自动解题插件。
 *
 * 给一个题目网址，插件会：
 *   1. 优先走平台 API 拿到结构化题干 + 文件清单（比截图准，也快）
 *   2. 调 AI（宿主内置模型，或用户配的 OpenAI 兼容接口）生成答案
 *   3. 写回文件并触发评测
 *   4. API 走不通时自动降级到浏览器路：开 Edge、截图、抓编辑器内容、写回、点评测
 *
 * 设计取舍：
 *   - 不依赖 Tabbit 浏览器（本机没装），自己用 playwright-core + 系统 Edge。
 *   - 不用 schemastery 的 Config：宿主拿不到 schemastery 时插件也要能加载，
 *     可调项全部走 profile 里那一行的 config 对象。
 *   - 截图会作为图像块进模型上下文，所以模型能"看见"页面，不只是读 DOM。
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import * as solver from './lib/solver.mjs';
import * as session from './lib/session.mjs';
import * as iwriteSolver from './lib/iwrite-solver.mjs';
import * as iwriteSession from './lib/iwrite-session.mjs';
import * as iwriteApi from './lib/iwrite-api.mjs';
import * as chaoxingSolver from './lib/chaoxing-solver.mjs';
import * as chaoxingSession from './lib/chaoxing-session.mjs';
import * as chaoxingApi from './lib/chaoxing-api.mjs';
import { pickRoute, routeSupportsImages } from './lib/ai.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

export const name = 'educoder-auto';
export const inject = ['tools'];

/** 默认配置。 */
const DEFAULTS = {
  /** AI 通道配置：provider/model 留空则自动挑宿主第一个可用路由。 */
  ai: {
    provider: '',
    model: '',
    baseURL: '',
    apiKey: '',
    maxTokens: 8192,
    temperature: 0.2,
  },
  /** 浏览器配置。 */
  browser: {
    /**
     * 默认无头：抓题/截图/评测都在后台跑，不弹窗口、不抢焦点。
     * 登录不受这个开关影响（登录必须看得见窗口，强制有头）。
     * 想看浏览器在干什么就设 true。
     */
    headless: true,
    executablePath: '',
    profileDir: '',
    viewportWidth: 1440,
    viewportHeight: 900,
  },
  /** 默认是否真的提交评测。关掉就是 dry-run，只生成代码不写平台。 */
  autoSubmit: true,
  /** 评测失败时最多重写几轮（把报错回喂给模型）。1 = 不重试。 */
  maxAttempts: 3,
  /** 触发评测后等结果最多多久（毫秒）。头歌评测要拉容器，慢的时候 3 分钟起步。 */
  buildTimeoutMs: 240_000,
  /**
   * 单题最多跑多久（毫秒）。
   * 拟人节奏下一道编程题正常要 2~6 分钟（读题 + 敲代码 + 自查），
   * 评测失败重写还要再来一轮，所以给到 30 分钟。
   */
  taskTimeoutMs: 1_800_000,
  /**
   * 截图识题兜底：API 拿到的题干少于 40 字（或干脆没有）时，
   * 开一次浏览器截图交给视觉模型读题。模型不支持图片时会自动跳过。
   */
  visionFallback: true,
  /**
   * 拟人化（降低被判定为脚本刷题的风险）：
   *   - 读题、写代码、点评测、改 bug 各阶段插入随机停顿；
   *   - 把代码缩进 / #include 空格改成和本人历史提交一致的风格。
   * 只影响节奏和空白字符，不影响答案正确性。
   */
  humanize: true,
  /** 节奏倍率：1 = 拟人节奏；0.2 = 快进 5 倍（调试用）；0 = 完全不等待。 */
  humanizeSpeed: 1,
  /** 节奏档位：brisk 熟练工（快）、normal 普通（默认）、relaxed 边玩边写（慢）。 */
  humanizeProfile: 'normal',
  /** 单次停顿的上限（毫秒），防止配置异常时卡太久。 */
  maxWaitMs: 600_000,
  /** 代码风格对齐：从题目模板骨架 + 本课程历史提交归纳风格并套用。 */
  styleMatch: true,
  /** 归纳风格时最多翻几道历史关卡（每道要多发 1~2 个请求，别设太大）。 */
  styleSampleTasks: 4,

  // ── iWrite（英语写作）────────────────────────────────────────────────
  /** iWrite 写作部分。和头歌完全独立：自己的登录态、自己的节奏参数。 */
  iwrite: {
    /** 是否真的提交（false = 只保存草稿）。 */
    autoSubmit: true,
    /** 作文不合格时最多重写几轮。 */
    maxAttempts: 3,
    /** 已有草稿够长且合格就沿用，不重写（省一次模型调用，也更像"自己改过"）。 */
    reuseDraft: true,
    /** 写作水平档位：highschool（高三/高考词汇，默认）/ cet4 / cet6。 */
    level: 'highschool',
    /** 定稿前再润色一遍（只改措辞，内容结构不变）。 */
    polish: true,
    /** 拟人节奏：读题 / 构思敲字 / 交卷前检查。 */
    humanize: true,
    humanizeSpeed: 1,
    humanizeProfile: 'normal',
    /** 单篇最多跑多久（毫秒）：拟人节奏下一篇 300 词作文要 30~60 分钟，给 2 小时。 */
    taskTimeoutMs: 7_200_000,
  },

  // ── 学习通（超星）作业 ────────────────────────────────────────────────
  /**
   * 学习通作业部分。同样独立：自己的登录态（chaoxing-session.json）、
   * 自己的浏览器 profile，和头歌/iWrite 互不干扰。
   * 走移动端 API（mooc1-api.chaoxing.com），不开浏览器抓题。
   */
  chaoxing: {
    /** 是否真的交卷。false = 只暂存（老师那边看不到，可以自己再检查）。 */
    autoSubmit: true,
    /** 暂存后回读页面对答案，核对无误才交卷。建议保持开着。 */
    verify: true,
    /** 每题之间的间隔（毫秒），0 = 不留停顿。留一点更像人在做题、也不容易触发风控。 */
    gapMs: 0,
    /** 额外作答要求（会拼进 prompt）。 */
    extra: '',
    /** 一份作业最多跑多久（毫秒）：抓题 + 模型 + 逐题暂存 + 回读 + 交卷。 */
    taskTimeoutMs: 1_800_000,
  },
};

/** 深合并用户配置到默认值。 */
function mergeConfig(base, patch) {
  if (!patch || typeof patch !== 'object') return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') {
      out[k] = mergeConfig(base[k], v);
    } else if (v !== undefined && v !== '') {
      out[k] = v;
    }
  }
  return out;
}

/** 把插件配置转成 lib 层认识的样子。 */
function aiConfigOf(config) {
  return {
    provider: config.ai?.provider || undefined,
    model: config.ai?.model || undefined,
    baseURL: config.ai?.baseURL || '',
    apiKey: config.ai?.apiKey || '',
    maxTokens: config.ai?.maxTokens,
    temperature: config.ai?.temperature,
  };
}

function browserOptsOf(config) {
  return {
    headless: config.browser?.headless !== false,
    executablePath: config.browser?.executablePath || undefined,
    profileDir: config.browser?.profileDir || undefined,
    viewport: {
      width: config.browser?.viewportWidth || 1440,
      height: config.browser?.viewportHeight || 900,
    },
  };
}

/**
 * iWrite 用独立的浏览器 profile。
 * 两个站点分属不同域，但共用一个 profile 会让 cookie 池混在一起，
 * 出问题时很难判断是哪边的登录态脏了。
 */
function iwriteBrowserOptsOf(config) {
  return { ...browserOptsOf(config), profileDir: iwriteSession.profileDir() };
}

/** 学习通同理：再开一份独立 profile。 */
function chaoxingBrowserOptsOf(config) {
  return { ...browserOptsOf(config), profileDir: chaoxingSession.profileDir() };
}

/** 读技能正文（打包时随插件分发）。 */
function readSkillBody() {
  const file = join(HERE, 'skills', 'educoder-auto', 'SKILL.md');
  if (!existsSync(file)) return '';
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/**
 * 把结果里所有 `undefined` 递归剔掉。
 * 宿主对工具返回值做「无损 JSON」校验：值为 undefined 的属性会让整次调用
 * 报 `tool "educoder_solve" returned invalid output: value is not lossless JSON`，
 * 所以这里统一清洗一遍（数组里的 undefined 转成 null，保持长度）。
 */
function pruneUndefined(value) {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0))) return null;
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => {
      const next = pruneUndefined(item);
      return next === undefined ? null : next;
    });
  }
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    const next = pruneUndefined(item);
    if (next !== undefined) out[key] = next;
  }
  return out;
}

/**
 * 把截图路径转成图像块，让模型真的"看见"页面。
 * attachments 服务不在时降级为纯文本（只报路径）。
 */
async function screenshotBlocks(ctx, paths, signal) {
  const attachments = ctx.get('attachments');
  const blocks = [];
  if (!attachments || !paths?.length) return blocks;
  const mediaTypeOf = (p) => {
    const ext = (p.split('.').pop() || '').toLowerCase();
    return ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png';
  };
  const cap = Math.min(attachments.imageLimits?.maxImageBytes ?? 5_000_000, attachments.imageLimits?.maxMessageImageBytes ?? 8_000_000);
  for (const path of paths) {
    if (signal?.aborted) break;
    try {
      const { statSync } = await import('node:fs');
      const info = statSync(path);
      if (info.size > cap) continue;
      const data = readFileSync(path);
      const ref = await attachments.saveImage({ data: new Uint8Array(data), mediaType: mediaTypeOf(path) });
      blocks.push({ type: 'image', attachment: ref });
    } catch (error) {
      ctx.logger?.warn?.(`educoder-auto: 截图转附件失败 ${path}: ${error?.message ?? error}`);
    }
  }
  return blocks;
}

export function apply(ctx, rawConfig) {
  const config = mergeConfig(DEFAULTS, rawConfig ?? {});
  const logger = ctx.logger;
  const tools = ctx.get('tools') ?? ctx.tools;
  if (!tools?.register) {
    logger?.warn?.('educoder-auto: tools 服务不可用，插件未注册任何工具');
    return;
  }

  const aiConfig = aiConfigOf(config);
  const browserOpts = browserOptsOf(config);

  // ── 工具 1：解题主入口 ────────────────────────────────────────────────
  const solveTool = {
    name: 'educoder_solve',
    description: [
      '自动完成头歌（Educoder）平台上的一道题。',
      '传入题目网址，插件会抓取题干与代码文件、调用 AI 生成答案、写回平台并（可选）提交评测。',
      '支持三类题：编程题（写代码 + 评测）、选择题、填空题（直接交答案）。',
      '优先走平台结构化 API；拿不到时自动降级为浏览器操作（开 Edge、截图、写编辑器、点评测）。',
      '截图会作为图像返回，便于确认页面状态。',
      '注意：会真实修改平台上的代码/答案并触发评测，除非 submit=false。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: '头歌题目网址，例如 https://www.educoder.net/tasks/xxxxx?homework_common_id=123',
        },
        mode: {
          type: 'string',
          enum: ['auto', 'api', 'browser'],
          description: 'auto（默认）：API 优先，失败降级浏览器；api：只用 API；browser：只用浏览器',
        },
        submit: {
          type: 'boolean',
          description: '是否真的保存并提交评测。false 时只生成代码不写平台（dry-run）。默认跟随插件配置',
        },
        extra: {
          type: 'string',
          description: '额外提示，例如上次评测的报错信息，会一起喂给模型',
        },
        keepOpen: {
          type: 'boolean',
          description: '跑完是否保留浏览器窗口。默认 false（关掉，避免占住 profile 导致下次启动失败）；想盯着看过程就设 true',
        },
        showBrowser: {
          type: 'boolean',
          description: '是否用有头（可见）浏览器跑。默认 false = 无头后台跑、不弹窗。想看着它操作就设 true（等价于配置 browser.headless: false，只对本次生效）',
        },
        humanize: {
          type: 'boolean',
          description: '是否用拟人节奏（读题/敲代码/自查各停顿一段，让提交时间像真人）。默认 true，快速调试时可设 false',
        },
        speed: {
          type: 'number',
          description: '拟人节奏倍率。1 = 真人速度（一道编程题 2~6 分钟）；0.05 = 快进 20 倍；0 = 完全不等待',
        },
      },
      required: ['url'],
      additionalProperties: false,
    },
    timeoutMs: config.taskTimeoutMs,
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          passed: { type: 'boolean' },
          channel: { type: 'string' },
          title: { type: 'string' },
          code: { type: 'string' },
          reason: { type: 'string' },
          kind: { type: 'string' },
          answers: { type: 'array', items: {} },
          chooses: { type: 'array', items: { type: 'object', additionalProperties: true } },
          verdict: { type: 'object', additionalProperties: true },
          attempts: { type: 'array', items: { type: 'object', additionalProperties: true } },
          trace: { type: 'string' },
          screenshots: { type: 'array', items: { type: 'string' } },
          image: { type: 'object', additionalProperties: true },
          detail: { type: 'object', additionalProperties: true },
        },
        required: ['ok', 'channel', 'trace'],
        additionalProperties: true,
      },
      render: (args, value) => {
        // 标题里的失败原因：优先用 reason；宿主若按 schema 裁剪掉字段，
        // 就从 trace 的最后一行兜底，别让用户看到"未知原因"。
        const lastTraceLine = String(value.trace ?? '').trim().split('\n').filter(Boolean).pop() ?? '';
        const reason = value.reason || value.detail?.reason || lastTraceLine || '未知原因';
        let head;
        const kindLabel = value.kind === 'choice' ? '选择题' : value.kind === 'fill' ? '填空题' : '';
        if (value.passed === true) {
          head = `✅ ${kindLabel ? kindLabel + '已通过' : '评测通过'}：${value.title || args.url}（${value.channel} 通道）`;
        } else if (value.passed === false) {
          head =
            `❌ ${kindLabel ? kindLabel + '未通过' : '评测未通过'}：${value.title || args.url}` +
            `（试了 ${value.attempts?.length ?? 1} 轮）`;
        } else if (value.ok) {
          head = `✅ 已通过 ${value.channel} 通道处理：${value.title || args.url}`;
        } else {
          head = `⚠️ 没有完成：${reason}`;
        }
        const blocks = [
          { type: 'text', text: head },
          { type: 'text', text: value.trace ?? '' },
        ];
        // 客观题：把题目、答案、得分列出来，让用户能自己核对
        if (value.answers?.length) {
          const lines = value.answers.map((a, i) => {
            const q = value.chooses?.[i]?.question;
            const ans = Array.isArray(a) ? JSON.stringify(a) : a;
            return `${i + 1}. ${q ? String(q).slice(0, 80) + ' → ' : ''}${ans}`;
          });
          const score =
            value.verdict?.maxScore !== undefined
              ? `\n得分：${value.verdict.finalScore ?? '?'}/${value.verdict.maxScore}` +
                (value.verdict.radio !== undefined ? `（${Math.round(value.verdict.radio * 100)}%）` : '')
              : '';
          blocks.push({ type: 'text', text: '作答：\n' + lines.join('\n') + score });
        }
        if (value.verdict?.cases?.length) {
          const lines = value.verdict.cases.map(
            (c) => `${c.passed ? '✅' : c.pending ? '⏳' : '❌'} ${c.name}${c.message ? ' — ' + String(c.message).slice(0, 200) : ''}`,
          );
          blocks.push({ type: 'text', text: '评测用例：\n' + lines.join('\n') });
        }
        if (value.code) {
          blocks.push({ type: 'text', text: '最终代码：\n```\n' + value.code + '\n```' });
        }
        if (value.image) blocks.push({ type: 'image', attachment: value.image });
        return blocks;
      },
    },
    async execute(args, exec) {
      const submit = args.submit ?? config.autoSubmit;
      const trace = solver.createTrace();
      const llm = ctx.get('llm');

      // showBrowser: true → 本次用有头浏览器（看着它操作）；否则跟随配置（默认无头）
      const effectiveBrowserOpts =
        args.showBrowser === true ? { ...browserOpts, headless: false } : browserOpts;

      const result = await solver.solveUrl({
        url: args.url,
        llm,
        aiConfig,
        attachments: ctx.get('attachments'),
        extra: args.extra,
        submit,
        mode: args.mode ?? 'auto',
        maxAttempts: config.maxAttempts,
        buildTimeoutMs: config.buildTimeoutMs,
        vision: config.visionFallback !== false,
        humanize: args.humanize ?? config.humanize !== false,
        humanizeSpeed: args.speed ?? config.humanizeSpeed,
        humanizeProfile: config.humanizeProfile,
        maxWaitMs: config.maxWaitMs,
        styleMatch: config.styleMatch !== false,
        styleSampleTasks: config.styleSampleTasks,
        browserOpts: effectiveBrowserOpts,
        keepBrowserOpen: args.keepOpen === true,
        trace,
        signal: exec?.signal,
      });

      const shots = [];
      if (result.screenshot) shots.push(result.screenshot);
      const images = await screenshotBlocks(ctx, shots, exec?.signal);
      return pruneUndefined({
        ok: result.ok === true,
        passed: result.passed,
        channel: result.channel ?? 'unknown',
        title: result.title ?? '',
        code: result.code ?? (result.writes?.[0]?.code ?? ''),
        reason: result.reason,
        kind: result.kind,
        answers: result.answers,
        chooses: result.chooses,
        verdict: result.verdict,
        attempts: result.attempts,
        trace: trace.text(),
        screenshots: shots,
        image: images[0]?.attachment,
        detail: {
          target: result.target,
          files: result.files,
          writes: result.writes?.map((w) => ({ path: w.path, saved: w.saved, reason: w.reason })),
          build: result.build,
          filled: result.filled,
          evaluated: result.evaluated,
        },
      });
    },
  };

  // ── 工具 2：登录 ──────────────────────────────────────────────────────
  const loginTool = {
    name: 'educoder_login',
    description: '打开浏览器让用户登录头歌，登录成功后自动把 session cookie 存到本地（之后 API 通道就能用了）。大约 1 分钟。',
    parameters: {
      type: 'object',
      properties: {
        timeoutSec: { type: 'number', description: '等待登录的最长秒数，默认 300' },
      },
      additionalProperties: false,
    },
    timeoutMs: 360_000,
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          message: { type: 'string' },
          sessionFile: { type: 'string' },
          screenshot: { type: 'string' },
        },
        required: ['ok', 'message'],
        additionalProperties: true,
      },
      render: (args, value) => {
        const blocks = [{ type: 'text', text: value.message }];
        if (value.image) blocks.push({ type: 'image', attachment: value.image });
        return blocks;
      },
    },
    async execute(args, exec) {
      try {
        const payload = await session.loginInteractive({
          log: (m) => logger?.info?.(`educoder-auto: ${m}`),
          timeoutMs: (args.timeoutSec ?? 300) * 1000,
          browserOpts,
        });
        const images = await screenshotBlocks(ctx, [payload.screenshot].filter(Boolean), exec?.signal);
        return pruneUndefined({
          ok: true,
          message: `登录成功，登录态已保存（${session.sessionFile()}）。现在可以用 educoder_solve 了。`,
          sessionFile: session.sessionFile(),
          savedAt: payload.savedAt,
          screenshot: payload.screenshot,
          image: images[0]?.attachment,
        });
      } catch (error) {
        const images = await screenshotBlocks(ctx, [error.screenshot].filter(Boolean), exec?.signal);
        return pruneUndefined({
          ok: false,
          message: `登录失败：${error.message}`,
          screenshot: error.screenshot,
          image: images[0]?.attachment,
        });
      }
    },
  };

  // ── 工具 3：状态检查 ──────────────────────────────────────────────────
  const statusTool = {
    name: 'educoder_status',
    description: '检查头歌插件的状态：登录态是否有效、浏览器能否启动、AI 路由是否可用。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    timeoutMs: 60_000,
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          login: { type: 'object', additionalProperties: true },
          ai: { type: 'object', additionalProperties: true },
          browser: { type: 'object', additionalProperties: true },
          text: { type: 'string' },
        },
        required: ['ok', 'text'],
        additionalProperties: true,
      },
      render: (args, value) => [{ type: 'text', text: value.text }],
    },
    async execute() {
      const lines = [];
      let ok = true;

      // 登录态（validateCookies 返回 {ok, courses, total}，成功标志是 ok 而不是 valid）
      const saved = await session.loadSession();
      let login = { saved: Boolean(saved), ok: false };
      if (saved?.cookies) {
        login = { ...login, ...(await session.validateCookies(saved.cookies)) };
        login.savedAt = saved.savedAt;
      } else {
        login.reason = '还没有登录态，运行 educoder_login';
        ok = false;
      }
      if (login.saved && !login.ok) ok = false;
      lines.push(
        `登录：${login.ok ? `✅ 有效（${login.courses ?? 0} 门课程）` : '❌ ' + (login.reason || '登录态已失效，重新运行 educoder_login')}` +
          (login.savedAt ? `（保存于 ${login.savedAt}）` : ''),
      );

      // AI 路由
      let aiInfo = { ok: false };
      const llm = ctx.get('llm');
      if (llm) {
        try {
          const route = await pickRoute(llm, aiConfig);
          aiInfo = { ok: true, route };
        } catch (error) {
          aiInfo = { ok: false, reason: error.message };
        }
      } else {
        aiInfo = { ok: false, reason: '宿主没有 llm 服务' };
      }
      if (!aiInfo.ok && !(aiConfig.baseURL && aiConfig.apiKey)) ok = false;
      lines.push(
        `AI：${aiInfo.ok ? '✅ ' + aiInfo.route.provider + ' / ' + aiInfo.route.model : '❌ ' + (aiInfo.reason || '没有可用路由') + (aiConfig.baseURL ? '（有 HTTP 兜底配置）' : '')}`,
      );
      if (aiInfo.ok) {
        // 截图识题能不能用，取决于模型吃不吃图；这里提前说清楚，别等跑到一半才发现。
        const vision = routeSupportsImages(aiInfo.route);
        const httpReady = Boolean((aiConfig.baseURL || '').trim() && (aiConfig.apiKey || '').trim());
        aiInfo.vision = vision === true || (vision !== false && httpReady);
        lines.push(
          `截图识题：${
            vision === true
              ? '✅ 模型支持图片输入'
              : vision === false
                ? httpReady
                  ? '✅ 宿主模型不支持图片，走 HTTP 兜底通道'
                  : '❌ 宿主模型只接受文本，且没配 HTTP 兜底'
                : httpReady
                  ? '✅ 模型能力未声明，配了 HTTP 兜底'
                  : '⚠️ 模型能力未声明，可能发不出图片'
          }${config.visionFallback === false ? '（配置里已关闭）' : ''}`,
        );
      }

      // 浏览器
      let browserInfo = { ok: false };
      try {
        const { browserStatus } = await import('./lib/browser.mjs');
        browserInfo = { ok: true, ...(await browserStatus()) };
      } catch (error) {
        browserInfo = { ok: false, reason: error.message };
        ok = false;
      }
      lines.push(`浏览器：${browserInfo.ok ? '✅ playwright-core 可用' + (browserInfo.open ? '（已打开）' : '') : '❌ ' + browserInfo.reason}`);

      // 拟人化：把当前节奏与档位说清楚，免得用户以为卡住了。
      const gearLabel = { brisk: '熟练工（快）', normal: '普通', relaxed: '边玩边写（慢）' };
      const humanizeOn = config.humanize !== false && Number(config.humanizeSpeed) !== 0;
      const speed = Number.isFinite(Number(config.humanizeSpeed)) ? Number(config.humanizeSpeed) : 1;
      lines.push(
        `拟人节奏：${
          humanizeOn
            ? `✅ 开启 · ${gearLabel[config.humanizeProfile] ?? '普通'}${speed !== 1 ? ` · 倍率 ${speed}` : ''}`
            : '⏹ 已关闭（提交记录会明显比真人快）'
        }`,
      );
      lines.push(`代码风格：${config.styleMatch === false ? '⏹ 已关闭' : '✅ 开启（归纳历史提交后对齐缩进/括号）'}`);

      return pruneUndefined({
        ok,
        login,
        ai: aiInfo,
        browser: browserInfo,
        humanize: { enabled: humanizeOn, speed, profile: config.humanizeProfile, styleMatch: config.styleMatch !== false },
        text: lines.join('\n'),
      });
    },
  };

  // ══════════════════════════════════════════════════════════════════════
  // iWrite（外研社英语写作）
  // ══════════════════════════════════════════════════════════════════════

  const iwriteConfig = config.iwrite ?? {};

  // ── 工具 4：iWrite 写作 ───────────────────────────────────────────────
  const iwriteSolveTool = {
    name: 'iwrite_solve',
    description: [
      '自动完成 iWrite（外研社英语写作平台 iwrite.unipus.cn）上的一篇作文。',
      '传写作页网址（或干脆不传，自动挑一份未提交的作业），插件会拉任务详情、',
      '按体裁/词数区间/题干要求/关键词让 AI 写作文、逐条校验后保存并提交。',
      '正文通过接口写入（平台编辑器是 TinyMCE iframe，接口更可靠）。',
      '注意：会真实保存并提交作业，除非 submit=false。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description:
            'iWrite 写作页网址，例如 https://iwrite.unipus.cn/student/daily/write?taskId=123&uid=456&classId=789。不传则自动从作业列表挑一份未提交的',
        },
        taskId: { type: 'string', description: '任务 id（url 里没带时手动给）' },
        classId: { type: 'string', description: '班级 id（url 里没带时手动给）' },
        submit: { type: 'boolean', description: '是否真的提交。false = 只保存草稿（dry-run）。默认跟随配置' },
        extra: { type: 'string', description: '额外要求，例如「多用简单句」「控制在 150 词以内」' },
        maxAttempts: { type: 'number', description: '不合格时最多重写几轮，默认 3' },
        reuseDraft: { type: 'boolean', description: '已有草稿合格就沿用不重写，默认 true' },
        level: {
          type: 'string',
          enum: ['highschool', 'cet4', 'cet6'],
          description: '写作水平档位：highschool = 高三生（高考词汇 + 四级常见词，默认）/ cet4 = 四级 / cet6 = 六级',
        },
        polish: { type: 'boolean', description: '定稿前再润色一遍（只改措辞，不动内容和结构）。默认 true' },
        humanize: { type: 'boolean', description: '是否用拟人节奏（读题/构思敲字/交卷前检查）。默认 true' },
        speed: { type: 'number', description: '拟人节奏倍率。1 = 真人（300 词作文约 30~60 分钟）；0.02 = 快进 50 倍；0 = 不等待' },
      },
      additionalProperties: false,
    },
    timeoutMs: iwriteConfig.taskTimeoutMs ?? 7_200_000,
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          submitted: { type: 'boolean' },
          channel: { type: 'string' },
          title: { type: 'string' },
          body: { type: 'string' },
          words: { type: 'number' },
          attempts: { type: 'number' },
          level: { type: 'string' },
          polished: { type: 'boolean' },
          problems: { type: 'array', items: { type: 'string' } },
          task: { type: 'object', additionalProperties: true },
          verified: { type: 'object', additionalProperties: true },
          reason: { type: 'string' },
          trace: { type: 'string' },
        },
        required: ['ok', 'channel', 'trace'],
        additionalProperties: true,
      },
      render: (args, value) => {
        const lastLine = String(value.trace ?? '').trim().split('\n').filter(Boolean).pop() ?? '';
        const reason = value.reason || lastLine || '未知原因';
        const via = value.channel === 'browser' ? '（页面兜底）' : '';
        let head;
        if (value.ok && value.submitted) {
          head = `✅ 作文已提交${via}：${value.title || value.task?.title || '（无标题）'}（${value.words} 词，${value.attempts} 轮）`;
        } else if (value.ok) {
          head = `✅ 已保存草稿（未提交）${via}：${value.title || '（无标题）'}（${value.words} 词）`;
        } else {
          head = `⚠️ 没有完成：${reason}`;
        }
        const blocks = [{ type: 'text', text: head }, { type: 'text', text: value.trace ?? '' }];
        if (value.level) {
          const label =
            value.level === 'cet4' ? '四级' : value.level === 'cet6' ? '六级' : '高三（高考词汇 + 四级常见词）';
          blocks.push({
            type: 'text',
            text: `水平：${label}${value.polished ? ' · 已润色' : ''}`,
          });
        }
        if (value.task?.genre || value.task?.wordsFrom) {
          const bits = [];
          if (value.task.genre) bits.push(`体裁 ${value.task.genre}`);
          if (value.task.wordsFrom || value.task.wordsTo) {
            bits.push(`要求 ${value.task.wordsFrom ?? ''}-${value.task.wordsTo ?? ''} 词`);
          }
          if (value.task.endTime) bits.push(`截止 ${value.task.endTime}`);
          if (bits.length) blocks.push({ type: 'text', text: '任务：' + bits.join(' · ') });
        }
        if (value.problems?.length) {
          blocks.push({ type: 'text', text: '未通过校验：\n' + value.problems.map((p) => '- ' + p).join('\n') });
        }
        if (value.verified) {
          const v = value.verified;
          const note = v.note ? `（${v.note}）` : '';
          blocks.push({
            type: 'text',
            text: `回读确认：${v.words} 词，正文${v.articleMatches ? '一致' : '不一致'}${v.submitted ? '，平台已标记提交' : ''}${note}`,
          });
        }
        if (value.body) blocks.push({ type: 'text', text: '作文正文：\n\n' + value.body });
        return blocks;
      },
    },
    async execute(args, exec) {
      const trace = iwriteSolver.createTrace();
      const result = await iwriteSolver.solveUrl({
        url: args.url,
        taskId: args.taskId,
        classId: args.classId,
        llm: ctx.get('llm'),
        aiConfig,
        submit: args.submit ?? iwriteConfig.autoSubmit !== false,
        extra: args.extra,
        maxAttempts: args.maxAttempts ?? iwriteConfig.maxAttempts ?? 3,
        reuseDraft: args.reuseDraft ?? iwriteConfig.reuseDraft !== false,
        level: args.level ?? iwriteConfig.level ?? 'highschool',
        polish: args.polish ?? iwriteConfig.polish !== false,
        humanize: args.humanize ?? iwriteConfig.humanize !== false,
        humanizeSpeed: args.speed ?? iwriteConfig.humanizeSpeed ?? 1,
        humanizeProfile: iwriteConfig.humanizeProfile ?? 'normal',
        trace,
        signal: exec?.signal,
      });
      return pruneUndefined({
        ok: result.ok === true,
        submitted: result.submitted === true,
        channel: result.channel ?? 'api',
        title: result.title ?? '',
        body: result.body ?? '',
        words: result.words ?? 0,
        attempts: result.attempts ?? 0,
        level: result.level ?? '',
        polished: result.polished === true,
        problems: result.problems ?? [],
        task: result.task,
        verified: result.verified,
        reason: result.reason,
        trace: trace.text(),
      });
    },
  };

  // ── 工具 5：iWrite 登录 ───────────────────────────────────────────────
  const iwriteLoginTool = {
    name: 'iwrite_login',
    description:
      '登录 iWrite（iwrite.unipus.cn）。默认先用已保存的账号密码**自动登录**（无头、不打扰）；' +
      '没保存过账号密码、或平台触发极验风控时，自动回落到弹窗让你手动登录一次。',
    parameters: {
      type: 'object',
      properties: {
        timeoutSec: { type: 'number', description: '手动登录时等待的最长秒数，默认 300' },
        username: { type: 'string', description: '账号（手机号）。给了就连同 password 一起保存，下次自动登录用' },
        password: { type: 'string', description: '密码。给了就保存到本地（chmod 600），下次自动登录用' },
        manual: { type: 'boolean', description: 'true = 跳过自动登录，直接弹窗手动登。默认 false' },
      },
      additionalProperties: false,
    },
    timeoutMs: 420_000,
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          message: { type: 'string' },
          sessionFile: { type: 'string' },
          user: { type: 'object', additionalProperties: true },
          screenshot: { type: 'string' },
          image: { type: 'object', additionalProperties: true },
        },
        required: ['ok', 'message'],
        additionalProperties: true,
      },
      render: (args, value) => {
        const blocks = [{ type: 'text', text: value.message }];
        if (value.image) blocks.push({ type: 'image', attachment: value.image });
        return blocks;
      },
    },
    async execute(args, exec) {
      const log = (m) => logger?.info?.(`educoder-auto/iwrite: ${m}`);
      // 给了账号密码就先存起来（下次自动登录直接用）
      if (args.username && args.password) {
        await iwriteSession.saveCredentials(args.username, args.password);
        logger?.info?.('educoder-auto/iwrite: 账号密码已保存，下次可以自动登录');
      }
      // 先试自动登录（无头，不弹窗）
      if (args.manual !== true) {
        const auto = await iwriteSession.loginWithCredentials({
          log,
          browserOpts: iwriteBrowserOptsOf(config),
          headless: true,
        });
        if (auto.ok) {
          return pruneUndefined({
            ok: true,
            mode: 'auto',
            message: `iWrite 自动登录成功，登录态已保存（${iwriteSession.sessionFile()}）。`,
            sessionFile: iwriteSession.sessionFile(),
            user: auto.user,
          });
        }
        logger?.info?.(`educoder-auto/iwrite: 自动登录没成（${auto.reason}），转手动登录`);
      }
      try {
        const payload = await iwriteSession.loginInteractive({
          log,
          timeoutMs: (args.timeoutSec ?? 300) * 1000,
          browserOpts: iwriteBrowserOptsOf(config),
        });
        const images = await screenshotBlocks(ctx, [payload.screenshot].filter(Boolean), exec?.signal);
        return pruneUndefined({
          ok: true,
          mode: 'manual',
          message: `iWrite 手动登录成功，登录态已保存（${iwriteSession.sessionFile()}）。`,
          sessionFile: iwriteSession.sessionFile(),
          user: payload.user,
          screenshot: payload.screenshot,
          image: images[0]?.attachment,
        });
      } catch (error) {
        const images = await screenshotBlocks(ctx, [error.screenshot].filter(Boolean), exec?.signal);
        return pruneUndefined({
          ok: false,
          message: `登录失败：${error.message}`,
          screenshot: error.screenshot,
          image: images[0]?.attachment,
        });
      }
    },
  };

  // ── 工具 6：iWrite 状态 ───────────────────────────────────────────────
  const iwriteStatusTool = {
    name: 'iwrite_status',
    description: '检查 iWrite 插件的状态：登录态是否有效、有几份待写作业、AI 路由是否可用。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    timeoutMs: 90_000,
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          login: { type: 'object', additionalProperties: true },
          tasks: { type: 'array', items: { type: 'object', additionalProperties: true } },
          text: { type: 'string' },
        },
        required: ['ok', 'text'],
        additionalProperties: true,
      },
      render: (args, value) => [{ type: 'text', text: value.text }],
    },
    async execute() {
      const lines = [];
      let ok = true;
      let tasks = [];

      const saved = await iwriteSession.loadSession();
      let login = { saved: Boolean(saved), ok: false };
      if (saved?.cookies && Object.keys(saved.cookies).length) {
        const check = await iwriteSession.validateCookies(saved.cookies);
        login = { saved: true, ok: check.ok, user: check.user, reason: check.reason, savedAt: saved.savedAt };
      } else {
        login.reason = '还没有登录态，运行 iwrite_login';
      }
      if (!login.ok) ok = false;
      lines.push(
        `iWrite 登录：${login.ok ? '✅ 有效' + (login.user?.name ? `（${login.user.name}）` : '') : '❌ ' + (login.reason || '登录态已失效，重新运行 iwrite_login')}` +
          (login.savedAt ? `（保存于 ${login.savedAt}）` : ''),
      );

      if (login.ok) {
        try {
          const user = login.user ?? {};
          const studentId = iwriteSolver.pickStudentId(user, saved.cookies);
          const listed = await iwriteApi.listTasks(saved.cookies, { studentId });
          tasks = (listed.stid || []).map((e) => {
            const n = iwriteApi.normalizeTaskEntry(e);
            return {
              taskId: n.taskId,
              classId: n.classId,
              title: n.title,
              genre: n.genre,
              wordsFrom: n.wordsFrom,
              wordsTo: n.wordsTo,
              submitted: n.submitted,
              score: n.score,
            };
          });
          const pending = tasks.filter((t) => !t.submitted);
          lines.push(`作业：共 ${tasks.length} 份，待写 ${pending.length} 份`);
          for (const t of tasks.slice(0, 10)) {
            const w = t.wordsFrom || t.wordsTo ? `${t.wordsFrom ?? ''}-${t.wordsTo ?? ''} 词` : '词数不限';
            lines.push(`  ${t.submitted ? '✅' : '⬜'} ${t.title || t.taskId}｜${t.genre || '体裁未指定'}｜${w}`);
          }
        } catch (error) {
          lines.push(`作业列表拉取失败：${error.message}`);
        }
      }

      // AI 路由（和头歌共用同一套配置）
      let aiInfo = { ok: false };
      const llm = ctx.get('llm');
      if (llm) {
        try {
          aiInfo = { ok: true, route: await pickRoute(llm, aiConfig) };
        } catch (error) {
          aiInfo = { ok: false, reason: error.message };
        }
      } else {
        aiInfo = { ok: false, reason: '宿主没有 llm 服务' };
      }
      if (!aiInfo.ok && !(aiConfig.baseURL && aiConfig.apiKey)) ok = false;
      lines.push(`AI：${aiInfo.ok ? `✅ ${aiInfo.route.provider} / ${aiInfo.route.model}` : '❌ ' + (aiInfo.reason || '没有可用路由')}`);

      const iwHumanize = iwriteConfig.humanize !== false && Number(iwriteConfig.humanizeSpeed) !== 0;
      lines.push(
        `拟人节奏：${iwHumanize ? `✅ 开启 · 倍率 ${iwriteConfig.humanizeSpeed ?? 1}` : '⏹ 已关闭（交卷时间会明显比真人快）'}`,
      );
      const iwLevel = iwriteConfig.level ?? 'highschool';
      const iwLevelLabel =
        iwLevel === 'cet4' ? '四级水平' : iwLevel === 'cet6' ? '六级水平' : '高三生（高考词汇 + 四级常见词）';
      lines.push(`写作水平：✅ ${iwLevelLabel}${iwriteConfig.polish !== false ? ' · 定稿前润色' : ''}`);
      lines.push(`提交：${iwriteConfig.autoSubmit === false ? '⏹ 只存草稿（不提交）' : '✅ 会真的提交'}`);

      return pruneUndefined({
        ok,
        login,
        tasks,
        ai: aiInfo,
        text: lines.join('\n'),
      });
    },
  };

  // ══════════════════════════════════════════════════════════════════════
  // 学习通（超星作业）
  // ══════════════════════════════════════════════════════════════════════

  const chaoxingConfig = config.chaoxing ?? {};

  // ── 工具 7：学习通作业 ────────────────────────────────────────────────
  const chaoxingSolveTool = {
    name: 'chaoxing_solve',
    description: [
      '自动完成学习通（超星 mooc1-api.chaoxing.com）上的一份作业。',
      '不传网址就自动挑作业列表里的第一份，也可以给作业地址、task 地址或标题关键词。',
      '流程：列作业 → 抓题 → AI 作答 → 逐题暂存 → 回读页面对答案 → 确认无误再交卷。',
      '注意：会真实暂存/提交作业（submit=false 就只暂存不交卷）。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description:
            '作业地址：doHomeWork 链接、或作业列表里的 android/mtaskmsgspecial 链接都行。不传则自动挑列表第一份',
        },
        pick: {
          type: 'string',
          description: '不传 url 时用来挑作业：课程/作业标题的关键词，或列表里的序号（1 起）',
        },
        submit: { type: 'boolean', description: '是否真的交卷。false = 只暂存（老师那边看不到）。默认跟随配置' },
        verify: { type: 'boolean', description: '暂存后回读页面对答案，默认 true' },
        extra: { type: 'string', description: '额外作答要求，会拼进 prompt，例如「全用英文作答」' },
        gapMs: { type: 'number', description: '每题之间的间隔毫秒，0 = 不留停顿' },
      },
      additionalProperties: false,
    },
    timeoutMs: chaoxingConfig.taskTimeoutMs ?? 1_800_000,
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          submitted: { type: 'boolean' },
          reason: { type: 'string' },
          workUrl: { type: 'string' },
          title: { type: 'string' },
          count: { type: 'number' },
          questions: { type: 'array', items: { type: 'object', additionalProperties: true } },
          answers: { type: 'array', items: { type: 'object', additionalProperties: true } },
          problems: { type: 'array', items: { type: 'string' } },
          verified: { type: 'object', additionalProperties: true },
          trace: { type: 'string' },
          raw: { type: 'string' },
        },
        required: ['ok'],
        additionalProperties: true,
      },
      render: (args, value) => {
        const head = value.ok
          ? `✅ ${value.submitted ? '作业已交卷' : '答案已暂存（未交卷）'}：共 ${value.count} 道题`
          : `⚠️ 没完成：${value.reason || '未知原因'}`;
        const blocks = [{ type: 'text', text: head }];
        if (value.title) blocks.push({ type: 'text', text: `作业：${value.title}` });
        if (value.trace) blocks.push({ type: 'text', text: value.trace });
        if (value.verified) {
          const v = value.verified;
          blocks.push({
            type: 'text',
            text: `回读校验：${v.ok ? '✅ 一致' : `⚠️ ${v.mismatch?.length ?? 0} 道对不上`}（核对 ${v.matched ?? 0} 道）${
              v.mismatch?.length
                ? '\n' + v.mismatch.map((m) => `- 题 ${m.questionId}：${m.reason || '不一致'}`).join('\n')
                : ''
            }`,
          });
        }
        if (value.problems?.length) {
          blocks.push({ type: 'text', text: '待注意：\n' + value.problems.map((p) => '- ' + p).join('\n') });
        }
        if (value.answers?.length) {
          const lines = value.answers.map((a) => `${a.no}. [${a.kind}] ${a.answer}${a.truncated ? '…' : ''}`);
          blocks.push({ type: 'text', text: '答案：\n' + lines.join('\n') });
        }
        if (value.raw) blocks.push({ type: 'text', text: '模型原始输出（解析失败）：\n' + value.raw });
        return blocks;
      },
    },
    async execute(args, exec) {
      const trace = chaoxingSolver.createTrace();
      const result = await chaoxingSolver.solveWork({
        workUrl: args.url,
        pick: args.pick,
        llm: ctx.get('llm'),
        aiConfig,
        submit: args.submit ?? chaoxingConfig.autoSubmit !== false,
        verify: args.verify ?? chaoxingConfig.verify !== false,
        extra: args.extra ?? chaoxingConfig.extra ?? undefined,
        gapMs: args.gapMs ?? chaoxingConfig.gapMs ?? 0,
        trace,
        signal: exec?.signal,
      });
      return pruneUndefined({
        ok: result.ok === true,
        submitted: result.submitted === true,
        reason: result.reason ?? '',
        workUrl: result.workUrl ?? '',
        title: result.title ?? '',
        count: result.count ?? 0,
        questions: result.questions ?? [],
        answers: result.answers ?? [],
        problems: result.problems ?? [],
        verified: result.verified ?? undefined,
        trace: result.trace ?? trace.text(),
        raw: result.raw ?? undefined,
      });
    },
  };

  // ── 工具 8：学习通登录 ────────────────────────────────────────────────
  const chaoxingLoginTool = {
    name: 'chaoxing_login',
    description:
      '登录学习通（超星）。会弹一个有头的 Edge 窗口，你在里面登录一次（手机号/扫码 + 人机验证），' +
      '登成功后自动抓 cookie 存到本地（chmod 600），之后 chaoxing_status / chaoxing_solve 直接复用。',
    parameters: {
      type: 'object',
      properties: {
        timeoutSec: { type: 'number', description: '等待登录的最长秒数，默认 300' },
        force: { type: 'boolean', description: '已保存的登录态还有效时也重新登一次，默认 false' },
      },
      additionalProperties: false,
    },
    timeoutMs: 420_000,
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          message: { type: 'string' },
          sessionFile: { type: 'string' },
          user: { type: 'object', additionalProperties: true },
          screenshot: { type: 'string' },
        },
        required: ['ok', 'message'],
        additionalProperties: true,
      },
      render: (args, value) => [{ type: 'text', text: value.message }],
    },
    async execute(args) {
      const log = (m) => logger?.info?.(`educoder-auto/chaoxing: ${m}`);

      if (args.force !== true) {
        const saved = await chaoxingSession.loadSession();
        if (saved?.cookies && Object.keys(saved.cookies).length) {
          const check = await chaoxingSession.validateCookies(saved.cookies).catch((e) => ({ ok: false, reason: e.message }));
          if (check.ok) {
            return pruneUndefined({
              ok: true,
              mode: 'reuse',
              message: `学习通登录态还有效，直接复用（${chaoxingSession.sessionFile()}）。`,
              sessionFile: chaoxingSession.sessionFile(),
              user: check.user,
            });
          }
          log(`已存的登录态失效了（${check.reason}），重新登一次`);
        }
      }

      try {
        const payload = await chaoxingSession.loginInteractive({
          log,
          timeoutMs: (args.timeoutSec ?? 300) * 1000,
          browserOpts: chaoxingBrowserOptsOf(config),
        });
        return pruneUndefined({
          ok: true,
          mode: 'interactive',
          message: `学习通登录成功，登录态已保存（${chaoxingSession.sessionFile()}）。`,
          sessionFile: chaoxingSession.sessionFile(),
          user: payload.user,
          screenshot: payload.screenshot,
        });
      } catch (error) {
        return pruneUndefined({
          ok: false,
          mode: 'interactive',
          message: `学习通登录没成功：${error.message}`,
          sessionFile: chaoxingSession.sessionFile(),
          screenshot: error.screenshot,
        });
      }
    },
  };

  // ── 工具 9：学习通状态 ────────────────────────────────────────────────
  const chaoxingStatusTool = {
    name: 'chaoxing_status',
    description: '检查学习通插件的状态：登录态是否有效、作业列表里有哪些待做作业、AI 路由是否可用。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    timeoutMs: 120_000,
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          login: { type: 'object', additionalProperties: true },
          works: { type: 'array', items: { type: 'object', additionalProperties: true } },
          ai: { type: 'object', additionalProperties: true },
          text: { type: 'string' },
        },
        required: ['ok', 'text'],
        additionalProperties: true,
      },
      render: (args, value) => [{ type: 'text', text: value.text }],
    },
    async execute() {
      const lines = [];
      let ok = true;
      let works = [];

      const saved = await chaoxingSession.loadSession();
      let login = { saved: Boolean(saved), ok: false };
      if (saved?.cookies && Object.keys(saved.cookies).length) {
        const check = await chaoxingSession.validateCookies(saved.cookies).catch((e) => ({ ok: false, reason: e.message }));
        login = { saved: true, ok: check.ok, user: check.user, reason: check.reason, savedAt: saved.savedAt };
      } else {
        login.reason = '还没有登录态，运行 chaoxing_login';
      }
      if (!login.ok) ok = false;
      lines.push(
        `学习通登录：${login.ok ? '✅ 有效' + (login.user?.name ? `（${login.user.name}）` : '') : '❌ ' + (login.reason || '登录态已失效，重新运行 chaoxing_login')}` +
          (login.savedAt ? `（保存于 ${login.savedAt}）` : ''),
      );

      if (login.ok) {
        try {
          works = await chaoxingApi.listWorks(saved.cookies);
          lines.push(`作业入口：${works.length} 份`);
          for (const w of works.slice(0, 10)) {
            lines.push(`  ${w.index}. ${w.title || '（无标题）'}`);
          }
        } catch (error) {
          lines.push(`作业列表拉取失败：${error.message}`);
        }
      }

      let aiInfo = { ok: false };
      const llm = ctx.get('llm');
      if (llm) {
        try {
          aiInfo = { ok: true, route: await pickRoute(llm, aiConfig) };
        } catch (error) {
          aiInfo = { ok: false, reason: error.message };
        }
      } else {
        aiInfo = { ok: false, reason: '宿主没有 llm 服务' };
      }
      if (!aiInfo.ok && !(aiConfig.baseURL && aiConfig.apiKey)) ok = false;
      lines.push(`AI：${aiInfo.ok ? `✅ ${aiInfo.route.provider} / ${aiInfo.route.model}` : '❌ ' + (aiInfo.reason || '没有可用路由')}`);

      lines.push(`交卷：${chaoxingConfig.autoSubmit === false ? '⏹ 只暂存（不交卷）' : '✅ 会真的交卷'}`);
      lines.push(`回读校验：${chaoxingConfig.verify === false ? '⏹ 关' : '✅ 开'} · 每题间隔 ${chaoxingConfig.gapMs ?? 0}ms`);

      return pruneUndefined({ ok, login, works, ai: aiInfo, text: lines.join('\n') });
    },
  };

  // ── 注册 ──────────────────────────────────────────────────────────────
  const disposers = [];
  for (const tool of [
    solveTool,
    loginTool,
    statusTool,
    iwriteSolveTool,
    iwriteLoginTool,
    iwriteStatusTool,
    chaoxingSolveTool,
    chaoxingLoginTool,
    chaoxingStatusTool,
  ]) {
    try {
      disposers.push(tools.register(tool));
    } catch (error) {
      logger?.warn?.(`educoder-auto: 注册工具 ${tool.name} 失败：${error?.message ?? error}`);
    }
  }

  // ── 技能（让模型知道怎么用） ──────────────────────────────────────────
  const skills = ctx.get('skills');
  const body = readSkillBody();
  if (skills?.register && body) {
    try {
      disposers.push(
        skills.register({
          name: 'educoder-auto',
          description:
            '自动做题与写作：头歌（Educoder）给题目网址就抓题干、AI 出代码/答案、写回并提交评测；iWrite（iwrite.unipus.cn）按体裁词数要点要求自动写英语作文并提交；学习通（超星）抓整份作业的题、AI 逐题作答、暂存回读校验后交卷',
          source: 'dsh-educoder-auto',
          content: body,
        }),
      );
    } catch (error) {
      logger?.warn?.(`educoder-auto: 注册技能失败：${error?.message ?? error}`);
    }
  }

  ctx.effect?.(() => () => {
    for (const dispose of disposers) {
      try {
        dispose?.();
      } catch {
        /* 卸载失败不影响其它 */
      }
    }
  }, 'educoder-auto: teardown');

  logger?.info?.(
    'educoder-auto: 已注册 educoder_solve / educoder_login / educoder_status / iwrite_solve / iwrite_login / iwrite_status / chaoxing_solve / chaoxing_login / chaoxing_status',
  );
}

export default { name, inject, apply };
