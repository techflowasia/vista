import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(new URL('./merge-package.mjs', import.meta.url));

function assertNoNull(value) {
  assert.notStrictEqual(value, null);
  if (typeof value === 'object') {
    for (const child of Object.values(value)) {
      assertNoNull(child);
    }
  }
}

async function merge(t, base, local) {
  const directory = await mkdtemp(join(tmpdir(), 'merge-package-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const basePath = join(directory, 'package.base.json');
  const localPath = join(directory, 'package.local.json');
  const outputPath = join(directory, 'package.json');

  await Promise.all([
    writeFile(basePath, JSON.stringify(base)),
    writeFile(localPath, JSON.stringify(local)),
  ]);
  execFileSync(process.execPath, [scriptPath, basePath, localPath, outputPath]);
  const result = JSON.parse(await readFile(outputPath, 'utf8'));
  assertNoNull(result);
  return result;
}

const sections = [
  'scripts',
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];

for (const section of sections) {
  test(`null deletes individual entries in ${section}`, async (t) => {
    const result = await merge(
      t,
      { [section]: { keep: 'original', remove: 'original' } },
      { [section]: { remove: null, missing: null } },
    );
    assert.deepStrictEqual(result, { [section]: { keep: 'original' } });
  });

  test(`null deletes the entire ${section} section`, async (t) => {
    const result = await merge(
      t,
      { name: 'my-app', [section]: { keep: 'original' } },
      { [section]: null },
    );
    assert.deepStrictEqual(result, { name: 'my-app' });
    assert.equal(Object.hasOwn(result, section), false);
  });
}

test('normal values override defaults while preserving inherited entries', async (t) => {
  const result = await merge(
    t,
    {
      private: true,
      scripts: { dev: 'vite', build: 'vite build' },
      dependencies: { react: '^19.0.0', 'react-dom': '^19.0.0' },
    },
    {
      name: 'my-app',
      scripts: { dev: 'vite --port 3001', test: 'node --test' },
      dependencies: { react: '^19.1.0' },
    },
  );
  assert.deepStrictEqual(result, {
    private: true,
    name: 'my-app',
    scripts: { dev: 'vite --port 3001', build: 'vite build', test: 'node --test' },
    dependencies: { react: '^19.1.0', 'react-dom': '^19.0.0' },
  });
});

test('removes null at every depth, including array elements, without removing falsy values', async (t) => {
  const result = await merge(
    t,
    {
      description: null,
      config: { removed: null, nested: { removed: null, enabled: false } },
      keywords: [null, 'base'],
    },
    {
      keywords: [null, 'local', { removed: null, nested: [null, { keep: 0, remove: null }] }],
      custom: { empty: '', list: [[null, false], null] },
    },
  );
  assert.deepStrictEqual(result, {
    config: { nested: { enabled: false } },
    keywords: ['local', { nested: [{ keep: 0 }] }],
    custom: { empty: '', list: [[false]] },
  });
});

test('deleting every entry leaves an empty section without null', async (t) => {
  const result = await merge(
    t,
    { scripts: { build: 'vite build' }, dependencies: { react: '^19.0.0' } },
    { scripts: { build: null }, dependencies: { react: null } },
  );
  assert.deepStrictEqual(result, { scripts: {}, dependencies: {} });
});
