/** Reading and writing primitives shared by every container parser. */

export class ByteReader {
  readonly view: DataView;
  offset = 0;

  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get remaining(): number {
    return this.bytes.length - this.offset;
  }

  u8(): number {
    return this.view.getUint8(this.offset++);
  }

  u16(): number {
    const value = this.view.getUint16(this.offset);
    this.offset += 2;
    return value;
  }

  u24(): number {
    return (this.u8() << 16) | (this.u8() << 8) | this.u8();
  }

  u32(): number {
    const value = this.view.getUint32(this.offset);
    this.offset += 4;
    return value;
  }

  u64(): number {
    const hi = this.u32();
    const lo = this.u32();
    return hi * 0x1_0000_0000 + lo;
  }

  slice(length: number): Uint8Array {
    const out = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return out;
  }

  ascii(length: number): string {
    let out = '';
    for (let i = 0; i < length; i++) out += String.fromCharCode(this.u8());
    return out;
  }

  skip(length: number): void {
    this.offset += length;
  }
}

/** Growable output buffer. Used by the tag and ZIP writers. */
export class ByteWriter {
  private buffer: Uint8Array;
  private length = 0;

  constructor(initialCapacity = 1024) {
    this.buffer = new Uint8Array(initialCapacity);
  }

  private ensure(extra: number): void {
    if (this.length + extra <= this.buffer.length) return;
    let capacity = this.buffer.length * 2;
    while (capacity < this.length + extra) capacity *= 2;
    const next = new Uint8Array(capacity);
    next.set(this.buffer.subarray(0, this.length));
    this.buffer = next;
  }

  u8(value: number): this {
    this.ensure(1);
    this.buffer[this.length++] = value & 0xff;
    return this;
  }

  u16(value: number): this {
    return this.u8(value >>> 8).u8(value);
  }

  u24(value: number): this {
    return this.u8(value >>> 16).u8(value >>> 8).u8(value);
  }

  u32(value: number): this {
    return this.u8(value >>> 24).u8(value >>> 16).u8(value >>> 8).u8(value);
  }

  /** Little-endian 32-bit, for ZIP records. */
  u32le(value: number): this {
    return this.u8(value).u8(value >>> 8).u8(value >>> 16).u8(value >>> 24);
  }

  u16le(value: number): this {
    return this.u8(value).u8(value >>> 8);
  }

  /** Little-endian 64-bit, for ZIP64 records. */
  u64le(value: number): this {
    const lo = value >>> 0;
    const hi = Math.floor(value / 0x1_0000_0000);
    return this.u32le(lo).u32le(hi);
  }

  bytes(data: Uint8Array): this {
    this.ensure(data.length);
    this.buffer.set(data, this.length);
    this.length += data.length;
    return this;
  }

  ascii(text: string): this {
    this.ensure(text.length);
    for (let i = 0; i < text.length; i++) {
      this.buffer[this.length++] = text.charCodeAt(i) & 0xff;
    }
    return this;
  }

  get size(): number {
    return this.length;
  }

  finish(): Uint8Array {
    return this.buffer.slice(0, this.length);
  }
}

/**
 * ID3 sizes are stored as "syncsafe" integers: seven meaningful bits per byte,
 * so the size can never contain a byte that looks like a frame sync.
 */
export function readSyncSafe(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] & 0x7f) << 21) |
    ((bytes[offset + 1] & 0x7f) << 14) |
    ((bytes[offset + 2] & 0x7f) << 7) |
    (bytes[offset + 3] & 0x7f)
  );
}

export function writeSyncSafe(writer: ByteWriter, value: number): void {
  writer
    .u8((value >>> 21) & 0x7f)
    .u8((value >>> 14) & 0x7f)
    .u8((value >>> 7) & 0x7f)
    .u8(value & 0x7f);
}

const LATIN1 = new TextDecoder('latin1');
const UTF8 = new TextDecoder('utf-8');
const UTF16LE = new TextDecoder('utf-16le');
const UTF16BE = new TextDecoder('utf-16be');

/** Strip the NUL terminators that tag payloads are routinely padded with. */
function stripNulls(text: string): string {
  return text.replace(/\0+$/, '');
}

/** Decode an ID3 text payload according to its leading encoding byte. */
export function decodeId3Text(encoding: number, data: Uint8Array): string {
  let text: string;
  switch (encoding) {
    case 0:
      text = LATIN1.decode(data);
      break;
    case 1: {
      // UTF-16 with a byte order mark.
      if (data.length >= 2 && data[0] === 0xff && data[1] === 0xfe) {
        text = UTF16LE.decode(data.subarray(2));
      } else if (data.length >= 2 && data[0] === 0xfe && data[1] === 0xff) {
        text = UTF16BE.decode(data.subarray(2));
      } else {
        text = UTF16LE.decode(data);
      }
      break;
    }
    case 2:
      text = UTF16BE.decode(data);
      break;
    default:
      text = UTF8.decode(data);
      break;
  }
  return stripNulls(text);
}

/** Encode text as UTF-16LE with a BOM, the widely supported ID3v2.3 form. */
export function encodeUtf16WithBom(text: string): Uint8Array {
  const out = new Uint8Array(2 + text.length * 2);
  out[0] = 0xff;
  out[1] = 0xfe;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    out[2 + i * 2] = code & 0xff;
    out[3 + i * 2] = code >>> 8;
  }
  return out;
}

export function encodeLatin1(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

/** True when every character survives a Latin-1 round trip. */
export function isLatin1Safe(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 0xff) return false;
  }
  return true;
}

export const utf8 = new TextEncoder();

export function concatBytes(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
