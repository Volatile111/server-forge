import { spawn } from 'node:child_process';
import { STAR_VALOR_APP_ID } from './steam.js';

/** Launches Star Valor through Steam. Starting "Star Valor.exe" directly (what 0.1.0 did) makes
 * Steamworks' RestartAppIfNecessary shut the game down and relaunch it via Steam anyway - visible
 * in Player-prev.log as "Shutting down because RestartAppIfNecessary returned true" - so going
 * through Steam from the start avoids a double start.
 *
 * Doesn't jump into a specific save slot; the game's own menu is still where you pick one. */
export function launchGame() {
  const child = spawn('explorer.exe', [`steam://rungameid/${STAR_VALOR_APP_ID}`], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  return { launched: true };
}
