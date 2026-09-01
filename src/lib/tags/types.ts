/** Shared shape produced by every container's metadata reader. */

export interface RawPicture {
  mimeType: string;
  /** ID3 picture type. 3 is the front cover. */
  pictureType: number;
  bytes: Uint8Array;
}

export interface ParsedTags {
  title: string;
  artist: string;
  albumArtist: string;
  album: string;
  track: number;
  trackTotal: number;
  disc: number;
  discTotal: number;
  year: string;
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
  sortArtist: string;
  sortAlbumArtist: string;
  sortAlbum: string;
  sortTitle: string;
  compilation: boolean;
  /** ReplayGain as found in the source, e.g. "-6.94 dB". */
  replayGainTrack: string;
  replayGainAlbum: string;
  picture?: RawPicture;
}

export function emptyParsedTags(): ParsedTags {
  return {
    title: '',
    artist: '',
    albumArtist: '',
    album: '',
    track: 0,
    trackTotal: 0,
    disc: 0,
    discTotal: 0,
    year: '',
    date: '',
    originalDate: '',
    genre: '',
    composer: '',
    comment: '',
    lyrics: '',
    bpm: 0,
    publisher: '',
    isrc: '',
    barcode: '',
    catalogNumber: '',
    sortArtist: '',
    sortAlbumArtist: '',
    sortAlbum: '',
    sortTitle: '',
    compilation: false,
    replayGainTrack: '',
    replayGainAlbum: '',
  };
}
