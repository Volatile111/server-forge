import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

/**
 * Minimal .zip reader - just enough to pull mod files out of a Nexus/GitHub download without
 * adding a dependency. Handles stored (0) and deflate (8) entries, which is what every normal zip
 * tool produces. ZIP64 and encrypted archives are rejected with a clear message; .7z/.rar aren't
 * zips at all and are rejected by the caller.
 *
 * Returns [{ name, data }] for every file entry (directories skipped). `name` keeps the archive's
 * internal path with forward slashes.
 */
export function readZip(zipPath) {
  const buf = readFileSync(zipPath);

  // End Of Central Directory record: scan backwards (it can be followed by a comment up to 64 KB).
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a valid .zip file.');

  const entryCount = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff || entryCount === 0xffff) throw new Error('ZIP64 archives are not supported - extract it manually and drop the files in.');

  const entries = [];
  let p = cdOffset;
  for (let n = 0; n < entryCount; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Corrupt .zip central directory.');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const utf8 = (flags & 0x800) !== 0;
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString(utf8 ? 'utf8' : 'latin1').replace(/\\/g, '/');
    p += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue;
    if (flags & 0x1) throw new Error(`"${name}" in the zip is encrypted.`);

    if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('Corrupt .zip local header.');
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compressedSize);

    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = inflateRawSync(raw);
    else throw new Error(`"${name}" uses an unsupported compression method (${method}).`);

    entries.push({ name, data });
  }
  return entries;
}
