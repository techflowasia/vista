import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

function removeNulls(value) {
  if (Array.isArray(value)) {
    return value.filter((item) => item !== null).map(removeNulls);
  }

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== null)
        .map(([key, item]) => [key, removeNulls(item)]),
    );
  }

  return value;
}

const [basePath, localPath, outputPath = 'package.json'] = process.argv.slice(2);

try {
  if (!basePath || !localPath) {
    throw new Error('Usage: node merge-package.mjs <base.json> <local.json> [output.json]');
  }

  const output = resolve(outputPath);
  if ([basePath, localPath].some((path) => resolve(path) === output)) {
    throw new Error('Output must not overwrite an input file');
  }

  const readJson = async (path) => {
    const data = JSON.parse(await readFile(path, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error(`${path} must contain a JSON object`);
    }
    return data;
  };

  const [base, local] = await Promise.all([readJson(basePath), readJson(localPath)]);
  const merged = { ...base, ...local };
  const sections = [
    'scripts',
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ];

  for (const section of sections) {
    if (!Object.hasOwn(base, section) && !Object.hasOwn(local, section)) continue;

    if (local[section] === null) {
      delete merged[section];
      continue;
    }

    for (const source of [base, local]) {
      if (!Object.hasOwn(source, section)) continue;
      const value = source[section];
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${section} must be a JSON object`);
      }
    }

    merged[section] = { ...base[section], ...local[section] };
  }

  await writeFile(output, `${JSON.stringify(removeNulls(merged), null, 2)}\n`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
