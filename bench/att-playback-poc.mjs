// att-playback-poc.mjs
// Proof of concept: is playing a precomputed frame table materially cheaper than
// rendering, on real hardware?
//
// Runs ON A DEVICE. Uses the device's own config.json for the real fixture patch and the
// device's own engine, so render and playback are compared on identical work.
//
// The device builds the table itself here. In the real architecture the server would build
// it; for measuring playback cost that makes no difference, and doing it locally means this
// test needs no server changes at all.
//
//   node att-playback-poc.mjs                 A/B, no DMX output (safe while PM2 runs)
//   node att-playback-poc.mjs --sacn          also emit sACN (STOP PM2 FIRST)
//   node att-playback-poc.mjs --shows 3,7,12  choose show ids
//   node att-playback-poc.mjs --seconds 20    measurement window per mode
//
// Nothing is written to the app directory and nothing is modified. Read-only except for an
// optional table dump under /tmp.

import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const APP = '/home/attitude/Documents/attitude/attitudecontrol2a';
const { AttitudeEngine3 } = await import(`${APP}/AttitudeEngine3.mjs`);

const argv = process.argv.slice(2);
const flag = (name, def) => {
  const i = argv.indexOf(name);
  return i === -1 ? def : (argv[i + 1] ?? true);
};
const WANT_SACN = argv.includes('--sacn');
const SECONDS = parseInt(flag('--seconds', '15'), 10);
const FRAME_MS = 25;
const GAMMA = 1.7;

// gamma table - in the real design the server pre-applies this, so playback never computes it
const GAMMA_TABLE = new Uint8Array(256);
for (let i = 0; i < 256; i++) GAMMA_TABLE[i] = Math.round(Math.pow(i / 255, GAMMA) * 255);

// ---------------------------------------------------------------------------
// 1. Real patch, from the device's own config
// ---------------------------------------------------------------------------
const config = JSON.parse(readFileSync(`${APP}/config.json`, 'utf8'));
const zones = config.zones ?? [];
const fixtures = config.fixtures ?? [];
const fixtureTypes = config.fixtureTypes ?? [];
const shows = config.shows ?? config.showsArray ?? [];

if (!zones.length || !fixtures.length) {
  console.error('config.json has no zones/fixtures - is this device assigned to a location?');
  process.exit(1);
}

// same logic as AttitudeFixtureManager.calculateAllFixtureSegments
function segmentsFor(list) {
  const out = [];
  for (const f of list) {
    const t = fixtureTypes.find((x) => x.id == f.type);
    if (!t) continue;
    const cps = t.channels / t.segments || t.channels;
    const n = t.multicountonefixture ? (f.quantity ?? 1) : (t.segments > 1 ? t.segments : 1);
    for (let i = 0; i < n; i++) {
      out.push({
        universe: f.universe,
        startAddress: f.startAddress + cps * i,
        colorMode: t.color,
        highlight: f.highlight ?? false,
      });
    }
  }
  return out;
}

// build the zone/group groupings the fixture manager would produce
const groups = [];
zones.forEach((zone, zi) => {
  if (zone.groups && zone.groups.length > 0) {
    zone.groups.forEach((g, gi) => {
      const list = fixtures.filter((f) => f.zoneNumber == zi + 1 && f.groupNumber == gi + 1);
      if (list.length) groups.push({ label: `z${zi + 1}g${gi + 1}`, segments: segmentsFor(list) });
    });
  } else {
    const list = fixtures.filter((f) => f.zoneNumber == zi + 1);
    if (list.length) groups.push({ label: `z${zi + 1}`, segments: segmentsFor(list) });
  }
});



// ---------------------------------------------------------------------------
// 2. Pick shows - one engine per group, as the fixture manager does
// ---------------------------------------------------------------------------
const wantIds = flag('--shows', null);
let chosen = wantIds
  ? String(wantIds).split(',').map((s) => shows.find((x) => String(x.id) === s.trim())).filter(Boolean)
  : shows.slice(0, groups.length);
if (!chosen.length) { console.error('no usable shows found in config.json'); process.exit(1); }
while (chosen.length < groups.length) chosen.push(chosen[chosen.length % chosen.length]);

// Mirrors AttitudeFixtureManager.processEngineInstances(). Most shows in the field are still
// LEGACY (pre-2.A) format - numeric direction, 0-100 speed, 1-20 size, colorsList of [r,g,b]
// arrays - and are translated at runtime. Reading them as native 2.A yields white static
// everywhere and then throws on `direction: 0`.
const LEGACY_SHOWTYPES = ['Static', 'All', 'All', 'Chase', 'Chase', 'Chase'];
const LEGACY_DIRECTIONS = ['Left to Right', 'Right to Left', 'Middle to Ends', 'Ends to Middle'];
const LEGACY_SIZES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16, 20, 25, 33, 50, 100];

function isNative(show) { return show.engineVersion == '2A'; }

function paramsFor(show) {
  if (isNative(show)) {
    return {
      showType: show.showType, direction: show.direction, speed: show.speed,
      size: show.size, splits: show.splits, transition: show.transition,
      transitionWidth: show.transitionWidth, bounce: show.bounce, colors: show.colors,
    };
  }

  let tw = 0;
  if (show.type == 2 || show.type == 6) tw = 1;
  else if (show.type == 5) tw = 0.25;

  return {
    showType: LEGACY_SHOWTYPES[show.type - 1] ?? 'Static',
    direction: LEGACY_DIRECTIONS[show.direction] ?? 'Left to Right',
    speed: Math.round((show.speed ?? 50) * 1.7 + 10),
    size: LEGACY_SIZES[(show.size ?? 1) - 1] ?? 100,
    splits: Math.round(show.splits ?? 1),
    transition: 'Both Edges',
    transitionWidth: tw,
    bounce: false,
    colors: (show.colorsList && show.colorsList.length)
      ? show.colorsList.map((c) => ({ red: c[0], green: c[1], blue: c[2] }))
      : [{ red: 255, green: 255, blue: 255 }],
  };
}

function describe(show) {
  const p = paramsFor(show);
  return `${isNative(show) ? '2A ' : 'legacy'} ${p.showType}/${p.colors.length}c/sz${p.size}/sp${p.speed}/${p.direction}`;
}

// drop any show the engine refuses, rather than dying on one bad translation
const usable = [];
for (let i = 0; i < groups.length; i++) {
  const s = chosen[i];
  try {
    new AttitudeEngine3(paramsFor(s));
    usable.push({ group: groups[i], show: s });
  } catch (err) {
    console.log(`  SKIP ${groups[i].label} show ${s.id} "${s.name ?? ''}" - ${err.message}`);
  }
}
if (!usable.length) { console.error('no usable show/group pairs'); process.exit(1); }
groups.length = 0;
chosen = [];
for (const u of usable) { groups.push(u.group); chosen.push(u.show); }

console.log(`patch: ${groups.length} groups, ${groups.reduce((s, g) => s + g.segments.length, 0)} segments total`);
console.log('(note: the PERF line reports segs= as the FIXTURE count, not segments)');
groups.forEach((g, i) => {
  const s = chosen[i];
  console.log(`  ${g.label.padEnd(8)} ${String(g.segments.length).padStart(4)} segs   show ${String(s.id).padStart(4)} "${(s.name ?? '').slice(0, 22).padEnd(22)}" ${describe(s)}`);
});

// ---------------------------------------------------------------------------
// 3. sACN sink - real if --sacn, otherwise a buffer so the work is identical
// ---------------------------------------------------------------------------
const UNIVERSES = 16;
const slots = Array.from({ length: UNIVERSES }, () => new Uint8Array(512));
let sacn = null;
if (WANT_SACN) {
  const require = createRequire(`${APP}/package.json`);
  const e131 = require('e131');
  sacn = { clients: [], packets: [], datas: [] };
  for (let u = 0; u < UNIVERSES; u++) {
    const c = new e131.Client(u + 1);
    const p = c.createPacket(512);
    p.setSourceName('Attitude playback PoC');
    p.setUniverse(u + 1);
    p.setPriority(p.DEFAULT_PRIORITY);
    sacn.clients.push(c); sacn.packets.push(p); sacn.datas.push(p.getSlotsData());
  }
  console.log('sACN output ENABLED - make sure PM2 is stopped or two sources will fight');
}
function setSlot(u, c, v) {
  if (u > 0 && u <= UNIVERSES && c > 0 && c <= 512) {
    slots[u - 1][c - 1] = v;
    if (sacn) sacn.datas[u - 1][c - 1] = v;
  }
}

// ---------------------------------------------------------------------------
// 4. Mode A - render, exactly what the device does today
// ---------------------------------------------------------------------------
const engines = groups.map((g, i) => {
  const e = new AttitudeEngine3(paramsFor(chosen[i]));
  e.setFixtureCount(g.segments.length);
  return e;
});

function renderFrame() {
  for (let i = 0; i < groups.length; i++) {
    const e = engines[i];
    e.configure(paramsFor(chosen[i]));   // the fixture manager reconfigures every frame
    e.run();
  }
  for (let i = 0; i < groups.length; i++) {
    const e = engines[i], segs = groups[i].segments;
    e.setFixtureCount(segs.length);
    for (let s = 0; s < segs.length; s++) {
      const col = e.getFixtureColor(s);
      const w = Math.min(col.red, col.green, col.blue);
      const seg = segs[s];
      setSlot(seg.universe, seg.startAddress, GAMMA_TABLE[col.red]);
      setSlot(seg.universe, seg.startAddress + 1, GAMMA_TABLE[col.green]);
      setSlot(seg.universe, seg.startAddress + 2, GAMMA_TABLE[col.blue]);
      if (seg.colorMode === 'RGBW') setSlot(seg.universe, seg.startAddress + 3, GAMMA_TABLE[w]);
    }
  }
}

// ---------------------------------------------------------------------------
// 5. Build the tables - the work the SERVER would do
// ---------------------------------------------------------------------------
const fpb = (speed) => Math.max(1, Math.round((1000 / (speed / 60)) / FRAME_MS));
const tables = [];
let buildNs = 0n, rawBytes = 0;

for (let i = 0; i < groups.length; i++) {
  const p = paramsFor(chosen[i]);
  const segs = groups[i].segments;
  const frames = Math.max(1, p.colors.length * fpb(p.speed) * (p.bounce ? 2 : 1));
  const e = new AttitudeEngine3(p);
  e.setFixtureCount(segs.length);

  const t0 = process.hrtime.bigint();
  const buf = Buffer.alloc(frames * segs.length * 4);   // gamma + white pre-applied
  let o = 0;
  for (let f = 0; f < frames; f++) {
    e.run();
    const all = e.getFixtureColor();
    for (let s = 0; s < segs.length; s++) {
      const c = all[s] ?? { red: 0, green: 0, blue: 0 };
      const w = Math.min(c.red, c.green, c.blue);
      buf[o++] = GAMMA_TABLE[c.red]; buf[o++] = GAMMA_TABLE[c.green];
      buf[o++] = GAMMA_TABLE[c.blue]; buf[o++] = GAMMA_TABLE[w];
    }
  }
  buildNs += process.hrtime.bigint() - t0;
  rawBytes += buf.length;
  tables.push({ buf, frames, stride: segs.length * 4 });
}

console.log(`\ntables built on-device: ${(rawBytes / 1024).toFixed(1)} KB raw, ${(Number(buildNs) / 1e6 / 1000).toFixed(2)} s of CPU`);
console.log('(in the real design the server does this once per show+layout, not the device)');

// ---------------------------------------------------------------------------
// 6. Mode B - playback
// ---------------------------------------------------------------------------
const cursor = new Array(groups.length).fill(0);

function playFrame() {
  for (let i = 0; i < groups.length; i++) {
    const t = tables[i], segs = groups[i].segments;
    let o = cursor[i] * t.stride;
    for (let s = 0; s < segs.length; s++) {
      const seg = segs[s];
      setSlot(seg.universe, seg.startAddress, t.buf[o]);
      setSlot(seg.universe, seg.startAddress + 1, t.buf[o + 1]);
      setSlot(seg.universe, seg.startAddress + 2, t.buf[o + 2]);
      if (seg.colorMode === 'RGBW') setSlot(seg.universe, seg.startAddress + 3, t.buf[o + 3]);
      o += 4;
    }
    cursor[i] = (cursor[i] + 1) % t.frames;
  }
}

// ---------------------------------------------------------------------------
// 7. Measure - same window, same patch, same shows
// ---------------------------------------------------------------------------
function measure(name, fn, seconds) {
  for (let i = 0; i < 40; i++) fn();                 // warm up
  const frames = Math.floor((seconds * 1000) / FRAME_MS);
  let total = 0n, max = 0n;
  for (let f = 0; f < frames; f++) {
    const a = process.hrtime.bigint();
    fn();
    const d = process.hrtime.bigint() - a;
    total += d; if (d > max) max = d;
  }
  const avg = Number(total) / 1e6 / frames;
  const mx = Number(max) / 1e6;
  const duty = (avg / FRAME_MS) * 100;
  console.log(`  ${name.padEnd(10)} avg ${avg.toFixed(3).padStart(8)} ms   max ${mx.toFixed(2).padStart(7)} ms   ${duty.toFixed(1).padStart(6)}% of the ${FRAME_MS}ms budget   max sustainable fps ${(1000 / Math.max(avg, 0.001)).toFixed(0)}`);
  return avg;
}

// ---------------------------------------------------------------------------
// 6b. LIVE mode - real time, real DMX output, so the picture can be checked.
//
// The A/B below is a tight synchronous loop, which blocks the event loop completely: no timer
// can fire inside it, so sACN packets could never be transmitted during a measurement run.
// (Earlier versions of this script accepted --sacn and silently sent nothing.) This mode
// drives the frame loop from setInterval exactly as the firmware does, with an independent
// 24ms send loop, so what leaves the box is real.
//
//   node att-playback-poc.mjs --live play   --sacn --seconds 30
//   node att-playback-poc.mjs --live render --sacn --seconds 30
// ---------------------------------------------------------------------------
if (argv.includes('--live')) {
  const mode = String(flag('--live', 'play'));
  const fn = mode === 'render' ? renderFrame : playFrame;
  console.log(`\nLIVE ${mode} for ${SECONDS}s at ${FRAME_MS}ms${sacn ? ' with sACN output' : ''}`);
  if (!sacn) console.log('WARNING: without --sacn nothing reaches the fixtures.');

  let sent = 0;
  const sendIv = sacn ? setInterval(() => {
    for (let u = 0; u < UNIVERSES; u++) sacn.clients[u].send(sacn.packets[u], () => {});
    sent++;
  }, 24) : null;

  let frames = 0, total = 0n, max = 0n;
  const t0 = process.hrtime.bigint();
  const frameIv = setInterval(() => {
    const a = process.hrtime.bigint();
    fn();
    const d = process.hrtime.bigint() - a;
    total += d; if (d > max) max = d; frames++;
  }, FRAME_MS);

  setTimeout(() => {
    clearInterval(frameIv); if (sendIv) clearInterval(sendIv);
    const secs = Number(process.hrtime.bigint() - t0) / 1e9;
    const avg = Number(total) / 1e6 / Math.max(frames, 1);
    console.log(`  achieved ${(frames / secs).toFixed(1)} fps over ${secs.toFixed(1)}s (ideal ${(1000 / FRAME_MS).toFixed(0)})`);
    console.log(`  work per frame: avg ${avg.toFixed(3)} ms, max ${(Number(max) / 1e6).toFixed(2)} ms`);
    if (sacn) console.log(`  sACN: ${sent} sends (${(sent / secs).toFixed(1)}/s x ${UNIVERSES} universes)`);
    process.exit(0);
  }, SECONDS * 1000);
} else {

console.log(`\nA/B over ${SECONDS}s each, ${groups.length} engines, ${groups.reduce((s, g) => s + g.segments.length, 0)} segments`);
const renderAvg = measure('render', renderFrame, SECONDS);
const playAvg = measure('playback', playFrame, SECONDS);

console.log(`\nspeedup: ${(renderAvg / Math.max(playAvg, 0.000001)).toFixed(1)}x`);
console.log(`headroom freed: ${((renderAvg - playAvg) / FRAME_MS * 100).toFixed(1)} percentage points of the frame budget`);

// what this implies for a throttled unit. AC-0020047 measured 9.6x slower than the bench
// device at 100MHz of 1512, so scale by that rather than guessing.
const THROTTLE = 9.6;
console.log(`\nprojected on a device throttled to 100MHz (x${THROTTLE}, the measured AC-0020047 ratio):`);
console.log(`  render   ${(renderAvg * THROTTLE).toFixed(1)} ms/frame -> ${(renderAvg * THROTTLE) > FRAME_MS ? 'OVER BUDGET, ' + (1000 / (renderAvg * THROTTLE)).toFixed(0) + ' fps' : 'ok'}`);
console.log(`  playback ${(playAvg * THROTTLE).toFixed(1)} ms/frame -> ${(playAvg * THROTTLE) > FRAME_MS ? 'OVER BUDGET, ' + (1000 / (playAvg * THROTTLE)).toFixed(0) + ' fps' : 'holds 40 fps'}`);

if (argv.includes('--dump')) {
  for (let i = 0; i < tables.length; i++) {
    const p = `/tmp/att-table-${groups[i].label}.bin`;
    writeFileSync(p, tables[i].buf);
    console.log(`wrote ${p} (${tables[i].frames} frames)`);
  }
}
}
