import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, readFile, readdir, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const runtime = join(root, '.runtime');
const statePath = join(runtime, '.vista-runtime.json');
const excluded = new Set([
  '.git',
  '.runtime',
  'node_modules',
  '.next',
  '.turbo',
  '.cache',
  '.pnpm-store',
  'dist',
  'build',
  'out',
  'coverage',
  'test-results',
  'playwright-report',
  'blob-report',
  '.codegraph',
  '.worktrees',
  'vista-data',
  'vista-postgres',
  'data',
  'logs',
]);
const generated = new Set(['public/vendor/maic-importer', 'public/vendor/standalone-player']);
const installFiles = new Set([
  'package.json',
  'pnpm-workspace.yaml',
  'pnpm-lock.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  '.npmrc',
  '.yarnrc.yml',
  '.pnpmfile.cjs',
]);

async function optionalJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

function execute(command, args, cwd = runtime) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' });
    const forward = (signal) => child.kill(signal);
    const interrupt = () => forward('SIGINT');
    const terminate = () => forward('SIGTERM');
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
    const cleanup = () => {
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', terminate);
    };
    child.once('error', (error) => {
      cleanup();
      reject(error);
    });
    child.once('exit', (code, signal) => {
      cleanup();
      if (code === 0) resolve();
      else
        reject(
          Object.assign(new Error(`${command} failed (${signal || code})`), {
            exitCode: code || 1,
          }),
        );
    });
  });
}

async function inventory(directory = root) {
  const entries = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const path = join(directory, entry.name);
    const name = relative(root, path).split('\\').join('/');
    if (
      excluded.has(entry.name) ||
      generated.has(name) ||
      entry.name.endsWith('.tsbuildinfo') ||
      entry.name === '.vista-runtime.json'
    )
      continue;
    if (entry.isSymbolicLink()) throw new Error(`Source symlinks are not supported: ${name}`);
    if (entry.isDirectory()) entries.push(...(await inventory(path)));
    else if (entry.isFile()) entries.push(name);
  }
  return entries;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

async function fingerprint(files, manifest, packageSources = false) {
  const hash = createHash('sha256');
  if (packageSources) hash.update(manifest.scripts?.['build:packages'] || '');
  if (!packageSources) {
    const { scripts = {}, ...installManifest } = manifest;
    hash.update(
      JSON.stringify(
        canonical({
          ...installManifest,
          scripts: Object.fromEntries(
            ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish']
              .filter((key) => key in scripts)
              .map((key) => [key, scripts[key]]),
          ),
          node: process.version,
          platform: process.platform,
          arch: process.arch,
          environment: {
            NODE_ENV: process.env.NODE_ENV,
            npm_config_production: process.env.npm_config_production,
          },
        }),
      ),
    );
  }
  for (const name of files) {
    if (name === 'package.json') continue;
    if (
      packageSources
        ? name.startsWith('packages/')
        : installFiles.has(name.split('/').at(-1)) || name.startsWith('patches/')
    ) {
      hash.update(name);
      hash.update(await readFile(join(root, name)));
    }
  }
  return hash.digest('hex');
}

try {
  const [script, ...args] = process.argv.slice(2);
  if (!script) throw new Error('Usage: node run.mjs <script> [args...]');
  try {
    const info = await lstat(runtime);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error('.runtime must be a real directory');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  await execute(
    process.execPath,
    [
      join(root, 'merge-package.mjs'),
      join(root, 'package.json'),
      join(root, 'vista.package.json'),
      join(runtime, 'package.json'),
    ],
    root,
  );
  const manifest = await optionalJson(join(runtime, 'package.json'));
  if (typeof manifest.scripts?.[script] !== 'string')
    throw new Error(`Unknown package script: ${script}`);
  const manager = manifest.packageManager?.split('@')[0] || 'npm';
  if (!['pnpm', 'npm', 'yarn'].includes(manager))
    throw new Error(`Unsupported package manager: ${manager}`);
  const previous = await optionalJson(statePath);
  const files = await inventory();
  const current = new Set(files);
  for (const name of previous.files || []) {
    if (!current.has(name)) {
      const target = join(runtime, name);
      await rm(target, { force: true });
      let directory = dirname(target);
      while (directory !== runtime) {
        try {
          await rmdir(directory);
        } catch (error) {
          if (['ENOTEMPTY', 'ENOENT'].includes(error.code)) break;
          throw error;
        }
        directory = dirname(directory);
      }
    }
  }
  for (const name of files) {
    if (name === 'package.json') continue;
    const target = join(runtime, name);
    await mkdir(dirname(target), { recursive: true });
    await cp(join(root, name), target);
  }
  if (script.startsWith('vista:')) {
    for (const name of ['vista-data', 'vista-postgres']) {
      const path = join(runtime, name);
      try {
        const info = await lstat(path);
        if (!info.isDirectory() || info.isSymbolicLink())
          throw new Error(`Runtime ${name} must be a real directory`);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      await mkdir(path, { recursive: true });
    }
    await writeFile(
      join(runtime, 'vista.runtime.yml'),
      `services:
  vista:
    container_name: vista-runtime-app
    ports: !override
      - '127.0.0.1:3001:3000'
    environment:
      DATABASE_URL: postgresql://openmaic:openmaic-runtime@postgres:5432/openmaic
      OPENMAIC_PUBLISH_ADDRESS: 127.0.0.1
  postgres:
    container_name: vista-runtime-db
    environment:
      POSTGRES_DB: openmaic
      POSTGRES_USER: openmaic
      POSTGRES_PASSWORD: openmaic-runtime
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U openmaic -d openmaic']
  render-service:
    container_name: vista-runtime-render
`,
    );
    const dockerignore = join(runtime, '.dockerignore');
    let ignored = '';
    try {
      ignored = await readFile(dockerignore, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await writeFile(dockerignore, `${ignored}\nvista-data\nvista-postgres\n.runtime\n`);
  }
  const install = await fingerprint(files, manifest);
  const packages = await fingerprint(files, manifest, true);
  let hasModules = false;
  try {
    const info = await lstat(join(runtime, 'node_modules'));
    hasModules = info.isDirectory() && !info.isSymbolicLink();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const needsInstall = previous.install !== install || !hasModules;
  await writeFile(statePath, JSON.stringify(needsInstall ? { files } : { ...previous, files }));
  if (needsInstall) {
    await execute(manager, manager === 'pnpm' ? ['install', '--no-frozen-lockfile'] : ['install']);
  } else if (previous.packages !== packages && manifest.scripts?.['build:packages']) {
    await execute(manager, ['run', 'build:packages']);
  }
  await writeFile(statePath, JSON.stringify({ files, install, packages }));
  await execute(manager, [
    'run',
    script,
    ...(manager === 'npm' && args.length ? ['--'] : []),
    ...args,
  ]);
} catch (error) {
  console.error(error.message);
  process.exitCode = error.exitCode || 1;
}
