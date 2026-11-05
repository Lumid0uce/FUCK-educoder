/**
 * 拟人化模块测试：时间节奏 + 代码风格。
 *
 * 这两块都容易"看起来对但实际改坏代码"，所以风格部分重点测不变式。
 */
import assert from 'node:assert/strict';
import * as humanize from '../lib/humanize.mjs';

export default async function run() {
  // ── jitter 落在区间内 ──
  for (let i = 0; i < 200; i++) {
    const v = humanize.jitter(1000, 0.3);
    assert.ok(v >= 700 && v <= 1300, `jitter 越界：${v}`);
  }
  // ratio 会被夹到 0.9，不会出现负数
  const wild = humanize.jitter(1000, 5);
  assert.ok(wild >= 100 && wild <= 1900, `jitter 极端参数越界：${wild}`);

  // ── planTiming 各阶段都是正数，且客观题不排 beforeSave ──
  const codeTiming = humanize.planTiming({ kind: 'code', fileCount: 2, codeChars: 800 });
  assert.ok(codeTiming.read > 0, 'code.read 应为正');
  assert.ok(codeTiming.beforeSave > 0, 'code.beforeSave 应为正');
  assert.ok(codeTiming.beforeBuild > 0, 'code.beforeBuild 应为正');
  assert.equal(typeof codeTiming.retryBackoff, 'function', 'code.retryBackoff 应为函数');
  // 重试越往后等越久（单次有抖动，比平均）
  const avgBackoff = (attempt) => {
    let sum = 0;
    for (let i = 0; i < 300; i++) sum += humanize.planTiming({ kind: 'code' }).retryBackoff(attempt);
    return sum / 300;
  };
  assert.ok(avgBackoff(2) > avgBackoff(1) * 1.5, '重试越往后等越久');

  const objTiming = humanize.planTiming({ kind: 'choice' });
  assert.equal(objTiming.beforeSave, 0, '客观题不该有 beforeSave');
  assert.ok(objTiming.think > 0, '客观题要有思考停顿');

  // 代码越长，敲得越久（单次有 ±30% 抖动，所以比平均值，不能比单次）
  const avgBeforeSave = (codeChars) => {
    let sum = 0;
    for (let i = 0; i < 300; i++) sum += humanize.planTiming({ kind: 'code', codeChars }).beforeSave;
    return sum / 300;
  };
  const short = avgBeforeSave(100);
  const long = avgBeforeSave(3000);
  assert.ok(long > short * 1.5, `代码越长 beforeSave 应明显更大（${Math.round(short)} → ${Math.round(long)}）`);

  // ── scaleWait：倍率与上限 ──
  assert.equal(humanize.scaleWait(10_000, { speed: 1 }), 10_000);
  assert.equal(humanize.scaleWait(10_000, { speed: 0.5 }), 5_000);
  assert.equal(humanize.scaleWait(10_000, { speed: 0 }), 0, 'speed=0 表示完全不等待');
  assert.equal(humanize.scaleWait(10_000, { speed: -3 }), 10_000, '负数应退回 1');
  assert.equal(humanize.scaleWait(10_000, { speed: 1, maxWaitMs: 3000 }), 3000, '应被 maxWaitMs 截断');
  assert.equal(humanize.scaleWait(0, { speed: 1 }), 0);

  // ── sleep 真的会等，且能被 abort ──
  const t0 = Date.now();
  await humanize.sleep(60);
  assert.ok(Date.now() - t0 >= 45, 'sleep 没等够');

  const ac = new AbortController();
  const p = humanize.sleep(5000, ac.signal);
  setTimeout(() => ac.abort(), 30);
  await assert.rejects(p, (e) => e.name === 'AbortError');

  // ── analyzeStyle：能认出用户真实提交过的写法 ──
  const allman = [
    '#include <stdio.h>\n\nint main(void)\n{\n    int a, b;\n    if (a > b)\n        printf("x");\n    return 0;\n}\n',
  ].join('');
  const s1 = humanize.analyzeStyle([{ content: allman }]);
  assert.equal(s1.indent, 'space');
  assert.equal(s1.indentWidth, 4);
  assert.equal(s1.brace, 'next-line');
  assert.equal(s1.keywordSpace, true);
  assert.equal(s1.includeSpace, true);
  assert.equal(s1.samples, 1);

  // tab 缩进 + #include< 无空格 + if( 无空格
  const tight = '#include<stdio.h>\nint main(void)\n{\n\tint x;\n\tif(x>0)\n\t\treturn 1;\n\treturn 0;\n}\n';
  const s2 = humanize.analyzeStyle([{ content: tight }]);
  assert.equal(s2.indent, 'tab');
  assert.equal(s2.includeSpace, false);
  assert.equal(s2.keywordSpace, false);

  // 空样本不炸
  const s3 = humanize.analyzeStyle([]);
  assert.equal(s3.samples, 0);
  assert.equal(humanize.styleHints(s3), '', '没样本时不该给提示词');

  // 风格提示词包含关键约束
  const hints = humanize.styleHints(s1);
  assert.match(hints, /4 个空格/);
  assert.match(hints, /单独占一行/);
  assert.match(hints, /#include <stdio\.h>/);

  // ── applyStyle：只改空白，不改语义 ──
  const src = '#include <stdio.h>\nint main(void)\n{\n    int a = 1;\n    return a;\n}\n';

  // 转成 tab 缩进
  const toTab = humanize.applyStyle(src, { indent: 'tab', indentWidth: 4 });
  assert.ok(toTab.changed);
  assert.ok(toTab.code.includes('\tint a = 1;'), '应把 4 空格换成 tab');
  assert.equal(
    toTab.code.replace(/\s+/g, ''),
    src.replace(/\s+/g, ''),
    '去掉空白后必须完全一致（不能动内容）',
  );

  // 转成 2 空格缩进
  const toTwo = humanize.applyStyle(toTab.code, { indent: 'space', indentWidth: 2 });
  assert.ok(toTwo.code.includes('  int a = 1;'), '应把 tab 换成 2 空格');

  // #include 空格两种方向
  assert.ok(humanize.applyStyle(src, { includeSpace: false }).code.includes('#include<stdio.h>'));
  assert.ok(
    humanize.applyStyle('#include<stdio.h>\nint main(){return 0;}\n', { includeSpace: true }).code.includes('#include <stdio.h>'),
  );

  // 跨行字符串必须原样返回（不能把字符串里的空白改掉）
  const multiline = 'const char *s = "line1\\\n    line2";\nint main(void){return 0;}\n';
  const guarded = humanize.applyStyle(multiline, { indent: 'tab', indentWidth: 4 });
  assert.equal(guarded.changed, false);
  assert.equal(guarded.code, multiline);
  assert.match(guarded.reason ?? '', /跨行字符串/);

  // 字符串里的空格也不能被当成缩进改写
  const withStr = 'int main(void)\n{\n    printf("    four spaces in string");\n    return 0;\n}\n';
  const r = humanize.applyStyle(withStr, { indent: 'tab', indentWidth: 4 });
  assert.ok(r.code.includes('"    four spaces in string"'), '字符串里的空格不能被改');

  // ── 花括号位置改写 ──
  const knr = 'int main(void) {\n  int a = 1;\n  if (a > 0) {\n    return a;\n  }\n  return 0;\n}';
  const toAllman = humanize.applyStyle(knr, { indent: 'space', indentWidth: 4, brace: 'next-line' });
  assert.equal(toAllman.code, 'int main(void)\n{\n    int a = 1;\n    if (a > 0)\n    {\n        return a;\n    }\n    return 0;\n}');
  assert.equal(toAllman.code.replace(/\s+/g, ''), knr.replace(/\s+/g, ''), '花括号改写不能动内容');

  const allmanSrc = 'int main(void)\n{\n    int a = 1;\n    if (a > 0)\n    {\n        return a;\n    }\n    return 0;\n}';
  const backToKnr = humanize.applyStyle(allmanSrc, { indent: 'space', indentWidth: 4, brace: 'same-line' });
  assert.ok(backToKnr.code.startsWith('int main(void) {'), '应把 { 并回上一行');
  assert.ok(backToKnr.code.includes('if (a > 0) {'));
  assert.equal(backToKnr.code.replace(/\s+/g, ''), allmanSrc.replace(/\s+/g, ''));

  // 2 空格缩进 → 4 空格（模型常见写法）
  const twoSpace = 'int main(void)\n{\n  int a = 1;\n  if (a > 0)\n  {\n    return a;\n  }\n  return 0;\n}';
  const toFour = humanize.applyStyle(twoSpace, { indent: 'space', indentWidth: 4, brace: 'next-line' });
  assert.ok(toFour.code.includes('\n    int a = 1;'), '2 空格应扩成 4 空格');
  assert.ok(toFour.code.includes('\n        return a;'), '嵌套层级也要跟着扩');
  assert.equal(toFour.code.replace(/\s+/g, ''), twoSpace.replace(/\s+/g, ''));

  // 注释行/宏里的 { 不能被挪（挪了就把代码挪进注释里了）
  const withComment = '// 这里说明 { 的用法\nint main(void) { return 0; }\n';
  const guarded2 = humanize.applyStyle(withComment, { brace: 'next-line' });
  assert.ok(guarded2.code.includes('// 这里说明 { 的用法'), '注释行不能被拆');
  assert.equal(guarded2.code.replace(/\s+/g, ''), withComment.replace(/\s+/g, ''));

  // 单行 {}、结构体、数组初始化：不该被粗暴拆开
  const compact = 'struct P { int x; };\nint a[3] = {1, 2, 3};\n';
  const compactOut = humanize.applyStyle(compact, { brace: 'next-line' });
  assert.equal(compactOut.code.replace(/\s+/g, ''), compact.replace(/\s+/g, ''), '紧凑写法不能被改坏');

  // ── 关键字与括号的空格 ──
  const tightKw = 'int main(void)\n{\n    if(x) return 1;\n    for(i=0;i<3;i++) printf("x");\n    return 0;\n}';
  const spaced = humanize.applyStyle(tightKw, { keywordSpace: true });
  assert.ok(spaced.code.includes('if (x)'), '应给 if 补空格');
  assert.ok(spaced.code.includes('for (i=0;i<3;i++)'), '应给 for 补空格');
  assert.equal(spaced.code.replace(/\s+/g, ''), tightKw.replace(/\s+/g, ''));

  const spacedKw = 'if (x) { return 1; }';
  assert.ok(humanize.applyStyle(spacedKw, { keywordSpace: false }).code.includes('if(x)'));

  // 字符串里的 if( 不能被当成代码改
  const inString = 'printf("if(x) and for(y)");\nif(x) return 1;\n';
  const stringOut = humanize.applyStyle(inString, { keywordSpace: true });
  assert.ok(stringOut.code.includes('"if(x) and for(y)"'), '字符串内容不能被改');
  assert.ok(stringOut.code.includes('if (x)'), '字符串之外的代码要改');

  // 空输入 / 无画像
  assert.equal(humanize.applyStyle('', { indent: 'tab' }).changed, false);
  assert.equal(humanize.applyStyle('int x;', null).changed, false);

  // ── extractSkeleton：去掉 Begin/End 之间的待填区 ──
  const tpl = '/********* Begin *********/\n\n/********* End *********/\nint main(void){return 0;}';
  const sk = humanize.extractSkeleton(tpl);
  assert.ok(!/Begin|End/.test(sk), '骨架里不该残留 Begin/End 标记');
  assert.ok(sk.includes('int main'), '骨架应保留模板代码');

  const tpl2 = '********* Begin *********\n\n********* End *********\n#include <stdio.h>';
  assert.ok(!/Begin|End/.test(humanize.extractSkeleton(tpl2)));

  // 没有占位符时整份返回
  const plain = 'int main(void){return 0;}';
  assert.equal(humanize.extractSkeleton(plain), plain);
  assert.equal(humanize.extractSkeleton(''), '');

  return '拟人化：节奏抖动/可中断/风格归纳/风格套用/骨架提取 全部通过';
}
