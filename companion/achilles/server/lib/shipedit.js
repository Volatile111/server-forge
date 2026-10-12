import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { JsonStore } from './store.js';

// Ship stat editing for .shipmod files (We Mod Any Ship's ship definitions: the game's SpaceShip class, written by
// .NET's XmlSerializer). The editor changes values only: never adds, removes or reorders elements, and writes the
// file back byte for byte apart from the changed values, so the game reads it exactly as before.
//
// The first edit keeps the file as it was in <data>/ship-originals/ ("Reset to original" puts it back). A file
// that changed since our last save (updated, replaced, edited by hand) counts as a new original.

/**
 * Every leaf element (no child elements) with its path and where its text sits in the file. Paths count each
 * element among same-named siblings: "weapons[1]/Turret[2]/turnSpeed[1]". Enough XML for XmlSerializer output (no
 * CDATA, no mixed content).
 */
export function parseLeaves(xml) {
  const leaves = [];
  const stack = []; // { name, counts: Map<childName, n>, path, hasChildren, contentStart, attrs }
  const re = /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[^\s=>\/]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|<\?[\s\S]*?\?>|<!--[\s\S]*?-->/g;
  let m;
  while ((m = re.exec(xml))) {
    if (!m[2]) continue; // declaration or comment
    const [, closing, name, attrs, selfClosing] = m;
    if (closing) {
      const open = stack.pop();
      if (!open || open.name !== name) throw new Error(`Not a valid ship file (</${name}> doesn't match).`);
      if (!open.hasChildren && stack.length) {
        leaves.push({ path: open.path, name, attrs: open.attrs, start: open.contentStart, end: m.index, raw: xml.slice(open.contentStart, m.index) });
      }
      continue;
    }
    const parent = stack[stack.length - 1];
    let p = name;
    if (parent) {
      parent.hasChildren = true;
      const n = (parent.counts.get(name) ?? 0) + 1;
      parent.counts.set(name, n);
      p = parent.path ? `${parent.path}/${name}[${n}]` : `${name}[${n}]`;
    }
    if (selfClosing) continue; // <mods /> and the like: nothing to edit
    stack.push({ name, counts: new Map(), path: parent ? p : '', hasChildren: false, contentStart: m.index + m[0].length, attrs });
  }
  if (stack.length) throw new Error('Not a valid ship file (it ends too early).');
  return leaves;
}

const unescape = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// The game's enums (Star Valor's Assembly-CSharp and We Mod Any Ship 1.3.1). XmlSerializer throws on a name it doesn't
// know, and one throw stops We Mod Any Ship loading every ship file after it, so only these names can be saved.
const FACTIONS = ['Independent', 'Miners', 'Traders', 'Pirates', 'Venghi', 'Rebels', 'Tecnomancers'];
export const ENUMS = {
  faction: FACTIONS,
  shipClass: ['Shuttle', 'Yacht', 'Corvette', 'Frigate', 'Cruiser', 'Dreadnought', 'Kraken'],
  shipRole: ['None', 'Interceptor', 'Fighter', 'Gunship', 'Destroyer', 'Battleship', 'Carrier', 'Corsair', 'Mining', 'Freighter', 'Passenger', 'Engineer', 'Racing', 'Ranger', 'Gladiator', 'Firebrand'],
  turretType: ['Rotating', 'limitedArch'],
  undefBool: ['True', 'False', 'Unknown'],
};
/** Which list a leaf's value must come from, or null. */
function enumOf(leaf) {
  if (leaf.name === 'manufacturer' || leaf.name === 'TFaction') return 'faction';
  if (leaf.name === 'shipClass' || leaf.name === 'shipRole') return leaf.name;
  if (/^weapons\[1\]\/Turret\[\d+\]\/type\[1\]$/.test(leaf.path)) return 'turretType';
  if (/^weapons\[1\]\/Turret\[\d+\]\/hasSpecialStats\[1\]$/.test(leaf.path)) return 'undefBool';
  return null;
}

// Fields declared float in the game/plugin classes (a "6" in the file can still take 6.5).
const FLOATS = new Set(['sizeScale', 'degreesLimit', 'turnSpeed', 'totalSpace', 'dmgBonus', 'criticalChanceBonus', 'criticalDamageBonus', 'armorPenBonus', 'rangeBonusPerc', 'projectileSpeedPerc', 'heatCapMod', 'weaponHeatMod', 'chargeTime', 'chargedFireTime', 'chargedFireCooldown', 'fluxDamageMod', 'explodeBoost', 'sizeMod', 'weaponChargedBaseDamageBoost', 'bonus']);

/** What kind of value a leaf holds: the plugin's declared type where known, else its text (and xsi:type for bonuses). */
function typeOf(leaf) {
  if (enumOf(leaf)) return 'enum';
  const v = leaf.raw.trim();
  const xsi = /xsi:type\s*=\s*"xsd:(\w+)"/.exec(leaf.attrs)?.[1];
  if (xsi === 'boolean' || /^(true|false)$/.test(v)) return 'bool';
  if (xsi === 'float' || xsi === 'double' || xsi === 'decimal' || (!xsi && FLOATS.has(leaf.name))) return 'float';
  if (xsi === 'int' || xsi === 'long' || xsi === 'short') return 'int';
  if (/^-?\d+$/.test(v)) return 'int';
  if (/^-?\d*\.\d+(E[+-]?\d+)?$/i.test(v)) return 'float';
  return 'text';
}

// Left alone: the ship's identity (saves and other files refer to it by name), bonus/property names (code keys) and
// crew positions (an enum with odd members; changing which seat is which is rarely wanted).
const LOCKED = (leaf) => leaf.name === 'shipModelName' || (leaf.name === 'name' && /BonusProperty/.test(leaf.path)) || (leaf.name === 'type' && /SSBonus/.test(leaf.path)) || leaf.name === 'position';

/** The top-level <factions> element (factions whose AI fly this ship), as found in the file. */
function factionsElement(xml) {
  const m = /^([ \t]*)<factions\s*\/>|^([ \t]*)<factions>[\s\S]*?<\/factions>/m.exec(xml);
  if (!m) return null;
  return { start: m.index, end: m.index + m[0].length, indent: m[1] ?? m[2] ?? '  ', list: [...m[0].matchAll(/<TFaction>([^<]*)<\/TFaction>/g)].map((x) => x[1].trim()) };
}

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

export class ShipEditor {
  constructor(dataDir, modLibrary) {
    this.modLibrary = modLibrary;
    this.originals = path.join(dataDir, 'ship-originals');
    this.store = new JsonStore(dataDir, 'ship-edits.json', { ships: {} });
  }

  _file(modId) {
    const mod = this.modLibrary.get(modId);
    if (mod.kind !== 'shipmod') throw new Error('Only ship mods have ship stats.');
    const file = this.modLibrary.locate(mod).currentPath;
    if (!existsSync(file)) throw new Error(`"${mod.filename}" is missing from disk.`);
    return { mod, file };
  }

  /** Filenames (lower case) whose current file is one this editor saved, i.e. edited and not replaced since. */
  editedFiles() {
    const out = new Set();
    for (const m of this.modLibrary.list().filter((x) => x.kind === 'shipmod')) {
      const rec = this.store.read().ships[m.filename.toLowerCase()];
      if (!rec) continue;
      const file = this.modLibrary.locate(m).currentPath;
      try {
        if (existsSync(file) && sha(readFileSync(file)) === rec.savedHash) out.add(m.filename.toLowerCase());
      } catch {}
    }
    return out;
  }

  read(modId) {
    const { mod, file } = this._file(modId);
    const buf = readFileSync(file);
    const xml = buf.toString('utf8');
    const leaves = parseLeaves(xml);
    const rec = this.store.read().ships[mod.filename.toLowerCase()];
    const edited = Boolean(rec && rec.savedHash === sha(buf));
    return {
      modId,
      filename: mod.filename,
      enabled: mod.enabled,
      edited,
      canReset: edited && existsSync(path.join(this.originals, rec.original)),
      // The factions list is edited as a whole (`factions` below), not entry by entry.
      fields: leaves
        .filter((l) => !l.path.startsWith('factions['))
        .map((l) => ({ path: l.path, name: l.name, type: typeOf(l), value: unescape(l.raw.trim()), locked: LOCKED(l), choice: enumOf(l) })),
      factions: factionsElement(xml)?.list ?? null,
      choices: ENUMS,
    };
  }

  /** `changes`: { [path]: newValue }; `factions`: the whole factions list, or undefined to leave it. Checks every
   * value against its type before writing anything. */
  save(modId, changes, factions) {
    const { mod, file } = this._file(modId);
    const buf = readFileSync(file);
    const xml = buf.toString('utf8');
    const leaves = new Map(parseLeaves(xml).map((l) => [l.path, l]));
    const edits = [];
    for (const [p, value] of Object.entries(changes ?? {})) {
      const leaf = leaves.get(p);
      if (!leaf || p.startsWith('factions[')) throw new Error(`Unknown field ${p}.`);
      if (LOCKED(leaf)) throw new Error(`${leaf.name} can't be changed.`);
      const v = String(value).trim();
      const type = typeOf(leaf);
      let text;
      if (type === 'enum') {
        if (!ENUMS[enumOf(leaf)].includes(v)) throw new Error(`"${v}" isn't a ${leaf.name} the game knows.`);
        text = v;
      } else if (type === 'bool') {
        if (!/^(true|false)$/i.test(v)) throw new Error(`${leaf.name} must be true or false.`);
        text = v.toLowerCase();
      } else if (type === 'int') {
        if (!/^-?\d+$/.test(v) || Math.abs(Number(v)) > 2147483647) throw new Error(`${leaf.name} must be a whole number.`);
        text = String(Number(v));
      } else if (type === 'float') {
        if (!/^-?(\d+\.?\d*|\.\d+)$/.test(v)) throw new Error(`${leaf.name} must be a number.`);
        text = String(Number(v));
      } else {
        if (!v || v.length > 200 || /[\r\n]/.test(v)) throw new Error(`${leaf.name} can't be empty or longer than 200 characters.`);
        text = escape(v);
      }
      if (text !== leaf.raw.trim()) edits.push({ leaf, text });
    }
    let newFactions = null;
    if (factions !== undefined && factions !== null) {
      const current = factionsElement(xml);
      if (!current) throw new Error('This ship file has no factions list.');
      if (!Array.isArray(factions) || factions.some((x) => !FACTIONS.includes(x))) throw new Error('Unknown faction in the list.');
      const list = [...new Set(factions)];
      if (list.join() !== current.list.join()) newFactions = list;
    }
    if (!edits.length && !newFactions) return this.read(modId);

    // Keep the file as it was before the first edit (or before this edit, if it changed since our last save).
    const key = mod.filename.toLowerCase();
    const rec = this.store.read().ships[key];
    let original = rec?.original;
    if (!rec || rec.savedHash !== sha(buf) || !existsSync(path.join(this.originals, rec.original))) {
      mkdirSync(this.originals, { recursive: true });
      original = mod.filename;
      for (let n = 2; existsSync(path.join(this.originals, original)); n++) original = `${path.basename(mod.filename, '.shipmod')} (${n}).shipmod`;
      copyFileSync(file, path.join(this.originals, original));
    }

    let out = xml;
    for (const { leaf, text } of edits.sort((a, b) => b.leaf.start - a.leaf.start)) {
      const lead = leaf.raw.match(/^\s*/)[0];
      const trail = leaf.raw.match(/\s*$/)[0];
      out = out.slice(0, leaf.start) + lead + text + trail + out.slice(leaf.end);
    }
    if (newFactions) {
      // Written the way XmlSerializer writes it, so the file reads as if the game had exported it.
      const el = factionsElement(out);
      const nl = out.includes('\r\n') ? '\r\n' : '\n';
      const body = newFactions.length ? `${el.indent}<factions>${nl}${newFactions.map((x) => `${el.indent}  <TFaction>${x}</TFaction>${nl}`).join('')}${el.indent}</factions>` : `${el.indent}<factions />`;
      out = out.slice(0, el.start) + body + out.slice(el.end);
    }
    parseLeaves(out); // still well-formed
    const outBuf = Buffer.from(out, 'utf8');
    const tmp = `${file}.achilles-tmp`;
    writeFileSync(tmp, outBuf);
    renameSync(tmp, file);
    this.store.update((d) => {
      d.ships[key] = { original, savedHash: sha(outBuf), savedAt: new Date().toISOString() };
      return d;
    });
    return this.read(modId);
  }

  /** Puts the file back the way it was before the first edit. */
  reset(modId) {
    const { mod, file } = this._file(modId);
    const key = mod.filename.toLowerCase();
    const rec = this.store.read().ships[key];
    const orig = rec && path.join(this.originals, rec.original);
    if (!orig || !existsSync(orig)) throw new Error('There is no original copy of this ship to go back to.');
    if (sha(readFileSync(file)) !== rec.savedHash) throw new Error('This ship file changed since it was edited here (updated or replaced), so the old original no longer applies.');
    const tmp = `${file}.achilles-tmp`;
    copyFileSync(orig, tmp);
    renameSync(tmp, file);
    this.store.update((d) => {
      delete d.ships[key];
      return d;
    });
    return this.read(modId);
  }
}
