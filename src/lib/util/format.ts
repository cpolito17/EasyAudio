/** Display formatting shared across the interface. */

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '-';
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  const remainder = total % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    return `${hours}:${String(minutes % 60).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
  }
  return `${minutes}:${String(remainder).padStart(2, '0')}`;
}

/** A loudness or level figure, with a dash for the silent case. */
export function formatDb(value: number | undefined, digits = 1): string {
  if (value === undefined || !Number.isFinite(value)) return '-';
  return value.toFixed(digits);
}

/** A gain, always signed so the direction is unambiguous. */
export function formatGain(value: number | undefined, digits = 1): string {
  if (value === undefined || !Number.isFinite(value)) return '-';
  if (Math.abs(value) < 0.05) return '0.0';
  return `${value > 0 ? '+' : ''}${value.toFixed(digits)}`;
}

export function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return '-';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatSampleRate(rate: number): string {
  if (!rate) return '-';
  return `${(rate / 1000).toFixed(rate % 1000 === 0 ? 0 : 1)} kHz`;
}

/** Total playing time of a set of tracks. */
export function formatTotalTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0 min';
  // Below a minute, rounding to minutes reads as "0 min", which looks broken.
  if (seconds < 60) return `${Math.round(seconds)} sec`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} hr ${minutes % 60} min`;
}
