/**
 * ID3v2 reader covering v2.2, v2.3 and v2.4.
 *
 * Real-world files are inconsistent, so this reads defensively: an unknown or
 * malformed frame is skipped rather than aborting the whole tag, because half a
 * tag is far more useful to the user than none.
 */

import { decodeId3Text, readSyncSafe } from '../util/bytes.ts';
import type { ParsedTags, RawPicture } from './types.ts';
import { emptyParsedTags } from './types.ts';

/** ID3v1 genre table, needed because TCON often stores a numeric reference. */
const ID3V1_GENRES = [
  'Blues', 'Classic Rock', 'Country', 'Dance', 'Disco', 'Funk', 'Grunge',
  'Hip-Hop', 'Jazz', 'Metal', 'New Age', 'Oldies', 'Other', 'Pop', 'R&B',
  'Rap', 'Reggae', 'Rock', 'Techno', 'Industrial', 'Alternative', 'Ska',
  'Death Metal', 'Pranks', 'Soundtrack', 'Euro-Techno', 'Ambient', 'Trip-Hop',
  'Vocal', 'Jazz+Funk', 'Fusion', 'Trance', 'Classical', 'Instrumental',
  'Acid', 'House', 'Game', 'Sound Clip', 'Gospel', 'Noise', 'Alt. Rock',
  'Bass', 'Soul', 'Punk', 'Space', 'Meditative', 'Instrumental Pop',
  'Instrumental Rock', 'Ethnic', 'Gothic', 'Darkwave', 'Techno-Industrial',
  'Electronic', 'Pop-Folk', 'Eurodance', 'Dream', 'Southern Rock', 'Comedy',
  'Cult', 'Gangsta Rap', 'Top 40', 'Christian Rap', 'Pop/Funk', 'Jungle',
  'Native American', 'Cabaret', 'New Wave', 'Psychedelic', 'Rave',
  'Showtunes', 'Trailer', 'Lo-Fi', 'Tribal', 'Acid Punk', 'Acid Jazz',
  'Polka', 'Retro', 'Musical', 'Rock & Roll', 'Hard Rock',
];

/** Expand "(17)" or "17" into the genre it references. */
function normaliseGenre(raw: string): string {
  const text = raw.trim();
  if (!text) return '';

  const parenthesised = text.match(/^\((\d+)\)\s*(.*)$/);
  if (parenthesised) {
    const remainder = parenthesised[2].trim();
    if (remainder) return remainder;
    return ID3V1_GENRES[Number(parenthesised[1])] ?? '';
  }

  if (/^\d+$/.test(text)) return ID3V1_GENRES[Number(text)] ?? text;
  return text;
}

/** Split "3/12" into its two halves. */
function splitPosition(raw: string): { position: number; total: number } {
  const [position, total] = raw.split('/');
  return {
    position: Number.parseInt(position, 10) || 0,
    total: Number.parseInt(total ?? '', 10) || 0,
  };
}

/**
 * Reverse ID3 unsynchronisation, which inserts a zero byte after every 0xFF so
 * a tag can never contain something a decoder mistakes for an MPEG frame sync.
 */
function removeUnsynchronisation(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length);
  let written = 0;
  for (let i = 0; i < bytes.length; i++) {
    out[written++] = bytes[i];
    if (bytes[i] === 0xff && bytes[i + 1] === 0x00) i++;
  }
  return out.subarray(0, written);
}

/** Read a NUL-terminated string in the given ID3 text encoding. */
function readTerminated(
  data: Uint8Array,
  start: number,
  encoding: number,
): { text: string; next: number } {
  const wide = encoding === 1 || encoding === 2;

  if (wide) {
    for (let i = start; i + 1 < data.length; i += 2) {
      if (data[i] === 0 && data[i + 1] === 0) {
        return {
          text: decodeId3Text(encoding, data.subarray(start, i)),
          next: i + 2,
        };
      }
    }
  } else {
    for (let i = start; i < data.length; i++) {
      if (data[i] === 0) {
        return {
          text: decodeId3Text(encoding, data.subarray(start, i)),
          next: i + 1,
        };
      }
    }
  }

  return {
    text: decodeId3Text(encoding, data.subarray(start)),
    next: data.length,
  };
}

function readTextFrame(data: Uint8Array): string {
  if (data.length === 0) return '';
  const encoding = data[0];
  // Multi-value frames are NUL separated in v2.4; the first value is the one
  // users mean, and joining them would corrupt round trips.
  const { text } = readTerminated(data, 1, encoding);
  return text.trim();
}

function readCommentFrame(data: Uint8Array): string {
  if (data.length < 4) return '';
  const encoding = data[0];
  // Skip the three-byte language code, then the short description.
  const { next } = readTerminated(data, 4, encoding);
  return decodeId3Text(encoding, data.subarray(next)).trim();
}

function readUserTextFrame(data: Uint8Array): { key: string; value: string } {
  if (data.length === 0) return { key: '', value: '' };
  const encoding = data[0];
  const { text: key, next } = readTerminated(data, 1, encoding);
  return {
    key: key.trim().toUpperCase(),
    value: decodeId3Text(encoding, data.subarray(next)).trim(),
  };
}

function readPictureFrame(data: Uint8Array, majorVersion: number): RawPicture | null {
  if (data.length < 4) return null;
  const encoding = data[0];

  let cursor = 1;
  let mimeType: string;

  if (majorVersion === 2) {
    // v2.2 stores a three-character format code instead of a MIME type.
    const format = String.fromCharCode(data[1], data[2], data[3]).toUpperCase();
    mimeType = format === 'PNG' ? 'image/png' : 'image/jpeg';
    cursor = 4;
  } else {
    const mime = readTerminated(data, 1, 0);
    mimeType = mime.text.trim() || 'image/jpeg';
    if (!mimeType.includes('/')) {
      mimeType = mimeType.toLowerCase() === 'png' ? 'image/png' : 'image/jpeg';
    }
    cursor = mime.next;
  }

  const pictureType = data[cursor];
  cursor += 1;

  const description = readTerminated(data, cursor, encoding);
  cursor = description.next;

  if (cursor >= data.length) return null;

  return {
    mimeType,
    pictureType,
    bytes: data.slice(cursor),
  };
}

/** Frame identifiers, normalised so v2.2 and v2.3+ share one switch. */
const V22_TO_V23: Record<string, string> = {
  TT2: 'TIT2', TP1: 'TPE1', TP2: 'TPE2', TAL: 'TALB', TRK: 'TRCK',
  TPA: 'TPOS', TYE: 'TYER', TCO: 'TCON', TCM: 'TCOM', TBP: 'TBPM',
  TPB: 'TPUB', TRC: 'TSRC', COM: 'COMM', ULT: 'USLT', PIC: 'APIC',
  TSP: 'TSOP', TSA: 'TSOA', TST: 'TSOT', TCP: 'TCMP', TXX: 'TXXX',
};

export interface Id3ReadResult extends ParsedTags {
  /** Total byte length of the tag, so callers can find the audio. */
  tagLength: number;
}

/** Parse the ID3v2 tag at the start of `bytes`, if there is one. */
export function readId3(bytes: Uint8Array): Id3ReadResult | null {
  if (bytes.length < 10) return null;
  if (bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return null;

  const majorVersion = bytes[3];
  if (majorVersion < 2 || majorVersion > 4) return null;

  const flags = bytes[5];
  const unsynchronised = (flags & 0x80) !== 0;
  const hasExtendedHeader = (flags & 0x40) !== 0;
  const hasFooter = (flags & 0x10) !== 0;

  const declaredSize = readSyncSafe(bytes, 6);
  const tagLength = 10 + declaredSize + (hasFooter ? 10 : 0);

  let body = bytes.subarray(10, Math.min(10 + declaredSize, bytes.length));
  if (unsynchronised) body = removeUnsynchronisation(body);

  const tags = emptyParsedTags();
  const pictures: RawPicture[] = [];

  let cursor = 0;

  if (hasExtendedHeader && body.length >= 4) {
    // v2.4 sizes the extended header syncsafe; v2.3 uses a plain integer that
    // excludes its own four size bytes.
    const size =
      majorVersion === 4
        ? readSyncSafe(body, 0)
        : ((body[0] << 24) | (body[1] << 16) | (body[2] << 8) | body[3]) + 4;
    cursor = Math.min(size, body.length);
  }

  const idLength = majorVersion === 2 ? 3 : 4;
  const headerLength = majorVersion === 2 ? 6 : 10;

  while (cursor + headerLength <= body.length) {
    let id = '';
    for (let i = 0; i < idLength; i++) {
      id += String.fromCharCode(body[cursor + i]);
    }
    // A run of zero bytes is padding, which legitimately ends the frame list.
    if (id.charCodeAt(0) === 0) break;

    let size: number;
    if (majorVersion === 2) {
      size = (body[cursor + 3] << 16) | (body[cursor + 4] << 8) | body[cursor + 5];
    } else if (majorVersion === 4) {
      size = readSyncSafe(body, cursor + 4);
    } else {
      size =
        (body[cursor + 4] << 24) |
        (body[cursor + 5] << 16) |
        (body[cursor + 6] << 8) |
        body[cursor + 7];
    }

    let frameFlags = 0;
    if (majorVersion > 2) {
      frameFlags = (body[cursor + 8] << 8) | body[cursor + 9];
    }

    if (size <= 0 || cursor + headerLength + size > body.length) break;

    let data = body.subarray(cursor + headerLength, cursor + headerLength + size);
    cursor += headerLength + size;

    // Compressed or encrypted frames are rare and not worth decoding; skipping
    // one still leaves the rest of the tag usable.
    const compressed = majorVersion === 4 ? (frameFlags & 0x0008) !== 0 : (frameFlags & 0x0080) !== 0;
    const encrypted = majorVersion === 4 ? (frameFlags & 0x0004) !== 0 : (frameFlags & 0x0040) !== 0;
    if (compressed || encrypted) continue;

    // A v2.4 frame can carry its own unsynchronisation flag.
    if (majorVersion === 4 && (frameFlags & 0x0002) !== 0) {
      data = removeUnsynchronisation(data);
    }
    // A data-length indicator prefixes the payload with four extra bytes.
    if (majorVersion === 4 && (frameFlags & 0x0001) !== 0 && data.length > 4) {
      data = data.subarray(4);
    }

    const normalised = majorVersion === 2 ? (V22_TO_V23[id] ?? id) : id;

    switch (normalised) {
      case 'TIT2': tags.title = readTextFrame(data); break;
      case 'TPE1': tags.artist = readTextFrame(data); break;
      case 'TPE2': tags.albumArtist = readTextFrame(data); break;
      case 'TALB': tags.album = readTextFrame(data); break;
      case 'TCOM': tags.composer = readTextFrame(data); break;
      case 'TPUB': tags.publisher = readTextFrame(data); break;
      case 'TSRC': tags.isrc = readTextFrame(data); break;
      case 'TCON': tags.genre = normaliseGenre(readTextFrame(data)); break;
      case 'TSOP': tags.sortArtist = readTextFrame(data); break;
      case 'TSO2': tags.sortAlbumArtist = readTextFrame(data); break;
      case 'TSOA': tags.sortAlbum = readTextFrame(data); break;
      case 'TSOT': tags.sortTitle = readTextFrame(data); break;
      case 'COMM': tags.comment = readCommentFrame(data); break;
      case 'USLT': tags.lyrics = readCommentFrame(data); break;

      case 'TRCK': {
        const { position, total } = splitPosition(readTextFrame(data));
        tags.track = position;
        tags.trackTotal = total;
        break;
      }
      case 'TPOS': {
        const { position, total } = splitPosition(readTextFrame(data));
        tags.disc = position;
        tags.discTotal = total;
        break;
      }
      case 'TBPM':
        tags.bpm = Number.parseInt(readTextFrame(data), 10) || 0;
        break;
      case 'TCMP':
        tags.compilation = readTextFrame(data).trim() === '1';
        break;

      case 'TYER':
        tags.year = readTextFrame(data).slice(0, 4);
        break;
      case 'TDRC': {
        // v2.4 replaces TYER with a full ISO 8601 timestamp.
        const value = readTextFrame(data);
        tags.date = value;
        tags.year = value.slice(0, 4);
        break;
      }
      case 'TDOR':
        tags.originalDate = readTextFrame(data);
        break;
      case 'TORY':
        tags.originalDate = readTextFrame(data).slice(0, 4);
        break;

      case 'APIC': {
        const picture = readPictureFrame(data, majorVersion);
        if (picture) pictures.push(picture);
        break;
      }

      case 'TXXX': {
        const { key, value } = readUserTextFrame(data);
        if (!value) break;
        if (key === 'BARCODE') tags.barcode = value;
        else if (key === 'CATALOGNUMBER') tags.catalogNumber = value;
        else if (key === 'REPLAYGAIN_TRACK_GAIN') tags.replayGainTrack = value;
        else if (key === 'REPLAYGAIN_ALBUM_GAIN') tags.replayGainAlbum = value;
        break;
      }

      default:
        break;
    }
  }

  // Prefer the designated front cover when a file carries several images.
  if (pictures.length > 0) {
    tags.picture = pictures.find((p) => p.pictureType === 3) ?? pictures[0];
  }

  if (!tags.year && tags.date) tags.year = tags.date.slice(0, 4);

  return { ...tags, tagLength };
}
