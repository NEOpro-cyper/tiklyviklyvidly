// lib/fleet.js — FLEET ENCRYPTED-URL SYSTEM.
// AES-256-GCM with a deterministic IV (same URL ⇒ same token), shared with 13
// apps + Cloudflare Workers via TOKEN_SECRET. Do NOT change any constant.
//
// Token format: "v1." + b64url(iv) + "." + b64url(ciphertext || 16-byte tag)
//   key  = SHA-256(TOKEN_SECRET)
//   iv   = first 12 bytes of SHA-256("iv:" + rawUrl)     (deterministic)
//
// Two app-side modes (controlled by ?worker= and ?data= query params):
//   worker=1|true|yes|on        → plain proxy:  url → `${WORKER_PROXY_URL}/${url}`
//   worker=<https://...>         → custom worker base (overrides default)
//   data=en                      → encrypted mode, WINS over plain when both set
//                                  url → `${base}/${encryptUrl(url)}`
// The JSON body is deep-walked; every http(s) URL string is rewritten so it
// carries ZERO upstream hostnames. Adds "encrypted": true to a successful
// top-level object.

const crypto = require("crypto");

const TOKEN_SECRET =
  process.env.TOKEN_SECRET ||
  "bbef4e4840ab0a33b6c129f0de8b1a6735471c82f43e9babc4adc64c5959a64a";

const WORKER_PROXY_URL =
  process.env.WORKER_PROXY_URL ||
  "https://bold-hill-8d64.ntb7nmytsd.workers.dev";

const WORKER_URL_EN =
  process.env.WORKER_URL_EN ||
  "https://noisy-feather-adb6.ryklcd0086.workers.dev/vl";

const KEY = crypto.createHash("sha256").update(TOKEN_SECRET).digest();

const b64u = (b) => Buffer.from(b).toString("base64url");

// Deterministic encryption: SHA-256("iv:"+url) → first 12 bytes as the GCM IV.
function encryptUrl(rawUrl) {
  const iv = crypto.createHash("sha256").update("iv:" + rawUrl).digest().subarray(0, 12);
  const c = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const ct = Buffer.concat([c.update(rawUrl, "utf8"), c.final(), c.getAuthTag()]);
  return `v1.${b64u(iv)}.${b64u(ct)}`;
}

// Local decrypt — used only for verification/tests, never on the request path.
function decryptUrl(token) {
  const m = String(token).match(/^v1\.([^.]+)\.([^.]+)$/);
  if (!m) throw new Error("bad token");
  const iv = Buffer.from(m[1], "base64url");
  const data = Buffer.from(m[2], "base64url");
  const tag = data.subarray(data.length - 16);
  const ct = data.subarray(0, data.length - 16);
  const d = crypto.createDecipheriv("aes-256-gcm", KEY, iv);
  d.setAuthTag(Buffer.from(tag));
  return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
}

// Resolve which mode is active from the request query. Returns
// { mode: "encrypted" | "plain" | null, base }.
function resolveMode(query) {
  const w = String(query.worker || "").trim();
  const isPlainFlag = /^(1|true|yes|on)$/i.test(w);
  const isCustomUrl = /^https?:\/\//i.test(w);
  const isEncrypted = String(query.data || "").toLowerCase() === "en";

  if (isEncrypted) {
    // encrypted wins; custom worker URL (if given) overrides the EN base
    const base = isCustomUrl ? w : WORKER_URL_EN;
    return { mode: "encrypted", base };
  }
  if (isPlainFlag) return { mode: "plain", base: WORKER_PROXY_URL };
  if (isCustomUrl) return { mode: "plain", base: w };
  return { mode: null, base: null };
}

const isUrl = (s) => typeof s === "string" && /^https?:\/\//i.test(s);

// Diagnostic keys / app-owned public links whose values are left untouched.
// poster/backdrop are cover images: TMDB serves them from its own global CDN,
// so rewriting them through the worker would only burn worker CPU/RAM and add
// latency for every image request. They always go DIRECT to image.tmdb.org.
const SKIP_KEYS = new Set(["attempts", "download_url", "poster", "backdrop"]);

// Belt-and-suspenders: any TMDB image URL is left untouched no matter which
// key it appears under (covers meta.logo etc. if ever exposed).
const IMAGE_HOST_RE = /^https?:\/\/image\.tmdb\.org\//i;

// Rewrite every http(s) URL string found anywhere in the JSON tree.
// Idempotent: URLs already starting with the active base are skipped.
function rewriteUrls(obj, mode, base, selfBase) {
  if (mode === null || base === null) return obj;
  if (Array.isArray(obj))
    return obj.map((x) => rewriteUrls(x, mode, base, selfBase));
  if (obj && typeof obj === "object") {
    const out = {};
    for (const [k, val] of Object.entries(obj)) {
      if (SKIP_KEYS.has(k)) {
        out[k] = val; // diagnostic / app-owned — never rewrite
        continue;
      }
      out[k] = rewriteUrls(val, mode, base, selfBase);
    }
    return out;
  }
  if (isUrl(obj)) {
    if (obj.startsWith(base)) return obj; // idempotent
    if (IMAGE_HOST_RE.test(obj)) return obj; // images stay direct — save worker CPU/RAM
    if (selfBase && obj.startsWith(selfBase)) return obj; // app's own links
    if (mode === "encrypted") return `${base}/${encryptUrl(obj)}`;
    if (mode === "plain") return `${base}/${obj}`;
  }
  return obj;
}

// Apply the fleet transformation to a finished response envelope.
function applyFleet(body, query, selfBase) {
  const { mode, base } = resolveMode(query);
  if (mode === null) return body;
  const out = rewriteUrls(body, mode, base, selfBase);
  if (
    mode === "encrypted" &&
    out &&
    typeof out === "object" &&
    !Array.isArray(out) &&
    !out.error
  ) {
    out.encrypted = true;
  }
  return out;
}

module.exports = {
  TOKEN_SECRET,
  WORKER_PROXY_URL,
  WORKER_URL_EN,
  encryptUrl,
  decryptUrl,
  resolveMode,
  rewriteUrls,
  applyFleet,
};
