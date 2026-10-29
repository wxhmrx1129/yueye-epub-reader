import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// Electron's CommonJS entry returns before app readiness, avoiding the ESM
// loader's top-level-await readiness deadlock. Use an isolated temporary profile.
const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(process.argv[2] || join(root, 'build'));
const profile = mkdtempSync(join(tmpdir(), 'yueye-icon-'));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
try {
  const result = spawnSync(require('electron'), [join(root, 'scripts/render-desktop-icon.cjs'), output, profile], {
    cwd: root, env, stdio: 'inherit', windowsHide: true, timeout: 45_000,
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  if (dirname(resolve(profile)) !== resolve(tmpdir()) || !profile.split(/[\\/]/).at(-1).startsWith('yueye-icon-')) {
    throw new Error(`Refusing to remove an unexpected icon profile: ${profile}`);
  }
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
