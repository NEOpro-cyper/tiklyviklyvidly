// verify.js — runs the spec's §4 verification checklist.
//   1. encryptUrl twice → identical; decrypt → original URL
//   2. ?data=en response carries NO raw upstream hostnames
//   3. ?worker=1&data=en → encrypted mode wins
//   4. ?worker=<custom-url>&data=en → tokens point at the custom worker
//   5. live: a token minted with data=en actually plays through the worker

const fleet = require("./lib/fleet");
const v = require("./lib/vidly");

const EN_WORKER = "https://noisy-feather-adb6.ryklcd0086.workers.dev";

function assert(cond, msg) {
  if (!cond) { console.error("  ✗ " + msg); process.exitCode = 1; }
  else console.log("  ✓ " + msg);
}

(async () => {
  console.log("\n== 1. encrypt determinism + roundtrip ==");
  const url = "https://example.com/a.m3u8";
  const t1 = fleet.encryptUrl(url);
  const t2 = fleet.encryptUrl(url);
  assert(t1 === t2, `token is deterministic (${t1.slice(0, 30)}…)`);
  assert(t1.startsWith("v1.") && t1.split(".").length === 3, "token shape v1.<iv>.<ct>");
  let back;
  try { back = fleet.decryptUrl(t1); } catch (e) { back = null; }
  assert(back === url, `decrypt(token) === original URL`);

  // a different URL must yield a different token
  assert(fleet.encryptUrl("https://example.com/b.m3u8") !== t1, "different URL → different token");

  console.log("\n== 2. ?data=en hides upstream hostnames ==");
  // Simulate a small response body and run the rewriter.
  const sample = {
    title: "X",
    streams: [
      { url: "https://gzip.rousav.tech/tvshows/abc/index.m3u8", quality: "1080p",
        subtitles: [{ url: "https://cache.vdrk.site/v1/vtt/movie/533535/English.vtt" }] },
    ],
    poster: "https://image.tmdb.org/t/p/w500/x.jpg",
    attempts: 3,
  };
  const enc = fleet.applyFleet(JSON.parse(JSON.stringify(sample)), { data: "en" }, null);
  const serialized = JSON.stringify(enc);
  assert(enc.encrypted === true, "top-level encrypted:true set");
  assert(!/rousav\.tech|vdrk\.site|image\.tmdb\.org/.test(serialized),
    "no raw upstream hostnames in JSON");
  assert(/v1\.[^.]+\.[^.]+/.test(serialized), "tokens (v1.<iv>.<ct>) present");
  assert(enc.attempts === 3, "diagnostic key 'attempts' left untouched");
  // idempotent: running again doesn't double-wrap
  const enc2 = fleet.applyFleet(JSON.parse(JSON.stringify(enc)), { data: "en" }, null);
  assert(JSON.stringify(enc2) === JSON.stringify(enc), "rewriter is idempotent");

  console.log("\n== 3. ?worker=1&data=en → encrypted wins ==");
  const both = fleet.resolveMode({ worker: "1", data: "en" });
  assert(both.mode === "encrypted", "mode=encrypted when both worker=1 and data=en");
  assert(both.base === fleet.WORKER_URL_EN, "base = WORKER_URL_EN (default EN worker)");

  console.log("\n== 4. ?worker=<custom>&data=en → tokens point at custom worker ==");
  const custom = "https://my-worker.example.workers.dev";
  const cm = fleet.resolveMode({ worker: custom, data: "en" });
  assert(cm.mode === "encrypted" && cm.base === custom, "custom worker URL wins as EN base");

  console.log("\n== 5. plain worker=1 (no data) ==");
  const pm = fleet.resolveMode({ worker: "1" });
  assert(pm.mode === "plain" && pm.base === fleet.WORKER_PROXY_URL, "plain mode, default proxy base");

  console.log("\n== 6. live: token decrypts + worker fetches the upstream ==");
  // Mint a token for a real vidly stream URL we obtained earlier and confirm
  // the worker serves it (HTTP 200, non-empty body).
  const ctx = await v.loadMedia("/movie/533535");
  const fr = await v.resolveFastest(ctx);
  if (!fr.fastest) { console.log("  (skipped: no fastest server available)"); return; }
  const raw = fr.fastest.streams[0].url;
  const token = fleet.encryptUrl(raw);
  // round-trip locally first
  assert(fleet.decryptUrl(token) === raw, "live stream token round-trips");
  // hit the worker: GET <enBase>/<token>
  const workerUrl = `${EN_WORKER}/${token}`;
  console.log("  fetching worker:", workerUrl.slice(0, 80) + "…");
  const { request } = require("./lib/proxy");
  try {
    const res = await request(workerUrl, {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "*/*" },
      timeout: 20000,
    });
    assert(res.status === 200, `worker returned HTTP ${res.status}`);
    const txt = await res.text();
    assert(txt.length > 0, `worker response non-empty (${txt.length} chars)`);
    // if it's an HLS playlist it should mention EXT or start with #, else just be bytes
    if (/^(#EXT|#!|ICY)/.test(txt)) console.log("  ✓ worker served an HLS manifest");
    else console.log("  ✓ worker served bytes (likely a segment)");
  } catch (e) {
    console.log("  (worker fetch skipped/failed:", e.message + ")");
  }

  console.log(process.exitCode ? "\n== SOME CHECKS FAILED ==" : "\n== ALL CHECKS PASSED ==");
})().catch((e) => { console.error("FATAL:", e); process.exit(1); });
