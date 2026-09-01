/**
 * ID3v2.3 writer.
 *
 * v2.3 rather than v2.4 is a deliberate compatibility choice: it is the version
 * every player understands, including the older and stranger ones. v2.4's
 * genuine improvements (UTF-8, TDRC timestamps) are not worth a file that some
 * target refuses to read.
 */

import {
  ByteWriter,
  encodeLatin1,
  encodeUtf16WithBom,
  isLatin1Safe,
  writeSyncSafe,
} from '../util/bytes.ts';
import type { TrackTags } from '../../types.ts';

export interface Id3WriteOptions {
  tags: TrackTags;
  cover?: { bytes: Uint8Array; mimeType: string };
  /** ReplayGain values to publish as TXXX frames, in dB. */
  replayGainTrackDb?: number;
  replayGainAlbumDb?: number;
  /** Peak values as a linear ratio, per the ReplayGain 2.0 specification. */
  replayGainTrackPeak?: number;
  replayGainAlbumPeak?: number;
  /** Bytes of padding left after the tag for in-place edits by other tools. */
  padding?: number;
}

/**
 * Encode a text payload, preferring Latin-1 and falling back to UTF-16.
 *
 * v2.3 offers only those two, so anything outside Latin-1 (an accent, a
 * non-Latin script, a typographic apostrophe) has to widen the whole frame.
 */
function encodeText(text: string): Uint8Array {
  if (isLatin1Safe(text)) {
    const body = encodeLatin1(text);
    const out = new Uint8Array(body.length + 2);
    out[0] = 0x00; // ISO-8859-1
    out.set(body, 1);
    out[out.length - 1] = 0x00;
    return out;
  }

  const body = encodeUtf16WithBom(text);
  const out = new Uint8Array(body.length + 3);
  out[0] = 0x01; // UTF-16 with BOM
  out.set(body, 1);
  // Wide encodings need a two-byte terminator.
  out[out.length - 2] = 0x00;
  out[out.length - 1] = 0x00;
  return out;
}

interface Frame {
  id: string;
  data: Uint8Array;
}

function textFrame(id: string, value: string): Frame | null {
  const text = value.trim();
  if (!text) return null;
  return { id, data: encodeText(text) };
}

/** COMM and USLT share a layout: encoding, language, description, then text. */
function longTextFrame(id: string, value: string): Frame | null {
  const text = value.trim();
  if (!text) return null;

  const wide = !isLatin1Safe(text);
  const writer = new ByteWriter(text.length * 2 + 16);
  writer.u8(wide ? 0x01 : 0x00);
  writer.ascii('eng');
  // Empty content descriptor, terminated in the frame's own encoding.
  if (wide) {
    writer.bytes(new Uint8Array([0xff, 0xfe, 0x00, 0x00]));
    writer.bytes(encodeUtf16WithBom(text));
  } else {
    writer.u8(0x00);
    writer.bytes(encodeLatin1(text));
  }
  return { id, data: writer.finish() };
}

function userTextFrame(key: string, value: string): Frame | null {
  if (!value) return null;

  const wide = !isLatin1Safe(key) || !isLatin1Safe(value);
  const writer = new ByteWriter(64);
  writer.u8(wide ? 0x01 : 0x00);
  if (wide) {
    writer.bytes(encodeUtf16WithBom(key));
    writer.bytes(new Uint8Array([0x00, 0x00]));
    writer.bytes(encodeUtf16WithBom(value));
  } else {
    writer.bytes(encodeLatin1(key));
    writer.u8(0x00);
    writer.bytes(encodeLatin1(value));
  }
  return { id: 'TXXX', data: writer.finish() };
}

function pictureFrame(bytes: Uint8Array, mimeType: string): Frame {
  const writer = new ByteWriter(bytes.length + 64);
  writer.u8(0x00); // Description is ISO-8859-1.
  writer.bytes(encodeLatin1(mimeType));
  writer.u8(0x00);
  writer.u8(0x03); // Picture type 3: front cover.
  writer.u8(0x00); // Empty description.
  writer.bytes(bytes);
  return { id: 'APIC', data: writer.finish() };
}

/** Format a position as "3/12", or just "3" when the total is unknown. */
function position(value: number, total: number): string {
  if (value <= 0 && total <= 0) return '';
  if (total > 0) return `${value}/${total}`;
  return String(value);
}

/** ReplayGain values are conventionally written to two decimal places. */
function formatGain(db: number): string {
  return `${db >= 0 ? '+' : ''}${db.toFixed(2)} dB`;
}

/** Build a complete ID3v2.3 tag. */
export function buildId3(options: Id3WriteOptions): Uint8Array {
  const { tags, cover, padding = 1024 } = options;

  const frames: (Frame | null)[] = [
    textFrame('TIT2', tags.title),
    textFrame('TPE1', tags.artist),
    textFrame('TPE2', tags.albumArtist),
    textFrame('TALB', tags.album),
    textFrame('TRCK', position(tags.track, tags.trackTotal)),
    textFrame('TPOS', position(tags.disc, tags.discTotal)),
    textFrame('TCON', tags.genre),
    textFrame('TCOM', tags.composer),
    textFrame('TPUB', tags.publisher),
    textFrame('TSRC', tags.isrc),
    textFrame('TSOP', tags.sortArtist),
    textFrame('TSO2', tags.sortAlbumArtist),
    textFrame('TSOA', tags.sortAlbum),
    textFrame('TSOT', tags.sortTitle),
    tags.bpm > 0 ? textFrame('TBPM', String(Math.round(tags.bpm))) : null,
    // TCMP is the iTunes compilation flag. Writing "0" is pointless noise, so
    // the frame only appears when the album really is a compilation.
    tags.compilation ? textFrame('TCMP', '1') : null,
    longTextFrame('COMM', tags.comment),
    longTextFrame('USLT', tags.lyrics),
    userTextFrame('BARCODE', tags.barcode.trim()),
    userTextFrame('CATALOGNUMBER', tags.catalogNumber.trim()),
  ];

  // Year and date. v2.3 splits them: TYER holds the year, TDAT holds DDMM.
  const year = (tags.year || tags.date.slice(0, 4)).trim();
  if (/^\d{4}$/.test(year)) {
    frames.push(textFrame('TYER', year));
    const match = tags.date.match(/^\d{4}-(\d{2})-(\d{2})/);
    if (match) frames.push(textFrame('TDAT', `${match[2]}${match[1]}`));
  }

  const originalYear = tags.originalDate.slice(0, 4);
  if (/^\d{4}$/.test(originalYear) && originalYear !== year) {
    frames.push(textFrame('TORY', originalYear));
  }

  if (options.replayGainTrackDb !== undefined) {
    frames.push(
      userTextFrame('REPLAYGAIN_TRACK_GAIN', formatGain(options.replayGainTrackDb)),
    );
  }
  if (options.replayGainTrackPeak !== undefined) {
    frames.push(
      userTextFrame('REPLAYGAIN_TRACK_PEAK', options.replayGainTrackPeak.toFixed(6)),
    );
  }
  if (options.replayGainAlbumDb !== undefined) {
    frames.push(
      userTextFrame('REPLAYGAIN_ALBUM_GAIN', formatGain(options.replayGainAlbumDb)),
    );
  }
  if (options.replayGainAlbumPeak !== undefined) {
    frames.push(
      userTextFrame('REPLAYGAIN_ALBUM_PEAK', options.replayGainAlbumPeak.toFixed(6)),
    );
  }

  // Art goes last so a player streaming the tag reaches the text fields first.
  if (cover && cover.bytes.length > 0) {
    frames.push(pictureFrame(cover.bytes, cover.mimeType));
  }

  const body = new ByteWriter(4096);
  for (const frame of frames) {
    if (!frame) continue;
    body.ascii(frame.id);
    body.u32(frame.data.length);
    body.u16(0x0000); // No frame flags.
    body.bytes(frame.data);
  }

  const bodyBytes = body.finish();
  const totalSize = bodyBytes.length + padding;

  const tag = new ByteWriter(totalSize + 10);
  tag.ascii('ID3');
  tag.u8(3).u8(0); // Version 2.3.0
  tag.u8(0x00); // No unsynchronisation, no extended header.
  writeSyncSafe(tag, totalSize);
  tag.bytes(bodyBytes);
  tag.bytes(new Uint8Array(padding));

  return tag.finish();
}
