/**
 * tests/credentials.test.mjs —— iWrite 账号密码存取。
 *
 * 用临时 DSH_HOME，绝不碰真实凭据文件。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export default async function run() {
  const home = await mkdtemp(join(tmpdir(), 'edu-cred-'));
  const old = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    // 每次 import 都要拿到新模块（dataDir 每次调用现算，所以缓存无害）
    const session = await import('../lib/iwrite-session.mjs');

    assert.equal(await session.loadCredentials(), null, '没有文件时应返回 null');

    const file = await session.saveCredentials('13628198902', 'pw-123456');
    assert.equal(file, join(home, 'educoder-auto', 'iwrite-credentials.json'), '凭据应落在 DSH_HOME 下');

    const back = await session.loadCredentials();
    assert.equal(back.username, '13628198902');
    assert.equal(back.password, 'pw-123456');
    assert.ok(back.savedAt, '应记录保存时间');

    const raw = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual(Object.keys(raw).sort(), ['password', 'savedAt', 'username'], '不该有多余字段');

    await session.clearCredentials();
    assert.equal(await session.loadCredentials(), null, '清空后应返回 null');

    // 缺字段的脏文件不能当成有效凭据
    const { writeFile, mkdir } = await import('node:fs/promises');
    await mkdir(join(home, 'educoder-auto'), { recursive: true });
    await writeFile(file, JSON.stringify({ username: 'x' }), 'utf8');
    assert.equal(await session.loadCredentials(), null, '缺 password 应视为没有凭据');
    await writeFile(file, 'not json', 'utf8');
    assert.equal(await session.loadCredentials(), null, '坏 JSON 应视为没有凭据');
  } finally {
    if (old === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = old;
    await rm(home, { recursive: true, force: true });
  }

  return '账号密码存取：落盘路径 / 回读 / 清空 / 脏文件兜底全过';
}
