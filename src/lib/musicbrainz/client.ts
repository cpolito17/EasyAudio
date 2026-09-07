/**
 * MusicBrainz lookup, proxied through the Worker.
 *
 * Text search rather than acoustic fingerprinting: it needs no API key and no
 * WASM, and for a release the user can name it fills in every field including
 * the per-track ISRCs. Fingerprinting is the stronger tool for a folder of
 * unlabelled files, and the Worker already exposes the endpoint for it.
 */

export interface ReleaseCandidate {
  id: string;
  title: string;
  artist: string;
  date: string;
  country: string;
  trackCount: number;
  label: string;
  catalogNumber: string;
  barcode: string;
  /** MusicBrainz match score, 0 to 100. */
  score: number;
  format: string;
}

export interface ReleaseTrack {
  position: number;
  discNumber: number;
  title: string;
  artist: string;
  isrc: string;
  lengthSeconds: number;
}

export interface ReleaseDetail {
  id: string;
  title: string;
  artist: string;
  date: string;
  barcode: string;
  label: string;
  catalogNumber: string;
  discTotal: number;
  tracks: ReleaseTrack[];
}

/** Shape of the pieces of the MusicBrainz response we actually read. */
interface MbArtistCredit {
  name?: string;
  joinphrase?: string;
  artist?: { name?: string };
}

interface MbTrack {
  position?: number;
  number?: string;
  title?: string;
  length?: number;
  'artist-credit'?: MbArtistCredit[];
  recording?: {
    title?: string;
    length?: number;
    isrcs?: string[];
    'artist-credit'?: MbArtistCredit[];
  };
}

interface MbMedium {
  position?: number;
  format?: string;
  'track-count'?: number;
  tracks?: MbTrack[];
}

interface MbLabelInfo {
  'catalog-number'?: string;
  label?: { name?: string };
}

interface MbRelease {
  id: string;
  title?: string;
  date?: string;
  country?: string;
  barcode?: string;
  score?: number;
  'track-count'?: number;
  'artist-credit'?: MbArtistCredit[];
  'label-info'?: MbLabelInfo[];
  media?: MbMedium[];
}

/**
 * Join an artist credit into a single string.
 *
 * The join phrases carry the punctuation, so "A" + " & " + "B" reproduces
 * exactly how the release itself is credited rather than inventing a separator.
 */
function joinCredit(credit: MbArtistCredit[] | undefined): string {
  if (!credit || credit.length === 0) return '';
  return credit
    .map((part) => `${part.name ?? part.artist?.name ?? ''}${part.joinphrase ?? ''}`)
    .join('')
    .trim();
}

const API_BASE = `${import.meta.env.BASE_URL.replace(/\/$/, '')}/api`;
const VISITOR_KEY = 'easyaudio-visitor';

function visitorId(): string {
  let id = localStorage.getItem(VISITOR_KEY);
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
    id = crypto.randomUUID();
    localStorage.setItem(VISITOR_KEY, id);
  }
  return id;
}

function apiPath(path: string): string {
  return `${API_BASE}${path}`;
}

async function request<T>(path: string): Promise<T> {
  const response = await fetch(apiPath(path), {
    headers: {
      accept: 'application/json',
      'x-easyaudio-visitor': visitorId(),
    },
  });
  if (!response.ok) {
    let message = `Lookup failed (${response.status}).`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // Keep the status-based message.
    }
    throw new Error(message);
  }
  return (await response.json()) as T;
}

/** Build a fielded Lucene query, which scores far better than free text. */
function buildQuery(artist: string, album: string, trackCount?: number): string {
  const escape = (value: string) => value.replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, ' ').trim();

  const parts: string[] = [];
  if (album.trim()) parts.push(`release:"${escape(album)}"`);
  if (artist.trim()) parts.push(`artist:"${escape(artist)}"`);
  if (trackCount && trackCount > 0) parts.push(`tracks:${trackCount}`);

  return parts.join(' AND ');
}

export async function searchReleases(
  artist: string,
  album: string,
  trackCount?: number,
): Promise<ReleaseCandidate[]> {
  const query = buildQuery(artist, album, trackCount);
  if (!query) return [];

  const data = await request<{ releases?: MbRelease[] }>(
    `/musicbrainz/search?limit=12&q=${encodeURIComponent(query)}`,
  );

  return (data.releases ?? []).map((release) => {
    const labelInfo = release['label-info']?.[0];
    return {
      id: release.id,
      title: release.title ?? 'Untitled',
      artist: joinCredit(release['artist-credit']),
      date: release.date ?? '',
      country: release.country ?? '',
      trackCount:
        release['track-count'] ??
        (release.media?.reduce(
          (total, medium) => total + (medium['track-count'] ?? 0),
          0,
        ) ||
          0),
      label: labelInfo?.label?.name ?? '',
      catalogNumber: labelInfo?.['catalog-number'] ?? '',
      barcode: release.barcode ?? '',
      score: release.score ?? 0,
      format: release.media?.[0]?.format ?? '',
    };
  });
}

export async function fetchRelease(mbid: string): Promise<ReleaseDetail> {
  const release = await request<MbRelease>(
    `/musicbrainz/release?id=${encodeURIComponent(mbid)}`,
  );

  const albumArtist = joinCredit(release['artist-credit']);
  const media = release.media ?? [];
  const tracks: ReleaseTrack[] = [];

  media.forEach((medium, mediumIndex) => {
    const discNumber = medium.position ?? mediumIndex + 1;
    for (const track of medium.tracks ?? []) {
      const recording = track.recording;
      // A track can override the recording's title and credit, which is how
      // compilations and alternate mixes are represented.
      const title = track.title || recording?.title || '';
      const artist =
        joinCredit(track['artist-credit']) ||
        joinCredit(recording?.['artist-credit']) ||
        albumArtist;
      const lengthMs = track.length ?? recording?.length ?? 0;

      tracks.push({
        position: track.position ?? (Number.parseInt(track.number ?? '0', 10) || 0),
        discNumber,
        title,
        artist,
        isrc: recording?.isrcs?.[0] ?? '',
        lengthSeconds: lengthMs / 1000,
      });
    }
  });

  const labelInfo = release['label-info']?.[0];

  return {
    id: release.id,
    title: release.title ?? '',
    artist: albumArtist,
    date: release.date ?? '',
    barcode: release.barcode ?? '',
    label: labelInfo?.label?.name ?? '',
    catalogNumber: labelInfo?.['catalog-number'] ?? '',
    discTotal: media.length || 1,
    tracks,
  };
}

/** URL for a release's front cover, served through the Worker proxy. */
export function coverArtUrl(mbid: string, size: '250' | '500' | '1200' = '1200'): string {
  return apiPath(`/coverart?id=${encodeURIComponent(mbid)}&size=${size}`);
}

/** Fetch cover art bytes, or null when the release has none. */
export async function fetchCoverArt(mbid: string): Promise<Blob | null> {
  const response = await fetch(coverArtUrl(mbid), {
    headers: { 'x-easyaudio-visitor': visitorId() },
  });
  if (!response.ok) return null;
  return response.blob();
}
