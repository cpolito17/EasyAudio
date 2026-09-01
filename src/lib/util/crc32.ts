/** CRC-32 (IEEE 802.3), required by every ZIP local file header. */

const TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let value = i;
    for (let bit = 0; bit < 8; bit++) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
})();

/** Incremental CRC so a file can be hashed while it streams out. */
export class Crc32 {
  private state = 0xffffffff;

  update(chunk: Uint8Array): void {
    let state = this.state;
    for (let i = 0; i < chunk.length; i++) {
      state = TABLE[(state ^ chunk[i]) & 0xff] ^ (state >>> 8);
    }
    this.state = state;
  }

  get value(): number {
    return (this.state ^ 0xffffffff) >>> 0;
  }
}

export function crc32(data: Uint8Array): number {
  const hasher = new Crc32();
  hasher.update(data);
  return hasher.value;
}
