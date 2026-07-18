// test-spawn-strategies.mjs — test all spawn strategies for Windows
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';

// Correct: simulate bin/cli.js which is in bin/ dir
const scriptsDir = resolve(import.meta.dirname, '..', 'scripts');
const winPath = resolve(scriptsDir, 'install.sh');

function toPosixPath(p) {
  if (process.platform !== 'win32') return p;
  const abs = resolve(p);
  const m = abs.match(/^([a-zA-Z]):\\(.*)$/);
  if (m) return '/' + m[1].toLowerCase() + '/' + m[2].replace(/\\/g, '/');
  return abs.replace(/\\/g, '/');
}

const posixPath = toPosixPath(winPath);

console.log('scriptsDir:', scriptsDir);
console.log('winPath:', winPath);
console.log('posixPath:', posixPath);
console.log('');

const strategies = [
  { name: 'A: bash posixPath', cmd: 'bash', args: [posixPath, '--dry-run'] },
  { name: 'B: bash winPath', cmd: 'bash', args: [winPath, '--dry-run'] },
  { name: 'C: bash -c posixPath', cmd: 'bash', args: ['-c', `${posixPath} --dry-run`] },
  { name: 'D: bash -c winPath', cmd: 'bash', args: ['-c', `${winPath} --dry-run`] },
  { name: 'E: bash -c exec posixPath $@', cmd: 'bash', args: ['-c', `exec "$0" "$@"`, posixPath, '--dry-run'] },
  { name: 'F: bash -c exec winPath $@', cmd: 'bash', args: ['-c', `exec "$0" "$@"`, winPath, '--dry-run'] },
];

for (const s of strategies) {
  const r = spawnSync(s.cmd, s.args, {
    encoding: 'utf8',
    stdio: ['inherit', 'pipe', 'pipe'],
  });
  const ok = r.status === 0;
  const snippet = r.stdout ? r.stdout.trim().slice(0, 100).replace(/\n/g, ' ') : '(no stdout)';
  console.log(`${ok ? '✅' : '❌'} ${s.name.padEnd(35)} exit=${r.status} ${snippet}`);
  if (!ok && r.stderr) {
    console.log(`   stderr: ${r.stderr.trim().slice(0, 200).replace(/\n/g, ' ')}`);
  }
}
