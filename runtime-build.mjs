import { spawn } from 'node:child_process';

const compose = ['compose', '-p', 'vista-runtime', '-f', 'vista.yml', '-f', 'vista.runtime.yml'];

function docker(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', [...compose, ...args], { stdio: 'inherit' });
    const interrupt = () => child.kill('SIGINT');
    const terminate = () => child.kill('SIGTERM');
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
          Object.assign(new Error(`Docker compose failed (${signal || code})`), {
            exitCode: code || 1,
          }),
        );
    });
  });
}

try {
  await docker(['build', 'vista']);
  await docker(['up', '-d', '--no-build']);
} catch (error) {
  console.error(error.message);
  process.exitCode = error.exitCode || 1;
}
