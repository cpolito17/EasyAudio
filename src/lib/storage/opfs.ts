/**
 * Origin Private File System storage for imported audio.
 *
 * Audio is kept on disk rather than in memory for two reasons. A hundred tracks
 * is easily several gigabytes, far past what a tab can hold; and writing them
 * down means the project survives a reload, so closing the tab by accident does
 * not cost an afternoon of tagging.
 *
 * Nothing here leaves the machine. OPFS is private to the origin and invisible
 * to the rest of the filesystem.
 */

const AUDIO_DIRECTORY = 'audio';

async function audioDirectory(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(AUDIO_DIRECTORY, { create: true });
}

export function isOpfsAvailable(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.storage?.getDirectory === 'function'
  );
}

/** Write bytes under `key`, replacing anything already there. */
export async function writeAudio(key: string, bytes: Uint8Array): Promise<void> {
  const directory = await audioDirectory();
  const handle = await directory.getFileHandle(key, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(bytes as unknown as BufferSource);
  } finally {
    await writable.close();
  }
}

/** Read the bytes stored under `key`, or null when they are gone. */
export async function readAudio(key: string): Promise<Uint8Array | null> {
  try {
    const directory = await audioDirectory();
    const handle = await directory.getFileHandle(key);
    const file = await handle.getFile();
    return new Uint8Array(await file.arrayBuffer());
  } catch {
    // A missing entry is expected after the browser clears site data.
    return null;
  }
}

/** Get the stored file directly, which avoids reading it all into memory. */
export async function getAudioFile(key: string): Promise<File | null> {
  try {
    const directory = await audioDirectory();
    const handle = await directory.getFileHandle(key);
    return await handle.getFile();
  } catch {
    return null;
  }
}

export async function deleteAudio(key: string): Promise<void> {
  try {
    const directory = await audioDirectory();
    await directory.removeEntry(key);
  } catch {
    // Already gone is the outcome we wanted.
  }
}

/** Remove stored audio that no live track references any more. */
export async function pruneAudio(liveKeys: Set<string>): Promise<number> {
  let removed = 0;
  try {
    const directory = await audioDirectory();
    const stale: string[] = [];
    // `keys()` is an async iterator over the directory contents.
    for await (const name of (
      directory as unknown as { keys(): AsyncIterableIterator<string> }
    ).keys()) {
      if (!liveKeys.has(name)) stale.push(name);
    }
    for (const name of stale) {
      await directory.removeEntry(name);
      removed++;
    }
  } catch {
    // Pruning is a housekeeping nicety, never worth surfacing as an error.
  }
  return removed;
}

export async function clearAllAudio(): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(AUDIO_DIRECTORY, { recursive: true });
  } catch {
    // Nothing to clear.
  }
}

export interface StorageEstimate {
  usedBytes: number;
  quotaBytes: number;
}

/** How much room the browser is willing to give this origin. */
export async function estimateStorage(): Promise<StorageEstimate | null> {
  if (typeof navigator.storage?.estimate !== 'function') return null;
  const estimate = await navigator.storage.estimate();
  return {
    usedBytes: estimate.usage ?? 0,
    quotaBytes: estimate.quota ?? 0,
  };
}

/**
 * Ask the browser to keep this origin's data.
 *
 * Without persistence, storage can be evicted under pressure and the user
 * returns to an empty project with no explanation.
 */
export async function requestPersistence(): Promise<boolean> {
  if (typeof navigator.storage?.persist !== 'function') return false;
  try {
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}
