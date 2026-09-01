/** Metadata fields we can read, edit and write back out. */
export interface TrackTags {
  title: string;
  artist: string;
  albumArtist: string;
  album: string;
  /** Track position within its disc. 0 means "unset". */
  track: number;
  trackTotal: number;
  disc: number;
  discTotal: number;
  year: string;
  /** Full release date when known, ISO-ish (YYYY-MM-DD). */
  date: string;
  originalDate: string;
  genre: string;
  composer: string;
  comment: string;
  lyrics: string;
  bpm: number;
  publisher: string;
  isrc: string;
  barcode: string;
  catalogNumber: string;
  /** Sort-order overrides so "The Beatles" files under B. */
  sortArtist: string;
  sortAlbumArtist: string;
  sortAlbum: string;
  sortTitle: string;
  /** iTunes-style compilation flag (TCMP). Splits or joins albums in libraries. */
  compilation: boolean;
}

/** Result of an EBU R128 / ITU-R BS.1770-4 analysis pass. */
export interface LoudnessReport {
  /** Integrated loudness, LUFS. -Infinity for silence. */
  integrated: number;
  /** Loudness range, LU. */
  range: number;
  /** True peak, dBTP (4x oversampled). */
  truePeak: number;
  /** Highest raw sample value, dBFS. */
  samplePeak: number;
  /** Count of samples at or beyond full scale in the source. */
  clippedSamples: number;
  /** Crest-style dynamic range figure, dB. Higher means less compressed. */
  dynamicRange: number;
}

export type AudioSourceFormat = 'mp3' | 'mp4' | 'flac' | 'ogg' | 'wav' | 'other';

export interface CoverImage {
  /** Data as stored, already normalised to JPEG or PNG. */
  bytes: Uint8Array;
  mimeType: string;
  width: number;
  height: number;
  /** Object URL for display. Revoked when the cover is replaced. */
  objectUrl: string;
}

export type AuditCode =
  | 'low-bitrate'
  | 'mixed-sample-rate'
  | 'already-clipped'
  | 'possible-duplicate'
  | 'missing-title'
  | 'missing-artist'
  | 'oversized-art'
  | 'non-square-art'
  | 'no-art'
  | 'decode-failed';

export interface AuditFinding {
  code: AuditCode;
  severity: 'info' | 'warning' | 'error';
  message: string;
}

export interface TrackAudioInfo {
  sampleRate: number;
  channels: number;
  durationSeconds: number;
  /** Average bitrate in kbps as delivered by the source file. */
  bitrateKbps: number;
  format: AudioSourceFormat;
  /** True when the source is a plain MP3 we can gain-adjust losslessly. */
  losslessGainEligible: boolean;
}

export interface TrackEdits {
  /** Seconds of silence to remove from the head. 0 disables. */
  trimStart: number;
  trimEnd: number;
  fadeIn: number;
  fadeOut: number;
}

export type TrackStatus =
  | 'importing'
  | 'ready'
  | 'analyzing'
  | 'analyzed'
  | 'failed';

export interface Track {
  id: string;
  fileName: string;
  fileSize: number;
  status: TrackStatus;
  error?: string;
  tags: TrackTags;
  audio: TrackAudioInfo;
  edits: TrackEdits;
  /** Analysis of the file as imported. */
  loudness?: LoudnessReport;
  /** Predicted analysis after the current normalization settings are applied. */
  projected?: LoudnessReport;
  /** Gain in dB that normalization will apply. */
  appliedGainDb?: number;
  /** Per-track art. Falls back to the album cover when absent. */
  cover?: CoverImage;
  findings: AuditFinding[];
  /** OPFS key holding the original bytes. */
  storageKey: string;
}

export interface Album {
  id: string;
  name: string;
  albumArtist: string;
  year: string;
  genre: string;
  cover?: CoverImage;
  trackIds: string[];
}

export type LoudnessTargetId =
  | 'spotify'
  | 'spotify-loud'
  | 'spotify-quiet'
  | 'apple'
  | 'youtube'
  | 'broadcast'
  | 'custom';

export interface NormalizationSettings {
  enabled: boolean;
  targetId: LoudnessTargetId;
  /** Target integrated loudness in LUFS. */
  targetLufs: number;
  /** True-peak ceiling in dBTP. */
  truePeakCeiling: number;
  /** Album mode keeps the relative levels between tracks intact. */
  mode: 'album' | 'track';
  /**
   * When true, a track that would clip is turned down rather than limited.
   * When false, a true-peak limiter holds the ceiling and keeps the loudness.
   */
  preferGainReduction: boolean;
  /** Write ReplayGain 2.0 tags alongside whatever we do to the samples. */
  writeReplayGainTags: boolean;
}

export interface ExportSettings {
  /** Output bitrate for tracks that must be re-encoded. */
  bitrateKbps: number;
  pathTemplate: string;
  /** Embed cover art in every file. */
  embedArt: boolean;
  /** Also write folder.jpg beside the audio. */
  writeFolderJpg: boolean;
  writeM3u: boolean;
  writeCueSheet: boolean;
  /** Longest edge of embedded art, in pixels. */
  artMaxEdge: number;
  artQuality: number;
}

export interface ExportProgress {
  phase: 'idle' | 'analyzing' | 'processing' | 'packaging' | 'done' | 'failed';
  completed: number;
  total: number;
  currentLabel: string;
  error?: string;
}
