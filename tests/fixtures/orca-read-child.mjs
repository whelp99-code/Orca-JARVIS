/* global process, Buffer, setInterval */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [mode, root] = process.argv.slice(2);
writeFileSync(join(root, 'parent.pid'), String(process.pid));
if (['descendant', 'escaped', 'quiet-success', 'quiet-error'].includes(mode)) {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    detached: mode === 'escaped', stdio: mode.startsWith('quiet-') ? 'ignore' : ['ignore', 'inherit', 'inherit'],
  });
  writeFileSync(join(root, 'descendant.pid'), String(child.pid));
  if (mode.startsWith('quiet-')) {
    process.stdout.write(JSON.stringify(mode === 'quiet-success' ? { ok: true, result: {} }
      : { ok: false, error: { code: 'runtime_timeout', message: 'fixture' } }));
  }
  process.exit(mode === 'quiet-error' ? 1 : 0);
} else if (mode === 'timeout') {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
} else if (mode === 'output') {
  process.stdout.write(Buffer.alloc(1_000_001, 120));
} else if (mode === 'stderr') {
  process.stderr.write(Buffer.alloc(1_000_001, 120));
} else if (mode === 'utf8') {
  process.stdout.write(Buffer.from([255]));
}
