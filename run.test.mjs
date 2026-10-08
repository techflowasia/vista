import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

async function fixture(t, manager = 'npm') {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'vista-run-test-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bin = join(directory, 'bin');
  await mkdir(bin);
  await cp(join(root, 'run.mjs'), join(directory, 'run.mjs'));
  await cp(join(root, 'merge-package.mjs'), join(directory, 'merge-package.mjs'));
  const base = {
    name: 'fixture',
    private: true,
    packageManager: `${manager}@1.0.0`,
    scripts: { dev: 'base', build: 'build', 'build:packages': 'build-packages' },
    dependencies: { keep: '1', remove: '1' },
  };
  const json = (name, value) => put(name, JSON.stringify(value));
  const put = async (name, value) => {
    await mkdir(dirname(join(directory, name)), { recursive: true });
    await writeFile(join(directory, name), value);
  };
  await json('package.json', base);
  await json('vista.package.json', { scripts: { dev: 'local' }, dependencies: { remove: null } });
  await put('source.txt', 'first');
  await put('node_modules/root-marker', 'untouched');
  await put('.env.local', 'TEST_SECRET=fixture');
  const fake = `#!${process.execPath}
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const cwd = process.cwd();
appendFileSync(process.env.CALLS, JSON.stringify({ args, cwd, manifest: JSON.parse(readFileSync('package.json')) }) + '\\n');
if (args[0] === 'install') {
  mkdirSync('node_modules', { recursive: true });
  writeFileSync('node_modules/runtime-marker', 'installed');
  mkdirSync('packages/local/dist', { recursive: true });
  writeFileSync('packages/local/dist/output.js', 'built');
  if (process.env.FAIL_INSTALL) process.exit(7);
}
if (args[0] === 'run' && process.env.FAIL_RUN) process.exit(9);
`;
  for (const command of ['npm', 'pnpm', 'yarn']) {
    await writeFile(join(bin, command), fake, { mode: 0o755 });
  }
  const callsPath = join(directory, 'calls.jsonl');
  const launch = (args = ['dev'], env = {}) =>
    spawnSync(process.execPath, [join(directory, 'run.mjs'), ...args], {
      cwd: tmpdir(),
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CALLS: callsPath, ...env },
    });
  const calls = async () =>
    (await readFile(callsPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
  const read = (name) => readFile(join(directory, name), 'utf8');
  return { directory, base, json, put, launch, calls, read };
}

function success(result) {
  assert.equal(result.status, 0, result.stderr);
}

test('merges every launch, forwards arguments, skips unchanged installs and leaves root untouched', async (t) => {
  const f = await fixture(t);
  const original = await f.read('package.json');
  success(f.launch(['dev', '--port', '3100', 'argument with spaces']));
  success(f.launch());
  const calls = await f.calls();
  assert.deepEqual(
    calls.map((call) => call.args),
    [['install'], ['run', 'dev', '--', '--port', '3100', 'argument with spaces'], ['run', 'dev']],
  );
  assert.equal(calls[0].cwd, join(f.directory, '.runtime'));
  assert.equal(calls[0].manifest.scripts.dev, 'local');
  assert.deepEqual(calls[0].manifest.dependencies, { keep: '1' });
  await f.json('vista.package.json', { scripts: { dev: 'changed' } });
  success(f.launch());
  const updated = await f.calls();
  assert.equal(updated.filter((call) => call.args[0] === 'install').length, 2);
  await f.json('vista.package.json', { scripts: { dev: 'changed again' } });
  success(f.launch());
  assert.equal((await f.calls()).filter((call) => call.args[0] === 'install').length, 2);
  assert.equal(JSON.parse(await f.read('.runtime/package.json')).scripts.dev, 'changed again');
  assert.equal(await f.read('package.json'), original);
  assert.equal(await f.read('node_modules/root-marker'), 'untouched');
  await assert.rejects(f.read('node_modules/runtime-marker'), { code: 'ENOENT' });
});

test('syncs source changes and deletions while preserving runtime modules, generated output and config', async (t) => {
  const f = await fixture(t);
  await f.put('obsolete/file.txt', 'remove');
  await f.put('vista-data/large', 'excluded');
  await f.put('vista-postgres/large', 'excluded');
  await f.put('.git/internal', 'excluded');
  await f.put('packages/local/node_modules/root', 'excluded');
  await f.put('packages/local/dist/root.js', 'excluded');
  await f.put('.next/root', 'excluded');
  success(f.launch());
  await f.put('.runtime/.next/cache', 'preserved');
  await rm(join(f.directory, 'obsolete'), { recursive: true });
  await f.put('source.txt', 'second');
  success(f.launch());
  assert.equal(await f.read('.runtime/source.txt'), 'second');
  assert.equal(await f.read('.runtime/.env.local'), 'TEST_SECRET=fixture');
  assert.equal(await f.read('.runtime/.next/cache'), 'preserved');
  assert.equal(await f.read('.runtime/node_modules/runtime-marker'), 'installed');
  assert.equal(await f.read('.runtime/packages/local/dist/output.js'), 'built');
  for (const path of [
    'obsolete/file.txt',
    'vista-data/large',
    'vista-postgres/large',
    '.git/internal',
    'packages/local/node_modules/root',
    'packages/local/dist/root.js',
    '.next/root',
  ]) {
    await assert.rejects(f.read(`.runtime/${path}`), { code: 'ENOENT' });
  }
  assert.equal((await f.calls()).filter((call) => call.args[0] === 'install').length, 1);
});

test('dependency, lifecycle, lockfile, workspace, config and manager changes invalidate install', async (t) => {
  const f = await fixture(t, 'pnpm');
  await f.json('packages/local/package.json', { name: 'local', dependencies: {} });
  await f.put('pnpm-workspace.yaml', 'packages:\n  - packages/*\n');
  await f.put('pnpm-lock.yaml', 'lockfileVersion: 9\n');
  success(f.launch(['dev', '--port', '3000']));
  assert.deepEqual((await f.calls())[0].args, ['install', '--no-frozen-lockfile']);
  assert.deepEqual((await f.calls())[1].args, ['run', 'dev', '--port', '3000']);
  const changes = [
    () => f.json('vista.package.json', { dependencies: { keep: '2' } }),
    () => f.json('vista.package.json', { scripts: { postinstall: 'changed' } }),
    () => f.put('pnpm-lock.yaml', 'lockfileVersion: 9\nchanged: true\n'),
    () => f.put('pnpm-workspace.yaml', 'packages:\n  - packages/**\n'),
    () => f.json('packages/local/package.json', { name: 'local', dependencies: { added: '1' } }),
    () => f.put('.npmrc', 'registry=https://fixture.invalid\n'),
    () => f.json('vista.package.json', { packageManager: 'pnpm@2.0.0' }),
  ];
  for (const change of changes) {
    await change();
    success(f.launch());
    success(f.launch());
  }
  assert.equal((await f.calls()).filter((call) => call.args[0] === 'install').length, 8);
  await rm(join(f.directory, '.runtime/node_modules'), { recursive: true });
  success(f.launch());
  assert.equal((await f.calls()).filter((call) => call.args[0] === 'install').length, 9);
});

test('workspace source changes rebuild packages without reinstalling', async (t) => {
  const f = await fixture(t);
  await f.put('packages/local/src/index.ts', 'export const value = 1;');
  success(f.launch());
  await f.put('packages/local/src/index.ts', 'export const value = 2;');
  success(f.launch());
  success(f.launch());
  assert.deepEqual(
    (await f.calls()).map((call) => call.args),
    [['install'], ['run', 'dev'], ['run', 'build:packages'], ['run', 'dev'], ['run', 'dev']],
  );
});

test('failed installs are not stamped and are retried before scripts run', async (t) => {
  const f = await fixture(t);
  assert.equal(f.launch(['dev'], { FAIL_INSTALL: '1' }).status, 7);
  assert.equal(JSON.parse(await f.read('.runtime/.vista-runtime.json')).install, undefined);
  success(f.launch());
  await f.json('vista.package.json', { dependencies: { keep: '2' } });
  assert.equal(f.launch(['dev'], { FAIL_INSTALL: '1' }).status, 7);
  success(f.launch());
  assert.deepEqual(
    (await f.calls()).map((call) => call.args[0]),
    ['install', 'install', 'run', 'install', 'install', 'run'],
  );
  assert.equal(f.launch(['dev'], { FAIL_RUN: '1' }).status, 9);
  success(f.launch());
  assert.equal((await f.calls()).filter((call) => call.args[0] === 'install').length, 4);
});

test('invalid merge, unknown scripts and missing arguments fail without invoking manager', async (t) => {
  const f = await fixture(t);
  assert.match(f.launch([]).stderr, /Usage:/);
  assert.match(f.launch(['unknown']).stderr, /Unknown package script/);
  await f.put('vista.package.json', '{invalid');
  assert.equal(f.launch().status, 1);
  await assert.rejects(f.calls(), { code: 'ENOENT' });
});

test('vista scripts generate isolated runtime configuration on every launch', async (t) => {
  const f = await fixture(t);
  const local = JSON.parse(await readFile(join(root, 'vista.package.json'), 'utf8'));
  await f.json('vista.package.json', local);
  await f.put('.env.local', 'DATABASE_URL=postgresql://external-secret@external/root');
  await f.put('.dockerignore', '.env*\n');
  await f.put('vista.yml', 'original compose');
  await f.put('vista-data/marker', 'root data');
  await f.put('vista-postgres/marker', 'root postgres');
  success(f.launch(['vista:up']));
  const override = await f.read('.runtime/vista.runtime.yml');
  assert.match(override, /container_name: vista-runtime-app/);
  assert.match(override, /container_name: vista-runtime-db/);
  assert.match(override, /container_name: vista-runtime-render/);
  assert.match(override, /ports: !override\n      - '127.0.0.1:3001:3000'/);
  assert.match(
    override,
    /DATABASE_URL: postgresql:\/\/openmaic:openmaic-runtime@postgres:5432\/openmaic/,
  );
  assert.match(override, /POSTGRES_PASSWORD: openmaic-runtime/);
  assert.doesNotMatch(override, /external-secret/);
  assert.match(await f.read('.runtime/.dockerignore'), /vista-data\nvista-postgres/);
  await f.put('.runtime/vista.runtime.yml', 'stale');
  success(f.launch(['vista:down']));
  assert.equal(await f.read('.runtime/vista.runtime.yml'), override);
  assert.equal(local.scripts['vista:up'], 'node runtime-build.mjs');
  assert.match(override, /VISTA_BUILD_LOW_MEMORY: '1'/);
  assert.match(override, /VISTA_BUILD_HEAP_MB: '2048'/);
  for (const command of Object.values(local.scripts).filter((value) =>
    value.startsWith('docker'),
  )) {
    assert.match(command, /-p vista-runtime -f vista.yml -f vista.runtime.yml/);
    assert.doesNotMatch(command, /vista-dev/);
  }
  assert.equal(await f.read('vista.yml'), 'original compose');
  assert.equal(await f.read('vista-data/marker'), 'root data');
  assert.equal(await f.read('vista-postgres/marker'), 'root postgres');
  assert.equal(
    await f.read('.env.local'),
    'DATABASE_URL=postgresql://external-secret@external/root',
  );
  await assert.rejects(f.read('.runtime/vista-data/marker'), { code: 'ENOENT' });
  await assert.rejects(f.read('.runtime/vista-postgres/marker'), { code: 'ENOENT' });
});

test('rejects runtime data symlinks before running vista scripts', async (t) => {
  const f = await fixture(t);
  await f.json('vista.package.json', { scripts: { 'vista:up': 'isolated' } });
  await mkdir(join(f.directory, '.runtime'));
  await mkdir(join(f.directory, 'vista-data'));
  await symlink(join(f.directory, 'vista-data'), join(f.directory, '.runtime/vista-data'));
  assert.match(f.launch(['vista:up']).stderr, /must be a real directory/);
  await assert.rejects(f.calls(), { code: 'ENOENT' });
});

test('rejects runtime symlinks rather than writing outside the runtime', async (t) => {
  const f = await fixture(t);
  const outside = join(f.directory, 'outside');
  await mkdir(outside);
  await symlink(outside, join(f.directory, '.runtime'));
  assert.match(f.launch().stderr, /real directory/);
  await assert.rejects(f.read('outside/package.json'), { code: 'ENOENT' });
});
