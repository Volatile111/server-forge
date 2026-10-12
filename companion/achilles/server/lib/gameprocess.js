import { execFile } from 'node:child_process';

const IMAGE = 'Star Valor.exe';

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true }, (err, stdout) => resolve(err ? '' : stdout));
  });
}

/** PIDs of running Star Valor processes. */
export async function gamePids() {
  const out = await run('tasklist', ['/FI', `IMAGENAME eq ${IMAGE}`, '/FO', 'CSV', '/NH']);
  return out
    .split(/\r?\n/)
    .map((l) => l.match(/^"([^"]+)","(\d+)"/))
    .filter((m) => m && m[1].toLowerCase() === IMAGE.toLowerCase())
    .map((m) => Number(m[2]));
}

export async function isGameRunning() {
  return (await gamePids()).length > 0;
}

/** Closes Star Valor: a normal close request first (like clicking X), then forced if it's still
 * there after `graceMs` (a game stuck on its splash screen usually ignores the polite one). */
export async function closeGame(graceMs = 6000) {
  const pids = await gamePids();
  if (pids.length === 0) return true;
  for (const pid of pids) await run('taskkill', ['/PID', String(pid)]);
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    if (!(await isGameRunning())) return true;
  }
  for (const pid of await gamePids()) await run('taskkill', ['/PID', String(pid), '/F']);
  await new Promise((r) => setTimeout(r, 1500));
  return !(await isGameRunning());
}
