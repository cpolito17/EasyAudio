/**
 * Application state.
 *
 * The store holds tags, grouping, measurements and settings; it never holds
 * audio. Audio lives in OPFS and is read back one track at a time, which is
 * what keeps a hundred-track project inside a tab's memory budget.
 */

import { create } from 'zustand';

import type {
  Album,
  AuditFinding,
  CoverImage,
  ExportSettings,
  NormalizationSettings,
  Track,
  TrackTags,
} from '../types.ts';
import { readTags } from '../lib/tags/read-any.ts';
import { parseMp3 } from '../lib/mp3/frames.ts';
import { parseFileName } from '../lib/filename/parse.ts';
import { DEFAULT_TEMPLATE } from '../lib/filename/template.ts';
import { analyzeFile } from '../lib/workers/analyzer.ts';
import { auditTracks, auditCover } from '../lib/audit/audit.ts';
import { coverFromBytes, releaseCover, processCover } from '../lib/art/cover.ts';
import {
  writeAudio,
  readAudio,
  deleteAudio,
  pruneAudio,
  requestPersistence,
} from '../lib/storage/opfs.ts';
import { saveProject, loadProject, clearProject } from '../lib/storage/db.ts';
import { buildPlan, LOUDNESS_TARGETS, type NormalizationPlan } from '../lib/export/plan.ts';

function emptyTags(): TrackTags {
  return {
    title: '', artist: '', albumArtist: '', album: '',
    track: 0, trackTotal: 0, disc: 0, discTotal: 0,
    year: '', date: '', originalDate: '', genre: '', composer: '',
    comment: '', lyrics: '', bpm: 0, publisher: '', isrc: '',
    barcode: '', catalogNumber: '',
    sortArtist: '', sortAlbumArtist: '', sortAlbum: '', sortTitle: '',
    compilation: false,
  };
}

export const DEFAULT_NORMALIZATION: NormalizationSettings = {
  enabled: true,
  targetId: 'spotify',
  targetLufs: -14,
  truePeakCeiling: -2,
  mode: 'album',
  preferGainReduction: false,
  writeReplayGainTags: true,
};

export const DEFAULT_EXPORT: ExportSettings = {
  bitrateKbps: 320,
  pathTemplate: DEFAULT_TEMPLATE,
  embedArt: true,
  writeFolderJpg: true,
  writeM3u: true,
  writeCueSheet: false,
  artMaxEdge: 1000,
  artQuality: 0.88,
};

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter}`;
}

/** Key under which an album groups its tracks. */
function albumKey(tags: TrackTags): string {
  const artist = (tags.albumArtist || tags.artist || 'Unknown Artist').trim().toLowerCase();
  const album = (tags.album || 'Unknown Album').trim().toLowerCase();
  return `${artist}::${album}`;
}

export interface ImportProgress {
  active: boolean;
  completed: number;
  total: number;
  label: string;
}

interface StoreState {
  tracks: Track[];
  albums: Album[];
  selectedTrackIds: string[];
  activeAlbumId: string | null;
  normalization: NormalizationSettings;
  exportSettings: ExportSettings;
  importProgress: ImportProgress;
  findings: Map<string, AuditFinding[]>;
  coverFindings: AuditFinding[];
  restored: boolean;
  storageWarning: string | null;

  importFiles: (files: File[]) => Promise<void>;
  removeTracks: (ids: string[]) => Promise<void>;
  clearAll: () => Promise<void>;

  selectTracks: (ids: string[]) => void;
  toggleTrackSelection: (id: string, additive: boolean, range: boolean) => void;
  setActiveAlbum: (id: string | null) => void;

  updateTags: (ids: string[], patch: Partial<TrackTags>) => void;
  updateEdits: (id: string, patch: Partial<Track['edits']>) => void;
  reorderTracks: (albumId: string, orderedIds: string[]) => void;
  moveTracksToAlbum: (trackIds: string[], albumId: string) => void;
  renumberAlbum: (albumId: string) => void;
  moveTracksToNewAlbum: (trackIds: string[], name: string, artist: string) => void;

  setAlbumCover: (albumId: string, source: Blob) => Promise<void>;
  clearAlbumCover: (albumId: string) => void;
  updateAlbum: (albumId: string, patch: Partial<Omit<Album, 'id' | 'trackIds'>>) => void;

  setNormalization: (patch: Partial<NormalizationSettings>) => void;
  setExportSettings: (patch: Partial<ExportSettings>) => void;

  analyzeAll: (force?: boolean) => Promise<void>;
  restore: () => Promise<void>;
  persist: () => Promise<void>;
  refreshAudit: () => void;
}

/** Build a track record from an imported file. */
async function buildTrack(file: File): Promise<Track> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const { format, tags: parsed } = readTags(bytes);

  const tags = emptyTags();
  Object.assign(tags, {
    title: parsed.title,
    artist: parsed.artist,
    albumArtist: parsed.albumArtist,
    album: parsed.album,
    track: parsed.track,
    trackTotal: parsed.trackTotal,
    disc: parsed.disc,
    discTotal: parsed.discTotal,
    year: parsed.year,
    date: parsed.date,
    originalDate: parsed.originalDate,
    genre: parsed.genre,
    composer: parsed.composer,
    comment: parsed.comment,
    lyrics: parsed.lyrics,
    bpm: parsed.bpm,
    publisher: parsed.publisher,
    isrc: parsed.isrc,
    barcode: parsed.barcode,
    catalogNumber: parsed.catalogNumber,
    sortArtist: parsed.sortArtist,
    sortAlbumArtist: parsed.sortAlbumArtist,
    sortAlbum: parsed.sortAlbum,
    sortTitle: parsed.sortTitle,
    compilation: parsed.compilation,
  });

  // Fill the gaps from the filename. Existing tags always win: a real tag is
  // better evidence than a guess, however confident the guess.
  const guessed = parseFileName(file.name);
  if (!tags.title && guessed.title) tags.title = guessed.title;
  if (!tags.artist && guessed.artist) tags.artist = guessed.artist;
  if (!tags.track && guessed.track) tags.track = guessed.track;
  if (!tags.disc && guessed.disc) tags.disc = guessed.disc;

  const storageKey = nextId('audio');
  await writeAudio(storageKey, bytes);

  // MP3 gives us bitrate and duration cheaply from the frame headers, before
  // any decoding, which makes the import list useful immediately.
  let sampleRate = 0;
  let channels = 0;
  let durationSeconds = 0;
  let bitrateKbps = 0;
  let losslessGainEligible = false;

  if (format === 'mp3') {
    const info = parseMp3(bytes);
    if (info) {
      sampleRate = info.sampleRate;
      channels = info.channels;
      durationSeconds = info.durationSeconds;
      bitrateKbps = info.averageBitrateKbps;
      losslessGainEligible = true;
    }
  }

  let cover: CoverImage | undefined;
  if (parsed.picture) {
    cover = (await coverFromBytes(parsed.picture.bytes, parsed.picture.mimeType)) ?? undefined;
  }

  return {
    id: nextId('track'),
    fileName: file.name,
    fileSize: file.size,
    status: 'ready',
    tags,
    audio: {
      sampleRate,
      channels,
      durationSeconds,
      bitrateKbps,
      format,
      losslessGainEligible,
    },
    edits: { trimStart: 0, trimEnd: 0, fadeIn: 0, fadeOut: 0 },
    cover,
    findings: [],
    storageKey,
  };
}

/** Sort tracks the way an album should read: by disc, then track, then title. */
function trackOrder(a: Track, b: Track): number {
  if ((a.tags.disc || 1) !== (b.tags.disc || 1)) {
    return (a.tags.disc || 1) - (b.tags.disc || 1);
  }
  if (a.tags.track !== b.tags.track) {
    // Unnumbered tracks sort after numbered ones rather than jumping to the top.
    if (a.tags.track === 0) return 1;
    if (b.tags.track === 0) return -1;
    return a.tags.track - b.tags.track;
  }
  return (a.tags.title || a.fileName).localeCompare(b.tags.title || b.fileName);
}

export const useStore = create<StoreState>((set, get) => ({
  tracks: [],
  albums: [],
  selectedTrackIds: [],
  activeAlbumId: null,
  normalization: DEFAULT_NORMALIZATION,
  exportSettings: DEFAULT_EXPORT,
  importProgress: { active: false, completed: 0, total: 0, label: '' },
  findings: new Map(),
  coverFindings: [],
  restored: false,
  storageWarning: null,

  async importFiles(files) {
    if (files.length === 0) return;

    await requestPersistence();

    set({
      importProgress: { active: true, completed: 0, total: files.length, label: '' },
    });

    const created: Track[] = [];

    for (let index = 0; index < files.length; index++) {
      const file = files[index];
      set({
        importProgress: {
          active: true,
          completed: index,
          total: files.length,
          label: file.name,
        },
      });

      try {
        created.push(await buildTrack(file));
      } catch (error) {
        // One unreadable file must not abort a hundred-file import.
        created.push({
          id: nextId('track'),
          fileName: file.name,
          fileSize: file.size,
          status: 'failed',
          error: error instanceof Error ? error.message : 'Could not read this file.',
          tags: emptyTags(),
          audio: {
            sampleRate: 0, channels: 0, durationSeconds: 0,
            bitrateKbps: 0, format: 'other', losslessGainEligible: false,
          },
          edits: { trimStart: 0, trimEnd: 0, fadeIn: 0, fadeOut: 0 },
          findings: [],
          storageKey: '',
        });
      }

      // Let the progress indicator paint between files.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const tracks = [...get().tracks, ...created];
    const albums = [...get().albums];

    // Group new tracks into albums by artist and album title.
    for (const track of created) {
      if (track.status === 'failed') continue;
      const key = albumKey(track.tags);
      const artist = track.tags.albumArtist || track.tags.artist || 'Unknown Artist';
      const name = track.tags.album || 'Unknown Album';

      let album = albums.find(
        (candidate) =>
          `${candidate.albumArtist.trim().toLowerCase()}::${candidate.name.trim().toLowerCase()}` === key,
      );

      if (!album) {
        album = {
          id: nextId('album'),
          name,
          albumArtist: artist,
          year: track.tags.year,
          genre: track.tags.genre,
          cover: track.cover,
          trackIds: [],
        };
        albums.push(album);
      }
      album.trackIds.push(track.id);
      if (!album.cover && track.cover) album.cover = track.cover;
    }

    // Put each album in reading order.
    for (const album of albums) {
      const members = album.trackIds
        .map((id) => tracks.find((track) => track.id === id))
        .filter((track): track is Track => Boolean(track));
      members.sort(trackOrder);
      album.trackIds = members.map((track) => track.id);
    }

    set({
      tracks,
      albums,
      activeAlbumId: get().activeAlbumId ?? albums[0]?.id ?? null,
      importProgress: { active: false, completed: files.length, total: files.length, label: '' },
    });

    get().refreshAudit();
    void get().persist();
    void get().analyzeAll();
  },

  async removeTracks(ids) {
    const removing = new Set(ids);
    const tracks = get().tracks.filter((track) => {
      if (!removing.has(track.id)) return true;
      releaseCover(track.cover);
      if (track.storageKey) void deleteAudio(track.storageKey);
      return false;
    });

    const albums = get()
      .albums.map((album) => ({
        ...album,
        trackIds: album.trackIds.filter((id) => !removing.has(id)),
      }))
      .filter((album) => album.trackIds.length > 0);

    set({
      tracks,
      albums,
      selectedTrackIds: get().selectedTrackIds.filter((id) => !removing.has(id)),
      activeAlbumId: albums.some((album) => album.id === get().activeAlbumId)
        ? get().activeAlbumId
        : (albums[0]?.id ?? null),
    });

    get().refreshAudit();
    void get().persist();
  },

  async clearAll() {
    for (const track of get().tracks) releaseCover(track.cover);
    for (const album of get().albums) releaseCover(album.cover);

    set({
      tracks: [],
      albums: [],
      selectedTrackIds: [],
      activeAlbumId: null,
      findings: new Map(),
      coverFindings: [],
    });

    await pruneAudio(new Set());
    await clearProject();
  },

  selectTracks(ids) {
    set({ selectedTrackIds: ids });
  },

  toggleTrackSelection(id, additive, range) {
    const { selectedTrackIds, tracks, albums, activeAlbumId } = get();

    if (range && selectedTrackIds.length > 0) {
      // Shift-click extends from the last selection through the visible order.
      const album = albums.find((candidate) => candidate.id === activeAlbumId);
      const order = album
        ? album.trackIds
        : tracks.map((track) => track.id);
      const anchor = order.indexOf(selectedTrackIds[selectedTrackIds.length - 1]);
      const target = order.indexOf(id);
      if (anchor >= 0 && target >= 0) {
        const [from, to] = anchor < target ? [anchor, target] : [target, anchor];
        set({ selectedTrackIds: order.slice(from, to + 1) });
        return;
      }
    }

    if (additive) {
      set({
        selectedTrackIds: selectedTrackIds.includes(id)
          ? selectedTrackIds.filter((candidate) => candidate !== id)
          : [...selectedTrackIds, id],
      });
      return;
    }

    set({ selectedTrackIds: [id] });
  },

  setActiveAlbum(id) {
    set({ activeAlbumId: id, selectedTrackIds: [] });
  },

  updateTags(ids, patch) {
    const targets = new Set(ids);

    set({
      tracks: get().tracks.map((track) =>
        targets.has(track.id) ? { ...track, tags: { ...track.tags, ...patch } } : track,
      ),
    });

    // Renaming the album on every track of an album has to move the album
    // record too, or the grouping and the tags drift apart and the export
    // ends up in a folder named after the old title.
    const touchesAlbumIdentity =
      patch.album !== undefined ||
      patch.albumArtist !== undefined ||
      patch.year !== undefined ||
      patch.genre !== undefined;

    if (touchesAlbumIdentity) {
      set({
        albums: get().albums.map((album) => {
          const coversWholeAlbum =
            album.trackIds.length > 0 &&
            album.trackIds.every((id) => targets.has(id));
          if (!coversWholeAlbum) return album;
          return {
            ...album,
            name: patch.album ?? album.name,
            albumArtist: patch.albumArtist ?? album.albumArtist,
            year: patch.year ?? album.year,
            genre: patch.genre ?? album.genre,
          };
        }),
      });
    }

    get().refreshAudit();
    void get().persist();
  },

  updateEdits(id, patch) {
    set({
      tracks: get().tracks.map((track) =>
        track.id === id ? { ...track, edits: { ...track.edits, ...patch } } : track,
      ),
    });
    void get().persist();
  },

  reorderTracks(albumId, orderedIds) {
    set({
      albums: get().albums.map((album) =>
        album.id === albumId ? { ...album, trackIds: orderedIds } : album,
      ),
    });
    void get().persist();
  },

  moveTracksToAlbum(trackIds, albumId) {
    const moving = new Set(trackIds);
    const target = get().albums.find((album) => album.id === albumId);
    if (!target) return;

    const albums = get().albums.map((album) => {
      if (album.id === albumId) {
        const existing = album.trackIds.filter((id) => !moving.has(id));
        return { ...album, trackIds: [...existing, ...trackIds] };
      }
      return { ...album, trackIds: album.trackIds.filter((id) => !moving.has(id)) };
    });

    // Adopt the destination album's whole identity, not just its title. Year
    // and genre matter because the export path template uses them: a track that
    // keeps a blank year lands in "Album" while its siblings are in
    // "Album (2024)", splitting one release across two folders.
    const tracks = get().tracks.map((track) =>
      moving.has(track.id)
        ? {
            ...track,
            tags: {
              ...track.tags,
              album: target.name,
              albumArtist: target.albumArtist,
              year: target.year || track.tags.year,
              genre: track.tags.genre || target.genre,
            },
          }
        : track,
    );

    set({
      tracks,
      albums: albums.filter((album) => album.trackIds.length > 0),
    });
    get().refreshAudit();
    void get().persist();
  },

  moveTracksToNewAlbum(trackIds, name, artist) {
    const moving = new Set(trackIds);
    const album: Album = {
      id: nextId('album'),
      name,
      albumArtist: artist,
      year: '',
      genre: '',
      trackIds: [...trackIds],
    };

    const albums = get()
      .albums.map((candidate) => ({
        ...candidate,
        trackIds: candidate.trackIds.filter((id) => !moving.has(id)),
      }))
      .filter((candidate) => candidate.trackIds.length > 0);

    set({
      albums: [...albums, album],
      tracks: get().tracks.map((track) =>
        moving.has(track.id)
          ? { ...track, tags: { ...track.tags, album: name, albumArtist: artist } }
          : track,
      ),
      activeAlbumId: album.id,
    });

    get().refreshAudit();
    void get().persist();
  },

  renumberAlbum(albumId) {
    const album = get().albums.find((candidate) => candidate.id === albumId);
    if (!album) return;

    const total = album.trackIds.length;
    const positions = new Map(album.trackIds.map((id, index) => [id, index + 1]));

    set({
      tracks: get().tracks.map((track) => {
        const position = positions.get(track.id);
        if (position === undefined) return track;
        return {
          ...track,
          tags: {
            ...track.tags,
            track: position,
            trackTotal: total,
            disc: track.tags.disc || 1,
            discTotal: track.tags.discTotal || 1,
          },
        };
      }),
    });
    get().refreshAudit();
    void get().persist();
  },

  async setAlbumCover(albumId, source) {
    const { cover } = await processCover(source, {
      maxEdge: Math.max(get().exportSettings.artMaxEdge, 1000),
      quality: 0.92,
    });

    const previous = get().albums.find((album) => album.id === albumId)?.cover;
    releaseCover(previous);

    set({
      albums: get().albums.map((album) =>
        album.id === albumId ? { ...album, cover } : album,
      ),
    });
    get().refreshAudit();
    void get().persist();
  },

  clearAlbumCover(albumId) {
    const previous = get().albums.find((album) => album.id === albumId)?.cover;
    releaseCover(previous);
    set({
      albums: get().albums.map((album) =>
        album.id === albumId ? { ...album, cover: undefined } : album,
      ),
    });
    get().refreshAudit();
    void get().persist();
  },

  updateAlbum(albumId, patch) {
    const album = get().albums.find((candidate) => candidate.id === albumId);
    if (!album) return;

    const members = new Set(album.trackIds);

    // Renaming an album has to move with its tracks, or the export splits it.
    const tagPatch: Partial<TrackTags> = {};
    if (patch.name !== undefined) tagPatch.album = patch.name;
    if (patch.albumArtist !== undefined) tagPatch.albumArtist = patch.albumArtist;
    if (patch.year !== undefined) tagPatch.year = patch.year;
    if (patch.genre !== undefined) tagPatch.genre = patch.genre;

    set({
      albums: get().albums.map((candidate) =>
        candidate.id === albumId ? { ...candidate, ...patch } : candidate,
      ),
      tracks:
        Object.keys(tagPatch).length > 0
          ? get().tracks.map((track) =>
              members.has(track.id)
                ? { ...track, tags: { ...track.tags, ...tagPatch } }
                : track,
            )
          : get().tracks,
    });
    get().refreshAudit();
    void get().persist();
  },

  setNormalization(patch) {
    const next = { ...get().normalization, ...patch };

    // Selecting a named target moves the level and the ceiling together, so the
    // pair always stays coherent.
    if (patch.targetId && patch.targetId !== 'custom') {
      const preset = LOUDNESS_TARGETS.find((target) => target.id === patch.targetId);
      if (preset) {
        next.targetLufs = preset.lufs;
        next.truePeakCeiling = preset.ceiling;
      }
    } else if (patch.targetLufs !== undefined || patch.truePeakCeiling !== undefined) {
      next.targetId = 'custom';
    }

    set({ normalization: next });
    void get().persist();
  },

  setExportSettings(patch) {
    set({ exportSettings: { ...get().exportSettings, ...patch } });
    void get().persist();
  },

  async analyzeAll(force = false) {
    const pending = get().tracks.filter(
      (track) =>
        track.status !== 'failed' &&
        track.storageKey &&
        (force || !track.loudness),
    );
    if (pending.length === 0) return;

    for (const track of pending) {
      set({
        tracks: get().tracks.map((candidate) =>
          candidate.id === track.id ? { ...candidate, status: 'analyzing' } : candidate,
        ),
      });

      try {
        const bytes = await readAudio(track.storageKey);
        if (!bytes) throw new Error('The stored audio is missing.');

        const result = await analyzeFile(track.id, bytes);

        set({
          tracks: get().tracks.map((candidate) =>
            candidate.id === track.id
              ? {
                  ...candidate,
                  status: 'analyzed',
                  loudness: result.report,
                  audio: {
                    ...candidate.audio,
                    sampleRate: result.sampleRate || candidate.audio.sampleRate,
                    channels: result.channels || candidate.audio.channels,
                    durationSeconds:
                      result.durationSeconds || candidate.audio.durationSeconds,
                  },
                }
              : candidate,
          ),
        });
      } catch (error) {
        set({
          tracks: get().tracks.map((candidate) =>
            candidate.id === track.id
              ? {
                  ...candidate,
                  status: 'failed',
                  error:
                    error instanceof Error
                      ? error.message
                      : 'This file could not be decoded.',
                }
              : candidate,
          ),
        });
      }

      get().refreshAudit();
    }

    void get().persist();
  },

  refreshAudit() {
    const { tracks, albums, activeAlbumId } = get();
    const findings = auditTracks(tracks);

    const album = albums.find((candidate) => candidate.id === activeAlbumId) ?? albums[0];
    const coverFindings = album
      ? auditCover(album.cover, album.trackIds.length)
      : [];

    set({ findings, coverFindings });
  },

  async restore() {
    const saved = await loadProject();
    if (!saved) {
      set({ restored: true });
      return;
    }

    set({
      tracks: saved.tracks,
      albums: saved.albums,
      normalization: saved.normalization,
      exportSettings: saved.exportSettings,
      activeAlbumId: saved.albums[0]?.id ?? null,
      restored: true,
    });

    // Drop any stored audio the restored project no longer references.
    await pruneAudio(new Set(saved.tracks.map((track) => track.storageKey)));
    get().refreshAudit();
  },

  async persist() {
    const { tracks, albums, normalization, exportSettings } = get();
    try {
      await saveProject({ tracks, albums, normalization, exportSettings });
      if (get().storageWarning) set({ storageWarning: null });
    } catch (error) {
      set({
        storageWarning:
          error instanceof Error
            ? `Could not save the project: ${error.message}`
            : 'Could not save the project to browser storage.',
      });
    }
  },
}));

/** Tracks belonging to the album currently on screen, in running order. */
export function useActiveTracks(): Track[] {
  const tracks = useStore((state) => state.tracks);
  const albums = useStore((state) => state.albums);
  const activeAlbumId = useStore((state) => state.activeAlbumId);

  const album = albums.find((candidate) => candidate.id === activeAlbumId);
  if (!album) return tracks;

  return album.trackIds
    .map((id) => tracks.find((track) => track.id === id))
    .filter((track): track is Track => Boolean(track));
}

export function useActiveAlbum(): Album | undefined {
  const albums = useStore((state) => state.albums);
  const activeAlbumId = useStore((state) => state.activeAlbumId);
  return albums.find((candidate) => candidate.id === activeAlbumId);
}

/** The current normalization plan for the active album. */
export function usePlan(tracks: Track[]): NormalizationPlan {
  const normalization = useStore((state) => state.normalization);
  return buildPlan(tracks, normalization);
}
