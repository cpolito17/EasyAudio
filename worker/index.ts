/**
 * EasyAudio's Worker serves the app and proxies public metadata providers.
 * Audio bytes never enter the Worker; all decoding, analysis, tag writing and
 * ZIP assembly stay in the browser.
 */

const APP_PREFIX = '/easyaudio';
const CANONICAL_ORIGIN = 'https://charliepolito.com';
const MB_USER_AGENT =
  'EasyAudio/1.0 (+https://github.com/cpolito17/EasyAudio; https://charliepolito.com/easyaudio/)';
const MBID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VISITOR_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface RuntimeEnv {
  ASSETS: Fetcher;
  API_USER_LIMITER: RateLimit;
  API_IP_LIMITER: RateLimit;
  ACOUSTID_API_KEY?: string;
}

const BASE_SECURITY_HEADERS: Record<string, string> = {
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
};

const HTML_CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  'upgrade-insecure-requests',
].join('; ');

function json(body: unknown, status = 200, extra: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': status >= 400 ? 'no-store' : 'public, max-age=3600',
      ...BASE_SECURITY_HEADERS,
      ...extra,
    },
  });
}

function badRequest(message: string): Response {
  return json({ error: message }, 400);
}

function secureAsset(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(BASE_SECURITY_HEADERS)) {
    headers.set(name, value);
  }
  const contentType = headers.get('content-type') ?? '';
  if (contentType.includes('text/html')) {
    headers.set('content-security-policy', HTML_CSP);
    headers.set('cache-control', 'public, max-age=300');
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function canonicalRedirect(url: URL): Response {
  const target = new URL(CANONICAL_ORIGIN);
  const suffix = routedPath(url);
  target.pathname = `${APP_PREFIX}${suffix}`.replace(/\/{2,}/g, '/');
  target.search = url.search;
  return Response.redirect(target.toString(), 308);
}

function routedPath(url: URL): string {
  if (url.pathname === APP_PREFIX) return '/';
  if (url.pathname.startsWith(`${APP_PREFIX}/`)) {
    return url.pathname.slice(APP_PREFIX.length) || '/';
  }
  return url.pathname;
}

async function upstream(url: string, init: RequestInit = {}): Promise<Response> {
  const signal = AbortSignal.timeout(10_000);
  const method = (init.method ?? 'GET').toUpperCase();
  return fetch(url, {
    ...init,
    signal,
    ...(method === 'GET' ? { cf: { cacheTtl: 3600, cacheEverything: true } } : {}),
  });
}

async function searchReleases(query: string, limit: number): Promise<Response> {
  const url =
    'https://musicbrainz.org/ws/2/release/?fmt=json&limit=' +
    encodeURIComponent(String(limit)) +
    '&query=' +
    encodeURIComponent(query);
  const res = await upstream(url, {
    headers: { 'user-agent': MB_USER_AGENT, accept: 'application/json' },
  });
  if (!res.ok) return json({ error: `MusicBrainz returned ${res.status}` }, 502);
  return json(await res.json());
}

async function lookupRelease(mbid: string): Promise<Response> {
  const inc = 'artist-credits+recordings+labels+isrcs+release-groups+media';
  const url =
    `https://musicbrainz.org/ws/2/release/${encodeURIComponent(mbid)}` +
    `?fmt=json&inc=${inc}`;
  const res = await upstream(url, {
    headers: { 'user-agent': MB_USER_AGENT, accept: 'application/json' },
  });
  if (!res.ok) return json({ error: `MusicBrainz returned ${res.status}` }, 502);
  return json(await res.json());
}

async function coverArt(mbid: string, size: string): Promise<Response> {
  const suffix = size === 'full' ? '' : `-${size}`;
  const url = `https://coverartarchive.org/release/${encodeURIComponent(mbid)}/front${suffix}`;
  const res = await upstream(url, { headers: { accept: 'image/*' } });
  if (!res.ok) {
    return json({ error: `No cover art (${res.status})` }, res.status === 404 ? 404 : 502);
  }
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().startsWith('image/')) {
    return json({ error: 'Cover Art Archive returned an unexpected file type.' }, 502);
  }
  return new Response(res.body, {
    headers: {
      'content-type': contentType,
      'cache-control': 'public, max-age=86400',
      ...BASE_SECURITY_HEADERS,
    },
  });
}

async function acoustid(
  env: RuntimeEnv,
  fingerprint: string,
  duration: string,
): Promise<Response> {
  if (!env.ACOUSTID_API_KEY) {
    return json({ error: 'Fingerprint lookup is not configured on this deployment.' }, 501);
  }
  const body = new URLSearchParams({
    client: env.ACOUSTID_API_KEY,
    meta: 'recordings releasegroups compress',
    duration,
    fingerprint,
  });
  const res = await upstream('https://api.acoustid.org/v2/lookup', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  if (!res.ok) return json({ error: `AcoustID returned ${res.status}` }, 502);
  return json(await res.json());
}

async function allowApiRequest(request: Request, env: RuntimeEnv, path: string): Promise<boolean> {
  if (request.headers.get('sec-fetch-site') === 'cross-site') return false;
  const suppliedVisitor = request.headers.get('x-easyaudio-visitor') ?? '';
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
  const visitor = VISITOR_RE.test(suppliedVisitor) ? suppliedVisitor : `ip:${ip}`;
  const [user, network] = await Promise.all([
    env.API_USER_LIMITER.limit({ key: `${path}:${visitor}` }),
    env.API_IP_LIMITER.limit({ key: `${path}:${ip}` }),
  ]);
  return user.success && network.success;
}

async function handleApi(request: Request, env: RuntimeEnv, path: string, url: URL): Promise<Response> {
  if (request.method !== 'GET') {
    return json({ error: 'Method not allowed' }, 405, { allow: 'GET' });
  }
  if (!(await allowApiRequest(request, env, path))) {
    return json({ error: 'Too many metadata requests. Please wait a minute.' }, 429, {
      'retry-after': '60',
    });
  }

  switch (path) {
    case '/api/health':
      return json({ ok: true, fingerprinting: Boolean(env.ACOUSTID_API_KEY) });

    case '/api/musicbrainz/search': {
      const query = (url.searchParams.get('q') ?? '').trim();
      if (!query) return badRequest('Missing "q" parameter.');
      if (query.length > 300) return badRequest('Search query is too long.');
      const limit = Math.min(25, Math.max(1, Number(url.searchParams.get('limit') ?? 10) || 10));
      return searchReleases(query, limit);
    }

    case '/api/musicbrainz/release': {
      const mbid = url.searchParams.get('id') ?? '';
      if (!MBID_RE.test(mbid)) return badRequest('Invalid release ID.');
      return lookupRelease(mbid);
    }

    case '/api/coverart': {
      const mbid = url.searchParams.get('id') ?? '';
      if (!MBID_RE.test(mbid)) return badRequest('Invalid release ID.');
      const size = url.searchParams.get('size') ?? '500';
      if (!['250', '500', '1200', 'full'].includes(size)) {
        return badRequest('size must be one of 250, 500, 1200, full.');
      }
      return coverArt(mbid, size);
    }

    case '/api/acoustid': {
      const fingerprint = url.searchParams.get('fingerprint') ?? '';
      const duration = url.searchParams.get('duration') ?? '';
      if (!fingerprint || fingerprint.length > 12_000) {
        return badRequest('Fingerprint is missing or too long.');
      }
      const seconds = Number(duration);
      if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 86_400) {
        return badRequest('Duration must be between 0 and 86400 seconds.');
      }
      return acoustid(env, fingerprint, String(Math.round(seconds)));
    }

    default:
      return json({ error: 'Not found' }, 404);
  }
}

export default {
  async fetch(request: Request, env: RuntimeEnv): Promise<Response> {
    const url = new URL(request.url);

    // Keep old workers.dev bookmarks useful without creating a duplicate SEO origin.
    if (url.hostname.endsWith('.workers.dev')) return canonicalRedirect(url);
    if (url.pathname === APP_PREFIX) {
      const target = new URL(request.url);
      target.pathname = `${APP_PREFIX}/`;
      return Response.redirect(target.toString(), 308);
    }

    const path = routedPath(url);
    try {
      if (path.startsWith('/api/')) return await handleApi(request, env, path, url);
      if (!['GET', 'HEAD'].includes(request.method)) {
        return json({ error: 'Method not allowed' }, 405, { allow: 'GET, HEAD' });
      }
      const assetUrl = new URL(request.url);
      assetUrl.pathname = path;
      return secureAsset(await env.ASSETS.fetch(new Request(assetUrl, request)));
    } catch (error) {
      console.error(
        JSON.stringify({
          event: 'easyaudio_request_failed',
          path,
          error: error instanceof Error ? error.name : 'UnknownError',
        }),
      );
      return json({ error: 'The metadata service is temporarily unavailable.' }, 502);
    }
  },
} satisfies ExportedHandler<RuntimeEnv>;
