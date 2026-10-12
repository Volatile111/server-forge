import { readFileSync, existsSync } from 'node:fs';

/**
 * Reads a string from a Windows DLL/EXE's version resource (VS_VERSION_INFO), e.g. "FileVersion"
 * or "ProductVersion" - the same values Explorer shows under Properties > Details. The strings
 * are stored as UTF-16LE "Key\0" + padding to a 4-byte boundary + "Value\0", so a byte search is
 * enough; no PE resource-tree walk needed.
 */
export function readVersionString(filePath, key = 'ProductVersion') {
  if (!existsSync(filePath)) return null;
  const buf = readFileSync(filePath);
  const needle = Buffer.from(`${key}\0`, 'utf16le');
  const at = buf.lastIndexOf(needle);
  if (at < 0) return null;
  let p = at + needle.length;
  while (p % 4 !== 0) p++; // value is DWORD-aligned
  let end = p;
  while (end + 1 < buf.length && !(buf[end] === 0 && buf[end + 1] === 0)) end += 2;
  const value = buf.subarray(p, end).toString('utf16le').trim();
  return value || null;
}

/** x64 / x86 from the PE header's Machine field. */
export function peArchitecture(filePath) {
  try {
    const buf = readFileSync(filePath);
    const pe = buf.readUInt32LE(0x3c);
    const machine = buf.readUInt16LE(pe + 4);
    return machine === 0x8664 ? 'x64' : machine === 0x14c ? 'x86' : machine === 0xaa64 ? 'arm64' : `unknown(0x${machine.toString(16)})`;
  } catch {
    return null;
  }
}
