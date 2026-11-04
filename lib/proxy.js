// lib/proxy.js — zero-dependency HTTP(S) client with optional webshare.io
// rotating-proxy support. Replaces global fetch() for outbound requests to
// vidly.pro so the server's IP doesn't get blocked.
//
// Config (env):
//   PROXY_HOST, PROXY_PORT, PROXY_USERNAME, PROXY_PASSWORD
// When PROXY_HOST+PROXY_USERNAME are set, HTTPS requests are tunneled through
// the proxy via the CONNECT method. Without them, requests go direct.
//
// Exposes request(url, {headers, method, body, timeout}) →
//   { status, ok, url, headers, text() }   (fetch-shaped)

const http = require("http");
const https = require("https");
const tls = require("tls");
const net = require("net");

const PROXY_HOST = process.env.PROXY_HOST || "";
const PROXY_PORT = process.env.PROXY_PORT || "80";
const PROXY_USERNAME = process.env.PROXY_USERNAME || "";
const PROXY_PASSWORD = process.env.PROXY_PASSWORD || "";

const hasProxy = !!(PROXY_HOST && PROXY_USERNAME);

// Build a shared https.Agent whose connections are opened through a CONNECT
// tunnel to the webshare proxy. TLS is then negotiated over the tunnel.
function buildProxyAgent() {
  if (!hasProxy) return null;
  const auth = Buffer.from(
    `${decodeURIComponent(PROXY_USERNAME)}:${decodeURIComponent(PROXY_PASSWORD)}`
  ).toString("base64");
  return new https.Agent({
    keepAlive: true,
    maxSockets: 64,
    createConnection(opts, cb) {
      const targetHost = opts.servername || opts.host;
      const targetPort = String(opts.port || 443);
      const sock = net.connect(Number(PROXY_PORT), PROXY_HOST);
      let buf = "";
      let settled = false;
      sock.setEncoding("utf8");
      sock.once("connect", () => {
        sock.write(
          `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
            `Host: ${targetHost}:${targetPort}\r\n` +
            `Proxy-Authorization: Basic ${auth}\r\n` +
            `Proxy-Connection: Keep-Alive\r\n\r\n`
        );
      });
      sock.on("data", (chunk) => {
        buf += chunk;
        const idx = buf.indexOf("\r\n\r\n");
        if (idx === -1) return;
        sock.removeAllListeners("data");
        sock.setEncoding(null);
        const head = buf.slice(0, idx);
        const statusLine = head.split("\r\n")[0];
        if (!/ 200 /.test(statusLine)) {
          if (!settled) {
            settled = true;
            cb(new Error("proxy CONNECT failed: " + statusLine));
          }
          sock.destroy();
          return;
        }
        // negotiate TLS over the tunnelled socket
        const tlsSock = tls.connect({
          socket: sock,
          servername: targetHost,
          ALPNProtocols: ["http/1.1"],
        });
        tlsSock.once("secureConnect", () => {
          if (!settled) {
            settled = true;
            cb(null, tlsSock);
          }
        });
        tlsSock.once("error", (e) => {
          if (!settled) {
            settled = true;
            cb(e);
          }
        });
      });
      sock.on("error", (e) => {
        if (!settled) {
          settled = true;
          cb(e);
        }
      });
    },
  });
}

const sharedAgent = buildProxyAgent();

function runOnce(lib, opts, body, timeoutMs, finalUrl) {
  return new Promise((resolve, reject) => {
    const req = lib.request(opts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () =>
        resolve({
          status: res.statusCode,
          resHeaders: res.headers,
          bodyBuf: Buffer.concat(chunks),
          finalUrl,
        })
      );
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

// fetch-shaped request with manual redirect following (3xx + Location).
async function request(targetUrl, { headers = {}, method = "GET", body, timeout = 25000 } = {}) {
  let url = targetUrl;
  let redirects = 0;
  while (redirects < 8) {
    const u = new URL(url);
    const isHttps = u.protocol === "https:";
    const lib = isHttps ? https : http;
    const opts = {
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      method,
      headers: { ...headers },
      timeout,
    };
    if (isHttps && sharedAgent) opts.agent = sharedAgent;
    const r = await runOnce(lib, opts, body, timeout, url);
    if (r.status >= 300 && r.status < 400 && r.resHeaders.location) {
      url = new URL(r.resHeaders.location, url).toString();
      redirects++;
      continue;
    }
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      url: r.finalUrl,
      headers: r.resHeaders,
      text: () => Promise.resolve(r.bodyBuf.toString("utf8")),
    };
  }
  throw new Error("too many redirects");
}

module.exports = { request, hasProxy, PROXY_HOST, PROXY_PORT };
