// Installs the Microsoft Visual C++ 2015-2022 Redistributable (x64), which Bedrock Dedicated Server needs
// (msvcp140.dll, vcruntime140.dll, vcruntime140_1.dll) and which Windows doesn't include. Microsoft's own installer,
// run quietly; it needs admin rights, so Windows asks (UAC) on the system the server runs on.
import { mkdirSync, rmSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { downloadFile } from './download.ts';
import { VC_REDIST_URL, missingVcDlls } from './games/bedrock-diagnose.ts';

const execFileAsync = promisify(execFile);
let busy: Promise<string> | null = null;

/** Downloads and runs the installer; resolves to a message for the owner. Only one runs at a time. */
export function installVcRedist(checkDir: string): Promise<string> {
  busy ??= run(checkDir).finally(() => (busy = null));
  return busy;
}

async function run(checkDir: string): Promise<string> {
  const dir = path.join(os.tmpdir(), `tavernhost-vcredist-${randomBytes(4).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  try {
    const exe = path.join(dir, 'vc_redist.x64.exe');
    await downloadFile(VC_REDIST_URL, exe);
    let code: number;
    try {
      // -Verb RunAs: Windows asks for admin rights. The path goes through an environment variable, never the command text.
      const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', "$p = Start-Process -FilePath $env:TH_EXE -ArgumentList '/install','/quiet','/norestart' -Verb RunAs -Wait -PassThru; $p.ExitCode"],
        { env: { ...process.env, TH_EXE: exe }, windowsHide: true, timeout: 10 * 60_000 },
      );
      code = Number(stdout.trim().split(/\s+/).pop());
    } catch (err) {
      if (/canceled by the user|cancelled by the user/i.test(String((err as { stderr?: string }).stderr ?? (err as Error).message))) {
        throw new Error('Windows asked for admin rights and it was declined, so nothing was installed. Try again and choose Yes.');
      }
      throw new Error(`The installer couldn't run: ${(err as Error).message.split('\n')[0]}`);
    }
    // 0 = installed, 3010 = installed (restart recommended), 1638 = this or a newer version is already installed.
    if (code === 1638) {
      const still = missingVcDlls(checkDir);
      return still.length ? `A newer Visual C++ runtime is already installed, but ${still.join(', ')} still can't be found. Use "Repair" in Windows Settings → Apps for "Microsoft Visual C++ 2015-2022 Redistributable (x64)".` : 'The Visual C++ runtime was already installed. Start the server again.';
    }
    if (code !== 0 && code !== 3010) throw new Error(`The Visual C++ installer failed (exit code ${code}).`);
    const still = missingVcDlls(checkDir);
    if (still.length) throw new Error(`The installer finished, but ${still.join(', ')} still can't be found. Restart the PC and try again.`);
    return `The Visual C++ runtime is installed${code === 3010 ? ' (Windows recommends a restart, but the server can start now)' : ''}. Start the server again.`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
