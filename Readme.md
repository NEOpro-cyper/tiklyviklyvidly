# Vidly.pro — Streaming Architecture & Encryption Analysis

**Target page:** `https://vidly.pro/movie/533535` (Deadpool & Wolverine, 2024)
**Method:** Fetched the raw HTML, downloaded every Next.js chunk, beautified the JS,
reversed the client-side decryptor, and live-verified it against the real API.
**Date:** 2026-11-03

---

## 1. High-level architecture

Vidly is a **Next.js (App Router, React Server Components)** application. The
movie page is server-rendered; the player is a client component that receives
its initial data as RSC props and then fetches per-server stream lists from a
single REST endpoint.

```
Browser (client component)
   │
   │  initial render: React Server Component props
   │     media { kind, tmdbId }  meta { title, poster, … }
   │     sealed = "v1.<encrypted blob>"          ◄── server-encrypted
   │     token  = "mw1go50t.HFGua9P0PMowpCruQVJJFTUTCnNHV3rI"
   │     theme, options {…}
   │
   ▼
   tr(sealed)  ──►  { provider, servers[], streams[] }   (decrypt once on mount)
   │
   │  on server switch / next-episode preload:
   │     GET /api/sources?kind=movie&provider=<id>&t=<token>&tmdb=533535
   │     GET /api/subtitles?kind=movie&tmdb=533535        (plain JSON)
   │     GET /api/episodes?…                                (TV only, plain JSON)
   │
   ▼
   response.text()  →  tr(text)  →  { streams: [ {url, type, quality, language} ] }
   │
   ▼
   hls.js loads stream.url, attaches to <video>
```

The decryption runs **in the browser on every `/api/sources` response**, and also
once on the server-supplied `sealed` prop at mount time.

---

## 2. The server list (Edge, Prism, Flux, …)

The seven servers — `Edge, Prism, Flux, Pulse, Volt, Nimbus, Citadel` — are
**not hardcoded** in the JS. They come from inside the encrypted `sealed`
payload. After decrypting the initial payload (see §4), you get:

```json
{
  "provider": { "id": "singularity", "label": "Edge", "tag": "HD" },
  "servers": [
    { "id": "singularity", "label": "Edge",   "tag": "HD" },
    { "id": "prism",       "label": "Prism",  "tag": "MULTI" },
    { "id": "flux",        "label": "Flux",   "tag": "HD" },
    { "id": "pulse",       "label": "Pulse",  "tag": "HD" },
    { "id": "volt",        "label": "Volt",   "tag": "HD" },
    { "id": "nimbus",      "label": "Nimbus", "tag": "HD" },
    { "id": "citadel",     "label": "Citadel","tag": "MULTI" }
  ],
  "streams": [
    { "url": "https://img.rousav.tech/media/62c3147f5d25551eb0fb/index.m3u8",
      "type": "hls", "quality": "1080p", "label": "Edge #1", "subtitles": [] }
  ]
}
```

So the labels are just human-friendly display names; the real identifier is the
`id` (`singularity`, `prism`, …), which is what gets sent back to the server.

The initial server set is produced server-side (Next.js RSC), encrypted with the
same scheme, and shipped as the `sealed` prop. Per-server stream lists are
produced on demand by `/api/sources`.

---

## 3. How each server's stream URL is fetched

### 3.1 The query-string builder — `eB.VP(media, providerId, token)`

Located in chunk `259-fb1abc67f774bf15.js` (beautified, module `2557`):

```js
function r(e, t, s) {                  // e = media, t = provider id, s = token
  let n = new URLSearchParams({ kind: e.kind, provider: t, t: s });
  e.tmdbId     && n.set("tmdb",    e.tmdbId);
  e.anilistId && n.set("anilist", e.anilistId);
  e.malId      && n.set("mal",     e.malId);
  e.season     && n.set("s",       String(e.season));
  e.episode    && n.set("e",       String(e.episode));
  e.audio      && n.set("audio",   e.audio);
  return n.toString();
}
```

For this movie the built URL is:

```
GET https://vidly.pro/api/sources?kind=movie&provider=singularity
        &t=mw1go50t.HFGua9P0PMowpCruQVJJFTUTCnNHV3rI&tmdb=533535
```

### 3.2 The fetch site (chunk 259, player component `td`)

```js
// on server switch:
let t = await fetch("/api/sources?".concat((0, eB.VP)(j, e, N)),
                    { cache: "no-store" });
if (404 === t.status) return void B(e => ({ ...e, streams: [],
        error: "Session expired. Reload the page." }));
if (!t.ok) throw Error(String(t.status));
B(tr(await t.text()));           // ◄── decrypt the raw text response
D(0);                            // reset stream index
```

`N` is the per-session `token` (from the RSC prop). `j` is the `media` object.
The response is **read as plain text** and passed straight into `tr()`.

The same endpoint is also hit silently to *preload* the next episode's sources
once playback passes 60% (chunk 259, `useEffect` on the player store):

```js
p && a / r >= .6 && u.current !== d.resumeKey &&
  (u.current = d.resumeKey,
   fetch("/api/sources?".concat((0, eB.VP)(p, d.providerId, d.token)),
         { cache: "no-store" }).catch(() => {}));
```

### 3.3 Subtitles & episodes

These two endpoints are **not encrypted** — they return plain JSON:

* `/api/subtitles?kind=movie&tmdb=533535` → `{ subtitles: [{ url, lang, label, group, source }] }`
  (e.g. `https://cache.vdrk.site/v1/vtt/movie/533535/English.vtt`)
* `/api/episodes?…` → TV episode list, cached in a `Map`.

So encryption is applied **only to the sources payload** (the thing that carries
the actual stream URLs), not to metadata.

---

## 4. The encryption / decryption scheme

This is **not** AES, WebCrypto, CryptoJS, or any standard library. It is a
hand-rolled **stream cipher built on a xorshift128-style PRNG**, keyed by a
hardcoded 16-character string. Everything is in chunk `259`, function `tr()`
(beautified line 4239).

### 4.1 Wire format

```
"v1." + base64url( iv[12 bytes] || ciphertext[N bytes] )
```

* `v1.` — version prefix; `tr` rejects anything not starting with it.
* base64url (`-`→`+`, `_`→`/`), then `atob`.
* First 12 bytes = IV / nonce. Remaining bytes = ciphertext.

### 4.2 Key derivation from the IV

The 12-byte IV seeds a 4-word (128-bit) PRNG state. Each state word is
produced by an **FNV-1a**-style hash that mixes (a) a per-word salt
`0x811c9dc5 ^ 0x9e3779b9 * wordIndex`, (b) every character of the hardcoded
key, and (c) every byte of the IV:

```js
let ta = "vY7#qL2!mZ9@wK4$";        // ◄── hardcoded 16-char key (line 4237)

function deriveState(iv) {           // returns [s, n, l, a]
  let state = [];
  for (let w = 0; w < 4; w++) {
    let n = (0x811c9dc5 ^ 0x9e3779b9 * w) >>> 0;     // FNV offset basis, salted per word
    for (let e = 0; e < ta.length; e++)
      n = Math.imul(n ^ ta.charCodeAt(e), 0x1000193) >>> 0;   // FNV-1a prime
    for (let t = 0; t < iv.length; t++)
      n = Math.imul(n ^ iv[t], 0x1000193) >>> 0;
    state.push(n);
  }
  return state;
}
```

`0x811c9dc5` is the FNV-1a 32-bit offset basis and `0x1000193` is the FNV-1a
32-bit prime — so this is FNV-1a, salted per state-word, over `key || iv`.

### 4.3 The keystream (xorshift128 variant)

Every 4th byte, the state is advanced one step of a **xorshift128**-style
generator and a fresh 32-bit `r` is produced; each of the 4 bytes in that group
is XORed with the corresponding byte of `r`:

```js
let [s, n, l, a] = deriveState(iv);
let r = 0;
for (let t = 0; t < data.length; t++) {
  if ((3 & t) === 0) {                       // advance every 4 bytes
    l >>>= 0; a >>>= 0;
    let e = (s >>> 0) + (n >>> 0) | 0;        // mix step
    s = n ^ (n >>> 9);
    n = l + (l << 3) | 0;
    l = (l = l << 21 | l >>> 11) + (e = e + (a = a + 1 | 0) | 0) | 0;
    r = e >>> 0;
  }
  data[t] ^= (r >>> ((3 & t) * 8)) & 255;     // XOR keystream byte
}
return JSON.parse(new TextDecoder().decode(data));
```

Because it's a pure XOR stream cipher, **encryption and decryption are the same
operation** — the server runs the identical routine to encrypt the JSON before
sending it.

### 4.4 The key

```js
let ta = "vY7#qL2!mZ9@wK4$";
```

This single hardcoded string is the entire secret. There is **no per-user key,
no public-key crypto, no token-bound key derivation**. The `token` in the query
string is purely a **server-side authorization/session handle** (it gates whether
`/api/sources` returns 200 vs 404 "Session expired"); it does **not** participate
in the cipher.

---

## 5. From decrypted URL to playback

Once `tr()` returns the `{ provider, servers, streams }` object, the player
(chunk 259, ~line 4149) routes each stream by `type`:

* `"hls"` → dynamically imports hls.js (chunk `910`), creates an `Hls` instance
  with ABR tuning (`maxBufferLength: 30`, `abrBandWidthFactor: 0.65`,
  `abrBandWidthUpFactor: 0.5`, `startPosition`), then
  `s.loadSource(stream.url); s.attachMedia(videoElement)`.
  Network/media errors are auto-recovered (up to 3 manifest retries, up to 2
  media-error recoveries with `swapAudioCodec()`).
* Native HLS (Safari) → `videoElement.src = stream.url`.
* Anything else → `videoElement.src = stream.url` directly (mp4 / progressive).

Quality levels, audio tracks, and subtitle tracks are read back out of hls.js
events (`MANIFEST_PARSED`, `LEVEL_SWITCHED`, `AUDIO_TRACKS_UPDATED`,
`SUBTITLE_TRACKS_UPDATED`) and surfaced in the "Quality & Server" /
"Audio & Subtitles" menus.

---

## 6. Live verification (proof it works)

I ported `tr()` to Python and ran it against:
1. the real `sealed` payload embedded in the page HTML, and
2. live `GET /api/sources` responses for all 7 servers.

Results (full output in `vidly_verification_output.txt`):

| Server id    | HTTP | Decrypted | Streams | Sample stream URL |
|--------------|------|-----------|---------|--------------------|
| singularity  | 200  | ✓         | 1       | `https://img.rousav.tech/media/62c3147f5d25551eb0fb/index.m3u8` |
| prism        | 200  | ✓         | 6       | `https://dash-hls-bridge.johndoesdmc.workers.dev/?url=…sacdn.hakunay…` |
| flux         | 200  | ✓         | 0       | (empty — server had no source for this title) |
| pulse        | 200  | ✓         | 0       | (empty) |
| volt         | 200  | ✓         | 0       | (empty) |
| nimbus       | 200  | ✓         | 1       | `https://proxy.streamrip.fun/m/mcJK6Lvxm2-…` |
| citadel      | 200  | ✓         | 3       | `https://proxy.streamrip.fun/m/-UA4MidhI9Owg5…` |

Every encrypted response decrypted cleanly to valid JSON containing the real
HLS stream URLs. The token `mw1go50t.HFGua9P0PMowpCruQVJJFTUTCnNHV3rI` was
accepted by all servers (no 404), confirming it is a session/authorization
token, not a crypto key.

The decrypted `prism` streams reveal the upstream backend: Vidly proxies
several third-party CDNs (`sacdn.hakunay…`, `streamrip.fun`,
`rousav.tech`, `johndoesdmc.workers.dev`) and re-exposes them as HLS.

---

## 7. Security observations

* **Symmetry by design** — encryption == decryption, so the same JS function
  runs on both sides. The "encryption" is obfuscation, not confidentiality:
  anyone who reads the bundle gets the key.
* **Single static key** — `ta = "vY7#qL2!mZ9@wK4$"` is shipped in cleartext in
  chunk 259. There is no key rotation, no per-session key, no KMS.
* **Token ≠ crypto key** — the `t=` query parameter authorizes the request
  server-side but is never mixed into the keystream. Stealing the token lets you
  fetch sources; it does not change the cipher.
* **Anti-debugging** — the page ships `devtools-detect` (the `md5` prop feeds
  an `ondevtoolopen` handler that pauses video and strips `src`), plus
  `disableMenu/disableSelect/disableCopy`. This protects the key in the bundle
  from casual inspection but does not change the cryptography.
* **No DRM** — streams are plain HLS `.m3u8` over HTTPS. Once decrypted, the
  manifest URL can be played in any player (VLC, mpv, etc.).

---

## 8. Reproducing it

The self-contained Python port of the decryptor is in
`/home/z/my-project/scripts/vidly_decrypt_verify.py`. Run:

```bash
python3 /home/z/my-project/scripts/vidly_decrypt_verify.py
```

It will: fetch the page, extract `sealed` + `token` from the RSC payload,
decrypt the server list, then call `/api/sources` for every server and print
the decrypted stream URLs. (Note: the `token` is session-bound and may expire;
re-fetch the page to get a fresh one.)

---

## Files

| Path | Purpose |
|------|---------|
| `/home/z/my-project/download/vidly_streaming_analysis.md` | This report |
| `/home/z/my-project/download/vidly_verification_output.txt` | Live decryption output (all 7 servers) |
| `/home/z/my-project/scripts/vidly_decrypt_verify.py` | Python port of `tr()` + live verifier |
| `/home/z/my-project/scripts/beautify_and_extract.py` | Beautifier for the JS chunks |
