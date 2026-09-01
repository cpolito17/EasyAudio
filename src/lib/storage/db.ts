/**
 * IndexedDB persistence for project state.
 *
 * The audio bytes live in OPFS; this stores everything else, so reopening the
 * tab restores the tags, the album grouping, the loudness measurements and the
 * settings exactly as they were.
 */

import type {
  Album,
  ExportSettings,
  NormalizationSettings,
  Track,
} from '../../types.ts';

const DATABASE_NAME = 'easyaudio';
const DATABASE_VERSION = 1;
const PROJECT_STORE = 'project';
const PROJECT_KEY = 'current';

/** A cover as stored: the object URL is rebuilt on load, never persisted. */
interface StoredCover {
  bytes: Uint8Array;
  mimeType: string;
  width: number;
  height: number;
}

export interface StoredProject {
  version: number;
  savedAt: number;
  tracks: (Omit<Track, 'cover'> & { cover?: StoredCover })[];
  albums: (Omit<Album, 'cover'> & { cover?: StoredCover })[];
  normalization: NormalizationSettings;
  exportSettings: ExportSettings;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(PROJECT_STORE)) {
        database.createObjectStore(PROJECT_STORE);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () =>
      reject(new Error('Another tab is holding the database open.'));
  });
}

/** Strip the object URL, which is meaningless once the page reloads. */
function toStoredCover(
  cover: { bytes: Uint8Array; mimeType: string; width: number; height: number } | undefined,
): StoredCover | undefined {
  if (!cover) return undefined;
  return {
    bytes: cover.bytes,
    mimeType: cover.mimeType,
    width: cover.width,
    height: cover.height,
  };
}

export async function saveProject(project: {
  tracks: Track[];
  albums: Album[];
  normalization: NormalizationSettings;
  exportSettings: ExportSettings;
}): Promise<void> {
  const database = await openDatabase();

  const payload: StoredProject = {
    version: DATABASE_VERSION,
    savedAt: Date.now(),
    tracks: project.tracks.map((track) => ({
      ...track,
      cover: toStoredCover(track.cover),
    })),
    albums: project.albums.map((album) => ({
      ...album,
      cover: toStoredCover(album.cover),
    })),
    normalization: project.normalization,
    exportSettings: project.exportSettings,
  };

  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(PROJECT_STORE, 'readwrite');
    transaction.objectStore(PROJECT_STORE).put(payload, PROJECT_KEY);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });

  database.close();
}

/**
 * Load the saved project, rebuilding the object URLs the covers need.
 *
 * Returns null when there is nothing saved, which is the first-run case.
 */
export async function loadProject(): Promise<{
  tracks: Track[];
  albums: Album[];
  normalization: NormalizationSettings;
  exportSettings: ExportSettings;
  savedAt: number;
} | null> {
  let database: IDBDatabase;
  try {
    database = await openDatabase();
  } catch {
    // Private browsing modes can refuse IndexedDB entirely. The app still
    // works, it just will not remember anything.
    return null;
  }

  const stored = await new Promise<StoredProject | undefined>((resolve, reject) => {
    const transaction = database.transaction(PROJECT_STORE, 'readonly');
    const request = transaction.objectStore(PROJECT_STORE).get(PROJECT_KEY);
    request.onsuccess = () => resolve(request.result as StoredProject | undefined);
    request.onerror = () => reject(request.error);
  });

  database.close();
  if (!stored) return null;

  const restoreCover = (cover: StoredCover | undefined) => {
    if (!cover) return undefined;
    const blob = new Blob([cover.bytes as BlobPart], { type: cover.mimeType });
    return { ...cover, objectUrl: URL.createObjectURL(blob) };
  };

  return {
    tracks: stored.tracks.map((track) => ({
      ...track,
      cover: restoreCover(track.cover),
    })) as Track[],
    albums: stored.albums.map((album) => ({
      ...album,
      cover: restoreCover(album.cover),
    })) as Album[],
    normalization: stored.normalization,
    exportSettings: stored.exportSettings,
    savedAt: stored.savedAt,
  };
}

export async function clearProject(): Promise<void> {
  try {
    const database = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(PROJECT_STORE, 'readwrite');
      transaction.objectStore(PROJECT_STORE).delete(PROJECT_KEY);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  } catch {
    // Nothing saved, nothing to clear.
  }
}
