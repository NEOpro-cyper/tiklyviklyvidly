// server.js — minimal zero-dependency HTTP server exposing Vidly streams.
//   GET /api/movie/:tmdbId[?server=Edge]
//   GET /api/tv/:tmdbId/:season/:episode[?server=Edge]
//   GET /api/anime/:anilistId/:episode/:audio[?server=Katana%20Sub]
//   GET /api/anime/mal/:malId/:episode/:audio[?server=Katana%20Sub]
//
// audio ∈ {"sub","dub"}. Without ?server=, returns the fastest responding
// server that yields >=1 stream. With ?server=, returns that specific server.
//
// Run: node server.js   (PORT env var, default 8787)
// Zero runtime dependencies — Node 18+.
//
//   ?worker=1            → plain proxy mode: every URL rewritten through the worker
//   ?worker=<https://…>  → custom worker base per request
//   ?data=en             → encrypted mode (AES-256-GCM tokens), wins over worker=1

const http = require("http");
const v = require("./lib/vidly");
const fleet = require("./lib/fleet");
const { hasProxy, PROXY_HOST, PROXY_PORT } = require("./lib/proxy");

const PORT = process.env.PORT || 8787;

// --- in-memory response cache (SUCCESSFUL responses only) -------------------
// The whole JSON envelope of a successful lookup (>=1 stream) is cached in RAM
// for 1 hour (env: RESPONSE_CACHE_TTL_MS). Error responses, empty results and
// session-expired failures are NEVER cached — the next request retries
// upstream immediately. The cache stores the raw (pre-fleet) body, so one
// entry serves every mode (?worker=1 / ?data=en / custom worker); the fleet
// URL rewrite is re-applied per request.
//
// Why this saves CPU: a hit skips the vidly page fetch, RSC flight parsing,
// the XOR decrypt AND the /api/sources race across all 7 servers.
// Why RAM stays low: entries are tiny (URLs + metadata strings, a few KB
// each) and the Map is LRU-capped at RESPONSE_CACHE_MAX_ENTRIES.
//
// Every response carries "X-Cache: HIT|MISS|BYPASS"; GET /health shows stats.

const responseCache = new Map(); // key -> { body, at }
const RESPONSE_CACHE_TTL =
  Number(process.env.RESPONSE_CACHE_TTL_MS) || 60 * 60 * 1000; // 1 hour
const RESPONSE_CACHE_MAX =
  Number(process.env.RESPONSE_CACHE_MAX_ENTRIES) || 300;
let cacheHits = 0;
let cacheMisses = 0;

function responseKey(mediaPath, serverName) {
  return `${mediaPath}|${serverName || "fastest"}`;
}

function responseCacheGet(key) {
  const hit = responseCache.get(key);
  if (!hit) {
    cacheMisses++;
    return null;
  }
  if (Date.now() - hit.at > RESPONSE_CACHE_TTL) {
    responseCache.delete(key);
    cacheMisses++;
    return null;
  }
  // LRU refresh: re-insert so the least-recently-used entry sorts first.
  responseCache.delete(key);
  responseCache.set(key, hit);
  cacheHits++;
  return hit.body;
}

function responseCacheSet(key, body) {
  while (responseCache.size >= RESPONSE_CACHE_MAX)
    responseCache.delete(responseCache.keys().next().value); // evict LRU
  responseCache.set(key, { body, at: Date.now() });
}

function responseCacheStats() {
  return {
    entries: responseCache.size,
    maxEntries: RESPONSE_CACHE_MAX,
    ttlMs: RESPONSE_CACHE_TTL,
    hits: cacheHits,
    misses: cacheMisses,
  };
}

// Find a server by label (case-insensitive) or id. Returns the server object
// or throws a 404-shaped error.
function findServer(servers, name) {
  const q = String(name).trim().toLowerCase();
  const byLabel = servers.find((s) => s.label.toLowerCase() === q);
  if (byLabel) return byLabel;
  const byId = servers.find((s) => s.id.toLowerCase() === q);
  if (byId) return byId;
  // also accept "tag" matches like "MULTI"/"SUB"/"DUB"
  const byTag = servers.find((s) => (s.tag || "").toLowerCase() === q);
  if (byTag) return byTag;
  const err = new Error(`unknown server "${name}"`);
  err.code = "UNKNOWN_SERVER";
  err.available = servers.map((s) => ({ id: s.id, label: s.label, tag: s.tag }));
  throw err;
}

// Resolve streams for a media path (page fetch + per-server sources). If
// vidly's session token has expired (404 → SESSION_EXPIRED, or every server
// 404'd), the stale page-cache entry is evicted and ONE retry runs on a
// freshly loaded page — a stale token can never wedge a title in a 502 loop.
async function resolveStreams(mediaPath, serverName) {
  let ctx = await v.loadMedia(mediaPath);

  async function attempt(c) {
    if (serverName) {
      const server = findServer(c.servers, serverName);
      const r = await v.fetchSources(c, server.id);
      return {
        chosen: server,
        streams: r.streams,
        ms: r.ms,
        mode: "specific",
        allRanked: undefined,
        errors: undefined,
        ctx: c,
      };
    }
    const fr = await v.resolveFastest(c);
    if (!fr.fastest) {
      // every server 404'd → the cached page token went stale, not a real miss
      const allExpired =
        fr.errors.length > 0 &&
        fr.errors.every((e) => /session expired/i.test(e.error || ""));
      throw Object.assign(new Error("no server returned any streams"), {
        code: "NO_STREAMS",
        tried: c.servers.map((s) => s.id),
        sessionExpired: allExpired,
      });
    }
    return {
      chosen: fr.fastest.server,
      streams: fr.fastest.streams,
      ms: fr.fastest.ms,
      mode: "fastest",
      allRanked: fr.all.map((x) => ({
        id: x.server.id,
        label: x.server.label,
        tag: x.server.tag,
        streams: x.streams.length,
        ms: x.ms,
      })),
      errors: fr.errors,
      ctx: c,
    };
  }

  try {
    return await attempt(ctx);
  } catch (e) {
    if (e.code !== "SESSION_EXPIRED" && !e.sessionExpired) throw e;
    v.evictMedia(mediaPath); // drop the stale token
    ctx = await v.loadMedia(mediaPath); // fresh page → fresh token
    return await attempt(ctx);
  }
}

// Build the response envelope shared by all routes.
// query carries the fleet params (worker/data) so the final envelope can be
// URL-rewritten/encrypted before serialization. selfBase is this server's own
// origin (used to leave app-owned links untouched).
async function handle(mediaPath, serverName, query, selfBase) {
  const ck = responseKey(mediaPath, serverName);
  const cached = responseCacheGet(ck);
  if (cached)
    return { body: fleet.applyFleet(cached, query, selfBase), cache: "HIT" };

  const { chosen, streams, ms, mode, errors, allRanked, ctx } =
    await resolveStreams(mediaPath, serverName);

  // Organise streams & captions. Multi-audio servers (e.g. Prism) return one
  // HLS stream per language and attach the SAME full subtitle list to every
  // stream — e.g. 6 streams × 7 captions = 42 duplicated entries. Hoist the
  // captions into ONE top-level, URL-deduplicated "subtitles" array and keep
  // "streams" as a lean list of HLS URLs. Clients get two clean lists:
  //   streams[].url/type/quality/language/label  → pick an HLS source
  //   subtitles[].url/lang/label                 → attach captions once
  const seenSub = new Set();
  const subtitles = [];
  for (const s of streams) {
    for (const sub of s.subtitles || []) {
      if (!sub || !sub.url || seenSub.has(sub.url)) continue;
      seenSub.add(sub.url);
      subtitles.push({
        url: sub.url,
        lang: sub.lang || sub.language || null,
        label: sub.label || sub.lang || null,
      });
    }
  }

  const body = {
    title: ctx.meta.title || null,
    year: ctx.meta.year || null,
    poster: ctx.meta.poster || null,
    backdrop: ctx.meta.backdrop || null,
    overview: ctx.meta.overview || null,
    media: ctx.media,
    mode,
    server: { id: chosen.id, label: chosen.label, tag: chosen.tag || null },
    responseMs: ms,
    streams: streams.map((s) => ({
      url: s.url,
      type: s.type,
      quality: s.quality || null,
      language: s.language || null,
      label: s.label || null,
    })),
    subtitles, // deduplicated captions — no longer repeated on every stream
    allServers: ctx.servers.map((s) => ({
      id: s.id,
      label: s.label,
      tag: s.tag || null,
    })),
    ranking: allRanked,
    errors: errors && errors.length ? errors : undefined,
  };

  // Cache SUCCESSFUL responses only — a resolution with zero streams (or any
  // thrown error) is never cached, so the next request retries upstream.
  if (streams.length > 0) responseCacheSet(ck, body);

  return { body: fleet.applyFleet(body, query, selfBase), cache: "MISS" };
}

// Route a parsed URL. Returns { status, body }.
async function route(method, pathname, query, selfBase) {
  if (method !== "GET") return { status: 405, body: { error: "GET only" } };

  // /api/movie/:tmdbId
  let m = pathname.match(/^\/api\/movie\/(\w+)$/);
  if (m) return await run(() => handle(`/movie/${m[1]}`, query.server, query, selfBase));

  // /api/tv/:tmdbId/:season/:episode
  m = pathname.match(/^\/api\/tv\/(\w+)\/(\d+)\/(\d+)$/);
  if (m)
    return await run(() =>
      handle(`/tv/${m[1]}/${m[2]}/${m[3]}`, query.server, query, selfBase)
    );

  // /api/anime/mal/:malId/:episode/:audio
  m = pathname.match(/^\/api\/anime\/mal\/(\w+)\/(\d+)\/(sub|dub)$/i);
  if (m)
    return await run(() =>
      handle(`/anime/mal/${m[1]}/${m[2]}/${m[3].toLowerCase()}`, query.server, query, selfBase)
    );

  // /api/anime/:anilistId/:episode/:audio
  m = pathname.match(/^\/api\/anime\/(\w+)\/(\d+)\/(sub|dub)$/i);
  if (m)
    return await run(() =>
      handle(`/anime/${m[1]}/${m[2]}/${m[3].toLowerCase()}`, query.server, query, selfBase)
    );

  if (pathname === "/" || pathname === "/health")
    return {
      status: 200,
      body: {
        ok: true,
        service: "vidly-api",
        cache: responseCacheStats(),
        routes: [
          "/api/movie/:tmdbId[?server=Edge]",
          "/api/tv/:tmdbId/:season/:episode[?server=Edge]",
          "/api/anime/:anilistId/:episode/:audio[?server=Katana%20Sub]",
          "/api/anime/mal/:malId/:episode/:audio[?server=Katana%20Sub]",
        ],
      },
    };

  return { status: 404, body: { error: "not found" } };
}

// Wrap a handler, normalising errors to a JSON envelope.
async function run(fn) {
  try {
    const { body, cache } = await fn();
    return { status: 200, body, cache };
  } catch (e) {
    if (e.code === "UNKNOWN_SERVER")
      return { status: 400, body: { error: e.message, servers: e.available } };
    if (e.code === "SESSION_EXPIRED")
      return { status: 502, body: { error: e.message } };
    if (e.code === "NO_STREAMS")
      return { status: 404, body: { error: e.message, tried: e.tried } };
    return { status: 502, body: { error: e.message } };
  }
}

function parseUrl(req) {
  const u = new URL(req.url, "http://localhost");
  const query = Object.fromEntries(u.searchParams);
  return { pathname: u.pathname, query };
}

const server = http.createServer(async (req, res) => {
  const { pathname, query } = parseUrl(req);
  // selfBase lets the fleet rewriter leave this app's own public links alone.
  const host = req.headers.host;
  const selfBase = host ? `http://${host}` : null;
  const { status, body, cache } = await route(req.method, pathname, query, selfBase);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Cache-Control": "no-store",
    "X-Cache": cache || "BYPASS",
  });
  res.end(JSON.stringify(body, null, 2));
});

server.listen(PORT, () => {
  console.log(`vidly-api listening on http://localhost:${PORT}`);
  console.log(`  GET /api/movie/:tmdbId[?server=Edge]`);
  console.log(`  GET /api/tv/:tmdbId/:season/:episode[?server=Edge]`);
  console.log(`  GET /api/anime/:anilistId/:episode/:audio[?server=Katana Sub]`);
  console.log(`  GET /api/anime/mal/:malId/:episode/:audio[?server=Katana Sub]`);
  console.log(`  fleet: ?worker=1 (plain) | ?data=en (encrypted) | ?worker=<url> (custom)`);
  console.log(
    `  response cache: successful responses only, ttl ${Math.round(
      RESPONSE_CACHE_TTL / 60000
    )} min, max ${RESPONSE_CACHE_MAX} entries (LRU)`
  );
  console.log(
    `  images: poster/backdrop stay direct from image.tmdb.org (never proxied)`
  );
  console.log(
    `  outbound proxy: ${hasProxy ? `${PROXY_HOST}:${PROXY_PORT} (webshare rotating)` : "OFF (direct)"}`
  );
});
