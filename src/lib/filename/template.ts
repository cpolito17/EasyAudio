/**
 * Export path templating.
 *
 * The template decides the folder structure inside the ZIP. Every path segment
 * is sanitised independently so a slash in an album title creates a folder the
 * user did not ask for, and so the archive extracts safely on Windows too.
 */

import type { Track } from '../../types.ts';

export const DEFAULT_TEMPLATE =
  '{albumartist}/{album} ({year})/{disc}-{track:02} {title}.{ext}';

export const TEMPLATE_TOKENS = [
  { token: '{albumartist}', description: 'Album artist, falling back to artist' },
  { token: '{artist}', description: 'Track artist' },
  { token: '{album}', description: 'Album title' },
  { token: '{title}', description: 'Track title' },
  { token: '{track}', description: 'Track number' },
  { token: '{track:02}', description: 'Track number, zero padded to 2 digits' },
  { token: '{disc}', description: 'Disc number' },
  { token: '{disc:02}', description: 'Disc number, zero padded' },
  { token: '{year}', description: 'Release year' },
  { token: '{genre}', description: 'Genre' },
  { token: '{ext}', description: 'File extension' },
] as const;

/**
 * Characters Windows forbids in a filename, plus control characters.
 *
 * Being strict here matters: an archive that extracts on macOS but fails on
 * Windows is a bug the user only discovers on someone else's machine.
 */
// eslint-disable-next-line no-control-regex
const ILLEGAL = /[<>:"/\\|?*\x00-\x1f]/g;

/** Names Windows reserves regardless of extension. */
const RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

/** Make one path segment safe, without touching separators. */
export function sanitizeSegment(input: string): string {
  let value = input.replace(ILLEGAL, '-').trim();

  // A trailing dot or space is silently dropped by Windows, which turns two
  // distinct tracks into one filename collision.
  value = value.replace(/[. ]+$/, '');

  if (RESERVED.has(value.toUpperCase())) value = `_${value}`;
  if (!value) value = 'Unknown';

  // Keep well clear of the 255-byte per-component limit on most filesystems.
  if (value.length > 120) value = value.slice(0, 120).trim();

  return value;
}

function pad(value: number, width: number): string {
  return String(Math.max(0, value)).padStart(width, '0');
}

/** Resolve one token against a track. */
function resolveToken(
  token: string,
  modifier: string | undefined,
  track: Track,
  extension: string,
): string {
  const { tags } = track;
  const width = modifier ? Number.parseInt(modifier, 10) || 0 : 0;

  switch (token) {
    case 'albumartist':
      return tags.albumArtist || tags.artist || 'Unknown Artist';
    case 'artist':
      return tags.artist || tags.albumArtist || 'Unknown Artist';
    case 'album':
      return tags.album || 'Unknown Album';
    case 'title':
      return tags.title || 'Untitled';
    case 'track':
      return width ? pad(tags.track, width) : String(tags.track || 0);
    case 'disc':
      return width ? pad(tags.disc || 1, width) : String(tags.disc || 1);
    case 'year':
      return tags.year || tags.date.slice(0, 4) || '';
    case 'genre':
      return tags.genre || '';
    case 'ext':
      return extension;
    default:
      return '';
  }
}

/**
 * Render a template into a ZIP-relative path.
 *
 * Segments that resolve to nothing collapse rather than leaving an empty folder
 * or a stray separator, so a single-disc album with no year still gets a tidy
 * path from the default template.
 */
export function renderPath(
  template: string,
  track: Track,
  extension = 'mp3',
): string {
  const filled = template.replace(
    /\{(\w+)(?::(\d+))?\}/g,
    (_, token: string, modifier: string | undefined) =>
      resolveToken(token.toLowerCase(), modifier, track, extension),
  );

  const segments = filled
    .split('/')
    .map((segment) =>
      // Tidy the artefacts an empty token leaves behind: a dangling " ()"
      // from a missing year, or a leading "-" from a missing disc number.
      segment
        .replace(/\(\s*\)/g, '')
        .replace(/\[\s*\]/g, '')
        .replace(/^\s*-\s*/, '')
        .replace(/\s{2,}/g, ' ')
        .trim(),
    )
    .filter((segment) => segment.length > 0)
    .map(sanitizeSegment);

  if (segments.length === 0) return `${sanitizeSegment(track.fileName)}`;
  return segments.join('/');
}

/**
 * Give every path a unique name.
 *
 * Two tracks with the same title on the same disc would otherwise overwrite
 * each other inside the archive, losing one silently.
 */
export function deduplicatePaths(paths: string[]): string[] {
  const seen = new Map<string, number>();

  return paths.map((path) => {
    const key = path.toLowerCase();
    const count = seen.get(key) ?? 0;
    seen.set(key, count + 1);
    if (count === 0) return path;

    const dot = path.lastIndexOf('.');
    if (dot <= path.lastIndexOf('/')) return `${path} (${count + 1})`;
    return `${path.slice(0, dot)} (${count + 1})${path.slice(dot)}`;
  });
}

/** Preview a template against one track without producing a real export. */
export function previewPath(template: string, track: Track): string {
  try {
    return renderPath(template, track);
  } catch {
    return 'Invalid template';
  }
}
