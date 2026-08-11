// bench/profile.mjs
// Phase-level profiler for AttitudeEngine3. Read-only: wraps prototype methods
// with timers, changes no behaviour. Run: node bench/profile.mjs

import { AttitudeEngine3 } from '../AttitudeEngine3.mjs';

// ---------- realistic show definitions ----------
const C = (r, g, b) => ({ red: r, green: g, blue: b });

const PALETTE_5 = [C(255, 0, 0), C(255, 128, 0), C(0, 255, 0), C(0, 128, 255), C(128, 0, 255)];
const PALETTE_3 = [C(255, 0, 0), C(255, 255, 255), C(0, 0, 255)];
const PALETTE_1 = [C(255, 180, 60)];

const SHOWS = [
  { name: 'Static/1col',        showType: 'Static', direction: 'Left to Right', speed: 50,  size: 100, splits: 1, transition: 'Both Edges',  transitionWidth: 0,    bounce: false, colors: PALETTE_1 },
  { name: 'All fade/3col',      showType: 'All',    direction: 'Left to Right', speed: 60,  size: 100, splits: 1, transition: 'Both Edges',  transitionWidth: 1,    bounce: false, colors: PALETTE_3 },
  { name: 'Chase/5col sz10',    showType: 'Chase',  direction: 'Left to Right', speed: 90,  size: 10,  splits: 1, transition: 'Both Edges',  transitionWidth: 0.25, bounce: false, colors: PALETTE_5 },
  { name: 'Chase/5col sz100',   showType: 'Chase',  direction: 'Middle to Ends',speed: 120, size: 100, splits: 2, transition: 'Both Edges',  transitionWidth: 1,    bounce: false, colors: PALETTE_5 },
  { name: 'Pulse/5col sz20',    showType: 'Pulse',  direction: 'Left to Right', speed: 90,  size: 20,  splits: 1, transition: 'Both Edges',  transitionWidth: 0.25, bounce: false, colors: PALETTE_5 },
  { name: 'Pulse/5col sz200*',  showType: 'Pulse',  direction: 'Left to Right', speed: 90,  size: 200, splits: 1, transition: 'Both Edges',  transitionWidth: 0.25, bounce: false, colors: PALETTE_5 },
  { name: 'Chase/5col RANDOM',  showType: 'Chase',  direction: 'Random',        speed: 90,  size: 25,  splits: 3, transition: 'Leading Edge',transitionWidth: 0.5,  bounce: true,  colors: PALETTE_5 },
];

const SEGMENTS = 79;   // matches Cloud10 Mechanicsburg
const FRAMES = 400;

// ---------- instrumentation ----------
const PHASES = [
  'calculateColorBase', 'flipPixelData', 'processCirculation', 'processSize',
  'expandPixelDataLength', 'trimPixelDataLength', 'processDirections',
  'processSplits', 'validatePixelDataLength', 'splitArrayIntoNumberOfItems',
  'masterFadeFunction',
];

const acc = Object.create(null);
const calls = Object.create(null);
function resetAcc() { for (const p of PHASES) { acc[p] = 0n; calls[p] = 0; } }
resetAcc();

for (const p of PHASES) {
  const orig = AttitudeEngine3.prototype[p];
  if (typeof orig !== 'function') { console.error('missing method', p); continue; }
  AttitudeEngine3.prototype[p] = function (...args) {
    const t0 = process.hrtime.bigint();
    const r = orig.apply(this, args);
    acc[p] += process.hrtime.bigint() - t0;
    calls[p]++;
    return r;
  };
}

const ms = (n) => Number(n) / 1e6;

// ---------- run ----------
console.log(`AttitudeEngine3 phase profile  —  ${FRAMES} frames, ${SEGMENTS} segments/engine, node ${process.version}\n`);
console.log('show                    run(ms/f)  fetch(ms/f)  total(ms/f)   peak pixelData');
console.log('-'.repeat(80));

const results = [];
for (const show of SHOWS) {
  const { name, ...params } = show;
  const engine = new AttitudeEngine3(params);
  engine.setFixtureCount(SEGMENTS);

  // warm up JIT
  for (let i = 0; i < 60; i++) { engine.run(); engine.getFixtureColor(0); }

  resetAcc();
  let peak = 0;
  const tRun0 = process.hrtime.bigint();
  let runNs = 0n, fetchNs = 0n;
  for (let f = 0; f < FRAMES; f++) {
    const a = process.hrtime.bigint();
    engine.run();
    const b = process.hrtime.bigint();
    for (let s = 0; s < SEGMENTS; s++) engine.getFixtureColor(s);
    const c = process.hrtime.bigint();
    runNs += b - a; fetchNs += c - b;
    if (engine.pixelData.length > peak) peak = engine.pixelData.length;
  }

  const perFrameRun = ms(runNs) / FRAMES;
  const perFrameFetch = ms(fetchNs) / FRAMES;
  console.log(
    name.padEnd(22) +
    perFrameRun.toFixed(3).padStart(10) +
    perFrameFetch.toFixed(3).padStart(13) +
    (perFrameRun + perFrameFetch).toFixed(3).padStart(13) +
    String(peak).padStart(17)
  );

  const phases = PHASES
    .filter((p) => calls[p] > 0)
    .map((p) => ({ p, ms: ms(acc[p]) / FRAMES, n: calls[p] / FRAMES }))
    .sort((a, b) => b.ms - a.ms);
  results.push({ name, perFrameRun, perFrameFetch, phases });
}

console.log('\n\nper-phase breakdown (ms per frame, calls per frame)');
console.log('='.repeat(80));
for (const r of results) {
  console.log(`\n${r.name}`);
  for (const ph of r.phases) {
    if (ph.ms < 0.0005) continue;
    console.log('   ' + ph.p.padEnd(30) + ph.ms.toFixed(3).padStart(8) + ' ms' + ('  x' + ph.n.toFixed(0)).padStart(9));
  }
}

// ---------- what a whole device does ----------
console.log('\n\nwhole-device estimate: 4 engines @ 40fps, 79 segments each');
console.log('='.repeat(80));
const typical = results.filter((r) => !r.name.includes('*'));
const avg = typical.reduce((s, r) => s + r.perFrameRun + r.perFrameFetch, 0) / typical.length;
console.log(`avg per engine per frame : ${avg.toFixed(3)} ms`);
console.log(`4 engines per frame      : ${(avg * 4).toFixed(3)} ms   (frame budget is 25 ms)`);
console.log(`bench device measured    : 13.43 ms total (eng 7.02 + patch 6.34)`);
console.log(`\nNOTE: this x86 box is far faster than an S905X A53 core. Ratios are what transfer,`);
console.log(`not absolute ms. Scale by the ratio of this box's 4-engine figure to the bench 7.02 ms.`);
