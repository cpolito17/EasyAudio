/**
 * Filename to tag inference.
 *
 * Untagged rips almost always encode their metadata in the filename. Guessing
 * it correctly turns an import from "type everything" into "check and adjust",
 * so the patterns here are ordered most specific first and every match is
 * reported with a confidence the UI can show.
 */

export interface ParsedFileName {
  track?: number;
  disc?: number;
  artist?: string;
  title?: string;
  /** How much of the name the pattern explained. */
  confidence: 'high' | 'medium' | 'low';
}

/** Strip the extension and normalise the separators people actually use. */
function baseName(fileName: string): string {
  const withoutExtension = fileName.replace(/\.[a-z0-9]{1,5}$/i, '');
  return withoutExtension
    // Underscores stand in for spaces in a lot of older rips.
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Remove decoration that carries no metadata. */
function clean(value: string): string {
  return value
    .replace(/^[\s\-.]+|[\s\-.]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const PATTERNS: {
  regex: RegExp;
  confidence: ParsedFileName['confidence'];
  build: (match: RegExpMatchArray) => Omit<ParsedFileName, 'confidence'>;
}[] = [
  {
    // "1-01 - Artist - Title" or "1.01 Artist - Title"
    regex: /^(\d{1,2})[-.](\d{1,2})\s*[-.]?\s*(.+?)\s+-\s+(.+)$/,
    confidence: 'high',
    build: (m) => ({
      disc: Number(m[1]),
      track: Number(m[2]),
      artist: clean(m[3]),
      title: clean(m[4]),
    }),
  },
  {
    // "1-01 Title" or "1.01 Title"
    regex: /^(\d{1,2})[-.](\d{1,2})\s+(.+)$/,
    confidence: 'high',
    build: (m) => ({
      disc: Number(m[1]),
      track: Number(m[2]),
      title: clean(m[3]),
    }),
  },
  {
    // "01 - Artist - Title"
    regex: /^(\d{1,3})\s*[-.)\]]\s*(.+?)\s+-\s+(.+)$/,
    confidence: 'high',
    build: (m) => ({
      track: Number(m[1]),
      artist: clean(m[2]),
      title: clean(m[3]),
    }),
  },
  {
    // "01 - Title" or "01. Title" or "01) Title"
    regex: /^(\d{1,3})\s*[-.)\]]\s*(.+)$/,
    confidence: 'high',
    build: (m) => ({ track: Number(m[1]), title: clean(m[2]) }),
  },
  {
    // "01 Title", with the number separated only by a space.
    regex: /^(\d{1,3})\s+(.+)$/,
    confidence: 'medium',
    build: (m) => ({ track: Number(m[1]), title: clean(m[2]) }),
  },
  {
    // "Artist - Title", no track number.
    regex: /^(.+?)\s+-\s+(.+)$/,
    confidence: 'medium',
    build: (m) => ({ artist: clean(m[1]), title: clean(m[2]) }),
  },
];

/** Infer what a filename is telling us. */
export function parseFileName(fileName: string): ParsedFileName {
  const name = baseName(fileName);

  for (const pattern of PATTERNS) {
    const match = name.match(pattern.regex);
    if (!match) continue;

    const parsed = pattern.build(match);
    // A track number above 99 is far more likely to be a year or a bitrate
    // than a real position, so reject the match rather than write nonsense.
    if (parsed.track !== undefined && (parsed.track < 1 || parsed.track > 199)) {
      continue;
    }
    if (!parsed.title) continue;

    return { ...parsed, confidence: pattern.confidence };
  }

  // Nothing matched, so the whole name is the best available title.
  return { title: clean(name), confidence: 'low' };
}

/**
 * Title-case a string using the conventions used for song titles.
 *
 * Short words stay lowercase unless they open or close the title, and anything
 * the user already capitalised unusually (an acronym, a stylised name) is left
 * alone rather than flattened.
 */
const MINOR_WORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from', 'in', 'into',
  'nor', 'of', 'on', 'onto', 'or', 'over', 'per', 'so', 'the', 'to', 'up',
  'via', 'vs', 'with', 'yet',
]);

export function toTitleCase(input: string): string {
  const words = input.trim().split(/(\s+)/);
  let wordIndex = 0;
  const lastWordIndex = words.filter((w) => w.trim()).length - 1;

  return words
    .map((word) => {
      if (!word.trim()) return word;
      const current = wordIndex++;

      // Preserve deliberate capitalisation: "REM", "iTunes", "DJ Shadow".
      const hasInnerCapital = /[A-Z]/.test(word.slice(1));
      if (hasInnerCapital) return word;

      const lower = word.toLowerCase();
      const isMinor = MINOR_WORDS.has(lower.replace(/[^a-z]/g, ''));

      if (isMinor && current !== 0 && current !== lastWordIndex) return lower;

      // Capitalise after an opening bracket or quote too.
      return lower.replace(/^([^a-z0-9]*)([a-z])/, (_, prefix, letter) =>
        prefix + letter.toUpperCase(),
      );
    })
    .join('');
}

/**
 * Pull a featured artist out of a title.
 *
 * Libraries split an album when the same record has different artist strings
 * per track, so moving "feat. X" out of the artist field and into the title is
 * one of the highest-value clean-ups available.
 */
export interface FeaturedSplit {
  base: string;
  featured: string;
}

const FEATURE_PATTERN =
  /\s*[([]?\s*\b(?:feat|ft|featuring|with)\b\.?\s+([^)\]]+)[)\]]?\s*$/i;

export function splitFeatured(value: string): FeaturedSplit | null {
  const match = value.match(FEATURE_PATTERN);
  if (!match) return null;

  const base = value.slice(0, match.index).trim();
  const featured = match[1].trim();
  if (!base || !featured) return null;

  return { base, featured };
}
