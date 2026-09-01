/**
 * Format detection and metadata dispatch.
 *
 * Detection is by content signature rather than file extension, because a file
 * named `.mp3` that is actually an M4A is common enough to matter and would
 * otherwise produce empty tags with no explanation.
 */

import type { AudioSourceFormat } from '../../types.ts';
import { readId3 } from './id3-read.ts';
import { readMp4Tags } from './mp4-read.ts';
import { readFlacTags, readOggTags } from './flac-read.ts';
import type { ParsedTags } from './types.ts';
import { emptyParsedTags } from './types.ts';
import { id3v2Length } from '../mp3/frames.ts';

function matchesAscii(bytes: Uint8Array, offset: number, text: string): boolean {
  if (offset + text.length > bytes.length) return false;
  for (let i = 0; i < text.length; i++) {
    if (bytes[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

export function detectFormat(bytes: Uint8Array): AudioSourceFormat {
  if (matchesAscii(bytes, 0, 'fLaC')) return 'flac';
  if (matchesAscii(bytes, 0, 'OggS')) return 'ogg';
  if (matchesAscii(bytes, 0, 'RIFF') && matchesAscii(bytes, 8, 'WAVE')) return 'wav';
  // MP4 family: a `ftyp` box sits at offset 4 of the first atom.
  if (matchesAscii(bytes, 4, 'ftyp')) return 'mp4';

  // MP3 either starts with an ID3v2 tag or straight into a frame sync. Skipping
  // the tag first avoids mistaking tag payload for audio.
  const afterTag = id3v2Length(bytes);
  if (afterTag > 0 && afterTag < bytes.length) {
    if (bytes[afterTag] === 0xff && (bytes[afterTag + 1] & 0xe0) === 0xe0) return 'mp3';
    // A tag with unusual padding still means we are almost certainly on MP3.
    return 'mp3';
  }
  if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return 'mp3';

  return 'other';
}

export interface ReadTagsResult {
  format: AudioSourceFormat;
  tags: ParsedTags;
}

/** Read whatever metadata the file carries, whatever container it is in. */
export function readTags(bytes: Uint8Array): ReadTagsResult {
  const format = detectFormat(bytes);

  try {
    switch (format) {
      case 'mp3': {
        const parsed = readId3(bytes);
        return { format, tags: parsed ?? emptyParsedTags() };
      }
      case 'mp4': {
        return { format, tags: readMp4Tags(bytes) ?? emptyParsedTags() };
      }
      case 'flac': {
        const result = readFlacTags(bytes);
        return { format, tags: result?.tags ?? emptyParsedTags() };
      }
      case 'ogg': {
        return { format, tags: readOggTags(bytes) ?? emptyParsedTags() };
      }
      default: {
        // WAV occasionally carries an ID3 chunk, and unknown containers
        // sometimes lead with one. It costs almost nothing to look.
        const parsed = readId3(bytes);
        return { format, tags: parsed ?? emptyParsedTags() };
      }
    }
  } catch {
    // A corrupt tag should never block an import. The user can still edit the
    // fields by hand, and the audit will flag what is missing.
    return { format, tags: emptyParsedTags() };
  }
}
