/**
 * Playlist and cue sheet generation.
 *
 * An M3U preserves the intended running order for players that sort
 * alphabetically. A cue sheet describes the album as one continuous programme,
 * which is what tools that burn discs or split a set expect.
 */

import type { Track } from '../../types.ts';

function escapeForCue(value: string): string {
  // Cue sheets quote strings and have no escape sequence, so an embedded quote
  // has to become something else rather than break the file.
  return value.replace(/"/g, "'");
}

/** Format seconds as the MM:SS:FF frame timing a cue sheet uses (75 fps). */
function toCueTime(seconds: number): string {
  const total = Math.max(0, seconds);
  const minutes = Math.floor(total / 60);
  const remainder = total - minutes * 60;
  const wholeSeconds = Math.floor(remainder);
  const frames = Math.round((remainder - wholeSeconds) * 75);

  // Rounding can push frames to 75, which is not representable.
  if (frames >= 75) {
    return `${String(minutes).padStart(2, '0')}:${String(wholeSeconds + 1).padStart(2, '0')}:00`;
  }

  return [
    String(minutes).padStart(2, '0'),
    String(wholeSeconds).padStart(2, '0'),
    String(frames).padStart(2, '0'),
  ].join(':');
}

export interface PlaylistEntry {
  track: Track;
  /** Path inside the archive, relative to where the playlist is written. */
  relativePath: string;
}

/**
 * Build an extended M3U.
 *
 * The `.m3u8` extension signals UTF-8, which matters the moment a title has an
 * accent in it.
 */
export function buildM3u(entries: PlaylistEntry[], title: string): string {
  const lines = ['#EXTM3U', `#PLAYLIST:${title}`];

  for (const { track, relativePath } of entries) {
    const artist = track.tags.artist || track.tags.albumArtist || 'Unknown Artist';
    const name = track.tags.title || track.fileName;
    const duration = Math.round(track.audio.durationSeconds) || -1;
    lines.push(`#EXTINF:${duration},${artist} - ${name}`);
    lines.push(relativePath);
  }

  // A trailing newline keeps the file well formed for line-based readers.
  return `${lines.join('\n')}\n`;
}

/** Build a cue sheet describing the album as a sequence of indexed tracks. */
export function buildCueSheet(
  entries: PlaylistEntry[],
  album: { name: string; artist: string; genre?: string; year?: string; barcode?: string },
): string {
  const lines: string[] = [];

  if (album.genre) lines.push(`REM GENRE "${escapeForCue(album.genre)}"`);
  if (album.year) lines.push(`REM DATE ${escapeForCue(album.year)}`);
  if (album.barcode) lines.push(`CATALOG ${escapeForCue(album.barcode)}`);

  lines.push(`PERFORMER "${escapeForCue(album.artist || 'Unknown Artist')}"`);
  lines.push(`TITLE "${escapeForCue(album.name || 'Unknown Album')}"`);

  // Each track references its own file, which is how a cue sheet describes a
  // set of individual files rather than one long image.
  entries.forEach(({ track, relativePath }, index) => {
    lines.push(`FILE "${escapeForCue(relativePath)}" MP3`);
    lines.push(`  TRACK ${String(index + 1).padStart(2, '0')} AUDIO`);
    lines.push(`    TITLE "${escapeForCue(track.tags.title || track.fileName)}"`);
    lines.push(
      `    PERFORMER "${escapeForCue(track.tags.artist || album.artist || 'Unknown Artist')}"`,
    );
    if (track.tags.isrc) lines.push(`    ISRC ${escapeForCue(track.tags.isrc)}`);
    // Each file starts at zero because the files are separate.
    lines.push(`    INDEX 01 ${toCueTime(0)}`);
  });

  return `${lines.join('\n')}\n`;
}

/**
 * A plain-text summary of what the export did to each track.
 *
 * Written alongside the audio so the numbers behind the normalization are
 * inspectable later, not just at the moment of export.
 */
export function buildLoudnessReport(
  tracks: Track[],
  settings: { targetLufs: number; mode: string; truePeakCeiling: number },
): string {
  const lines: string[] = [
    'EasyAudio loudness report',
    `Generated ${new Date().toISOString()}`,
    '',
    `Target: ${settings.targetLufs} LUFS (${settings.mode} mode)`,
    `True peak ceiling: ${settings.truePeakCeiling} dBTP`,
    '',
  ];

  const column = (value: string, width: number) => value.padEnd(width);
  const number = (value: number | undefined, digits = 1) =>
    value === undefined || !Number.isFinite(value) ? '-' : value.toFixed(digits);

  lines.push(
    column('Track', 40) +
      column('LUFS in', 10) +
      column('Gain', 9) +
      column('LUFS out', 10) +
      column('Peak out', 10) +
      column('LRA', 7) +
      'DR',
  );
  lines.push('-'.repeat(94));

  for (const track of tracks) {
    const name = `${track.tags.track || '?'}. ${track.tags.title || track.fileName}`;
    lines.push(
      column(name.slice(0, 38), 40) +
        column(number(track.loudness?.integrated), 10) +
        column(
          track.appliedGainDb === undefined
            ? '-'
            : `${track.appliedGainDb >= 0 ? '+' : ''}${track.appliedGainDb.toFixed(1)}`,
          9,
        ) +
        column(number(track.projected?.integrated), 10) +
        column(number(track.projected?.truePeak), 10) +
        column(number(track.loudness?.range), 7) +
        number(track.loudness?.dynamicRange),
    );
  }

  lines.push('');
  lines.push(
    'LUFS is loudness to ITU-R BS.1770-4. Peak is true peak in dBTP, measured',
    'with 4x oversampling. LRA is loudness range in LU. DR is a crest-based',
    'dynamic range figure: lower means more heavily compressed.',
  );

  return `${lines.join('\n')}\n`;
}
