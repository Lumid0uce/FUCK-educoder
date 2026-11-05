/**
 * API 层纯函数单测：签名、URL 解析、字段归一、占位符识别。
 */
import assert from 'node:assert/strict';
import * as api from '../lib/educoder-api.mjs';

export default async function run() {
  let n = 0;

  // 签名
  const s1 = api.sign('GET', 1700000000000);
  assert.match(s1, /^[0-9a-f]{32}$/, '签名应是 32 位 hex');
  assert.equal(api.sign('GET', 1700000000000), s1, '同输入应同输出');
  assert.notEqual(api.sign('POST', 1700000000000), s1, '不同方法应不同签名');
  n += 3;

  // URL 解析
  assert.equal(api.parseTaskId('https://www.educoder.net/tasks/nz3x7y4m'), 'nz3x7y4m');
  assert.equal(api.parseTaskId('https://www.educoder.net/tasks/abc?homework_common_id=1'), 'abc');
  assert.equal(api.parseTaskId('https://www.educoder.net/classrooms/c1/homework/9/tasks/tt1'), 'tt1');
  assert.equal(api.parseTaskId('https://www.educoder.net/paths/3'), undefined);
  assert.equal(api.parseHomeworkId('https://www.educoder.net/tasks/x?homework_common_id=777'), '777');
  assert.equal(api.parseShixunId('https://www.educoder.net/shixuns/ss1/challenges'), 'ss1');
  // 新式三段式 URL：/tasks/<course>/<hw>/<taskId>，第一段是课程号不是 task id
  const threeSeg = 'https://www.educoder.net/tasks/R9VAZCPK/4201563/faweobst9iy8';
  assert.equal(api.parseTaskId(threeSeg), 'faweobst9iy8', '三段式应取最后一段');
  assert.equal(api.parseHomeworkId(threeSeg), '4201563', '三段式应取中间数字段');
  assert.equal(api.parseTaskId('https://www.educoder.net/tasks/R9VAZCPK/4201563/faweobst9iy8?x=1'), 'faweobst9iy8');
  // query 优先于路径段
  assert.equal(
    api.parseHomeworkId('https://www.educoder.net/tasks/R9VAZCPK/4201563/faweobst9iy8?homework_common_id=999'),
    '999',
  );
  n += 10;

  // 字段归一
  const taskJson = {
    data: { challenge: { name: 'T', task_pass: '题干', path: 'a.py；b.c', files: [{ path: 'a.py', content: 'x' }] } },
  };
  assert.equal(api.extractTitle(taskJson), 'T');
  assert.equal(api.extractStatement(taskJson), '题干');
  const files = api.extractFiles(taskJson);
  assert.equal(files.length, 1, 'files 数组应优先于 path');
  assert.equal(files[0].path, 'a.py');
  n += 4;

  const f2 = api.extractFiles({ data: { challenge: { path: 'a.py；b.c' } } });
  assert.equal(f2.length, 2, 'path 应按全角分号拆分');
  assert.equal(f2[1].path, 'b.c');
  assert.equal(api.guessLanguage('x.py'), 'python');
  assert.equal(api.guessLanguage('x.cpp'), 'cpp');
  assert.equal(api.guessLanguage('x.zzz'), '');
  n += 5;

  // 占位符
  assert.equal(api.PLACEHOLDER_RE.test('def f():\n    ————\n'), true);
  assert.equal(api.PLACEHOLDER_RE.test('a — b'), false, '单个破折号不算占位符');
  assert.equal(api.looksUnsolved(''), true);
  assert.equal(api.looksUnsolved('————'), true);
  assert.equal(api.looksUnsolved('def f():\n    return 1\n'), false);
  n += 5;

  // 列表归一
  assert.equal(api.normalizeList({ data: { list: [1, 2], total: 2 } }).list.length, 2);
  assert.equal(api.normalizeList({ data: [1, 2, 3] }).list.length, 3);
  assert.equal(api.normalizeList({ data: { homework_commons: [1], total: 1 } }).list.length, 1);
  assert.equal(api.normalizeList({}).list.length, 0);
  // 真实站点的作业列表在顶层 homeworks，总数在 all_count
  const realHw = { homeworks: [{ homework_id: 11, name: 'h', shixun_identifier: 's1' }], all_count: 1 };
  assert.equal(api.normalizeList(realHw).list.length, 1, '应识别顶层 homeworks');
  assert.equal(api.normalizeList(realHw).total, 1, '应识别 all_count');
  n += 6;

  // 作业条目归一
  const nh = api.normalizeHomework({ homework_id: 42, name: '第2章', shixun_identifier: 's9y', challenge_count: 2, status: ['提交中'] });
  assert.equal(nh.id, 42);
  assert.equal(nh.shixunId, 's9y');
  assert.equal(nh.challengeCount, 2);
  assert.equal(nh.status, '提交中');
  n += 4;

  // 真实题目：标题在 challenge.subject
  assert.equal(api.extractTitle({ challenge: { subject: '打印输出 Hello World' } }), '打印输出 Hello World');
  assert.equal(api.extractTitle({ challenge: { name: 'N', subject: 'S' } }), 'N', 'name 优先于 subject');

  // 题型识别
  assert.equal(api.detectKind({ challenge: { subject: '单项选择题' }, chooses: [{}] }).kind, 'choice');
  assert.equal(api.detectKind({ challenge: { subject: '填空题' }, chooses: [{}, {}] }).kind, 'fill');
  assert.equal(api.detectKind({ challenge: { subject: '打印输出 Hello World', path: 'a.c；' } }).kind, 'code');
  assert.equal(api.detectKind({ challenge: {} }).kind, 'unknown');
  const chooses = api.extractChooses({
    chooses: [{ challenge_choose_id: 9, subject: '题1', question_type: 3, multi_count: 2 }],
  });
  assert.equal(chooses.length, 1);
  assert.equal(chooses[0].id, 9);
  assert.equal(chooses[0].question, '题1');
  n += 10;

  // 文件内容 base64 解码（真实响应：{content:{content:'<b64>',size},language:'c'}）
  const b64 = Buffer.from('#include<stdio.h>\nint main(void){return 0;}\n', 'utf8').toString('base64');
  assert.equal(api.decodeMaybeBase64(b64), '#include<stdio.h>\nint main(void){return 0;}\n');
  assert.equal(api.decodeMaybeBase64('已经是明文了'), '已经是明文了', '非 base64 应原样返回');
  assert.equal(api.decodeMaybeBase64(''), '');
  n += 3;

  return `API 层单测：${n} 条断言全过`;
}
