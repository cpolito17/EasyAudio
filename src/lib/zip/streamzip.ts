/**
 * Streaming ZIP writer with ZIP64 support.
 *
 * Building an archive in memory means holding the entire album twice over, and
 * a hundred tracks will exhaust the tab long before the download starts. This
 * writer emits each file as soon as it is ready and never keeps more than the
 * current file plus the central directory.
 *
 * Everything is stored uncompressed. MP3 and JPEG are already compressed, so
 * deflate would spend real CPU time to save close to nothing.
 */

import { ByteWriter, utf8 } from '../util/bytes.ts';
import { Crc32 } from '../util/crc32.ts';

/** Beyond this, a field must use the ZIP64 extensions. */
const ZIP32_LIMIT = 0xffffffff;

const SIGNATURE_LOCAL = 0x04034b50;
const SIGNATURE_CENTRAL = 0x02014b50;
const SIGNATURE_END = 0x06054b50;
const SIGNATURE_ZIP64_END = 0x06064b50;
const SIGNATURE_ZIP64_LOCATOR = 0x07064b50;

const METHOD_STORE = 0;
/** Bit 11 declares the filename is UTF-8, which matters for non-ASCII titles. */
const FLAG_UTF8 = 0x0800;

interface CentralEntry {
  nameBytes: Uint8Array;
  crc: number;
  size: number;
  localHeaderOffset: number;
  dosTime: number;
  dosDate: number;
}

/** Convert a Date to the two 16-bit fields MS-DOS used, which ZIP inherited. */
function toDosDateTime(date: Date): { dosTime: number; dosDate: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    dosTime:
      (date.getHours() << 11) |
      (date.getMinutes() << 5) |
      (Math.floor(date.getSeconds() / 2) & 0x1f),
    dosDate: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

export interface ZipSink {
  write(chunk: Uint8Array): Promise<void> | void;
  close(): Promise<void> | void;
}

/**
 * Writes a ZIP archive to a sink one entry at a time.
 *
 * Sizes are known before each entry is written, so no data descriptors are
 * needed and the archive stays readable by the strictest tools.
 */
export class ZipWriter {
  private entries: CentralEntry[] = [];
  private offset = 0;
  private closed = false;
  private readonly sink: ZipSink;

  constructor(sink: ZipSink) {
    this.sink = sink;
  }

  private async emit(chunk: Uint8Array): Promise<void> {
    await this.sink.write(chunk);
    this.offset += chunk.length;
  }

  /**
   * Add one file. `data` may be a single buffer or an iterable of chunks, so a
   * large track can be streamed without ever being fully materialised.
   */
  async add(
    name: string,
    data: Uint8Array | Iterable<Uint8Array>,
    modified = new Date(),
  ): Promise<void> {
    if (this.closed) throw new Error('Archive is already closed.');

    const chunks: Uint8Array[] =
      data instanceof Uint8Array ? [data] : Array.from(data);

    let size = 0;
    const hasher = new Crc32();
    for (const chunk of chunks) {
      size += chunk.length;
      hasher.update(chunk);
    }
    const crc = hasher.value;

    const nameBytes = utf8.encode(name);
    const { dosTime, dosDate } = toDosDateTime(modified);
    const localHeaderOffset = this.offset;

    // A single file at or past 4 GB forces ZIP64 for this entry.
    const needsZip64 = size >= ZIP32_LIMIT || localHeaderOffset >= ZIP32_LIMIT;

    const header = new ByteWriter(64 + nameBytes.length);
    header.u32le(SIGNATURE_LOCAL);
    header.u16le(needsZip64 ? 45 : 20); // Version needed to extract.
    header.u16le(FLAG_UTF8);
    header.u16le(METHOD_STORE);
    header.u16le(dosTime);
    header.u16le(dosDate);
    header.u32le(crc);

    if (needsZip64) {
      // The real sizes live in the extra field.
      header.u32le(ZIP32_LIMIT);
      header.u32le(ZIP32_LIMIT);
    } else {
      header.u32le(size);
      header.u32le(size);
    }

    header.u16le(nameBytes.length);
    header.u16le(needsZip64 ? 20 : 0); // Extra field length.
    header.bytes(nameBytes);

    if (needsZip64) {
      header.u16le(0x0001); // ZIP64 extended information.
      header.u16le(16);
      header.u64le(size); // Uncompressed.
      header.u64le(size); // Compressed.
    }

    await this.emit(header.finish());
    for (const chunk of chunks) await this.emit(chunk);

    this.entries.push({ nameBytes, crc, size, localHeaderOffset, dosTime, dosDate });
  }

  /** Write the central directory and finish the archive. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    const directoryStart = this.offset;

    for (const entry of this.entries) {
      const needsZip64 =
        entry.size >= ZIP32_LIMIT || entry.localHeaderOffset >= ZIP32_LIMIT;

      const extra = new ByteWriter(32);
      if (needsZip64) {
        extra.u16le(0x0001);
        // Only the fields that actually overflowed are included, in a fixed
        // order: uncompressed size, compressed size, then local header offset.
        extra.u16le(24);
        extra.u64le(entry.size);
        extra.u64le(entry.size);
        extra.u64le(entry.localHeaderOffset);
      }
      const extraBytes = extra.finish();

      const record = new ByteWriter(64 + entry.nameBytes.length + extraBytes.length);
      record.u32le(SIGNATURE_CENTRAL);
      record.u16le(needsZip64 ? 45 : 20); // Version made by.
      record.u16le(needsZip64 ? 45 : 20); // Version needed.
      record.u16le(FLAG_UTF8);
      record.u16le(METHOD_STORE);
      record.u16le(entry.dosTime);
      record.u16le(entry.dosDate);
      record.u32le(entry.crc);
      record.u32le(needsZip64 ? ZIP32_LIMIT : entry.size);
      record.u32le(needsZip64 ? ZIP32_LIMIT : entry.size);
      record.u16le(entry.nameBytes.length);
      record.u16le(extraBytes.length);
      record.u16le(0); // File comment length.
      record.u16le(0); // Disk number start.
      record.u16le(0); // Internal attributes.
      record.u32le(0); // External attributes.
      record.u32le(needsZip64 ? ZIP32_LIMIT : entry.localHeaderOffset);
      record.bytes(entry.nameBytes);
      record.bytes(extraBytes);

      await this.emit(record.finish());
    }

    const directorySize = this.offset - directoryStart;
    const needsZip64End =
      this.entries.length >= 0xffff ||
      directoryStart >= ZIP32_LIMIT ||
      directorySize >= ZIP32_LIMIT;

    if (needsZip64End) {
      const zip64End = new ByteWriter(56);
      zip64End.u32le(SIGNATURE_ZIP64_END);
      zip64End.u64le(44); // Size of this record minus its first 12 bytes.
      zip64End.u16le(45);
      zip64End.u16le(45);
      zip64End.u32le(0); // This disk.
      zip64End.u32le(0); // Disk with the directory.
      zip64End.u64le(this.entries.length);
      zip64End.u64le(this.entries.length);
      zip64End.u64le(directorySize);
      zip64End.u64le(directoryStart);
      const zip64EndOffset = this.offset;
      await this.emit(zip64End.finish());

      const locator = new ByteWriter(20);
      locator.u32le(SIGNATURE_ZIP64_LOCATOR);
      locator.u32le(0);
      locator.u64le(zip64EndOffset);
      locator.u32le(1); // Total disks.
      await this.emit(locator.finish());
    }

    const end = new ByteWriter(22);
    end.u32le(SIGNATURE_END);
    end.u16le(0);
    end.u16le(0);
    end.u16le(Math.min(this.entries.length, 0xffff));
    end.u16le(Math.min(this.entries.length, 0xffff));
    end.u32le(needsZip64End ? ZIP32_LIMIT : directorySize);
    end.u32le(needsZip64End ? ZIP32_LIMIT : directoryStart);
    end.u16le(0); // No archive comment.
    await this.emit(end.finish());

    await this.sink.close();
  }

  get bytesWritten(): number {
    return this.offset;
  }
}

/**
 * A sink backed by the File System Access API.
 *
 * This is the path that makes large exports safe: bytes go straight to the
 * file the user picked, so peak memory stays at roughly one track.
 */
export async function createFileSink(
  suggestedName: string,
): Promise<{ sink: ZipSink; kind: 'file' } | null> {
  const picker = (
    window as unknown as {
      showSaveFilePicker?: (options: unknown) => Promise<FileSystemFileHandle>;
    }
  ).showSaveFilePicker;

  if (typeof picker !== 'function') return null;

  try {
    const handle = await picker({
      suggestedName,
      types: [
        {
          description: 'ZIP archive',
          accept: { 'application/zip': ['.zip'] },
        },
      ],
    });
    const writable = await handle.createWritable();
    return {
      kind: 'file',
      sink: {
        write: (chunk) => writable.write(chunk as unknown as BufferSource),
        close: () => writable.close(),
      },
    };
  } catch (error) {
    // The user dismissing the picker is a normal outcome, not a failure.
    if (error instanceof DOMException && error.name === 'AbortError') return null;
    throw error;
  }
}

/**
 * Fallback sink that accumulates chunks and resolves to a Blob.
 *
 * Used when the File System Access API is unavailable, mostly Firefox and
 * Safari. Memory then scales with the archive, which is why the UI warns before
 * a very large export on those browsers.
 */
export function createBlobSink(): {
  sink: ZipSink;
  result: Promise<Blob>;
} {
  const chunks: Uint8Array[] = [];
  let resolveResult: (blob: Blob) => void;
  const result = new Promise<Blob>((resolve) => {
    resolveResult = resolve;
  });

  return {
    sink: {
      write(chunk) {
        // Copy: the caller may reuse its buffer for the next chunk.
        chunks.push(chunk.slice());
      },
      close() {
        resolveResult(new Blob(chunks as BlobPart[], { type: 'application/zip' }));
      },
    },
    result,
  };
}
