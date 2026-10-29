import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import electron from 'electron';

const server = await createServer({ server: { host: '127.0.0.1', port: 5173, strictPort: true } });
await server.listen();
server.printUrls();
const environment = { ...process.env, YUEYE_DEV_URL: 'http://127.0.0.1:5173' };
delete environment.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, ['.'], { stdio: 'inherit', env: environment, windowsHide: true });
let stopped = false;
async function stop(code = 0) {
  if (stopped) return;
  stopped = true;
  if (child.exitCode === null) child.kill();
  await server.close();
  process.exitCode = code;
}
child.once('error', error => { console.error(error); void stop(1); });
child.once('exit', code => void stop(code ?? 1));
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
