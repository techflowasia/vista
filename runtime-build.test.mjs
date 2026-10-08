import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

async function run(t, mode) {
  const dir = await mkdtemp(join(tmpdir(), 'vista-build-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const calls = join(dir, 'calls');
  await writeFile(
    join(dir, 'docker'),
    `#!${process.execPath}
const fs=require('node:fs');
const a=process.argv.slice(2);
fs.appendFileSync(process.env.CALLS,JSON.stringify(a)+'\\n');
const limit=3*1024**3;
if(a[0]==='info') console.log(JSON.stringify({MemTotal:process.env.MODE==='headroom'?4*1024**3:8*1024**3}));
else if(a[0]==='inspect') console.log(JSON.stringify(a[1].startsWith('buildx_')?[{HostConfig:{Memory:process.env.MODE==='cap'?0:limit,MemorySwap:limit,CpuQuota:200000}}]:[{Id:'root',State:{Running:true,StartedAt:'original',OOMKilled:false,Health:{Status:'healthy'}},RestartCount:0}]));
else if(a[0]==='exec') console.log(a.at(-1)==='/proc/meminfo'?'MemAvailable: 7000000 kB':limit);
else if(a.includes('build')&&process.env.MODE==='failure') process.exit(7);
`,
    { mode: 0o755 },
  );
  const result = spawnSync(process.execPath, ['runtime-build.mjs'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, CALLS: calls, MODE: mode },
  });
  return { result, calls: (await readFile(calls, 'utf8')).trim().split('\n').map(JSON.parse) };
}

test('bounded builder is scoped, verified, removed before no-build startup', async (t) => {
  const { result, calls } = await run(t, 'success');
  assert.equal(result.status, 0, result.stderr);
  const create = calls.find((a) => a[1] === 'create');
  assert.ok(
    create.includes(
      'memory=3g,memory-swap=3g,cpu-period=100000,cpu-quota=200000,default-load=true',
    ),
  );
  assert.ok(!create.includes('--use'));
  assert.ok(calls.some((a) => a.includes('/sys/fs/cgroup/memory.max')));
  const build = calls.findIndex((a) => a[0] === 'compose' && a.includes('build'));
  const cleanup = calls.findIndex((a) => a[1] === 'rm');
  const up = calls.findIndex((a) => a[0] === 'compose' && a.includes('up'));
  assert.ok(build < cleanup && cleanup < up);
  assert.ok(calls[up].includes('--no-build'));
});

for (const mode of ['headroom', 'cap', 'failure']) {
  test(`fails closed on ${mode} without starting services`, async (t) => {
    const { result, calls } = await run(t, mode);
    assert.equal(result.status, 1);
    assert.ok(!calls.some((a) => a.includes('up')));
    if (mode === 'headroom') assert.ok(!calls.some((a) => a[1] === 'create'));
    else assert.ok(calls.some((a) => a[1] === 'rm'));
  });
}
