/**
 * A minimal reader for .NET BinaryFormatter's wire format (MS-NRBF), scoped ONLY to what Star
 * Valor's small "_Info.dat" save sidecar files actually contain: a single flat root object with
 * primitive and string members, no nested objects/arrays/references. This is NOT a general NRBF
 * parser - it deliberately does not (and should not) attempt to read the multi-megabyte main
 * "SaveGameData_XX.dat" files, which are far more complex object graphs; running an untrusted or
 * even semi-trusted general deserializer over those would be a real hazard for no real benefit,
 * since the sidecar files already carry everything the manager needs to display.
 *
 * Verified by hand against a real "SaveGameData_01_Info.dat" from this system, byte-by-byte,
 * before writing this - every record type/offset below was cross-checked against actual file
 * content, not assumed from the spec alone.
 *
 * Record types (MS-NRBF ??2.1.2.1) actually handled: SerializationHeaderRecord(0),
 * BinaryLibrary(12), ClassWithMembersAndTypes(5), BinaryObjectString(6), MessageEnd(11).
 */

const RECORD = {
  SERIALIZATION_HEADER: 0,
  CLASS_WITH_MEMBERS_AND_TYPES: 5,
  BINARY_OBJECT_STRING: 6,
  BINARY_LIBRARY: 12,
  MESSAGE_END: 11,
};

const BINARY_TYPE = {
  PRIMITIVE: 0,
  STRING: 1,
  OBJECT: 2,
  SYSTEM_CLASS: 3,
  CLASS: 4,
  OBJECT_ARRAY: 5,
  STRING_ARRAY: 6,
  PRIMITIVE_ARRAY: 7,
};

const PRIMITIVE_TYPE = {
  BOOLEAN: 1,
  BYTE: 2,
  CHAR: 3,
  DECIMAL: 5,
  DOUBLE: 6,
  INT16: 7,
  INT32: 8,
  INT64: 9,
  SBYTE: 10,
  SINGLE: 11,
  TIME_SPAN: 12,
  DATE_TIME: 13,
  UINT16: 14,
  UINT32: 15,
  UINT64: 16,
  NULL: 17,
  STRING: 18,
};

class Cursor {
  constructor(buffer) {
    this.view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    this.buffer = buffer;
    this.pos = 0;
  }

  u8() {
    const value = this.view.getUint8(this.pos);
    this.pos += 1;
    return value;
  }

  i32() {
    const value = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return value;
  }

  /** A .NET BinaryFormatter length-prefixed string: a 7-bit-encoded length, then that many UTF-8 bytes. */
  lengthPrefixedString() {
    let length = 0;
    let shift = 0;
    for (;;) {
      const byte = this.u8();
      length |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
    }
    const bytes = this.buffer.subarray(this.pos, this.pos + length);
    this.pos += length;
    return Buffer.from(bytes).toString('utf8');
  }

  readPrimitive(primitiveType) {
    switch (primitiveType) {
      case PRIMITIVE_TYPE.BOOLEAN:
        return this.u8() !== 0;
      case PRIMITIVE_TYPE.BYTE:
        return this.u8();
      case PRIMITIVE_TYPE.INT16: {
        const value = this.view.getInt16(this.pos, true);
        this.pos += 2;
        return value;
      }
      case PRIMITIVE_TYPE.INT32:
        return this.i32();
      case PRIMITIVE_TYPE.INT64: {
        const value = this.view.getBigInt64(this.pos, true);
        this.pos += 8;
        return value;
      }
      case PRIMITIVE_TYPE.SINGLE: {
        const value = this.view.getFloat32(this.pos, true);
        this.pos += 4;
        return value;
      }
      case PRIMITIVE_TYPE.DOUBLE: {
        const value = this.view.getFloat64(this.pos, true);
        this.pos += 8;
        return value;
      }
      case PRIMITIVE_TYPE.UINT16: {
        const value = this.view.getUint16(this.pos, true);
        this.pos += 2;
        return value;
      }
      case PRIMITIVE_TYPE.UINT32: {
        const value = this.view.getUint32(this.pos, true);
        this.pos += 4;
        return value;
      }
      case PRIMITIVE_TYPE.UINT64: {
        const value = this.view.getBigUint64(this.pos, true);
        this.pos += 8;
        return value;
      }
      case PRIMITIVE_TYPE.SBYTE: {
        const value = this.view.getInt8(this.pos);
        this.pos += 1;
        return value;
      }
      case PRIMITIVE_TYPE.CHAR: {
        // .NET writes Char as UTF-8 bytes (1-4 of them), same encoding as a length-1 string body.
        const start = this.pos;
        const first = this.buffer[start];
        const byteLength = first < 0x80 ? 1 : first < 0xe0 ? 2 : first < 0xf0 ? 3 : 4;
        const value = Buffer.from(this.buffer.subarray(start, start + byteLength)).toString('utf8');
        this.pos += byteLength;
        return value;
      }
      case PRIMITIVE_TYPE.DATE_TIME: {
        // .NET DateTime wire format: a UInt64 where the low 62 bits are ticks (100ns units) since
        // 0001-01-01, and the top 2 bits are DateTimeKind - mask those off before converting.
        const raw = this.view.getBigUint64(this.pos, true);
        this.pos += 8;
        const ticks = raw & 0x3fffffffffffffffn;
        const TICKS_PER_MS = 10000n;
        const TICKS_AT_UNIX_EPOCH = 621355968000000000n; // ticks between 0001-01-01 and 1970-01-01
        const unixMs = Number((ticks - TICKS_AT_UNIX_EPOCH) / TICKS_PER_MS);
        return new Date(unixMs).toISOString();
      }
      case PRIMITIVE_TYPE.STRING:
        return this.lengthPrefixedString();
      default:
        throw new Error(`Unsupported primitive type code ${primitiveType} in save info file - format may have changed.`);
    }
  }
}

/**
 * Reads a flat NRBF object graph (SerializationHeaderRecord, one BinaryLibrary, one
 * ClassWithMembersAndTypes with only primitive/string members, MessageEnd) and returns its
 * members as a plain object. Throws if the file doesn't match that exact shape, rather than
 * guessing - a caller that gets unexpected save-file structure should fall back to "unknown", not
 * silently show wrong data.
 */
export function readFlatNrbfObject(buffer) {
  const cursor = new Cursor(buffer);

  const headerType = cursor.u8();
  if (headerType !== RECORD.SERIALIZATION_HEADER) throw new Error('Not a recognized .NET BinaryFormatter stream.');
  cursor.i32(); // root id
  cursor.i32(); // header id
  cursor.i32(); // major version
  cursor.i32(); // minor version

  const libraryRecordType = cursor.u8();
  if (libraryRecordType !== RECORD.BINARY_LIBRARY) throw new Error('Expected a BinaryLibrary record.');
  cursor.i32(); // library id
  cursor.lengthPrefixedString(); // assembly-qualified name, unused

  const classRecordType = cursor.u8();
  if (classRecordType !== RECORD.CLASS_WITH_MEMBERS_AND_TYPES) throw new Error('Expected ClassWithMembersAndTypes - this reader only handles a flat root object.');
  cursor.i32(); // object id
  cursor.lengthPrefixedString(); // class name, unused
  const memberCount = cursor.i32();
  const memberNames = [];
  for (let i = 0; i < memberCount; i++) memberNames.push(cursor.lengthPrefixedString());

  const memberBinaryTypes = [];
  for (let i = 0; i < memberCount; i++) memberBinaryTypes.push(cursor.u8());

  const memberPrimitiveTypes = new Array(memberCount).fill(null);
  for (let i = 0; i < memberCount; i++) {
    const binaryType = memberBinaryTypes[i];
    if (binaryType === BINARY_TYPE.PRIMITIVE) {
      memberPrimitiveTypes[i] = cursor.u8();
    } else if (binaryType !== BINARY_TYPE.STRING) {
      throw new Error(`Member "${memberNames[i]}" has unsupported type code ${binaryType} - this reader only handles primitive/string members.`);
    }
  }

  cursor.i32(); // library id reference (same library id as the class was declared against)

  const result = {};
  for (let i = 0; i < memberCount; i++) {
    const name = memberNames[i];
    if (memberBinaryTypes[i] === BINARY_TYPE.STRING) {
      const stringRecordType = cursor.u8();
      if (stringRecordType !== RECORD.BINARY_OBJECT_STRING) throw new Error(`Expected BinaryObjectString for member "${name}".`);
      cursor.i32(); // object id
      result[name] = cursor.lengthPrefixedString();
    } else {
      result[name] = cursor.readPrimitive(memberPrimitiveTypes[i]);
    }
  }

  const endType = cursor.u8();
  if (endType !== RECORD.MESSAGE_END) throw new Error('Expected MessageEnd - trailing data may mean this file has more structure than expected.');

  return result;
}
