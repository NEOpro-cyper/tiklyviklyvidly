// lib/proxy.js — zero-dependency HTTP(S) client with webshare.io rotating-proxy
// support. Replaces global fetch() for outbound requests to vidly.pro so the
// server's IP doesn't get blocked by Cloudflare bot-management on /api/sources.
//
// Config (env):
//   PROXY_HOST, PROXY_PORT, PROXY_USERNAME, PROXY_PASSWORD
// When PROXY_HOST + PROXY_USERNAME are set, HTTPS requests are tunnelled
// through the proxy via CONNECT (TLS negotiated over the tunnelled socket,
// HTTP basic auth in Proxy-Authorization). Without them, requests go direct.
//
// Why not https.Agent({createConnection})? In Node 18+ https.Agent does NOT
// honor a createConnection passed via constructor options for HTTPS targets —
// the request bypasses the tunnel and goes direct. So we build the CONNECT
// tunnel + TLS + raw HTTP/1.1 ourselves, which is exactly what works.
//
// request(url, {headers, method, body, timeout}) →
//   { status, ok, url, headers, text() }   (fetch-shaped)

const http = require("http");
const tls = require("tls");
const net = require("net");

const PROXY_HOST = process.env.PROXY_HOST || "";
const PROXY_PORT = process.env.PROXY_PORT || "80";
const PROXY_USERNAME = process.env.PROXY_USERNAME || "";
const PROXY_PASSWORD = process.env.PROXY_PASSWORD || "";

const hasProxy = !!(PROXY_HOST && PROXY_USERNAME);

// Open a TCP socket to the proxy, issue CONNECT, wait for "200 OK", then
// upgrade the raw socket to TLS. Resolves with the tls.TLSSocket.
function openTunnel(targetHost, targetPort, timeoutMs) {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(
      `${decodeURIComponent(PROXY_USERNAME)}:${decodeURIComponent(PROXY_PASSWORD)}`
    ).toString("base64");
    const sock = net.connect({ port: Number(PROXY_PORT), host: PROXY_HOST });
    const timer = setTimeout(
      () => { sock.destroy(); reject(new Error("proxy tunnel timeout")); },
      timeoutMs
    );
    let buf = "";
    sock.setEncoding("utf8");
    sock.once("connect", () => {
      sock.write(
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
          `Host: ${targetHost}:${targetPort}\r\n` +
          `Proxy-Authorization: Basic ${auth}\r\n` +
          `Proxy-Connection: Keep-Alive\r\n\r\n`
      );
    });
    const onData = (chunk) => {
      buf += chunk;
      const idx = buf.indexOf("\r\n\r\n");
      if (idx === -1) return;
      sock.removeListener("data", onData);
      sock.setEncoding(null);
      const head = buf.slice(0, idx);
      const statusLine = head.split("\r\n")[0];
      if (!/ 200 /.test(statusLine)) {
        clearTimeout(timer);
        sock.destroy();
        reject(new Error("proxy CONNECT rejected: " + statusLine));
        return;
      }
      const tlsSock = tls.connect({
        socket: sock,
        servername: targetHost,
        ALPNProtocols: ["http/1.1"],
      });
      tlsSock.once("secureConnect", () => {
        clearTimeout(timer);
        resolve(tlsSock);
      });
      tlsSock.once("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
    };
    sock.on("data", onData);
    sock.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

// Send a raw HTTP/1.1 request over an existing socket (TLS or plain) and read
// one full response (headers + body, honouring chunked + Connection: close).
function rawHttp(sock, host, method, path, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => { sock.destroy(); reject(new Error("response timeout")); },
      timeoutMs
    );
    const headerLines = [
      `${method} ${path} HTTP/1.1`,
      `Host: ${host}`,
      `Connection: close`,
    ];
    for (const [k, v] of Object.entries(headers)) headerLines.push(`${k}: ${v}`);
    if (body) headerLines.push(`Content-Length: ${Buffer.byteLength(body)}`);
    sock.write(headerLines.join("\r\n") + "\r\n\r\n" + (body || ""));
    const chunks = [];
    sock.on("data", (c) => chunks.push(c));
    sock.on("end", () => {
      clearTimeout(timer);
      const raw = Buffer.concat(chunks);
      const sep = raw.indexOf("\r\n\r\n");
      if (sep === -1) return reject(new Error("malformed HTTP response"));
      const headerBlock = raw.slice(0, sep).toString("utf8");
      const [statusLine, ...rest] = headerBlock.split("\r\n");
      const status = parseInt(statusLine.split(" ")[1], 10);
      const respHeaders = {};
      for (const line of rest) {
        const ci = line.indexOf(":");
        if (ci > 0) {
          const k = line.slice(0, ci).trim().toLowerCase();
          const v = line.slice(ci + 1).trim();
          respHeaders[k] = v; // last value wins (Location, Content-Type)
        }
      }
      let bodyBuf = raw.slice(sep + 4);
      if ((respHeaders["transfer-encoding"] || "").includes("chunked")) {
        bodyBuf = dechunk(bodyBuf);
      }
      resolve({ status, headers: respHeaders, bodyBuf });
    });
    sock.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

// Decode HTTP/1.1 chunked transfer-encoding.
function dechunk(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    const nl = buf.indexOf("\r\n", i);
    if (nl === -1) break;
    const size = parseInt(buf.slice(i, nl).toString("ascii").trim(), 16);
    if (isNaN(size) || size === 0) break;
    out.push(buf.slice(nl + 2, nl + 2 + size));
    i = nl + 2 + size + 2; // skip data + trailing CRLF
  }
  return Buffer.concat(out);
}

// fetch-shaped request with manual redirect following (Location header).
async function request(targetUrl, { headers = {}, method = "GET", body, timeout = 25000 } = {}) {
  let url = targetUrl;
  let redirects = 0;
  while (redirects < 8) {
    const u = new URL(url);
    const isHttps = u.protocol === "https:";
    const host = u.hostname;
    const port = u.port || (isHttps ? 443 : 80);
    const path = u.pathname + u.search;
    let sock;
    if (isHttps && hasProxy) {
      sock = await openTunnel(host, port, timeout);
    } else if (isHttps) {
      sock = tls.connect({ host, port, servername: host, ALPNProtocols: ["http/1.1"] });
      await new Promise((res, rej) => {
        sock.once("secureConnect", res);
        sock.once("error", rej);
        setTimeout(() => rej(new Error("TLS timeout")), timeout);
      });
    } else {
      sock = net.connect({ host, port });
      await new Promise((res, rej) => {
        sock.once("connect", res);
        sock.once("error", rej);
        setTimeout(() => rej(new Error("connect timeout")), timeout);
      });
    }
    const r = await rawHttp(sock, host, method, path, headers, body, timeout);
    try { sock.destroy(); } catch {}
    if (r.status >= 300 && r.status < 400 && r.headers.location) {
      url = new URL(r.headers.location, url).toString();
      redirects++;
      continue;
    }
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      url,
      headers: r.headers,
      text: () => Promise.resolve(r.bodyBuf.toString("utf8")),
    };
  }
  throw new Error("too many redirects");
}

module.exports = { request, hasProxy, PROXY_HOST, PROXY_PORT, openTunnel };
