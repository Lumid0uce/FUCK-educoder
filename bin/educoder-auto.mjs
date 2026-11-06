#!/usr/bin/env node
/**
 * educoder-auto CLI。
 *
 * 插件装在 DSH 里时用工具调用就够了；这个 CLI 是给「不想开 GUI」或者
 * 「想写脚本批处理」的场景用的。两条路共用同一套 lib。
 *
 *   educoder-auto status
 *   educoder-auto login
 *   educoder-auto solve <url> [--submit] [--mode api|browser|auto] [--extra "..."]
 *   educoder-auto courses
 *   educoder-auto homework <courseId>
 */

import { parseArgs } from 'node:util';
import * as solver from '../lib/solver.mjs';
import * as session from '../lib/session.mjs';
import * as api from '../lib/educoder-api.mjs';
import * as iwriteSolver from '../lib/iwrite-solver.mjs';
import * as iwriteSession from '../lib/iwrite-session.mjs';
import * as iwriteApi from '../lib/iwrite-api.mjs';
import * as chaoxingSolver from '../lib/chaoxing-solver.mjs';
import * as chaoxingSession from '../lib/chaoxing-session.mjs';
import * as chaoxingApi from '../lib/chaoxing-api.mjs';

const USAGE = `
educoder-auto —— 头歌自动解题 / iWrite 自动写作 CLI

头歌：
  educoder-auto status                         查看登录态 / 浏览器 / 配置文件位置
  educoder-auto login [--timeout 300]          打开浏览器登录，保存登录态
  educoder-auto logout                         清空登录态
  educoder-auto solve <url> [选项]              解一道题
      --submit            真的保存并提交评测（默认只生成代码）
      --mode <m>          auto | api | browser（默认 auto）
      --extra <text>      额外提示，例如上次的报错
      --json              输出完整 JSON
  educoder-auto courses [--limit 30]           列出我的课程
  educoder-auto homework <courseId>            列出某课程的作业

iWrite（英语写作）：
  educoder-auto iwrite-status                  查看 iWrite 登录态与待写作业
  educoder-auto iwrite-login [账号 密码] [选项]  登录 iWrite
      --user <u> --pass <p>   保存账号密码并自动登录
      --manual                强制手动登录（弹窗）
      --timeout <n>           手动登录等待秒数
  educoder-auto iwrite-logout                  清空 iWrite 登录态
  educoder-auto iwrite-solve [url] [选项]       写一篇（不给 url 就自动挑一份未提交的）
      --submit            真的提交（默认只保存草稿）
      --extra <text>      额外写作要求，例如「多用简单句」
      --speed <n>         拟人节奏倍率（1 = 真人；0.02 = 快进 50 倍；0 = 不等待）
      --attempts <n>      不合格时最多重写几轮（默认 3）
      --level <l>         写作水平：highschool（默认，高三/四级词）/ cet4 / cet6
      --no-polish         不做定稿润色
      --json              输出完整 JSON
  educoder-auto iwrite-tasks                   列出我的 iWrite 作业

学习通（超星）：
  educoder-auto chaoxing-status                查看学习通登录态与待做作业
  educoder-auto chaoxing-login [选项]          打开浏览器登录学习通，保存登录态
      --timeout <n>           登录等待秒数（默认 300）
      --force                 已有登录态也重登
  educoder-auto chaoxing-logout                清空学习通登录态
  educoder-auto chaoxing-solve [url|关键词] [选项]  做一份作业（不给就挑列表第一份）
      --submit            真的交卷（默认只暂存）
      --no-verify         不做事后回读校验
      --extra <text>      额外作答要求，例如「全用英文作答」
      --gap <ms>          每题之间的间隔毫秒
      --json              输出完整 JSON
  educoder-auto chaoxing-works                 列出待做作业

环境变量：
  EDUC_AI_BASEURL    OpenAI 兼容接口地址（没有宿主 llm 时的兜底通道）
  EDUC_AI_KEY        对应 apiKey
  EDUC_AI_MODEL      模型名
`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      submit: { type: 'boolean', default: false },
      mode: { type: 'string', default: 'auto' },
      extra: { type: 'string' },
      json: { type: 'boolean', default: false },
      timeout: { type: 'string', default: '300' },
      limit: { type: 'string', default: '30' },
      speed: { type: 'string' },
      attempts: { type: 'string' },
      level: { type: 'string', default: 'highschool' },
      'no-polish': { type: 'boolean', default: false },
      user: { type: 'string' },
      pass: { type: 'string' },
      manual: { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      gap: { type: 'string' },
      'no-verify': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  const cmd = positionals[0];
  if (!cmd || values.help) {
    console.log(USAGE);
    return 0;
  }

  const aiConfig = {
    baseURL: process.env.EDUC_AI_BASEURL || '',
    apiKey: process.env.EDUC_AI_KEY || '',
    model: process.env.EDUC_AI_MODEL || '',
  };

  switch (cmd) {
    case 'status': {
      const saved = await session.loadSession();
      console.log(`数据目录：${session.dataDir()}`);
      console.log(`登录态文件：${session.sessionFile()}${saved ? '（存在）' : '（不存在）'}`);
      if (saved?.cookies) {
        const v = await session.validateCookies(saved.cookies);
        console.log(`登录态：${v.ok ? '✅ 有效' : '❌ ' + v.reason}${saved.savedAt ? `（保存于 ${saved.savedAt}）` : ''}`);
      }
      const { browserStatus } = await import('../lib/browser.mjs');
      console.log(`浏览器：${JSON.stringify(await browserStatus())}`);
      console.log(`HTTP AI 兜底：${aiConfig.baseURL ? '已配置 ' + aiConfig.baseURL : '未配置'}`);
      return 0;
    }

    case 'login': {
      const payload = await session.loginInteractive({
        log: (m) => console.log(m),
        timeoutMs: Number(values.timeout) * 1000,
      });
      console.log(`✅ 登录态已保存：${session.sessionFile()}（${payload.savedAt}）`);
      return 0;
    }

    case 'logout': {
      await session.clearSession();
      console.log('已清空登录态');
      return 0;
    }

    case 'solve': {
      const url = positionals[1];
      if (!url) {
        console.error('缺少 url');
        console.log(USAGE);
        return 2;
      }
      const trace = solver.createTrace();
      const result = await solver.solveUrl({
        url,
        aiConfig,
        submit: values.submit,
        mode: values.mode,
        extra: values.extra,
        trace,
      });
      if (values.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(trace.text());
        console.log('');
        if (result.answers?.length) {
          console.log('作答：');
          result.answers.forEach((a, i) => {
            const q = result.chooses?.[i]?.question;
            const ans = Array.isArray(a) ? JSON.stringify(a) : a;
            console.log(`  ${i + 1}. ${q ? String(q).slice(0, 70) + ' → ' : ''}${ans}`);
          });
          const v = result.verdict;
          if (v?.maxScore !== undefined) {
            console.log(`  得分：${v.finalScore ?? '?'}/${v.maxScore}` + (v.radio !== undefined ? `（${Math.round(v.radio * 100)}%）` : ''));
          }
          console.log('');
        }
        if (result.code) console.log(result.code);
        else if (result.writes) for (const w of result.writes) console.log(`--- ${w.path} ---\n${w.code}`);
        console.log('');
        if (result.verdict?.cases?.length) {
          console.log('评测用例：');
          for (const c of result.verdict.cases) {
            console.log(`  ${c.passed ? '✅' : c.pending ? '⏳' : '❌'} ${c.name}${c.message ? ' — ' + String(c.message).slice(0, 200) : ''}`);
          }
          console.log('');
        }
        const kindLabel = result.kind === 'choice' ? '选择题' : result.kind === 'fill' ? '填空题' : '';
        if (result.passed === true) console.log(`✅ ${kindLabel ? kindLabel + '已通过' : '评测通过'}（${result.channel}）`);
        else if (result.passed === false) console.log(`❌ ${kindLabel ? kindLabel + '未通过' : '评测未通过'}（${result.channel}，试了 ${result.attempts?.length ?? 1} 轮）`);
        else console.log(result.ok ? `✅ 完成（${result.channel}）` : `⚠️ 未完成：${result.reason ?? ''}`);
      }
      return result.passed === true || (result.passed === undefined && result.ok) ? 0 : 1;
    }

    case 'courses': {
      const cookies = await session.getCookies();
      const res = await api.listCourses(cookies, { limit: Number(values.limit) });
      for (const c of res.list) {
        console.log(`${c.id}\t${c.name ?? c.title ?? '(无标题)'}`);
      }
      console.log(`共 ${res.total} 个`);
      return 0;
    }

    case 'homework': {
      const courseId = positionals[1];
      if (!courseId) {
        console.error('缺少 courseId');
        return 2;
      }
      const cookies = await session.getCookies();
      const res = await api.listHomework(cookies, courseId);
      for (const h of res.list) {
        const done = h.finishedCount ?? '?';
        const total = h.challengeCount ?? '?';
        const mark = done === total && total !== '?' && total !== 0 ? '✅' : '  ';
        console.log(
          `${mark} ${h.id}\t${h.name || '(无标题)'}\t${done}/${total} 关\tshixun=${h.shixunId ?? '(无)'}`,
        );
      }
      console.log(`共 ${res.total} 个`);
      return 0;
    }

    case 'iwrite-status': {
      const saved = await iwriteSession.loadSession();
      console.log(`数据目录：${iwriteSession.dataDir()}`);
      console.log(`登录态文件：${iwriteSession.sessionFile()}${saved ? '（存在）' : '（不存在）'}`);
      if (!saved?.cookies) {
        console.log('登录态：❌ 还没有，运行 `educoder-auto iwrite-login`');
        return 1;
      }
      const v = await iwriteSession.validateCookies(saved.cookies);
      console.log(`登录态：${v.ok ? '✅ 有效' : '❌ ' + v.reason}${saved.savedAt ? `（保存于 ${saved.savedAt}）` : ''}`);
      if (v.ok) {
        const studentId = iwriteSolver.pickStudentId(v.user, saved.cookies);
        const listed = await iwriteApi.listTasks(saved.cookies, { studentId });
        const tasks = (listed.stid || []).map((e) => iwriteApi.normalizeTaskEntry(e));
        const pending = tasks.filter((t) => !t.submitted);
        console.log(`作业：共 ${tasks.length} 份，待写 ${pending.length} 份`);
        for (const t of tasks) {
          const w = t.wordsFrom || t.wordsTo ? `${t.wordsFrom ?? ''}-${t.wordsTo ?? ''} 词` : '词数不限';
          console.log(`  ${t.submitted ? '✅' : '⬜'} ${t.taskId}\t${t.title || '(无标题)'}\t${t.genre || '体裁未指定'}\t${w}`);
        }
      }
      console.log(`HTTP AI 兜底：${aiConfig.baseURL ? '已配置 ' + aiConfig.baseURL : '未配置'}`);
      return v.ok ? 0 : 1;
    }

    case 'iwrite-login': {
      const user = values.user || positionals[1];
      const pass = values.pass || positionals[2];
      if (user && pass) {
        await iwriteSession.saveCredentials(user, pass);
        console.log(`账号密码已保存：${iwriteSession.credentialsFile()}`);
      }
      if (values.manual !== true) {
        const auto = await iwriteSession.loginWithCredentials({ log: (m) => console.log(m) });
        if (auto.ok) {
          console.log('✅ iWrite 自动登录成功，登录态已保存');
          return 0;
        }
        console.log(`自动登录没成：${auto.reason}，转手动登录`);
      }
      const payload = await iwriteSession.loginInteractive({
        log: (m) => console.log(m),
        timeoutMs: Number(values.timeout) * 1000,
      });
      console.log(`✅ iWrite 登录态已保存：${iwriteSession.sessionFile()}（${payload.savedAt}）`);
      return 0;
    }

    case 'iwrite-logout': {
      await iwriteSession.clearSession();
      console.log('已清空 iWrite 登录态');
      return 0;
    }

    case 'iwrite-tasks': {
      const cookies = await iwriteSession.getCookies();
      const user = await iwriteApi.currentUser(cookies).catch(() => ({}));
      const studentId = iwriteSolver.pickStudentId(user, cookies);
      const listed = await iwriteApi.listTasks(cookies, { studentId });
      for (const e of listed.stid || []) {
        const t = iwriteApi.normalizeTaskEntry(e);
        const w = t.wordsFrom || t.wordsTo ? `${t.wordsFrom ?? ''}-${t.wordsTo ?? ''} 词` : '词数不限';
        console.log(
          `${t.submitted ? '✅' : '  '} ${t.taskId}\t${t.title || '(无标题)'}\t${t.genre || '体裁未指定'}\t${w}\tclass=${t.classId}`,
        );
      }
      console.log(`共 ${listed.stid?.length ?? 0} 份`);
      return 0;
    }

    case 'iwrite-solve': {
      const url = positionals[1];
      const trace = iwriteSolver.createTrace();
      const result = await iwriteSolver.solveUrl({
        url,
        llm: undefined,
        aiConfig,
        submit: values.submit,
        extra: values.extra,
        maxAttempts: values.attempts ? Number(values.attempts) : 3,
        level: values.level || 'highschool',
        polish: values['no-polish'] !== true,
        humanizeSpeed: values.speed !== undefined ? Number(values.speed) : 1,
        trace,
      });
      if (values.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(trace.text());
        console.log('');
        if (result.task?.title || result.title) console.log(`标题：${result.title || result.task?.title}`);
        if (result.words) console.log(`词数：${result.words}`);
        if (result.problems?.length) {
          console.log('未通过校验：');
          for (const p of result.problems) console.log(`  - ${p}`);
        }
        if (result.verified) {
          console.log(
            `回读：${result.verified.words} 词，正文${result.verified.articleMatches ? '一致' : '不一致'}${result.verified.submitted ? '，已标记提交' : ''}`,
          );
        }
        if (result.body) console.log('\n' + result.body);
        console.log('');
        if (result.ok && result.submitted) console.log('✅ 已提交');
        else if (result.ok) console.log('✅ 已保存草稿（未提交）');
        else console.log(`⚠️ 未完成：${result.reason ?? ''}`);
      }
      return result.ok ? 0 : 1;
    }

    case 'chaoxing-status':
    case 'chaoxing-works': {
      const saved = await chaoxingSession.loadSession();
      console.log(`登录态文件：${chaoxingSession.sessionFile()}${saved ? '（存在）' : '（不存在）'}`);
      if (!saved?.cookies) {
        console.log('登录态：❌ 还没有，运行 `educoder-auto chaoxing-login`');
        return 1;
      }
      const v = await chaoxingSession.validateCookies(saved.cookies);
      console.log(`登录态：${v.ok ? '✅ 有效' : '❌ ' + v.reason}${saved.savedAt ? `（保存于 ${saved.savedAt}）` : ''}`);
      if (v.ok) {
        const works = await chaoxingApi.listWorks(saved.cookies);
        console.log(`作业：共 ${works.length} 份`);
        for (const w of works) {
          const tag = w.submitted ? '已提交' : w.status || '未提交';
          console.log(`  ${String(w.index).padStart(2)}. [${tag}] ${w.title || '(无标题)'}  (taskrefId=${w.taskrefId || '-'} course=${w.courseId || '-'})`);
        }
      }
      console.log(`HTTP AI 兜底：${aiConfig.baseURL ? '已配置 ' + aiConfig.baseURL : '未配置'}`);
      return v.ok ? 0 : 1;
    }

    case 'chaoxing-login': {
      if (!values.force) {
        const saved = await chaoxingSession.loadSession();
        if (saved?.cookies) {
          const v = await chaoxingSession.validateCookies(saved.cookies);
          if (v.ok) {
            console.log('✅ 已有有效登录态，直接复用（要重登加 --force）');
            return 0;
          }
          console.log(`原有登录态失效：${v.reason}，重新登录`);
        }
      }
      const payload = await chaoxingSession.loginInteractive({
        log: (m) => console.log(m),
        timeoutMs: Number(values.timeout) * 1000,
      });
      console.log(`✅ 学习通登录态已保存：${chaoxingSession.sessionFile()}（${payload.savedAt}）`);
      return 0;
    }

    case 'chaoxing-logout': {
      await chaoxingSession.clearSession();
      console.log('已清空学习通登录态');
      return 0;
    }

    case 'chaoxing-solve': {
      const target = positionals[1];
      const trace = chaoxingSolver.createTrace();
      const result = await chaoxingSolver.solveWork({
        workUrl: target && target.includes('doHomeWork') ? target : undefined,
        taskUrl: target && target.includes('mtaskmsgspecial') ? target : undefined,
        pick: target && !target.includes('doHomeWork') && !target.includes('mtaskmsgspecial') ? target : undefined,
        llm: undefined,
        aiConfig,
        submit: values.submit,
        verify: values['no-verify'] !== true,
        extra: values.extra,
        gapMs: values.gap !== undefined ? Number(values.gap) : 0,
        trace,
      });
      if (values.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(trace.text());
        console.log('');
        if (result.title) console.log(`作业：${result.title}`);
        if (result.count) console.log(`题目：${result.count} 道`);
        if (result.problems?.length) {
          console.log('没答上的：');
          for (const p of result.problems) console.log(`  - ${p}`);
        }
        if (result.verified) {
          const v = result.verified;
          const total = (v.matched ?? 0) + (v.mismatch?.length ?? 0);
          console.log(`回读：${v.ok ? '✅ 一致' : '⚠️ 有对不上的'}（核对 ${v.matched ?? 0}/${total} 题）`);
          for (const m of v.mismatch || []) console.log(`  ⚠️ ${m.questionId}：${m.reason}`);
        }
        console.log('');
        if (result.ok && result.submitted) console.log('✅ 已交卷');
        else if (result.ok) console.log('✅ 已暂存（未交卷）');
        else console.log(`⚠️ 未完成：${result.reason ?? ''}`);
      }
      return result.ok ? 0 : 1;
    }

    default:
      console.error(`未知命令：${cmd}`);
      console.log(USAGE);
      return 2;
  }
}
main()
  .then((code) => process.exit(code ?? 0))
  .catch((error) => {
    console.error(`❌ ${error?.message ?? error}`);
    if (error?.code === 'NEED_LOGIN') console.error('提示：先运行 `educoder-auto login`');
    process.exit(1);
  });
