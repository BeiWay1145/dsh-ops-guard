#!/usr/bin/env node
/**
 * aria2-dl — forward a download to the local aria2-next (Motrix Next) JSON-RPC.
 *
 * Bundled with dsh-ops-guard so the guard's suggested command actually
 * exists on a machine that installed only this package. The guard denies
 * bypass downloads and points at THIS file; without it in the repo, the guard
 * would refuse a download and then name a script the user does not have.
 *
 * Provenance: adapted from the local `aria2-download` skill's forwarder
 * (authored in a different session), which was machine-private. The RPC design
 * is kept; the machine-specific assumptions are not (see below).
 *
 * Design:
 *  - Engine address is 127.0.0.1:16800 (loopback only, no rpc-secret).
 *    Override the port with ARIA2_RPC_PORT.
 *  - Talks RPC only; does not require aria2c.exe on PATH. A missing engine is
 *    reported explicitly instead of failing silently.
 *  - Writes one status file per task to ~/.dsh/downloads/tasks/<taskId>.json,
 *    the ledger dsh-sidebar-downloads renders.
 *
 * Differences from the skill copy (deliberate):
 *  - The default output directory is no longer hardcoded to D:\\Downloads.
 *    It resolves to $ARIA2_DOWNLOAD_DIR, else the user's Downloads folder,
 *    else the current directory — a machine without a D: drive still works.
 *  - The RPC timeout is configurable via ARIA2_RPC_TIMEOUT_MS.
 *
 * Usage:
 *   node aria2-dl.js <url> [--out=<name>] [--dir=<dir>] [--header=<K: V>]... [--no-wait]
 *   node aria2-dl.js --status <gid>
 *   node aria2-dl.js --list
 *
 * Exit codes: 0 ok / 1 failure (engine unavailable, RPC error, download error)
 */
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RPC_HOST = '127.0.0.1';
const RPC_PORT = Number(process.env.ARIA2_RPC_PORT || 16800);
const RPC_PATH = '/jsonrpc';
const RPC_TIMEOUT_MS = Number(process.env.ARIA2_RPC_TIMEOUT_MS || 15000);
const TASKS_DIR = path.join(os.homedir(), '.dsh', 'downloads', 'tasks');

/**
 * Resolve the default destination without assuming a drive letter.
 * The skill copy hardcoded D:\\Downloads, which fails on a machine with no D:.
 */
function defaultDir() {
  if (process.env.ARIA2_DOWNLOAD_DIR) return process.env.ARIA2_DOWNLOAD_DIR;
  // os.homedir()/Downloads is the platform convention; fall back to cwd when
  // it does not exist either.
  const downloads = path.join(os.homedir(), 'Downloads');
  try {
    if (fs.statSync(downloads).isDirectory()) return downloads;
  } catch { /* not present */ }
  return process.cwd();
}

const DEFAULT_DIR = defaultDir();

let _id = 0;
function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ jsonrpc: '2.0', id: String(++_id), method, params: params || [] });
    const req = http.request(
      { host: RPC_HOST, port: RPC_PORT, path: RPC_PATH, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        timeout: RPC_TIMEOUT_MS },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          try {
            const j = JSON.parse(body);
            if (j.error) return reject(new Error('aria2 RPC ' + (j.error.code || '') + ': ' + (j.error.message || 'unknown')));
            resolve(j.result);
          } catch { reject(new Error('aria2 RPC returned unparseable body: ' + body.slice(0, 200))); }
        });
      }
    );
    req.on('timeout', () => { req.destroy(); reject(new Error('aria2 RPC timeout (' + RPC_HOST + ':' + RPC_PORT + ')')); });
    req.on('error', (e) => {
      if (e.code === 'ECONNREFUSED') {
        reject(new Error('the aria2 engine is not listening on ' + RPC_HOST + ':' + RPC_PORT + ' — start Motrix Next first'));
      } else reject(new Error('aria2 RPC connection failed: ' + e.message));
    });
    req.end(payload);
  });
}

function writeTask(taskId, obj) {
  try {
    fs.mkdirSync(TASKS_DIR, { recursive: true });
    fs.writeFileSync(path.join(TASKS_DIR, taskId + '.json'), JSON.stringify(obj), 'utf8');
  } catch { /* panel state is best-effort; it must never break the download */ }
}

function parseArgs(argv) {
  const out = { urls: [], out: null, dir: DEFAULT_DIR, headers: [], wait: true, status: false, list: false, gid: null };
  for (const a of argv) {
    if (a === '--status') out.status = true;
    else if (a === '--list') out.list = true;
    else if (a === '--no-wait') out.wait = false;
    else if (a.startsWith('--out=')) out.out = a.slice(6);
    else if (a.startsWith('--dir=')) out.dir = a.slice(6);
    else if (a.startsWith('--header=')) out.headers.push(a.slice(9));
    else if (a.startsWith('--gid=')) out.gid = a.slice(6);
    else if (a.startsWith('--')) { /* ignore unknown switches */ }
    else out.urls.push(a);
  }
  return out;
}

function human(bytes) { return (bytes / 1048576).toFixed(1) + 'MB'; }

function deriveName(url) {
  try {
    const p = new URL(url).pathname;
    const base = decodeURIComponent(p.split('/').filter(Boolean).pop() || '');
    return base || null;
  } catch { return null; }
}

function taskIdFor(name, gid) {
  const stem = String(name || 'download').replace(/\.[^.]+$/, '').replace(/[^\w.\-]+/g, '_').slice(0, 60);
  // The gid comes back from the engine; tolerate a non-string so a surprising
  // reply cannot crash the CLI after the download was already enqueued.
  const short = String(gid || 'x').slice(0, 6);
  return stem + '-' + Date.now().toString(36) + '-' + short;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.list) {
    const active = await rpc('aria2.tellActive');
    const waiting = await rpc('aria2.tellWaiting', [0, 50]);
    const rows = [...active, ...waiting];
    if (!rows.length) { console.log('no active tasks'); return 0; }
    for (const t of rows) {
      console.log([t.gid, t.status, human(Number(t.completedLength || 0)) + '/' + human(Number(t.totalLength || 0)),
        (Number(t.downloadSpeed || 0) / 1048576).toFixed(2) + 'MB/s',
        (t.files && t.files[0] && t.files[0].path) || ''].join('  '));
    }
    return 0;
  }

  if (args.status) {
    const gid = args.gid || args.urls[0];
    if (!gid) { console.error('usage: aria2-dl.js --status <gid>'); return 1; }
    const t = await rpc('aria2.tellStatus', [gid]);
    console.log(JSON.stringify({
      gid: t.gid, status: t.status,
      total: Number(t.totalLength || 0), downloaded: Number(t.completedLength || 0),
      percent: t.totalLength ? Math.round(Number(t.completedLength) / Number(t.totalLength) * 1000) / 10 : 0,
      speedMBps: Math.round(Number(t.downloadSpeed || 0) / 1048576 * 100) / 100,
      etaSec: Number(t.downloadSpeed) > 0 && Number(t.totalLength)
        ? Math.round((Number(t.totalLength) - Number(t.completedLength)) / Number(t.downloadSpeed)) : -1,
      path: (t.files && t.files[0] && t.files[0].path) || '',
      error: t.errorMessage || '',
    }, null, 2));
    return 0;
  }

  const url = args.urls[0];
  if (!url) { console.error('usage: aria2-dl.js <url> [--out=<name>] [--dir=<dir>] [--header=<K: V>]'); return 1; }

  // Fail fast with an actionable message when the engine is down.
  try { await rpc('aria2.getVersion'); }
  catch (e) { console.error('[aria2-dl] ' + e.message); return 1; }

  const opts = { dir: args.dir, continue: 'true', 'auto-file-renaming': 'true' };
  const name = args.out || deriveName(url);
  if (name) opts.out = name;
  for (const h of args.headers) {
    opts.header = opts.header ? [].concat(opts.header, h) : [h];
  }

  const gid = await rpc('aria2.addUri', [[url], opts]);
  const taskId = taskIdFor(name, gid);
  const startedAt = Date.now();

  console.log('[aria2-dl] gid=' + gid + ' task=' + taskId);
  writeTask(taskId, { name: name || url, url, gid, outPath: path.join(args.dir, name || ''), status: 'starting', startedAt, percent: 0, downloaded: 0, total: 0, speedMBps: 0, etaSec: -1 });

  if (!args.wait) {
    console.log('[aria2-dl] enqueued (not waiting). Query with --status ' + gid + '.');
    return 0;
  }

  let last = 0;
  for (;;) {
    await new Promise((r) => setTimeout(r, 1000));
    let t;
    try { t = await rpc('aria2.tellStatus', [gid]); }
    catch (e) { console.error('[aria2-dl] status query failed: ' + e.message); return 1; }

    const total = Number(t.totalLength || 0);
    const done = Number(t.completedLength || 0);
    const speed = Number(t.downloadSpeed || 0);
    const pct = total ? Math.min(100, Math.round(done / total * 1000) / 10) : 0;
    const etaSec = speed > 0 && total ? Math.round((total - done) / speed) : -1;
    const filePath = (t.files && t.files[0] && t.files[0].path) || path.join(args.dir, name || '');

    writeTask(taskId, {
      name: name || url, url, gid, outPath: filePath,
      total, downloaded: done, percent: pct,
      speedMBps: Math.round(speed / 1048576 * 100) / 100,
      etaSec, elapsedSec: Math.round((Date.now() - startedAt) / 1000),
      status: t.status === 'complete' ? 'done' : (t.status === 'error' ? 'error' : 'downloading'),
      ...(t.status === 'complete' || t.status === 'error' ? { endedAt: Date.now() } : {}),
      ...(t.errorMessage ? { error: t.errorMessage } : {}),
    });

    if (t.status === 'complete') {
      console.log('[aria2-dl] done: ' + filePath + '  (' + human(done) + ', ' + ((Date.now() - startedAt) / 1000).toFixed(1) + 's)');
      return 0;
    }
    if (t.status === 'error' || t.status === 'removed') {
      console.error('[aria2-dl] failed: ' + (t.errorMessage || t.status));
      return 1;
    }

    const now = Date.now();
    if (now - last >= 3000) {
      last = now;
      console.log('[aria2-dl] ' + pct + '% ' + human(done) + '/' + (total ? human(total) : '?')
        + ' ' + (speed / 1048576).toFixed(2) + 'MB/s' + (etaSec >= 0 ? ' ETA ' + etaSec + 's' : ''));
    }
  }
}

main().then((c) => process.exit(c)).catch((e) => { console.error('[aria2-dl] ' + e.message); process.exit(1); });
