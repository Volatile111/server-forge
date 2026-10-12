import { execFile } from 'node:child_process';
import { existsSync, statSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonStore } from './store.js';
import { managedFolder } from './steam.js';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'inspect-plugins.ps1');
// Bump whenever inspect-plugins.ps1's output changes, so old cached results are re-scanned.
const SCANNER_VERSION = 3;

// Namespaces the C# compiler injects into every assembly - useless for telling mods apart in
// stack traces, and would falsely match every mod to every crash.
const COMPILER_NAMESPACES = /^(Microsoft\.CodeAnalysis|System(\..*)?|JetBrains\.Annotations)$/;

function fileKey(p) {
  const s = statSync(p);
  return `${s.size}:${Math.floor(s.mtimeMs)}`;
}

function runScript(installPath, dllPaths, script = SCRIPT, extraArgs = ['-GameManaged', managedFolder(installPath)]) {
  const dir = mkdtempSync(path.join(tmpdir(), 'achilles-inspect-'));
  const listFile = path.join(dir, 'list.json');
  writeFileSync(listFile, JSON.stringify(dllPaths), 'utf8');
  const args = [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', script,
    '-CecilPath', path.join(installPath, 'BepInEx', 'core', 'Mono.Cecil.dll'),
    ...extraArgs,
    '-ListFile', listFile,
  ];
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', args, { windowsHide: true, maxBuffer: 32 * 1024 * 1024, timeout: 120000 }, (err, stdout, stderr) => {
      rmSync(dir, { recursive: true, force: true });
      if (err) return reject(new Error(`Plugin scanner failed: ${(stderr || err.message).trim().slice(0, 400)}`));
      try {
        const parsed = JSON.parse(stdout.replace(/^﻿/, ''));
        resolve(Array.isArray(parsed) ? parsed : [parsed]);
      } catch {
        reject(new Error(`Plugin scanner returned unreadable output: ${stdout.slice(0, 200)}`));
      }
    });
  });
}

const LOADER_SCRIPT = path.join(path.dirname(SCRIPT), 'check-loader.ps1');

/** Checks plugins against a DIFFERENT BepInEx version's core folder (see check-loader.ps1).
 * Returns Map(path -> { ok, error, problems: [{ detail, where[] }] }). */
export async function checkAgainstLoader(installPath, candidateCore, candidateVersion, dllPaths) {
  const existing = dllPaths.filter((p) => existsSync(p));
  if (existing.length === 0) return new Map();
  const results = await runScript(installPath, existing, LOADER_SCRIPT, [
    '-CandidateCore', candidateCore,
    '-CurrentCore', path.join(installPath, 'BepInEx', 'core'),
    '-CandidateVersion', candidateVersion,
  ]);
  return new Map(results.map((r) => [r.path, { ok: r.ok, error: r.error ?? null, problems: (r.problems ?? []).map((p) => ({ detail: p.detail, where: p.where ?? [] })) }]));
}

function normalize(result) {
  return {
    ...result,
    namespaces: (result.namespaces ?? []).filter((ns) => !COMPILER_NAMESPACES.test(ns)),
    dependencies: result.dependencies ?? [],
    incompatibilities: result.incompatibilities ?? [],
    processes: result.processes ?? [],
    problems: (result.problems ?? []).map((p) => ({ ...p, where: p.where ?? [] })),
    missingMembers: result.missingMembers ?? [],
    patches: result.patches ?? [],
  };
}

/**
 * Reads plugin identity + game-compatibility problems for DLLs by running
 * server/tools/inspect-plugins.ps1 (Mono.Cecil from BepInEx's own core folder, no install needed).
 * Results are cached per file (size+mtime) and thrown away wholesale whenever the game's
 * Assembly-CSharp.dll changes, i.e. on every game update.
 */
export class PluginInspector {
  constructor(dataDir, installPath) {
    this.installPath = installPath;
    this.cache = new JsonStore(dataDir, 'inspect-cache.json', { gameKey: null, entries: {} });
  }

  gameKey() {
    return `v${SCANNER_VERSION}:${fileKey(path.join(managedFolder(this.installPath), 'Assembly-CSharp.dll'))}`;
  }

  /** Returns Map(path -> inspection result). Only runs the scanner for files not already cached. */
  async inspect(dllPaths) {
    const existing = dllPaths.filter((p) => existsSync(p));
    const data = this.cache.read();
    const gameKey = this.gameKey();
    if (data.gameKey !== gameKey) {
      data.gameKey = gameKey;
      data.entries = {};
    }

    const todo = existing.filter((p) => data.entries[p.toLowerCase()]?.key !== fileKey(p));
    if (todo.length > 0) {
      const results = await runScript(this.installPath, todo);
      for (const r of results) {
        data.entries[r.path.toLowerCase()] = { key: fileKey(r.path), result: normalize(r) };
      }
      this.cache.write(data);
    }

    return new Map(existing.map((p) => [p, data.entries[p.toLowerCase()]?.result ?? null]));
  }

  async inspectOne(dllPath) {
    return (await this.inspect([dllPath])).get(dllPath) ?? null;
  }
}
