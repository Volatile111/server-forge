import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

// Star Valor's fixed Steam App ID - confirmed from this system's own appmanifest_833360.acf.
export const STAR_VALOR_APP_ID = '833360';

const DEFAULT_STEAM_ROOTS = [
  'C:\\Program Files (x86)\\Steam',
  'C:\\Program Files\\Steam',
];

/** Very small VDF (Valve Data Format) value reader - good enough for libraryfolders.vdf's flat
 * "path" fields, without pulling in a full VDF parser dependency for one field. */
function extractQuotedValuesAfterKey(vdfText, key) {
  const values = [];
  const re = new RegExp(`"${key}"\\s*"([^"]*)"`, 'g');
  let match;
  while ((match = re.exec(vdfText))) values.push(match[1]);
  return values;
}

/** Every Steam library root this system knows about (the main Steam install, plus every
 * additional library drive listed in libraryfolders.vdf). */
export function findSteamLibraryRoots() {
  const roots = new Set();
  for (const root of DEFAULT_STEAM_ROOTS) {
    if (existsSync(root)) roots.add(root);
  }

  for (const root of [...roots]) {
    const vdfPath = path.join(root, 'steamapps', 'libraryfolders.vdf');
    if (!existsSync(vdfPath)) continue;
    try {
      const text = readFileSync(vdfPath, 'utf8');
      for (const libPath of extractQuotedValuesAfterKey(text, 'path')) {
        if (existsSync(libPath)) roots.add(libPath);
      }
    } catch {}
  }

  return [...roots];
}

/** Finds Star Valor's actual install folder by reading each library's appmanifest for the app ID,
 * rather than guessing folder names - "Star Valor" as a literal path isn't guaranteed (Steam lets
 * users rename library folders, and the display name in the manifest is the only reliable link). */
export function findStarValorInstallPath() {
  for (const root of findSteamLibraryRoots()) {
    const manifestPath = path.join(root, 'steamapps', `appmanifest_${STAR_VALOR_APP_ID}.acf`);
    if (!existsSync(manifestPath)) continue;

    try {
      const text = readFileSync(manifestPath, 'utf8');
      const [installDir] = extractQuotedValuesAfterKey(text, 'installdir');
      if (!installDir) continue;
      const fullPath = path.join(root, 'steamapps', 'common', installDir);
      if (existsSync(fullPath)) return fullPath;
    } catch {}
  }

  return null;
}

/** True if this looks like a real Star Valor install (has the exe and BepInEx's doorstop files). */
export function looksLikeStarValorInstall(installPath) {
  if (!installPath) return false;
  return existsSync(path.join(installPath, 'Star Valor.exe'));
}

/** Whether BepInEx (the mod loader) is set up in this install - doorstop_config.ini + winhttp.dll
 * are what actually hook the game process; the BepInEx/ folder alone isn't enough to confirm it's wired up. */
export function bepInExIsInstalled(installPath) {
  return (
    existsSync(path.join(installPath, 'doorstop_config.ini')) &&
    existsSync(path.join(installPath, 'winhttp.dll')) &&
    existsSync(path.join(installPath, 'BepInEx', 'core'))
  );
}

export function pluginsFolder(installPath) {
  return path.join(installPath, 'BepInEx', 'plugins');
}

export function saveDataFolder(installPath) {
  return path.join(installPath, 'Save_Data');
}

export function managedFolder(installPath) {
  return path.join(installPath, 'Star Valor_Data', 'Managed');
}

/** The Steam build id of the installed game (changes on every game update), read from the same
 * appmanifest used to find the install. */
export function gameBuildId(installPath) {
  const manifestPath = path.join(installPath, '..', '..', `appmanifest_${STAR_VALOR_APP_ID}.acf`);
  try {
    const [buildId] = extractQuotedValuesAfterKey(readFileSync(manifestPath, 'utf8'), 'buildid');
    return buildId ?? null;
  } catch {
    return null;
  }
}

/** BepInEx's own version, from the first line it writes to its log ("BepInEx 5.4.23.5 - ..."). */
export function bepInExVersion(installPath) {
  try {
    const firstLine = readFileSync(path.join(installPath, 'BepInEx', 'LogOutput.log'), 'utf8').split('\n', 1)[0];
    return firstLine.match(/BepInEx (\d+\.\d+\.\d+(?:\.\d+)?)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Unity writes Player.log to LocalLow\<company>\<product>, both of which the game records in
 * Star Valor_Data\app.info ("Rafael Burgos" / "Star Valor") - read it rather than hardcoding. */
export function unityLogFolder(installPath) {
  try {
    const [company, product] = readFileSync(path.join(installPath, 'Star Valor_Data', 'app.info'), 'utf8').split(/\r?\n/);
    const localLow = path.join(process.env.USERPROFILE ?? '', 'AppData', 'LocalLow');
    return path.join(localLow, company.trim(), product.trim());
  } catch {
    return null;
  }
}

export function listPluginFiles(installPath) {
  const dir = pluginsFolder(installPath);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true });
}
