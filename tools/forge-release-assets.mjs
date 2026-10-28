// Included in each installer build so pre-rebrand apps still find their expected filename.
import { readFileSync, existsSync, copyFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export function releaseNames(which, version) {
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) throw new Error('Invalid release version.');
  if (which === 'host') return [`Server-Forge-Setup-${version}.exe`, `Tavern-Host-Setup-${version}.exe`];
  if (which === 'client') return [`SF-Mod-Manager-Setup-${version}.exe`, `Tavern-Client-Mod-Manager-Setup-${version}.exe`];
  throw new Error('Use host or client.');
}
export function prepareAssets(root, which) {
  const metadata = JSON.parse(readFileSync(path.join(root, which === 'host' ? 'package.json' : 'companion/package.json'), 'utf8'));
  const names = releaseNames(which, metadata.version);
  const source = path.join(root, 'release', names[0]);
  if (!existsSync(source) || statSync(source).size === 0) throw new Error('Build the new installer before creating compatibility assets.');
  copyFileSync(source, path.join(root, 'release', names[1]));
  console.log('Prepared installers: ' + names.join(', '));
  return names;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) prepareAssets(path.resolve(import.meta.dirname, '..'), process.argv[2]);
