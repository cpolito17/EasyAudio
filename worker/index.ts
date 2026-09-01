/**
 * EasyAudio Worker.
 *
 * The Worker deliberately does no audio work. Every byte of audio stays in the
 * browser: decoding, loudness analysis, gain application, tag writing and ZIP
 * assembly all run in the user's tab. Cloudflare isolates cap out at 128 MB of
 * memory and request bodies well below album size, so shipping audio here would
 * be slower, more expensive and worse for privacy than doing it locally.
 *
 * What is left for the Worker is the small set of things a browser genuinely
 * cannot do alone: serving the app, and proxying metadata providers that either
 * block cross-origin browser requests or require a shared identifying header.
 */

interface Env {
  ASSETS: Fetcher;
  ACOUSTID_API_KEY?: string;
}

/** MusicBrainz requires a descriptive, contactable User-Agent on every call. */
const MB_USER_AGENT =
  'EasyAudio/0.1 (https://github.com/cpolito17/EasyAudio)';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'public, max-age=3600',
};

function json(body: unknown, status = 200, extra: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...extra },
  });
}

function badRequest(message: string): Response {
  return json({ error: message }, 400);
}

/**
 * Fetch upstream with a bounded timeout so a hanging provider cannot pin the
 * request open until the platform kills it.
 */
async function upstream(url: string, headers: HeadersInit): Promise<Response> {
  const signal = AbortSignal.timeout(10_000);
  return fetch(url, { headers, signal, cf: { cacheTtl: 3600 } });
}

async function searchReleases(query: string, limit: number): Promise<Response> {
  const url =
    'https://musicbrainz.org/ws/2/release/?fmt=json&limit=' +
    encodeURIComponent(String(limit)) +
    '&query=' +
    encodeURIComponent(query);

  const res = await upstream(url, {
    'user-agent': MB_USER_AGENT,
    accept: 'application/json',
  });
  if (!res.ok) {
    return json({ error: `MusicBrainz returned ${res.status}` }, 502);
  }
  return json(await res.json());
}

async function lookupRelease(mbid: string): Promise<Response> {
  // `recordings` gives us the track list; `isrcs` and `labels` fill the fields
  // that separate a tidy library from a merely populated one.
  const inc = 'artist-credits+recordings+labels+isrcs+release-groups+media';
  const url =
    `https://musicbrainz.org/ws/2/release/${encodeURIComponent(mbid)}` +
    `?fmt=json&inc=${inc}`;

  const res = await upstream(url, {
    'user-agent': MB_USER_AGENT,
    accept: 'application/json',
  });
  if (!res.ok) {
    return json({ error: `MusicBrainz returned ${res.status}` }, 502);
  }
  return json(await res.json());
}

/**
 * Cover Art Archive redirects to archive.org, which does not send permissive
 * CORS headers for every asset. Streaming the bytes through the Worker keeps
 * the browser's canvas untainted so we can still resize and re-encode the art.
 */
async function coverArt(mbid: string, size: string): Promise<Response> {
  const suffix = size === 'full' ? '' : `-${size}`;
  const url = `https://coverartarchive.org/release/${encodeURIComponent(mbid)}/front${suffix}`;

  const res = await upstream(url, { accept: 'image/*' });
  if (!res.ok) {
    return json({ error: `No cover art (${res.status})` }, res.status === 404 ? 404 : 502);
  }

  const contentType = res.headers.get('content-type') ?? 'image/jpeg';
  return new Response(res.body, {
    headers: {
      'content-type': contentType,
      'cache-control': 'public, max-age=86400',
    },
  });
}

/**
 * Acoustic fingerprint lookup. Disabled unless an API key is configured, so a
 * fresh deploy degrades to manual and text-search tagging rather than erroring.
 */
async function acoustid(
  env: Env,
  fingerprint: string,
  duration: string,
): Promise<Response> {
  if (!env.ACOUSTID_API_KEY) {
    return json(
      { error: 'Fingerprint lookup is not configured on this deployment.' },
      501,
    );
  }
  const body = new URLSearchParams({
    client: env.ACOUSTID_API_KEY,
    meta: 'recordings releasegroups compress',
    duration,
    fingerprint,
  });
  const res = await upstream('https://api.acoustid.org/v2/lookup?' + body, {
    accept: 'application/json',
  });
  if (!res.ok) {
    return json({ error: `AcoustID returned ${res.status}` }, 502);
  }
  return json(await res.json());
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }

    if (request.method !== 'GET') {
      return json({ error: 'Method not allowed' }, 405, { allow: 'GET' });
    }

    try {
      switch (url.pathname) {
        case '/api/health':
          return json({ ok: true, fingerprinting: Boolean(env.ACOUSTID_API_KEY) });

        case '/api/musicbrainz/search': {
          const query = url.searchParams.get('q');
          if (!query) return badRequest('Missing "q" parameter.');
          const limit = Math.min(
            25,
            Math.max(1, Number(url.searchParams.get('limit') ?? 10) || 10),
          );
          return await searchReleases(query, limit);
        }

        case '/api/musicbrainz/release': {
          const mbid = url.searchParams.get('id');
          if (!mbid) return badRequest('Missing "id" parameter.');
          return await lookupRelease(mbid);
        }

        case '/api/coverart': {
          const mbid = url.searchParams.get('id');
          if (!mbid) return badRequest('Missing "id" parameter.');
          const size = url.searchParams.get('size') ?? '500';
          if (!['250', '500', '1200', 'full'].includes(size)) {
            return badRequest('size must be one of 250, 500, 1200, full.');
          }
          return await coverArt(mbid, size);
        }

        case '/api/acoustid': {
          const fingerprint = url.searchParams.get('fingerprint');
          const duration = url.searchParams.get('duration');
          if (!fingerprint || !duration) {
            return badRequest('Missing "fingerprint" or "duration".');
          }
          return await acoustid(env, fingerprint, duration);
        }

        default:
          return json({ error: 'Not found' }, 404);
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unexpected upstream failure.';
      return json({ error: message }, 502);
    }
  },
} satisfies ExportedHandler<Env>;
