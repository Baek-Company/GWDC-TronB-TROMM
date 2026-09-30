import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

if (process.versions.node.split('.')[0] !== '24') {
  console.error('Node 24가 필요합니다. ./scripts/run run dev 로 실행하세요.');
  process.exit(1);
}
if (existsSync('.env.local')) process.loadEnvFile('.env.local');
const env = { ...process.env, API_PORT: process.env.API_PORT || '8787', UI_PORT: process.env.UI_PORT || '5173' };
let stopping = false;
let restarting = false;
let restartQueued = false;
let restartTimer;
const watchedDirectories = ['server', 'server/agent', 'server/data', 'server/llm', 'server/mcp', 'shared'];

function sourceSnapshot() {
  const files = new Map();
  for (const directory of watchedDirectories) {
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      if (!entry.isFile() || !/\.(?:ts|tsx|js|mjs)$/.test(entry.name)) continue;
      const file = join(directory, entry.name);
      try {
        const stat = statSync(file, { bigint: true });
        files.set(file, `${stat.mtimeNs}:${stat.size}`);
      } catch { /* An editor can replace a file between listing and stat. */ }
    }
  }
  return files;
}

let lastSnapshot = sourceSnapshot();
const poller = setInterval(() => {
  const current = sourceSnapshot();
  const changed = current.size !== lastSnapshot.size
    || [...current].some(([file, fingerprint]) => lastSnapshot.get(file) !== fingerprint);
  lastSnapshot = current;
  if (changed) scheduleRestart();
}, 800);

function startApi() {
  const child = spawn(process.execPath, ['--env-file-if-exists=.env.local', '--import', 'tsx', 'server/index.ts'], { stdio: 'inherit', env });
  child.on('error', error => { console.error(error.message); stop(1); });
  child.on('exit', code => {
    if (stopping) return;
    if (!restarting) { stop(code ?? 1); return; }
    restarting = false;
    api = startApi();
    if (restartQueued) {
      restartQueued = false;
      scheduleRestart();
    }
  });
  return child;
}

let api = startApi();
const ui = spawn(process.execPath, ['--env-file-if-exists=.env.local', 'node_modules/vite/bin/vite.js'], { stdio: 'inherit', env });
ui.on('error', error => { console.error(error.message); stop(1); });
ui.on('exit', code => { if (!stopping) stop(code ?? 1); });

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  clearTimeout(restartTimer);
  clearInterval(poller);
  api.kill('SIGTERM');
  ui.kill('SIGTERM');
  process.exitCode = code;
}

function scheduleRestart() {
  if (stopping) return;
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    if (restarting) { restartQueued = true; return; }
    restarting = true;
    console.log('서버 코드 변경을 감지해 API를 다시 시작합니다.');
    api.kill('SIGTERM');
  }, 200);
}

process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
