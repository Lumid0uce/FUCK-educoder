/**
 * 评测结论判定单测：API 路的 test_sets 解析（布尔 result 的真实格式）+ 浏览器路的页面文字判定。
 */
import assert from 'node:assert/strict';
import { judgeVerdictText } from '../lib/solver.mjs';
import { readBuildResult, readGameStatus } from '../lib/educoder-api.mjs';

export default async function run() {
  let n = 0;

  // 页面文字判定
  assert.equal(judgeVerdictText('恭喜！评测通过 3/3'), 'pass');
  assert.equal(judgeVerdictText('评测失败：编译错误'), 'fail');
  assert.equal(judgeVerdictText('Compilation Error at line 3'), 'fail');
  assert.equal(judgeVerdictText('Runtime Error: index out of range'), 'fail');
  assert.equal(judgeVerdictText('本关未通过'), 'fail');
  assert.equal(judgeVerdictText('等待评测…'), 'unknown', '没信息时应返回 unknown 而不是瞎猜');
  assert.equal(judgeVerdictText(''), 'unknown');
  n += 7;

  // ── game_status.json（真实格式：result 是布尔）──
  const pending = readGameStatus({ test_sets: [{ result: null }] });
  assert.equal(pending.state, 'pending', 'result 为 null 表示还在跑');

  const passing = readGameStatus({
    test_sets: [
      { result: true, compile_success: 1, output: 'Hello World' },
      { result: true, compile_success: 1, output: 'ok' },
    ],
  });
  assert.equal(passing.state, 'pass');
  assert.equal(passing.passed, 2);
  assert.equal(passing.total, 2);

  const failing = readGameStatus({
    test_sets: [
      { result: true, compile_success: 1 },
      { result: false, compile_success: 1, output: 'Hello World', actual_output: 'Hello' },
    ],
    last_compile_output: '',
  });
  assert.equal(failing.state, 'fail');
  assert.equal(failing.passed, 1);
  assert.ok(failing.cases[1].message.includes('Hello'), '失败用例应带出实际输出');

  // 编译失败：compile_success=0，actual_output 是「编译失败…」，报错在 last_compile_output
  const compileFail = readGameStatus({
    test_sets: [
      { result: false, compile_success: 0, output: 'Hello World', actual_output: '编译失败，请在测试结果中查看具体的错误信息' },
    ],
    last_compile_output: "a.c:2:5: error: redefinition of 'main'<br/> int main(void)<br/>",
  });
  assert.equal(compileFail.state, 'fail');
  assert.equal(compileFail.cases[0].compileFailed, true);
  assert.ok(compileFail.compileOutput.includes('redefinition of'), '应还原出编译器报错');
  assert.ok(!compileFail.compileOutput.includes('<br/>'), '<br/> 应换成换行');
  n += 12;

  // 混合：部分 pending 时整体必须是 pending
  assert.equal(readGameStatus({ test_sets: [{ result: true }, { result: null }] }).state, 'pending');
  assert.equal(readGameStatus({ test_sets: [] }).state, 'unknown');
  assert.equal(readGameStatus({ test_sets: [], status: 2 }).state, 'pass', 'status=2 视为完成');
  n += 3;

  // ── task 详情里的 test_sets（同样布尔格式，作为备用路径）──
  assert.equal(readBuildResult({ data: { challenge: { test_sets: [{ result: null }] } } }).state, 'pending');
  assert.equal(readBuildResult({ data: { challenge: { test_sets: [{ result: true }, { result: true }] } } }).state, 'pass');
  const fail2 = readBuildResult({
    data: { challenge: { test_sets: [{ result: true }, { result: false, actual_output: 'WA' }] } },
  });
  assert.equal(fail2.state, 'fail');
  assert.equal(fail2.passed, 1);
  assert.equal(fail2.cases[1].message, 'WA');
  assert.equal(readBuildResult({ data: { game: { status: 2 }, challenge: {} } }).state, 'pass');
  assert.equal(readBuildResult({ data: { challenge: {} } }).state, 'unknown');
  assert.equal(readBuildResult({ data: { challenge: { test_sets: [{ result: true }, { result: null }] } } }).state, 'pending');
  n += 7;

  return `评测判定单测：${n} 条断言全过`;
}
