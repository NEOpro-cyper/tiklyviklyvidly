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

// Build the response envelope shared by all routes.
// query carries the fleet params (worker/data) so the final envelope can be
// URL-rewritten/encrypted before serialization. selfBase is this server's own
// origin (used to leave app-owned links untouched).
async function handle(mediaPath, serverName, query, selfBase) {
  const ctx = await v.loadMedia(mediaPath);
  let chosen, streams, ms, mode, errors, allRanked;

  if (serverName) {
    const server = findServer(ctx.servers, serverName);
    const r = await v.fetchSources(ctx, server.id);
    chosen = server;
    streams = r.streams;
    ms = r.ms;
    mode = "specific";
  } else {
    const fr = await v.resolveFastest(ctx);
    if (!fr.fastest)
      throw Object.assign(
        new Error("no server returned any streams"),
        { code: "NO_STREAMS", tried: ctx.servers.map((s) => s.id) }
      );
    chosen = fr.fastest.server;
    streams = fr.fastest.streams;
    ms = fr.fastest.ms;
    mode = "fastest";
    allRanked = fr.all.map((x) => ({
      id: x.server.id,
      label: x.server.label,
      tag: x.server.tag,
      streams: x.streams.length,
      ms: x.ms,
    }));
    errors = fr.errors;
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
      subtitles: s.subtitles && s.subtitles.length ? s.subtitles : undefined,
    })),
    allServers: ctx.servers.map((s) => ({
      id: s.id,
      label: s.label,
      tag: s.tag || null,
    })),
    ranking: allRanked,
    errors: errors && errors.length ? errors : undefined,
  };

  return fleet.applyFleet(body, query, selfBase);
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
    const body = await fn();
    return { status: 200, body };
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
  const { status, body } = await route(req.method, pathname, query, selfBase);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Cache-Control": "no-store",
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
    `  outbound proxy: ${hasProxy ? `${PROXY_HOST}:${PROXY_PORT} (webshare rotating)` : "OFF (direct)"}`
  );
});
