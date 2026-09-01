/**
 * FLAC and Ogg metadata readers.
 *
 * Both store tags as Vorbis comments: a vendor string followed by a list of
 * "FIELD=value" entries in UTF-8, with little-endian lengths. FLAC additionally
 * defines a PICTURE metadata block for cover art; Ogg embeds the same structure
 * base64-encoded inside a METADATA_BLOCK_PICTURE comment.
 */

import type { ParsedTags, RawPicture } from './types.ts';
import { emptyParsedTags } from './types.ts';

const UTF8 = new TextDecoder('utf-8');

/** Parse the PICTURE block payload shared by FLAC and Ogg. */
function readPictureBlock(bytes: Uint8Array): RawPicture | null {
  if (bytes.length < 32) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let cursor = 0;
  const pictureType = view.getUint32(cursor);
  cursor += 4;

  const mimeLength = view.getUint32(cursor);
  cursor += 4;
  if (cursor + mimeLength > bytes.length) return null;
  const mimeType = UTF8.decode(bytes.subarray(cursor, cursor + mimeLength));
  cursor += mimeLength;

  const descriptionLength = view.getUint32(cursor);
  cursor += 4 + descriptionLength;

  // Width, height, colour depth and indexed-colour count, none of which we need
  // because the image itself is authoritative.
  cursor += 16;

  if (cursor + 4 > bytes.length) return null;
  const dataLength = view.getUint32(cursor);
  cursor += 4;
  if (cursor + dataLength > bytes.length) return null;

  return {
    mimeType: mimeType || 'image/jpeg',
    pictureType,
    bytes: bytes.slice(cursor, cursor + dataLength),
  };
}

/** Apply one "FIELD=value" comment to the accumulating tag set. */
function applyComment(tags: ParsedTags, entry: string): void {
  const separator = entry.indexOf('=');
  if (separator < 1) return;

  const key = entry.slice(0, separator).trim().toUpperCase();
  const value = entry.slice(separator + 1).trim();
  if (!value) return;

  switch (key) {
    case 'TITLE': tags.title = value; break;
    case 'ARTIST': tags.artist = value; break;
    case 'ALBUMARTIST':
    case 'ALBUM ARTIST': tags.albumArtist = value; break;
    case 'ALBUM': tags.album = value; break;
    case 'GENRE': tags.genre = value; break;
    case 'COMPOSER': tags.composer = value; break;
    case 'COMMENT':
    case 'DESCRIPTION': tags.comment = value; break;
    case 'LYRICS':
    case 'UNSYNCEDLYRICS': tags.lyrics = value; break;
    case 'PUBLISHER':
    case 'LABEL': tags.publisher = value; break;
    case 'ISRC': tags.isrc = value; break;
    case 'BARCODE': tags.barcode = value; break;
    case 'CATALOGNUMBER': tags.catalogNumber = value; break;
    case 'ARTISTSORT': tags.sortArtist = value; break;
    case 'ALBUMARTISTSORT': tags.sortAlbumArtist = value; break;
    case 'ALBUMSORT': tags.sortAlbum = value; break;
    case 'TITLESORT': tags.sortTitle = value; break;
    case 'REPLAYGAIN_TRACK_GAIN': tags.replayGainTrack = value; break;
    case 'REPLAYGAIN_ALBUM_GAIN': tags.replayGainAlbum = value; break;
    case 'BPM': tags.bpm = Number.parseInt(value, 10) || 0; break;
    case 'COMPILATION': tags.compilation = value === '1' || value.toLowerCase() === 'true'; break;
    case 'TRACKNUMBER': {
      // Some taggers write "3/12" here rather than using TRACKTOTAL.
      const [position, total] = value.split('/');
      tags.track = Number.parseInt(position, 10) || 0;
      if (total) tags.trackTotal = Number.parseInt(total, 10) || 0;
      break;
    }
    case 'TRACKTOTAL':
    case 'TOTALTRACKS':
      tags.trackTotal = Number.parseInt(value, 10) || 0;
      break;
    case 'DISCNUMBER': {
      const [position, total] = value.split('/');
      tags.disc = Number.parseInt(position, 10) || 0;
      if (total) tags.discTotal = Number.parseInt(total, 10) || 0;
      break;
    }
    case 'DISCTOTAL':
    case 'TOTALDISCS':
      tags.discTotal = Number.parseInt(value, 10) || 0;
      break;
    case 'DATE':
      tags.date = value;
      tags.year = value.slice(0, 4);
      break;
    case 'YEAR':
      if (!tags.year) tags.year = value.slice(0, 4);
      break;
    case 'ORIGINALDATE':
    case 'ORIGINALYEAR':
      tags.originalDate = value;
      break;
    case 'METADATA_BLOCK_PICTURE': {
      try {
        const binary = atob(value);
        const decoded = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) decoded[i] = binary.charCodeAt(i);
        const picture = readPictureBlock(decoded);
        if (picture && (!tags.picture || picture.pictureType === 3)) {
          tags.picture = picture;
        }
      } catch {
        // A malformed image must not cost us the rest of the tags.
      }
      break;
    }
    default:
      break;
  }
}

/** Read the comment list at `offset`, returning how far it extended. */
function readVorbisComments(
  tags: ParsedTags,
  bytes: Uint8Array,
  offset: number,
  limit: number,
): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let cursor = offset;

  if (cursor + 4 > limit) return;
  const vendorLength = view.getUint32(cursor, true);
  cursor += 4 + vendorLength;

  if (cursor + 4 > limit) return;
  const count = view.getUint32(cursor, true);
  cursor += 4;

  for (let i = 0; i < count; i++) {
    if (cursor + 4 > limit) return;
    const length = view.getUint32(cursor, true);
    cursor += 4;
    if (cursor + length > limit) return;
    applyComment(tags, UTF8.decode(bytes.subarray(cursor, cursor + length)));
    cursor += length;
  }
}

export interface FlacStreamInfo {
  sampleRate: number;
  channels: number;
  totalSamples: number;
}

export interface FlacReadResult {
  tags: ParsedTags;
  streamInfo?: FlacStreamInfo;
}

export function readFlacTags(bytes: Uint8Array): FlacReadResult | null {
  // "fLaC"
  if (bytes.length < 8 || bytes[0] !== 0x66 || bytes[1] !== 0x4c ||
      bytes[2] !== 0x61 || bytes[3] !== 0x43) {
    return null;
  }

  const tags = emptyParsedTags();
  let streamInfo: FlacStreamInfo | undefined;
  let cursor = 4;

  while (cursor + 4 <= bytes.length) {
    const isLast = (bytes[cursor] & 0x80) !== 0;
    const blockType = bytes[cursor] & 0x7f;
    const length = (bytes[cursor + 1] << 16) | (bytes[cursor + 2] << 8) | bytes[cursor + 3];
    cursor += 4;
    if (cursor + length > bytes.length) break;

    if (blockType === 0 && length >= 18) {
      // STREAMINFO packs sample rate, channels and sample count into a bit
      // field starting 10 bytes in.
      const b = bytes.subarray(cursor, cursor + 18);
      const sampleRate = (b[10] << 12) | (b[11] << 4) | (b[12] >> 4);
      const channels = ((b[12] >> 1) & 0x07) + 1;
      const totalSamples =
        ((b[13] & 0x0f) * 0x1_0000_0000) +
        (b[14] << 24 >>> 0) + (b[15] << 16) + (b[16] << 8) + b[17];
      streamInfo = { sampleRate, channels, totalSamples };
    } else if (blockType === 4) {
      readVorbisComments(tags, bytes, cursor, cursor + length);
    } else if (blockType === 6) {
      const picture = readPictureBlock(bytes.subarray(cursor, cursor + length));
      if (picture && (!tags.picture || picture.pictureType === 3)) {
        tags.picture = picture;
      }
    }

    cursor += length;
    if (isLast) break;
  }

  return { tags, streamInfo };
}

/** Read Vorbis comments from an Ogg stream (Vorbis or Opus). */
export function readOggTags(bytes: Uint8Array): ParsedTags | null {
  // "OggS"
  if (bytes.length < 4 || bytes[0] !== 0x4f || bytes[1] !== 0x67 ||
      bytes[2] !== 0x67 || bytes[3] !== 0x53) {
    return null;
  }

  const tags = emptyParsedTags();
  let cursor = 0;
  // The comment header lives in the first few pages; scanning the whole file
  // for it would be wasteful on a large lossless stream.
  const searchLimit = Math.min(bytes.length, 512 * 1024);

  while (cursor + 27 <= searchLimit) {
    if (bytes[cursor] !== 0x4f || bytes[cursor + 1] !== 0x67 ||
        bytes[cursor + 2] !== 0x67 || bytes[cursor + 3] !== 0x53) {
      cursor++;
      continue;
    }

    const segmentCount = bytes[cursor + 26];
    const segmentTable = cursor + 27;
    if (segmentTable + segmentCount > bytes.length) break;

    let payloadLength = 0;
    for (let i = 0; i < segmentCount; i++) payloadLength += bytes[segmentTable + i];

    const payload = segmentTable + segmentCount;
    if (payload + payloadLength > bytes.length) break;

    // Vorbis comment headers start with 0x03 "vorbis"; Opus uses "OpusTags".
    if (payloadLength > 7 && bytes[payload] === 0x03 &&
        String.fromCharCode(...bytes.subarray(payload + 1, payload + 7)) === 'vorbis') {
      readVorbisComments(tags, bytes, payload + 7, payload + payloadLength);
      return tags;
    }
    if (payloadLength > 8 &&
        String.fromCharCode(...bytes.subarray(payload, payload + 8)) === 'OpusTags') {
      readVorbisComments(tags, bytes, payload + 8, payload + payloadLength);
      return tags;
    }

    cursor = payload + payloadLength;
  }

  return tags;
}
