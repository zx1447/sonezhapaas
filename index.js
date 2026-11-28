/* =====================================================================
 * Hostrix Argo 临时隧道 VPN 节点 (VLESS/VMess/Trojan + WS via Cloudflare Argo)
 * 零依赖单文件 Node.js (>=14)
 *
 * 原理 (借鉴 eooce/nodejs-argo):
 *   cloudflared 在服务器上主动外连 Cloudflare 边缘建立 Argo 快速隧道,
 *   客户端流量: 用户 -> CF 边缘(443/TLS) -> Argo 隧道 -> 本机 xray -> 目标网站
 *   完全绕开托管平台入口代理对 WebSocket/流式响应的限制。
 *
 * 路由:
 *   /            节点面板 (隧道状态 / 复制节点链接 / 订阅 / 重置 UUID)
 *   /sub         订阅内容 (base64)  ?plain=1 查看原文
 *   /api/info    面板数据 (JSON)
 *   /api/check   出站网络检测 (JSON)
 *   /api/reset   POST 重置 UUID (旧节点立即失效)
 *
 * 内部组件:
 *   xray        127.0.0.1:8001  vless-tcp 入站 + fallbacks 按 path 分流
 *               127.0.0.1:3002  vless-ws  /vless-argo
 *               127.0.0.1:3003  vmess-ws  /vmess-argo
 *               127.0.0.1:3004  trojan-ws /trojan-argo
 *   cloudflared tunnel --protocol http2 --url http://127.0.0.1:8001
 * ===================================================================== */
'use strict';
const http = require('http');
const https = require('https');
const net = require('net');
const os = require('os');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = parseInt(process.env.PORT || '20041', 10) || 20041;
const NODE_NAME = 'Hostrix-Argo';

/* ---- 组件路径与端口 ---- */
const XRAY_BIN = path.join(__dirname, 'xray');
const XRAY_CFG = path.join(__dirname, 'xray-config.json');
const ARGO_BIN = process.env.ARGO_BIN || path.join(__dirname, 'cloudflared');
const BOOT_LOG = path.join(__dirname, 'argo-boot.log');
const ARGO_PORT = 8001;
const PATH_VLESS = '/vless-argo';
const PATH_VMESS = '/vmess-argo';
const PATH_TROJAN = '/trojan-argo';
const CFIP = process.env.CFIP || '';   // 可选: CF 优选域名/IP, 填了则在订阅附加优选地址变体

/* cloudflared 下载源 (按序尝试) */
const ARG_ARCH = (os.arch() === 'arm64' || os.arch() === 'arm' || os.arch() === 'aarch64') ? 'arm64' : 'amd64';
const ARG_SOURCES = ARG_ARCH === 'arm64' ? [
  'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64',
  'https://arm64.oooen.com/bot',
  'https://arm64.ssss.nyc.mn/bot'
] : [
  'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64',
  'https://amd64.oooen.com/bot',
  'https://amd64.ssss.nyc.mn/bot'
];

/* ---------------- UUID 配置持久化 ---------------- */
const CFG_CANDIDATES = [
  path.join(__dirname, 'data', 'config.json'),
  '/tmp/hostrix-vpn-config.json'
];
let config = null;
function newUuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
}
function loadConfig() {
  for (const f of CFG_CANDIDATES) {
    try {
      const c = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (c && typeof c.uuid === 'string' && c.uuid.length === 36) { config = { uuid: c.uuid, __file: f }; return; }
    } catch (e) { /* try next */ }
  }
  config = { uuid: newUuid() };
  saveConfig();
}
function saveConfig() {
  for (const f of CFG_CANDIDATES) {
    try {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, JSON.stringify({ uuid: config.uuid }, null, 2));
      config.__file = f; return;
    } catch (e) { /* try next */ }
  }
  console.log('[config] 警告: 配置无法写盘, UUID 仅本次运行有效');
}
loadConfig();

/* ---------------- xray 配置与守护 ---------------- */
function writeXrayConfig() {
  const cfg = {
    log: { loglevel: 'warning' },
    inbounds: [
      {
        tag: 'argo-in', listen: '127.0.0.1', port: ARGO_PORT, protocol: 'vless',
        settings: {
          clients: [{ id: config.uuid, level: 0 }], decryption: 'none',
          fallbacks: [
            { path: PATH_VLESS, dest: 3002 },
            { path: PATH_VMESS, dest: 3003 },
            { path: PATH_TROJAN, dest: 3004 }
          ]
        },
        streamSettings: { network: 'tcp', security: 'none' },
        sniffing: { enabled: true, destOverride: ['http', 'tls'] }
      },
      {
        tag: 'vless-ws', listen: '127.0.0.1', port: 3002, protocol: 'vless',
        settings: { clients: [{ id: config.uuid, level: 0 }], decryption: 'none' },
        streamSettings: { network: 'ws', security: 'none', wsSettings: { path: PATH_VLESS } },
        sniffing: { enabled: true, destOverride: ['http', 'tls', 'quic'] }
      },
      {
        tag: 'vmess-ws', listen: '127.0.0.1', port: 3003, protocol: 'vmess',
        settings: { clients: [{ id: config.uuid, alterId: 0, level: 0 }] },
        streamSettings: { network: 'ws', security: 'none', wsSettings: { path: PATH_VMESS } },
        sniffing: { enabled: true, destOverride: ['http', 'tls', 'quic'] }
      },
      {
        tag: 'trojan-ws', listen: '127.0.0.1', port: 3004, protocol: 'trojan',
        settings: { clients: [{ password: config.uuid, level: 0 }] },
        streamSettings: { network: 'ws', security: 'none', wsSettings: { path: PATH_TROJAN } },
        sniffing: { enabled: true, destOverride: ['http', 'tls', 'quic'] }
      }
    ],
    outbounds: [
      { protocol: 'freedom', tag: 'direct' },
      { protocol: 'blackhole', tag: 'block' }
    ]
  };
  try {
    fs.writeFileSync(XRAY_CFG, JSON.stringify(cfg, null, 2));
    console.log('[xray] 配置已写入 (fallbacks: ' + PATH_VLESS + '->3002, ' + PATH_VMESS + '->3003, ' + PATH_TROJAN + '->3004)');
  } catch (e) { console.log('[xray] 配置写入失败: ' + e.message); }
}
let xrayProc = null;
function startXray() {
  if (!fs.existsSync(XRAY_BIN)) {
    console.log('[xray] 二进制不存在 (' + XRAY_BIN + '), 15s 后重试');
    setTimeout(startXray, 15000);
    return;
  }
  try { fs.chmodSync(XRAY_BIN, 0o755); } catch (e) {}
  writeXrayConfig();
  const p = spawn(XRAY_BIN, ['run', '-c', XRAY_CFG], { stdio: ['ignore', 'pipe', 'pipe'] });
  xrayProc = p;
  console.log('[xray] 核心已启动 pid=' + p.pid);
  p.stdout.on('data', function (d) { process.stdout.write('[xray] ' + d); });
  p.stderr.on('data', function (d) { process.stdout.write('[xray] ' + d); });
  p.on('exit', function (code) {
    console.log('[xray] 核心退出 code=' + code + ', 3s 后自动重启');
    xrayProc = null;
    setTimeout(startXray, 3000);
  });
}
function stopXray() {
  try { if (xrayProc) xrayProc.kill('SIGKILL'); } catch (e) {}
}

/* ---------------- 清理残留进程 (容器热重启场景) ---------------- */
function killStale() {
  const targets = [XRAY_BIN, ARGO_BIN];
  try {
    const dirs = fs.readdirSync('/proc').filter(function (d) { return /^\d+$/.test(d); });
    dirs.forEach(function (d) {
      const pid = parseInt(d, 10);
      if (pid === process.pid) return;
      try {
        const cmd = fs.readFileSync('/proc/' + d + '/cmdline', 'utf8');
        const args = cmd.split('\0').filter(Boolean);
        if (args.length && args[0] && targets.indexOf(args[0]) >= 0) {
          try { process.kill(pid, 'SIGKILL'); console.log('[guard] 清理残留进程 pid=' + pid + ' (' + args[0] + ')'); } catch (e) {}
        }
      } catch (e) { /* proc gone */ }
    });
  } catch (e) { /* no /proc (win) */ }
}

/* ---------------- cloudflared 下载 (多源 + ELF 校验) ---------------- */
function isElf(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const b = Buffer.alloc(4);
    fs.readSync(fd, b, 0, 4, 0);
    fs.closeSync(fd);
    return b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46;
  } catch (e) { return false; }
}
function httpGetFollow(url, cb, depth) {
  depth = depth || 0;
  if (depth > 6) { cb(null, new Error('重定向过多')); return; }
  const mod = url.indexOf('https:') === 0 ? https : http;
  let done = false;
  const req = mod.get(url, { headers: { 'User-Agent': 'curl/8.5.0', 'Accept': '*/*' } }, function (res) {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.resume();
      const next = new URL(res.headers.location, url).toString();
      httpGetFollow(next, cb, depth + 1); return;
    }
    if (res.statusCode !== 200) { res.resume(); if (!done) { done = true; cb(null, new Error('HTTP ' + res.statusCode)); } return; }
    if (!done) { done = true; cb(res); }
  });
  req.on('error', function (e) { if (!done) { done = true; cb(null, e); } });
  req.setTimeout(60000, function () { req.destroy(new Error('连接超时')); });
}
function downloadFrom(url, dest, cb) {
  httpGetFollow(url, function (stream, err) {
    if (err) { cb(err); return; }
    const part = dest + '.part';
    const out = fs.createWriteStream(part);
    let size = 0;
    stream.on('data', function (c) { size += c.length; });
    stream.on('error', function (e) { try { fs.unlinkSync(part); } catch (e2) {} cb(e); });
    stream.pipe(out);
    out.on('finish', function () {
      out.close(function () {
        if (size < 10 * 1024 * 1024) { try { fs.unlinkSync(part); } catch (e2) {} cb(new Error('文件过小 ' + size + 'B (源返回异常)')); return; }
        try { fs.renameSync(part, dest); cb(null, size); } catch (e) { cb(e); }
      });
    });
  });
}
function downloadArgo(cb, idx) {
  idx = idx || 0;
  if (idx >= ARG_SOURCES.length) { cb(new Error('全部下载源失败')); return; }
  const url = ARG_SOURCES[idx];
  console.log('[argo] 下载 cloudflared (' + ARG_ARCH + ', 源 ' + (idx + 1) + '/' + ARG_SOURCES.length + '): ' + url);
  downloadFrom(url, ARGO_BIN, function (err, size) {
    if (err) { console.log('[argo] 源 ' + (idx + 1) + ' 失败: ' + err.message); downloadArgo(cb, idx + 1); return; }
    if (!isElf(ARGO_BIN)) {
      console.log('[argo] 源 ' + (idx + 1) + ' 返回内容不是有效 ELF 二进制');
      try { fs.unlinkSync(ARGO_BIN); } catch (e2) {}
      downloadArgo(cb, idx + 1); return;
    }
    try { fs.chmodSync(ARGO_BIN, 0o755); } catch (e2) {}
    console.log('[argo] cloudflared 下载完成 (' + (size / 1048576).toFixed(1) + ' MB)');
    cb(null);
  });
}

/* ---------------- CA 证书包 (给 Go 程序 cloudflared 用) ----------------
 * 极简容器可能缺 /etc/ssl/certs, Go 的 crypto/x509 找不到根证书会报
 * x509: certificate signed by unknown authority。
 * Node 自带 Mozilla 根证书库, 启动时导出成 PEM, 通过 SSL_CERT_FILE 注入。 */
const CA_BUNDLE = path.join(__dirname, 'ca-bundle.crt');
function ensureCaBundle() {
  try {
    if (!fs.existsSync(CA_BUNDLE)) {
      const certs = require('tls').rootCertificates;   // Node >= 12.3
      if (certs && certs.length) {
        fs.writeFileSync(CA_BUNDLE, certs.join('\n') + '\n');
        console.log('[argo] CA 证书包已从 Node 内置根导出 (' + certs.length + ' 个根) -> ' + CA_BUNDLE);
        return CA_BUNDLE;
      }
      console.log('[argo] Node 无内置根证书, 尝试下载 Mozilla CA 包');
      return '';   // 由 startArgo 异步兜底下载
    }
    return CA_BUNDLE;
  } catch (e) { console.log('[argo] CA 导出失败: ' + e.message); return ''; }
}
function downloadCaBundle(cb) {
  downloadFrom('https://curl.se/ca/cacert.pem', CA_BUNDLE, function (err) {
    if (err) { console.log('[argo] CA 包下载失败: ' + err.message); cb(''); return; }
    console.log('[argo] Mozilla CA 包已下载 -> ' + CA_BUNDLE);
    cb(CA_BUNDLE);
  });
}

/* ---------------- Argo 隧道管理 ---------------- */
let argoProc = null;
let argoDomain = '';
let argoState = 'starting';     // starting | online | failed
let argoSince = 0;              // 上线时间
let argoTries = 0;              // 当前连续失败次数
let argoWaiter = null;          // 域名轮询定时器

function tailLog(n) {
  try {
    const t = fs.readFileSync(BOOT_LOG, 'utf8');
    return t.length > 4000 ? t.slice(-4000) : t;
  } catch (e) { return ''; }
}
function waitDomain(timeoutMs, cb) {
  const deadline = Date.now() + timeoutMs;
  const re = /https?:\/\/([a-z0-9-]+\.trycloudflare\.com)\/?/i;
  const tick = function () {
    const m = tailLog(999).match(re);
    if (m) { cb(null, m[1].toLowerCase()); return; }
    if (Date.now() > deadline) { cb(new Error('等待隧道域名超时')); return; }
    argoWaiter = setTimeout(tick, 1000);
  };
  tick();
}
function spawnArgo() {
  try { fs.unlinkSync(BOOT_LOG); } catch (e) {}
  const args = ['tunnel', '--edge-ip-version', 'auto', '--no-autoupdate',
    '--protocol', 'http2', '--logfile', BOOT_LOG, '--loglevel', 'info',
    '--url', 'http://127.0.0.1:' + ARGO_PORT];
  const env = Object.assign({}, process.env);
  const ca = ensureCaBundle();
  if (ca) { env.SSL_CERT_FILE = ca; }
  const p = spawn(ARGO_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'], env: env });
  argoProc = p;
  argoState = 'starting';
  console.log('[argo] cloudflared 已启动 pid=' + p.pid + ' (protocol http2 -> 127.0.0.1:' + ARGO_PORT + ')');
  p.stdout.on('data', function (d) { process.stdout.write('[argo] ' + d); });
  p.stderr.on('data', function (d) { process.stdout.write('[argo] ' + d); });
  p.on('exit', function (code) {
    argoProc = null;
    clearTimeout(argoWaiter);
    if (argoState === 'online') {
      argoDomain = ''; argoState = 'starting'; argoTries = 0;
      console.log('[argo] 隧道进程退出 code=' + code + ', 5s 后重建 (域名会变化, 链接自动刷新)');
      setTimeout(spawnArgo, 5000);
    } else {
      argoTries++;
      console.log('[argo] 启动失败 (' + argoTries + '/3) code=' + code + ', 日志尾部:\n' + tailLog(600));
      if (argoTries < 3) setTimeout(spawnArgo, 4000);
      else {
        argoState = 'failed';
        console.log('[argo] 连续 3 次失败, 60s 后继续重试');
        setTimeout(function () { argoTries = 0; spawnArgo(); }, 60000);
      }
    }
  });
  waitDomain(45000, function (err, domain) {
    if (err) {
      console.log('[argo] 未在 45s 内获得隧道域名, 杀掉进程重试');
      try { p.kill('SIGKILL'); } catch (e2) {}
      return;
    }
    argoDomain = domain;
    argoState = 'online';
    argoSince = Date.now();
    argoTries = 0;
    console.log('[argo] 临时隧道上线: https://' + domain + ' -> 127.0.0.1:' + ARGO_PORT);
  });
}
function startArgo() {
  const afterBinary = function () {
    // 确保 CA 包就绪 (极简容器缺系统 CA, Go 程序需要)
    if (fs.existsSync(CA_BUNDLE)) { spawnArgo(); return; }
    try {
      const certs = require('tls').rootCertificates;
      if (certs && certs.length) { fs.writeFileSync(CA_BUNDLE, certs.join('\n') + '\n'); console.log('[argo] CA 证书包已导出 (' + certs.length + ' 个根)'); spawnArgo(); return; }
    } catch (e) { /* 老版本 Node 无 rootCertificates */ }
    console.log('[argo] Node 无内置根证书, 下载 Mozilla CA 包兜底');
    downloadCaBundle(function (ca) { spawnArgo(); });
  };
  if (fs.existsSync(ARGO_BIN)) {
    try { fs.chmodSync(ARGO_BIN, 0o755); } catch (e) {}
    if (!isElf(ARGO_BIN)) { console.log('[argo] 本地二进制无效, 重新下载'); try { fs.unlinkSync(ARGO_BIN); } catch (e2) {} }
    else { afterBinary(); return; }
  }
  console.log('[argo] cloudflared 二进制不存在, 开始自动下载');
  downloadArgo(function (err) {
    if (err) {
      argoState = 'failed';
      console.log('[argo] cloudflared 下载失败: ' + err.message + ', 60s 后重试');
      setTimeout(startArgo, 60000);
      return;
    }
    afterBinary();
  });
}

/* ---------------- 节点链接生成 ---------------- */
function buildLinks(argoDomain, uuid) {
  if (!argoDomain) return null;
  const host = argoDomain;
  const nameV = NODE_NAME + '-VLESS';
  const nameM = NODE_NAME + '-VMESS';
  const nameT = NODE_NAME + '-TROJAN';
  const vless = 'vless://' + uuid + '@' + host + ':443?encryption=none&security=tls&sni=' + host
    + '&fp=chrome&type=ws&host=' + host + '&path=' + encodeURIComponent(PATH_VLESS + '?ed=2560') + '#' + nameV;
  const vmessJson = JSON.stringify({
    v: '2', ps: nameM, add: host, port: '443', id: uuid, aid: '0', scy: 'auto',
    net: 'ws', type: 'none', host: host, path: PATH_VMESS + '?ed=2560', tls: 'tls', sni: host, fp: 'chrome'
  });
  const vmess = 'vmess://' + Buffer.from(vmessJson, 'utf8').toString('base64');
  const trojan = 'trojan://' + uuid + '@' + host + ':443?security=tls&sni=' + host
    + '&fp=chrome&type=ws&host=' + host + '&path=' + encodeURIComponent(PATH_TROJAN + '?ed=2560') + '#' + nameT;
  const links = [vless, vmess, trojan];
  if (CFIP) {
    const cf = CFIP;
    links.push('vless://' + uuid + '@' + cf + ':443?encryption=none&security=tls&sni=' + host
      + '&fp=chrome&type=ws&host=' + host + '&path=' + encodeURIComponent(PATH_VLESS + '?ed=2560') + '#' + nameV + '-CF');
  }
  return links;
}

/* ---------------- 工具 ---------------- */
function publicHost(req) {
  const xf = req.headers['x-forwarded-host'];
  return ((xf && String(xf).split(',')[0].trim()) || req.headers.host || '').toLowerCase();
}
function isLocalHost(h) {
  return /^localhost/.test(h) || /^127\./.test(h) || /^0\.0\.0\.0/.test(h) || /^10\./.test(h) || /^192\.168\./.test(h);
}
function subUrlFor(host) {
  const local = isLocalHost(host) || host.indexOf(':') >= 0;
  return (local ? 'http://' : 'https://') + host + '/sub';
}
function checkOutbound(cb) {
  const t0 = Date.now();
  const s = net.connect({ host: '1.1.1.1', port: 80 });
  const done = function (ok, msg) { try { s.destroy(); } catch (e) {} cb(ok, msg); };
  s.setTimeout(4000, function () { done(false, '连接超时 (1.1.1.1:80, 4s)'); });
  s.on('connect', function () { done(true, '出站正常 ' + (Date.now() - t0) + 'ms (1.1.1.1:80)'); });
  s.on('error', function (e) { done(false, '出站失败: ' + e.message); });
}
function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(obj));
}

/* ---------------- 网页面板 ---------------- */
const PANEL_HTML = [
'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">',
'<meta name="viewport" content="width=device-width,initial-scale=1">',
'<title>Argo 临时隧道节点面板</title>',
'<style>',
':root{--bg:#0b0f14;--card:#121821;--line:#1f2937;--tx:#e5e7eb;--sub:#9ca3af;--acc:#34d399;--warn:#fbbf24}',
'*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font:15px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif}',
'.wrap{max-width:880px;margin:0 auto;padding:24px 16px 48px}',
'h1{font-size:22px;margin:8px 0 4px}',
'.tag{display:inline-block;font-size:12px;border:1px solid rgba(52,211,153,.4);background:rgba(52,211,153,.08);color:var(--acc);padding:2px 10px;border-radius:999px;vertical-align:middle}',
'.tag.warn{color:var(--warn);border-color:rgba(251,191,36,.4);background:rgba(251,191,36,.08)}',
'.desc{color:var(--sub);margin:0 0 6px}',
'.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px;margin-top:16px}',
'.row{display:flex;justify-content:space-between;gap:12px;padding:7px 0;border-bottom:1px dashed var(--line);flex-wrap:wrap}',
'.row:last-child{border-bottom:0}',
'.k{color:var(--sub);flex:0 0 auto}',
'.v{font-family:ui-monospace,Consolas,monospace;word-break:break-all;text-align:right}',
'.btns{display:flex;gap:10px;flex-wrap:wrap;margin-top:14px}',
'button{background:var(--acc);color:#04231a;border:0;border-radius:10px;padding:10px 16px;font-size:14px;font-weight:600;cursor:pointer}',
'button:hover{filter:brightness(1.1)}',
'button.ghost{background:transparent;color:var(--tx);border:1px solid var(--line)}',
'button.danger{background:transparent;color:var(--warn);border:1px solid rgba(251,191,36,.4)}',
'textarea{width:100%;background:#0d131b;color:var(--tx);border:1px solid var(--line);border-radius:10px;padding:10px;font:12px ui-monospace,Consolas,monospace;height:110px;margin-top:10px;resize:vertical}',
'ol{color:var(--sub);padding-left:20px;margin:8px 0 0}ol li{margin:5px 0}',
'b.w{color:var(--tx)}',
'#toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);background:#059669;color:#fff;padding:8px 18px;border-radius:999px;font-size:13px;opacity:0;transition:.25s;pointer-events:none;z-index:9}',
'</style></head><body><div class="wrap">',
'<h1>Argo 临时隧道节点面板 <span class="tag" id="state">启动中</span></h1>',
'<p class="desc">VLESS / VMess / Trojan + WS · 经 Cloudflare Argo 隧道 · 服务器主动外连, 免平台入口限制</p>',
'<div class="card">',
'  <b class="w">隧道状态</b>',
'  <div class="row"><span class="k">临时隧道域名</span><span class="v" id="argo">获取中...</span></div>',
'  <div class="row"><span class="k">隧道上线于</span><span class="v" id="argoUp">-</span></div>',
'  <div class="row"><span class="k">本地链路</span><span class="v">cloudflared -> xray(8001 分流 vless/vmess/trojan)</span></div>',
'</div>',
'<div class="card">',
'  <div class="row"><span class="k">UUID</span><span class="v" id="uuid">-</span></div>',
'  <div class="row"><span class="k">节点地址</span><span class="v" id="host">-</span></div>',
'  <div class="row"><span class="k">端口 / 传输</span><span class="v">443 (TLS) · WebSocket</span></div>',
'  <div class="row"><span class="k">路径</span><span class="v">/vless-argo · /vmess-argo · /trojan-argo</span></div>',
'  <div class="btns">',
'    <button id="b1">复制 VLESS</button>',
'    <button id="b1b">复制 VMess</button>',
'    <button id="b1c">复制 Trojan</button>',
'    <button id="b2" class="ghost">复制订阅地址</button>',
'    <button id="b3" class="ghost">复制订阅内容</button>',
'    <button id="b4" class="danger">重置 UUID</button>',
'  </div>',
'  <textarea id="box" readonly spellcheck="false" placeholder="节点链接显示在这里"></textarea>',
'</div>',
'<div class="card">',
'  <b class="w">使用方法（客户端导入）</b>',
'  <ol>',
'    <li><b>方式一 · 订阅导入（推荐）</b>：v2rayNG / NekoBox / Hiddify / Shadowrocket / Clash.Meta → 添加订阅 → 粘贴订阅地址 → 更新</li>',
'    <li><b>方式二 · 节点链接</b>：复制单个链接 → 客户端"从剪贴板导入"</li>',
'    <li>临时隧道域名每次重启会变（临时隧道特性），失效后回到本页复制最新链接或更新订阅即可</li>',
'    <li>隧道走 Cloudflare 边缘，与托管平台的入口代理无关，公网可正常代理</li>',
'  </ol>',
'</div>',
'<div class="card">',
'  <b class="w">运行状态</b>',
'  <div class="row"><span class="k">本页已运行</span><span class="v" id="up">-</span></div>',
'  <div class="row"><span class="k">出站网络</span><span class="v" id="out">-</span></div>',
'  <div class="btns"><button id="b5" class="ghost">检测出站网络</button></div>',
'</div>',
'<div id="toast"></div>',
'<script>',
'var $ = function (id) { return document.getElementById(id); };',
'var INFO = null;',
'function toast(msg) { var t = $("toast"); t.textContent = msg; t.style.opacity = 1; clearTimeout(t._h); t._h = setTimeout(function () { t.style.opacity = 0; }, 1600); }',
'function copyText(txt, label) {',
'  if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(txt).then(function () { toast(label + " 已复制"); }, function () { fallback(txt, label); }); }',
'  else { fallback(txt, label); }',
'}',
'function fallback(txt, label) { var b = $("box"); b.value = txt; b.select(); try { document.execCommand("copy"); toast(label + " 已复制"); } catch (e) { toast("复制失败, 请手动选择文本"); } }',
'function fmtUp(sec) { var d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60; return (d ? d + "天 " : "") + h + ":" + (m < 10 ? "0" + m : m) + ":" + (s < 10 ? "0" + s : s); }',
'function load() {',
'  fetch("/api/info").then(function (r) { return r.json(); }).then(function (j) {',
'    INFO = j;',
'    $("uuid").textContent = j.uuid; $("host").textContent = j.argoDomain || "-";',
'    $("box").value = (j.links && j.links.length) ? j.links.join("\\n") : "隧道尚未就绪, 自动重试中...";',
'    var st = $("state");',
'    if (j.argoState === "online") { st.textContent = "隧道在线"; st.className = "tag"; $("argo").textContent = j.argoDomain; $("argoUp").textContent = fmtUp(j.argoUptimeSec) + " 前"; }',
'    else if (j.argoState === "failed") { st.textContent = "隧道建立失败(重试中)"; st.className = "tag warn"; $("argo").textContent = "-"; $("argoUp").textContent = "-"; }',
'    else { st.textContent = "隧道建立中..."; st.className = "tag warn"; $("argo").textContent = "获取中..."; $("argoUp").textContent = "-"; }',
'    $("up").textContent = fmtUp(j.uptimeSec);',
'  }).catch(function () { $("state").textContent = "加载失败"; $("state").className = "tag warn"; });',
'}',
'$("b1").onclick = function () { if (INFO && INFO.links) copyText(INFO.links[0] || "", "VLESS 链接"); };',
'$("b1b").onclick = function () { if (INFO && INFO.links) copyText(INFO.links[1] || "", "VMess 链接"); };',
'$("b1c").onclick = function () { if (INFO && INFO.links) copyText(INFO.links[2] || "", "Trojan 链接"); };',
'$("b2").onclick = function () { if (INFO) copyText(INFO.subUrl, "订阅地址"); };',
'$("b3").onclick = function () { fetch("/sub").then(function (r) { return r.text(); }).then(function (t) { $("box").value = t; copyText(t, "订阅内容(base64)"); }); };',
'$("b4").onclick = function () { if (!confirm("确定重置 UUID? 旧节点链接/订阅将立即失效, 需重新复制。")) return;',
'  fetch("/api/reset", { method: "POST" }).then(function () { toast("UUID 已重置"); load(); }); };',
'$("b5").onclick = function () { $("out").textContent = "检测中..."; fetch("/api/check").then(function (r) { return r.json(); }).then(function (j) { $("out").textContent = (j.ok ? "[OK] " : "[FAIL] ") + j.msg; }); };',
'setInterval(load, 10000); load();',
'</script></div></body></html>'
].join('\n');

/* ---------------- HTTP 服务 ---------------- */
const startedAt = Date.now();
const server = http.createServer(function (req, res) {
  let u;
  try { u = new URL(req.url, 'http://x'); } catch (e) { res.writeHead(400); res.end(); return; }
  const p = u.pathname;
  if (p === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PANEL_HTML);
    return;
  }
  if (p === '/sub') {
    const links = buildLinks(argoDomain, config.uuid);
    const body = links ? links.join('\n') + '\n' : '';
    if (!links) {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      res.end('Argo tunnel not ready, please retry later.');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(u.searchParams.get('plain') === '1' ? body : Buffer.from(body, 'utf8').toString('base64'));
    return;
  }
  if (p === '/api/info') {
    const host = publicHost(req);
    sendJson(res, 200, {
      name: NODE_NAME,
      host: host,
      uuid: config.uuid,
      argoDomain: argoDomain || '',
      argoState: argoState,
      argoUptimeSec: argoSince ? Math.floor((Date.now() - argoSince) / 1000) : 0,
      links: buildLinks(argoDomain, config.uuid),
      subUrl: subUrlFor(host),
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
      configFile: config.__file || '(memory)',
      arch: ARG_ARCH
    });
    return;
  }
  if (p === '/api/check') {
    checkOutbound(function (ok, msg) { sendJson(res, 200, { ok: ok, msg: msg }); });
    return;
  }
  if (p === '/api/reset') {
    if (req.method !== 'POST') { sendJson(res, 405, { ok: false, msg: 'method not allowed' }); return; }
    if (req.headers.origin) {
      try {
        const oh = new URL(req.headers.origin).host;
        if (oh !== publicHost(req)) { sendJson(res, 403, { ok: false, msg: 'cross origin rejected' }); return; }
      } catch (e) { /* ignore */ }
    }
    config.uuid = newUuid();
    saveConfig();
    writeXrayConfig();
    stopXray();                      // startXray 的 exit 回调会自动重启
    console.log('[config] UUID 已重置: ' + config.uuid + ' | xray 将自动以新 UUID 重启');
    sendJson(res, 200, { ok: true, uuid: config.uuid });
    return;
  }
  res.writeHead(302, { Location: '/' });
  res.end();
});

server.on('clientError', function (err, socket) {
  try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch (e) {}
});

server.listen(PORT, '0.0.0.0', function () {
  console.log('==============================================');
  console.log('[vpn] Argo 临时隧道节点启动 (vless/vmess/trojan + ws)');
  console.log('[vpn] 面板端口:', PORT, '| 内部:', ARGO_PORT, '(cloudflared->xray fallbacks)');
  console.log('[vpn] UUID:', config.uuid);
  console.log('[vpn] 面板: /  |  订阅: /sub');
  console.log('[vpn] 配置文件:', config.__file || '(memory)');
  console.log('==============================================');
  killStale();
  startXray();
  startArgo();
});

process.on('uncaughtException', function (e) { console.error('[guard] uncaught:', e && e.message); });
process.on('unhandledRejection', function (e) { console.error('[guardR]', e && (e.message || e)); });
