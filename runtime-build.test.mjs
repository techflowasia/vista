import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

async function run(t, failBuild = false) {
  const dir = await mkdtemp(join(tmpdir(), 'vista-build-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const calls = join(dir, 'calls');
  await writeFile(
    join(dir, 'docker'),
    `#!${process.execPath}
const fs=require('node:fs');
const args=process.argv.slice(2);
fs.appendFileSync(process.env.CALLS,JSON.stringify(args)+'\\n');
if(args.includes('build')&&process.env.FAIL_BUILD==='1') process.exit(7);
`,
    { mode: 0o755 },
  );
  const result = spawnSync(process.execPath, ['runtime-build.mjs'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      CALLS: calls,
      FAIL_BUILD: failBuild ? '1' : '0',
    },
  });
  return { result, calls: (await readFile(calls, 'utf8')).trim().split('\n').map(JSON.parse) };
}

test('default Docker build has no bundler or memory overrides', async () => {
  const dockerfile = await readFile('Dockerfile', 'utf8');
  assert.match(dockerfile, /RUN pnpm run build:packages\n\nRUN pnpm build\n/);
  assert.doesNotMatch(dockerfile, /VISTA_BUILD_|NODE_OPTIONS|--webpack|bound-next-minifier/);
  const next = await readFile('next.config.ts', 'utf8');
  assert.doesNotMatch(
    next,
    /VISTA_BUILD_|webpackBuildWorker|webpackMemoryOptimizations|parallelism/,
  );
});

test('Corepack retains declared manager version and builder cache', async () => {
  const dockerfile = await readFile('Dockerfile', 'utf8');
  const manifest = JSON.parse(await readFile('package.json', 'utf8'));
  assert.ok(dockerfile.includes(`corepack prepare ${manifest.packageManager} --activate`));
  assert.match(
    dockerfile,
    /COPY --from=deps \/root\/\.cache\/node\/corepack \/root\/\.cache\/node\/corepack/,
  );
});

test('default builder targets isolated project and starts only after successful build', async (t) => {
  const { result, calls } = await run(t);
  assert.equal(result.status, 0, result.stderr);
  const compose = ['compose', '-p', 'vista-runtime', '-f', 'vista.yml', '-f', 'vista.runtime.yml'];
  assert.deepEqual(calls, [
    [...compose, 'build', 'vista'],
    [...compose, 'up', '-d', '--no-build'],
  ]);
});

test('failed build propagates exit code without starting services', async (t) => {
  const { result, calls } = await run(t, true);
  assert.equal(result.status, 7);
  assert.equal(calls.length, 1);
  assert.ok(!calls.some((args) => args.includes('up')));
});
