import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const builder = `vista-runtime-${randomUUID()}`;
const container = `buildx_buildkit_${builder}0`;
const compose = ['compose', '-p', 'vista-runtime', '-f', 'vista.yml', '-f', 'vista.runtime.yml'];
const limit = 3 * 1024 ** 3;
const docker = (args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 120000 });
const inspect = (names) => JSON.parse(docker(['inspect', ...names]));
const originals = () =>
  inspect(['vista-app', 'vista-db']).map((c) => ({
    id: c.Id,
    running: c.State.Running,
    started: c.State.StartedAt,
    oom: c.State.OOMKilled,
    restarts: c.RestartCount,
    health: c.State.Health?.Status,
  }));
let created = false;
let monitor;
let interrupted = false;
const stop = () => {
  interrupted = true;
  if (created) docker(['buildx', 'stop', builder]);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
try {
  const info = JSON.parse(docker(['info', '--format', '{{json .}}']));
  if (info.MemTotal < limit + 4 * 1024 ** 3)
    throw new Error('Build requires 3 GiB plus 4 GiB reserved VM capacity');
  const baseline = JSON.stringify(originals());
  const available =
    Number(
      docker(['exec', 'vista-db', 'cat', '/proc/meminfo']).match(/MemAvailable:\s+(\d+)/)?.[1],
    ) * 1024;
  if (!(available >= limit + 2 * 1024 ** 3))
    throw new Error('Insufficient available memory for bounded build and 2 GiB headroom');
  docker([
    'buildx',
    'create',
    '--name',
    builder,
    '--driver',
    'docker-container',
    '--driver-opt',
    'memory=3g,memory-swap=3g,cpu-period=100000,cpu-quota=200000,default-load=true',
  ]);
  created = true;
  docker(['buildx', 'inspect', '--bootstrap', builder]);
  const c = inspect([container])[0];
  if (
    c.HostConfig.Memory !== limit ||
    c.HostConfig.MemorySwap !== limit ||
    c.HostConfig.CpuQuota !== 200000
  )
    throw new Error('Builder hard resource limits were not applied');
  const caps = docker(['exec', container, 'cat', '/sys/fs/cgroup/memory.max']);
  if (Number(caps.trim()) !== limit) throw new Error('Builder cgroup memory limit not enforced');
  console.log('Build isolated: memory=3 GiB, swap=0, CPUs=2; original containers monitored');
  await new Promise((resolve, reject) => {
    const child = spawn('docker', [...compose, 'build', '--builder', builder, 'vista'], {
      stdio: 'inherit',
    });
    let failure;
    monitor = setInterval(() => {
      try {
        if (JSON.stringify(originals()) !== baseline)
          throw new Error('Original container state changed; stopping isolated builder');
        const current = docker(['exec', container, 'cat', '/sys/fs/cgroup/memory.current']);
        console.log(`Builder memory: ${Math.round(Number(current) / 1024 ** 2)} MiB / 3072 MiB`);
      } catch (error) {
        failure = error;
        clearInterval(monitor);
        stop();
      }
    }, 15000);
    child.once('error', reject);
    child.once('exit', (code) => {
      clearInterval(monitor);
      if (failure) reject(failure);
      else if (code !== 0 || interrupted)
        reject(new Error(`Bounded Docker build failed (${code})`));
      else resolve();
    });
  });
  if (JSON.stringify(originals()) !== baseline) throw new Error('Original container state changed');
  docker(['buildx', 'rm', builder]);
  created = false;
  if (interrupted) throw new Error('Build interrupted');
  process.stdout.write(docker([...compose, 'up', '-d', '--no-build']));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  clearInterval(monitor);
  if (created) {
    try {
      docker(['buildx', 'rm', builder]);
    } catch {
      console.error(`Unable to remove own builder ${builder}; manual cleanup required`);
    }
  }
}
