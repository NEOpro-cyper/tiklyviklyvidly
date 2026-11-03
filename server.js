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
// Zero dependencies — Node 18+ (global fetch).

const http = require("http");
const v = require("./lib/vidly");

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
async function handle(mediaPath, serverName) {
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

  return {
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
}

// Route a parsed URL. Returns { status, body }.
async function route(method, pathname, query) {
  if (method !== "GET") return { status: 405, body: { error: "GET only" } };

  // /api/movie/:tmdbId
  let m = pathname.match(/^\/api\/movie\/(\w+)$/);
  if (m) return await run(() => handle(`/movie/${m[1]}`, query.server));

  // /api/tv/:tmdbId/:season/:episode
  m = pathname.match(/^\/api\/tv\/(\w+)\/(\d+)\/(\d+)$/);
  if (m)
    return await run(() =>
      handle(`/tv/${m[1]}/${m[2]}/${m[3]}`, query.server)
    );

  // /api/anime/mal/:malId/:episode/:audio
  m = pathname.match(/^\/api\/anime\/mal\/(\w+)\/(\d+)\/(sub|dub)$/i);
  if (m)
    return await run(() =>
      handle(`/anime/mal/${m[1]}/${m[2]}/${m[3].toLowerCase()}`, query.server)
    );

  // /api/anime/:anilistId/:episode/:audio
  m = pathname.match(/^\/api\/anime\/(\w+)\/(\d+)\/(sub|dub)$/i);
  if (m)
    return await run(() =>
      handle(`/anime/${m[1]}/${m[2]}/${m[3].toLowerCase()}`, query.server)
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
  const { status, body } = await route(req.method, pathname, query);
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
});
