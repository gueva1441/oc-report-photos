'use strict';

const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const express = require('express');

// ---------- Config ----------
const REPORT_SECRET = process.env.REPORT_SECRET || '';
const GAS_URL = process.env.GAS_URL || '';
const WARM_TOKEN = process.env.WARM_TOKEN || '';
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS || 365);
const DATA_DIR = path.resolve(process.env.DATA_DIR || '/data');
const PORT = Number(process.env.PORT || 3000);
const PAGE_ORIGIN = process.env.PAGE_ORIGIN || 'https://oc.northmasters.ca';

const PHOTO_CONCURRENCY = 3; // fotos a la vez por warm (cuota de Apps Script)
const MAX_WARMS = 2; // warms a la vez en todo el servicio
const GAS_ATTEMPTS = 5;
const GAS_TIMEOUT_MS = 90 * 1000;
const FAIL_COOLDOWN_MS = 60 * 1000; // tras un warm fallido, no reintentar ese ticket por 1 min
const DAY_MS = 24 * 60 * 60 * 1000;

const TASK_RE = /^TSK-\d+$/;
const KEY_RE = /^[A-Za-z0-9_-]{16}$/;
const DIR_RE = /^TSK-\d+_[A-Za-z0-9_-]{16}$/;
const FILE_URL_RE = /^\/TSK-\d+_[A-Za-z0-9_-]{16}\/\d+\.[a-z0-9]+$/;

for (const [name, value] of Object.entries({ REPORT_SECRET, GAS_URL, WARM_TOKEN, PUBLIC_BASE_URL })) {
  if (!value) {
    console.error(`Falta la variable de entorno ${name}`);
    process.exit(1);
  }
}
if (WARM_TOKEN.length < 32) {
  console.error('WARM_TOKEN debe tener 32 caracteres o más');
  process.exit(1);
}

// ---------- Llave ----------
function keyFor(taskId) {
  return crypto.createHmac('sha256', REPORT_SECRET).update(taskId.trim()).digest('base64url').slice(0, 16);
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

// Devuelve true solo si el formato es válido Y la k coincide con el HMAC.
function validTicket(taskId, k) {
  return typeof taskId === 'string' && typeof k === 'string' &&
    TASK_RE.test(taskId) && KEY_RE.test(k) && safeEqual(k, keyFor(taskId));
}

// ---------- Google Apps Script ----------
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Apps Script a veces responde HTML si está ocupado: reintenta con espera de 1 a 5 s.
async function gasJson(params) {
  const url = `${GAS_URL}?${new URLSearchParams(params)}`;
  let lastError;
  for (let attempt = 1; attempt <= GAS_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(GAS_TIMEOUT_MS) });
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`respuesta no JSON (HTTP ${res.status})`);
      }
      if (!json || json.ok !== true) throw new Error(`ok:false (${(json && json.error) || 'sin detalle'})`);
      return json;
    } catch (err) {
      lastError = err;
      if (attempt < GAS_ATTEMPTS) await sleep(attempt * 1000 + Math.random() * 1000);
    }
  }
  throw new Error(`api=${params.api} falló tras ${GAS_ATTEMPTS} intentos: ${lastError.message}`);
}

// ---------- Disco ----------
const EXT_BY_MIME = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/heic': 'heic',
  'image/heif': 'heif',
};

function extFor(mime) {
  const m = String(mime || '').toLowerCase().split(';')[0].trim();
  if (EXT_BY_MIME[m]) return EXT_BY_MIME[m];
  const sub = (m.split('/')[1] || '').replace(/[^a-z0-9]/g, '');
  return sub || 'bin';
}

const dirFor = (taskId, k) => path.join(DATA_DIR, `${taskId}_${k}`);

async function readManifest(dir) {
  try {
    const manifest = JSON.parse(await fsp.readFile(path.join(dir, 'manifest.json'), 'utf8'));
    return manifest && manifest.complete === true ? manifest : null;
  } catch {
    return null;
  }
}

async function writeAtomic(file, data) {
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, file);
}

// ---------- Warm ----------
const inFlight = new Map(); // "<task>_<k>" -> true
const lastFailure = new Map(); // "<task>_<k>" -> timestamp
const waiting = [];
let running = 0;

function acquireSlot() {
  if (running < MAX_WARMS) {
    running++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiting.push(resolve));
}

function releaseSlot() {
  const next = waiting.shift();
  if (next) next();
  else running--;
}

async function doWarm(taskId, k) {
  const dir = dirFor(taskId, k);
  const started = Date.now();
  console.log(`[warm] inicio ${taskId}`);

  const report = await gasJson({ api: 'report', task_id: taskId, k });
  const list = Array.isArray(report.photos) ? report.photos : [];
  if (list.length === 0) {
    // No se cachea un reporte vacío: quedaría sin fotos hasta que venza la retención.
    console.log(`[warm] fin ${taskId}: 0 fotos, no se guarda nada`);
    return;
  }

  // Restos de un warm anterior que no terminó.
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true });

  const pad = Math.max(2, String(list.length).length);
  const photos = new Array(list.length);
  let totalBytes = 0;
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < list.length) {
      const i = nextIndex++;
      const photo = await gasJson({ api: 'photo', id: list[i].id, s: list[i].s });
      const bytes = Buffer.from(String(photo.data || ''), 'base64');
      if (bytes.length === 0) throw new Error(`foto ${i + 1} vacía`);
      const file = `${String(i + 1).padStart(pad, '0')}.${extFor(photo.mime)}`;
      await writeAtomic(path.join(dir, file), bytes);
      photos[i] = { file, mime: photo.mime, kb: Math.round(bytes.length / 1024) };
      totalBytes += bytes.length;
    }
  }
  await Promise.all(Array.from({ length: Math.min(PHOTO_CONCURRENCY, list.length) }, worker));

  const manifest = {
    reference: report.reference,
    date: report.date,
    description: report.description,
    videos: report.videos,
    photos,
    complete: true,
    cachedAt: new Date().toISOString(),
  };
  await writeAtomic(path.join(dir, 'manifest.json'), JSON.stringify(manifest));

  const mb = (totalBytes / 1024 / 1024).toFixed(1);
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`[warm] fin ${taskId}: ${photos.length} fotos, ${mb} MB, ${secs} s`);
}

// Arranca un warm en segundo plano si hace falta. El ticket ya debe venir validado.
async function startWarm(taskId, k) {
  const id = `${taskId}_${k}`;
  if (inFlight.has(id)) return 'running';
  if (await readManifest(dirFor(taskId, k))) return 'cached';
  if (inFlight.has(id)) return 'running';
  if (Date.now() - (lastFailure.get(id) || 0) < FAIL_COOLDOWN_MS) return 'cooldown';

  inFlight.set(id, true);
  (async () => {
    await acquireSlot();
    try {
      await doWarm(taskId, k);
      lastFailure.delete(id);
    } catch (err) {
      lastFailure.set(id, Date.now());
      console.error(`[warm] ERROR ${taskId}: ${err.message}`);
    } finally {
      releaseSlot();
      inFlight.delete(id);
    }
  })();
  return 'started';
}

// ---------- Limpieza ----------
async function cleanup() {
  const cutoff = Date.now() - RETENTION_DAYS * DAY_MS;
  let removed = 0;
  let entries = [];
  try {
    entries = await fsp.readdir(DATA_DIR, { withFileTypes: true });
  } catch (err) {
    console.error(`[limpieza] no se pudo leer ${DATA_DIR}: ${err.message}`);
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !DIR_RE.test(entry.name) || inFlight.has(entry.name)) continue;
    const dir = path.join(DATA_DIR, entry.name);
    try {
      const manifest = await readManifest(dir);
      let expired;
      if (manifest) {
        expired = !(Date.parse(manifest.cachedAt) > cutoff);
      } else {
        // Carpeta sin manifest: resto de un warm fallido. Se borra si tiene más de un día.
        expired = (await fsp.stat(dir)).mtimeMs < Date.now() - DAY_MS;
      }
      if (expired) {
        await fsp.rm(dir, { recursive: true, force: true });
        removed++;
      }
    } catch (err) {
      console.error(`[limpieza] ${entry.name}: ${err.message}`);
    }
  }
  console.log(`[limpieza] ${removed} carpeta(s) borrada(s)`);
}

// ---------- HTTP ----------
const app = express();
app.disable('x-powered-by');

app.get('/health', (req, res) => res.type('text/plain').send('ok'));

app.post('/warm', express.json({ limit: '10kb' }), async (req, res) => {
  if (!safeEqual(req.get('X-Warm-Token') || '', WARM_TOKEN)) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  const body = req.body || {};
  const taskId = typeof body.task_id === 'string' ? body.task_id.trim() : '';
  const k = body.k;
  if (!validTicket(taskId, k)) return res.status(403).json({ ok: false, error: 'invalid' });
  const status = await startWarm(taskId, k);
  res.status(202).json({ ok: true, status });
});

app.use('/api/report', (req, res, next) => {
  res.set('Access-Control-Allow-Origin', PAGE_ORIGIN);
  res.set('Vary', 'Origin');
  res.set('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') {
    res.set('Access-Control-Allow-Methods', 'GET');
    return res.sendStatus(204);
  }
  next();
});

app.get('/api/report', async (req, res) => {
  const taskId = typeof req.query.t === 'string' ? req.query.t.trim() : '';
  const k = req.query.k;
  if (!validTicket(taskId, k)) return res.status(403).json({ ok: false, error: 'invalid' });

  const manifest = await readManifest(dirFor(taskId, k));
  if (!manifest) {
    await startWarm(taskId, k);
    return res.json({ ok: true, cached: false });
  }
  res.json({
    ok: true,
    cached: true,
    reference: manifest.reference,
    date: manifest.date,
    description: manifest.description,
    videos: manifest.videos,
    photos: manifest.photos.map((p) => ({
      url: `${PUBLIC_BASE_URL}/files/${taskId}_${k}/${p.file}`,
      mime: p.mime,
      kb: p.kb,
    })),
  });
});

// Solo fotos (<carpeta>/<número>.<ext>): ni manifest.json, ni temporales, ni listados.
app.use('/files', (req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  if (!FILE_URL_RE.test(req.path)) return res.sendStatus(404);
  next();
}, express.static(DATA_DIR, {
  index: false,
  redirect: false,
  dotfiles: 'ignore',
  maxAge: '365d',
  immutable: true,
}), (req, res) => res.sendStatus(404));

app.use((req, res) => res.sendStatus(404));

app.use((err, req, res, next) => {
  if (err && err.status && err.status < 500) return res.status(err.status).json({ ok: false, error: 'bad_request' });
  console.error(`[http] ${req.method} ${req.path}: ${err && err.message}`);
  res.status(500).json({ ok: false, error: 'server' });
});

fs.mkdirSync(DATA_DIR, { recursive: true });
app.listen(PORT, () => {
  console.log(`oc-report-photos escuchando en :${PORT}, datos en ${DATA_DIR}, retención ${RETENTION_DAYS} días`);
});

setTimeout(cleanup, 60 * 1000);
setInterval(cleanup, DAY_MS);

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
