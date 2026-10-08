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

test('Docker build selects Webpack while retaining bounded heap and package preparation', async () => {
  const dockerfile = await readFile('Dockerfile', 'utf8');
  assert.match(dockerfile, /ARG VISTA_BUILD_HEAP_MB="1536"/);
  assert.match(
    dockerfile,
    /RUN VISTA_BUILD_LOW_MEMORY=\$VISTA_BUILD_LOW_MEMORY NODE_OPTIONS=--max-old-space-size=\$VISTA_BUILD_HEAP_MB pnpm build --webpack/,
  );
  assert.match(dockerfile, /NODE_OPTIONS=--max-old-space-size=1024 pnpm run build:packages/);
});

test('Corepack prepares the declared manager and preserves its cache in the builder', async () => {
  const dockerfile = await readFile('Dockerfile', 'utf8');
  const manifest = JSON.parse(await readFile('package.json', 'utf8'));
  assert.ok(dockerfile.includes(`corepack prepare ${manifest.packageManager} --activate`));
  assert.match(
    dockerfile,
    /COPY --from=deps \/root\/\.cache\/node\/corepack \/root\/\.cache\/node\/corepack/,
  );
});

test('low-memory config removes compiler child workers without weakening validation', () => {
  const load = (enabled) => {
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        "import imported from './next.config.ts'; const config=imported.default ?? imported; const input={cache:{type:'filesystem'},parallelism:100,optimization:{minimize:true},plugins:['preserved']}; console.log(JSON.stringify({config,production:config.webpack?.(structuredClone(input),{dev:false}),development:config.webpack?.(structuredClone(input),{dev:true})}));",
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, VISTA_BUILD_LOW_MEMORY: enabled },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const loaded = load('1');
  assert.equal(loaded.production.cache, false);
  assert.equal(loaded.production.parallelism, 1);
  assert.equal(loaded.production.optimization.minimize, true);
  assert.deepEqual(loaded.production.plugins, ['preserved']);
  assert.deepEqual(loaded.development.cache, { type: 'filesystem' });
  assert.equal(loaded.development.parallelism, 100);
  const low = loaded.config;
  assert.equal(low.experimental.webpackBuildWorker, false);
  assert.equal(low.experimental.webpackMemoryOptimizations, true);
  assert.equal(low.experimental.parallelServerCompiles, false);
  assert.equal(low.experimental.parallelServerBuildTraces, false);
  assert.equal(low.experimental.cpus, 1);
  assert.equal(low.experimental.staticGenerationMaxConcurrency, 1);
  assert.notEqual(low.typescript.ignoreBuildErrors, true);
  const normalLoaded = load('0');
  assert.equal(normalLoaded.production, undefined);
  const normal = normalLoaded.config;
  assert.equal(normal.experimental.webpackBuildWorker, undefined);
  assert.equal(normal.experimental.webpackMemoryOptimizations, undefined);
});

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
