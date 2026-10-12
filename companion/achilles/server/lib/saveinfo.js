import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { readFlatNrbfObject } from './nrbf.js';

const GAME_MODE_NAMES = { 0: 'Campaign', 2: 'Sandbox', 3: 'Station' };

/** Every save slot found in Save_Data, in slot order - one entry per distinct "NN" found in
 * SaveGameData_NN*.dat, whether or not its _Info.dat sidecar could be read. */
export function listSaveSlots(installPath) {
  const dir = path.join(installPath, 'Save_Data');
  if (!existsSync(dir)) return [];

  const slotNumbers = new Set();
  for (const name of readdirSync(dir)) {
    const match = name.match(/^SaveGameData_(\d+)(?:_.*)?\.dat$/);
    if (match) slotNumbers.add(match[1]);
  }

  return [...slotNumbers]
    .sort((a, b) => Number(a) - Number(b))
    .map((slot) => readSaveSlot(dir, slot));
}

function readSaveSlot(saveDataDir, slot) {
  const mainFile = path.join(saveDataDir, `SaveGameData_${slot}.dat`);
  const infoFile = path.join(saveDataDir, `SaveGameData_${slot}_Info.dat`);
  const autoFile = path.join(saveDataDir, `SaveGameData_${slot}_Auto.dat`);

  const base = {
    slot,
    hasMainSave: existsSync(mainFile),
    hasAutosave: existsSync(autoFile),
    info: null,
    infoError: null,
  };

  if (!existsSync(infoFile)) return base;

  try {
    const raw = readFlatNrbfObject(readFileSync(infoFile));
    base.info = {
      charName: typeof raw.charName === 'string' ? raw.charName : null,
      level: typeof raw.level === 'number' ? raw.level : null,
      credits: typeof raw.credits === 'number' ? Math.round(raw.credits) : null,
      gameMode: GAME_MODE_NAMES[raw.gameMode] ?? (raw.gameMode !== undefined ? `Mode ${raw.gameMode}` : null),
      difficulty: raw.difficulty ?? null,
      permadeath: raw.permadeath ?? null,
      shipModelID: raw.shipModelID ?? null,
      version: typeof raw.version === 'number' ? raw.version.toFixed(2) + (raw.subVersion ?? '') : null,
      timePlayedHours: typeof raw.timePlayed === 'number' ? Math.round((raw.timePlayed / 3600) * 10) / 10 : null,
      lastSaveDateTime: raw.lastSaveDateTime ?? null,
      hasBaseBuildingDLC: raw.hasBaseBuildingDLC ?? null,
    };
  } catch (err) {
    base.infoError = err.message;
  }

  return base;
}
