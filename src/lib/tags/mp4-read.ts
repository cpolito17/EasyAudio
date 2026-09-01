/**
 * MP4 / M4A metadata reader.
 *
 * MP4 stores tags as iTunes-style atoms nested at moov > udta > meta > ilst.
 * Each tag atom contains a `data` atom whose type code says whether the payload
 * is UTF-8 text, an integer or an image.
 */

import type { ParsedTags } from './types.ts';
import { emptyParsedTags } from './types.ts';

const UTF8 = new TextDecoder('utf-8');

interface Atom {
  type: string;
  start: number;
  end: number;
  contentStart: number;
}

/** Walk the atoms directly inside [start, end). */
function* atoms(bytes: Uint8Array, start: number, end: number): Generator<Atom> {
  let cursor = start;

  while (cursor + 8 <= end) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + cursor, 8);
    let size = view.getUint32(0);
    const type = String.fromCharCode(
      bytes[cursor + 4], bytes[cursor + 5], bytes[cursor + 6], bytes[cursor + 7],
    );
    let contentStart = cursor + 8;

    if (size === 1) {
      // A size of 1 means the real 64-bit size follows the type.
      if (cursor + 16 > end) return;
      const large = new DataView(bytes.buffer, bytes.byteOffset + cursor + 8, 8);
      size = large.getUint32(0) * 0x1_0000_0000 + large.getUint32(4);
      contentStart = cursor + 16;
    } else if (size === 0) {
      // Extends to the end of its container.
      size = end - cursor;
    }

    if (size < 8 || cursor + size > end) return;

    yield { type, start: cursor, end: cursor + size, contentStart };
    cursor += size;
  }
}

function findAtom(
  bytes: Uint8Array,
  start: number,
  end: number,
  type: string,
): Atom | null {
  for (const atom of atoms(bytes, start, end)) {
    if (atom.type === type) return atom;
  }
  return null;
}

/** The payload of a tag atom's inner `data` box, with its type code. */
function readData(
  bytes: Uint8Array,
  atom: Atom,
): { typeCode: number; payload: Uint8Array } | null {
  const data = findAtom(bytes, atom.contentStart, atom.end, 'data');
  if (!data) return null;
  // The data atom begins with a 4-byte type code and 4 reserved bytes.
  if (data.contentStart + 8 > data.end) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset + data.contentStart, 4);
  return {
    typeCode: view.getUint32(0) & 0x00ffffff,
    payload: bytes.subarray(data.contentStart + 8, data.end),
  };
}

function readText(bytes: Uint8Array, atom: Atom): string {
  const data = readData(bytes, atom);
  if (!data) return '';
  return UTF8.decode(data.payload).trim();
}

function readInteger(bytes: Uint8Array, atom: Atom): number {
  const data = readData(bytes, atom);
  if (!data || data.payload.length === 0) return 0;
  let value = 0;
  for (const byte of data.payload) value = value * 256 + byte;
  return value;
}

/** trkn and disk store position and total as a pair of 16-bit fields. */
function readPositionPair(
  bytes: Uint8Array,
  atom: Atom,
): { position: number; total: number } {
  const data = readData(bytes, atom);
  if (!data || data.payload.length < 6) return { position: 0, total: 0 };
  const view = new DataView(
    data.payload.buffer,
    data.payload.byteOffset,
    data.payload.length,
  );
  return { position: view.getUint16(2), total: view.getUint16(4) };
}

export function readMp4Tags(bytes: Uint8Array): ParsedTags | null {
  const moov = findAtom(bytes, 0, bytes.length, 'moov');
  if (!moov) return null;

  const udta = findAtom(bytes, moov.contentStart, moov.end, 'udta');
  if (!udta) return emptyParsedTags();

  const meta = findAtom(bytes, udta.contentStart, udta.end, 'meta');
  if (!meta) return emptyParsedTags();

  // `meta` is a full box: four bytes of version and flags precede its children.
  const ilst = findAtom(bytes, meta.contentStart + 4, meta.end, 'ilst');
  if (!ilst) return emptyParsedTags();

  const tags = emptyParsedTags();

  for (const atom of atoms(bytes, ilst.contentStart, ilst.end)) {
    switch (atom.type) {
      case '©nam': tags.title = readText(bytes, atom); break;
      case '©ART': tags.artist = readText(bytes, atom); break;
      case 'aART': tags.albumArtist = readText(bytes, atom); break;
      case '©alb': tags.album = readText(bytes, atom); break;
      case '©gen': tags.genre = readText(bytes, atom); break;
      case '©wrt': tags.composer = readText(bytes, atom); break;
      case '©cmt': tags.comment = readText(bytes, atom); break;
      case '©lyr': tags.lyrics = readText(bytes, atom); break;
      case 'soar': tags.sortArtist = readText(bytes, atom); break;
      case 'soaa': tags.sortAlbumArtist = readText(bytes, atom); break;
      case 'soal': tags.sortAlbum = readText(bytes, atom); break;
      case 'sonm': tags.sortTitle = readText(bytes, atom); break;
      case '©day': {
        const value = readText(bytes, atom);
        tags.date = value;
        tags.year = value.slice(0, 4);
        break;
      }
      case 'tmpo': tags.bpm = readInteger(bytes, atom); break;
      case 'cpil': tags.compilation = readInteger(bytes, atom) === 1; break;
      case 'trkn': {
        const { position, total } = readPositionPair(bytes, atom);
        tags.track = position;
        tags.trackTotal = total;
        break;
      }
      case 'disk': {
        const { position, total } = readPositionPair(bytes, atom);
        tags.disc = position;
        tags.discTotal = total;
        break;
      }
      case 'covr': {
        const data = readData(bytes, atom);
        if (data && data.payload.length > 0) {
          // Type code 13 is JPEG, 14 is PNG.
          tags.picture = {
            mimeType: data.typeCode === 14 ? 'image/png' : 'image/jpeg',
            pictureType: 3,
            bytes: data.payload.slice(),
          };
        }
        break;
      }
      case '----': {
        // Freeform atoms carry their key in a `name` child box.
        const name = findAtom(bytes, atom.contentStart, atom.end, 'name');
        if (!name) break;
        const key = UTF8.decode(bytes.subarray(name.contentStart + 4, name.end))
          .trim()
          .toUpperCase();
        const value = readText(bytes, atom);
        if (!value) break;
        if (key === 'BARCODE') tags.barcode = value;
        else if (key === 'CATALOGNUMBER') tags.catalogNumber = value;
        else if (key === 'ISRC') tags.isrc = value;
        else if (key === 'REPLAYGAIN_TRACK_GAIN') tags.replayGainTrack = value;
        else if (key === 'REPLAYGAIN_ALBUM_GAIN') tags.replayGainAlbum = value;
        break;
      }
      default:
        break;
    }
  }

  return tags;
}
