// TOS Guardian — episode report (learning loop, phase 0)
//
// Turns episode records into a markdown report. Accepts event files from the
// observer collector and episode files from the batch runner, in any mix.
//
// Usage:
//   node tools/report.js <events.ndjson | episodes.ndjson> [more files...] [--out report.md] [--title "..."]

const fs = require('fs');
const path = require('path');
const { assembleEpisodes, validateEpisode } = require('../episode');
const { buildReport } = require('./report-lib');

const args = process.argv.slice(2);
const files = [];
let outPath = null;
let title = null;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--help' || a === '-h') {
    console.log('Usage: node tools/report.js <events.ndjson | episodes.ndjson> [...] [--out report.md] [--title "..."]');
    process.exit(0);
  } else if (a === '--out') outPath = args[++i];
  else if (a === '--title') title = args[++i];
  else if (a.startsWith('--')) { console.error(`Unknown option: ${a}`); process.exit(1); }
  else files.push(a);
}
if (files.length === 0) {
  console.error('Usage: node tools/report.js <events.ndjson | episodes.ndjson> [...] [--out report.md]');
  process.exit(1);
}

const events = [];
const episodes = [];
let skipped = 0;
for (const file of files) {
  const text = fs.readFileSync(path.resolve(process.cwd(), file), 'utf8');
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch (e) { skipped++; continue; }
    if (record && typeof record.stage === 'string') events.push(record);
    else if (record && record.stages) {
      if (validateEpisode(record).valid) episodes.push(record); else skipped++;
    } else skipped++;
  }
}
const all = episodes.concat(assembleEpisodes(events));
all.sort((a, b) => String(a.startedAt || '').localeCompare(String(b.startedAt || '')));

const report = buildReport(all, { title: title || undefined });
if (outPath) {
  fs.writeFileSync(path.resolve(process.cwd(), outPath), report, 'utf8');
  console.log(`Wrote ${outPath} (${all.length} episode(s)${skipped ? `, ${skipped} line(s) skipped` : ''})`);
} else {
  process.stdout.write(report);
  if (skipped) console.error(`${skipped} line(s) skipped`);
}
