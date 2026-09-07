// TOS Guardian — local observer collector (learning loop, phase 0)
//
// Receives episode events from the extension in observer mode and appends
// them, one JSON line each, to an ndjson file on this machine. Binds to
// 127.0.0.1 only. Validates every event against episode.js before writing and
// refuses anything that does not fit the schema, so the file only ever holds
// records the report generator understands.
//
// Usage:
//   node tools/observer.js [--port 3123] [--out ./observer]
//
// Then: Options page -> Developer -> Observer mode -> on, same port.
// Read what you have: node tools/report.js observer/events.ndjson
//
// GET  /          status
// GET  /episodes  every episode assembled from the events received so far
// POST /events    one event (JSON body)

const fs = require('fs');
const path = require('path');
const http = require('http');
const {
  OBSERVER_DEFAULT_PORT,
  validateEvent,
  assembleEpisodes
} = require('../episode');

const args = process.argv.slice(2);
let port = OBSERVER_DEFAULT_PORT;
let outDir = path.resolve(process.cwd(), 'observer');
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--help' || a === '-h') {
    console.log('Usage: node tools/observer.js [--port 3123] [--out ./observer]');
    process.exit(0);
  } else if (a === '--port') port = Number(args[++i]);
  else if (a === '--out') outDir = path.resolve(process.cwd(), args[++i]);
  else { console.error(`Unknown option: ${a}`); process.exit(1); }
}
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error('--port must be an integer between 1 and 65535');
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });
const eventsPath = path.join(outDir, 'events.ndjson');

// Events already on disk from earlier sessions, so /episodes shows everything.
const events = [];
if (fs.existsSync(eventsPath)) {
  for (const line of fs.readFileSync(eventsPath, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (validateEvent(event).valid) events.push(event);
    } catch (e) { /* skip a corrupt line rather than refuse to start */ }
  }
}

const MAX_BODY_BYTES = 64 * 1024;

function send(res, status, body, type) {
  res.writeHead(status, {
    'Content-Type': type || 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    // Chrome's private-network access check asks a local server to say so
    // explicitly before it lets a request through from a non-local context.
    'Access-Control-Allow-Private-Network': 'true'
  });
  res.end(body);
}

function summarize(event) {
  const d = event.data || {};
  const parts = [];
  for (const key of Object.keys(d)) {
    const value = d[key];
    if (typeof value === 'object') continue;
    parts.push(`${key}=${value}`);
  }
  return parts.slice(0, 6).join(' ');
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', chunk => {
      total += chunk.length;
      if (total > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return send(res, 204, '');
    if (req.method === 'GET' && req.url === '/') {
      return send(res, 200, `TOS Guardian observer: ${events.length} event(s) on record, writing ${eventsPath}\n`, 'text/plain');
    }
    if (req.method === 'GET' && req.url === '/episodes') {
      return send(res, 200, JSON.stringify(assembleEpisodes(events)));
    }
    if (req.method === 'POST' && req.url === '/events') {
      let event;
      try { event = JSON.parse(await readBody(req, MAX_BODY_BYTES)); }
      catch (e) { return send(res, 400, JSON.stringify({ error: 'invalid_body', reason: e.message })); }
      const check = validateEvent(event);
      if (!check.valid) {
        console.warn(`[observer] rejected ${event && event.stage ? event.stage : 'event'}: ${check.errors.join('; ')}`);
        return send(res, 400, JSON.stringify({ error: 'invalid_event', errors: check.errors }));
      }
      events.push(event);
      fs.appendFileSync(eventsPath, JSON.stringify(event) + '\n', 'utf8');
      const time = new Date(event.ts).toISOString().slice(11, 19);
      console.log(`[${time}] ${event.episodeId.slice(0, 6)}  ${event.stage.padEnd(8)} ${summarize(event)}`);
      return send(res, 204, '');
    }
    return send(res, 404, JSON.stringify({ error: 'not_found' }));
  } catch (err) {
    console.error('[observer] request failed:', err.message);
    return send(res, 500, JSON.stringify({ error: 'internal' }));
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`TOS Guardian observer listening on http://127.0.0.1:${port}`);
  console.log(`  events file: ${eventsPath} (${events.length} on record)`);
  console.log('  turn on Observer mode in the extension options with the same port; nothing leaves this machine');
});
