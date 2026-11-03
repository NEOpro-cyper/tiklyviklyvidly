// lib/vidly.js — Vidly.pro reverse-engineered client.
// Fetches a movie/TV/anime page, extracts the encrypted "sealed" payload +
// session token from Next.js RSC flight data, decrypts the server list, then
// calls /api/sources per server (also encrypted) to get the real HLS URLs.
//
// Cipher: hand-rolled XOR stream cipher (xorshift128 keystream seeded by an
// FNV-1a hash of a hardcoded key + a 12-byte IV). See decrypt() below.
// Zero dependencies — Node 18+ only (uses global fetch, Buffer, TextDecoder).

const KEY = "vY7#qL2!mZ9@wK4$"; // hardcoded in vidly chunk 259, let ta = "..."

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const BASE = "https://vidly.pro";

// --- cipher -----------------------------------------------------------------

function deriveState(iv) {
  // FNV-1a (offset 0x811c9dc5, prime 0x1000193), salted per state-word with
  // 0x9e3779b9 * wordIndex, hashed over KEY then IV. Returns 4 state words.
  const st = [];
  for (let w = 0; w < 4; w++) {
    let n = (0x811c9dc5 ^ Math.imul(0x9e3779b9, w)) >>> 0;
    for (let i = 0; i < KEY.length; i++)
      n = Math.imul(n ^ KEY.charCodeAt(i), 0x1000193) >>> 0;
    for (let i = 0; i < iv.length; i++)
      n = Math.imul(n ^ iv[i], 0x1000193) >>> 0;
    st.push(n);
  }
  return st;
}

// Mirror of tr(e) in vidly chunk 259: "v1." + base64url(iv[12] || ciphertext).
// Pure XOR stream cipher, so encrypt === decrypt.
function decrypt(payload) {
  if (!payload || !payload.startsWith("v1."))
    throw new Error("bad payload (no v1. prefix)");
  const b64 = payload.slice(3).replace(/-/g, "+").replace(/_/g, "/");
  const raw = Buffer.from(b64, "base64");
  const iv = raw.subarray(0, 12);
  const body = Buffer.from(raw.subarray(12));
  let [s, n, l, a] = deriveState(iv);
  let r = 0;
  for (let t = 0; t < body.length; t++) {
    if ((3 & t) === 0) {
      // advance the xorshift128-style state every 4 bytes
      l >>>= 0;
      a >>>= 0;
      let e = ((s >>> 0) + (n >>> 0)) | 0;
      s = (n ^ (n >>> 9)) | 0;
      n = (l + (l << 3)) | 0;
      l = ((l = (l << 21) | (l >>> 11)) + (e = (e + (a = (a + 1) | 0)) | 0)) | 0;
      r = e >>> 0;
    }
    body[t] ^= (r >>> ((3 & t) * 8)) & 255;
  }
  return JSON.parse(new TextDecoder().decode(body));
}

// --- RSC flight payload parsing ---------------------------------------------

// Concatenate every self.__next_f.push([1,"..."]) block and unescape it.
function parseFlight(html) {
  const blocks = [...html.matchAll(/self\.__next_f\.push\(\[1,"([\s\S]*?)"\]\)/g)]
    .map((m) => m[1])
    .map((b) => JSON.parse('"' + b + '"'));
  return blocks.join("");
}

// Resolve the "sealed" value: either an inline "v1.abc..." string, or an RSC
// reference "$NN" pointing to a raw-text row "NN:T<hexlen>,<text>".
function resolveSealed(full) {
  const m = full.match(/"sealed":"([^"]+)"/);
  if (!m) return null;
  const val = m[1];
  if (val.startsWith("v1.")) return val;
  if (val.startsWith("$")) {
    const refId = val.slice(1).split(",")[0];
    const tm = full.match(new RegExp(refId + ":T([0-9a-f]+),"));
    if (tm) {
      const len = parseInt(tm[1], 16);
      const start = tm.index + tm[0].length;
      return full.slice(start, start + len);
    }
  }
  return null;
}

// Extract a flat object literal from the flight payload (e.g. the "media"
// object). Drops "$undefined" values that Next.js uses for absent props.
function extractObject(full, key) {
  const re = new RegExp('"' + key + '":\\{');
  const m = re.exec(full);
  if (!m) return null;
  let i = m.index + m[0].length;
  let depth = 1;
  let s = "{";
  while (i < full.length && depth > 0) {
    const c = full[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) break; // closing brace — stop, don't append
    }
    s += c;
    i++;
  }
  s += "}";
  // turn "$undefined" into a removable token, "null"-ify
  let cleaned = s
    .replace(/"\$undefined"/g, "null")
    .replace(/,(\s*[},])/g, "$1"); // drop trailing commas before } or }
  try {
    const obj = JSON.parse(cleaned);
    for (const k of Object.keys(obj))
      if (obj[k] === null) delete obj[k];
    return obj;
  } catch (e) {
    return null;
  }
}

// --- page fetch + parse -----------------------------------------------------

// In-memory cache: media-key -> { token, media, meta, servers, at }.
// Tokens last a long time; avoids re-fetching the page on every call.
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function mediaKey(media) {
  return [media.kind, media.tmdbId || media.anilistId || media.malId,
    media.season || 0, media.episode || 0, media.audio || ""].join(":");
}

async function fetchPageText(path) {
  const res = await fetch(BASE + path, {
    headers: { "User-Agent": UA, Accept: "text/html" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`page ${path} returned HTTP ${res.status}`);
  return { html: await res.text(), url: res.url };
}

// Fetch a media page and return { media, meta, token, servers, provider, referer }.
async function loadMedia(path) {
  const cacheKey = path;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit;

  const { html } = await fetchPageText(path);
  const full = parseFlight(html);
  const media = extractObject(full, "media");
  const meta = extractObject(full, "meta");
  const token = (full.match(/"token":"([^"]+)"/) || [])[1];
  const sealed = resolveSealed(full);
  if (!media || !token || !sealed)
    throw new Error("could not find media/token/sealed on page");

  const initial = decrypt(sealed);
  const out = {
    media,
    meta: meta || {},
    token,
    servers: initial.servers || [],
    provider: initial.provider || {},
    initialStreams: initial.streams || [],
    referer: BASE + path,
    at: Date.now(),
  };
  cache.set(cacheKey, out);
  return out;
}

// --- /api/sources -----------------------------------------------------------

// Mirror of eB.VP(media, providerId, token): builds the query string.
function buildSourcesQuery(media, provider, token) {
  const p = new URLSearchParams({
    kind: media.kind,
    provider,
    t: token,
  });
  if (media.tmdbId) p.set("tmdb", String(media.tmdbId));
  if (media.anilistId) p.set("anilist", String(media.anilistId));
  if (media.malId) p.set("mal", String(media.malId));
  if (media.season) p.set("s", String(media.season));
  if (media.episode) p.set("e", String(media.episode));
  if (media.audio) p.set("audio", media.audio);
  return p.toString();
}

// Fetch + decrypt one server's sources. Returns { streams, ms } or throws.
async function fetchSources(ctx, serverId) {
  const q = buildSourcesQuery(ctx.media, serverId, ctx.token);
  const url = `${BASE}/api/sources?${q}`;
  const t0 = Date.now();
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Referer: ctx.referer, Accept: "*/*" },
    cache: "no-store",
  });
  const ms = Date.now() - t0;
  if (res.status === 404) {
    const e = new Error("session expired (404)");
    e.code = "SESSION_EXPIRED";
    throw e;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  const dec = decrypt(text);
  return { streams: dec.streams || [], failed: dec.failed || [], ms };
}

// Race all servers concurrently; return the fastest one that yields >=1 stream.
async function resolveFastest(ctx) {
  const results = await Promise.allSettled(
    ctx.servers.map((s) => fetchSources(ctx, s.id).then((r) => ({ server: s, ...r })))
  );
  const ok = results
    .filter((r) => r.status === "fulfilled" && r.value.streams.length > 0)
    .map((r) => r.value)
    .sort((a, b) => a.ms - b.ms);
  const errors = results
    .filter((r) => r.status === "rejected")
    .map((r) => ({ server: r.reason?.serverId || "?", error: r.reason?.message }));
  return { fastest: ok[0] || null, all: ok, errors };
}

module.exports = {
  KEY,
  decrypt,
  parseFlight,
  resolveSealed,
  extractObject,
  loadMedia,
  buildSourcesQuery,
  fetchSources,
  resolveFastest,
  BASE,
};
