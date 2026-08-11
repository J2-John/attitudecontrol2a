// bench/frame.mjs
// Whole-frame A/B: baseline engine vs optimised engine, running the same work the
// fixture manager does every 25 ms - configure each engine, run it, then walk every
// segment applying white extraction, gamma and a stub sACN write.
//
// Run: node bench/frame.mjs

import { AttitudeEngine3 as Baseline } from './AttitudeEngine3.baseline.mjs';
import { AttitudeEngine3 as Optimised } from '../AttitudeEngine3.mjs';

const C = (r, g, b) => ({ red: r, green: g, blue: b });
const P5 = [C(255, 0, 0), C(255, 128, 0), C(0, 255, 0), C(0, 128, 255), C(128, 0, 255)];
const P3 = [C(255, 0, 0), C(255, 255, 255), C(0, 0, 255)];

// four engines, matching the 'engines=4 segs=79' seen on the bench device
const SHOWS = [
  { showType: 'Chase',  direction: 'Left to Right',  speed: 90,  size: 25,  splits: 1, transition: 'Both Edges', transitionWidth: 0.25, bounce: false, colors: P5 },
  { showType: 'All',    direction: 'Left to Right',  speed: 60,  size: 100, splits: 1, transition: 'Both Edges', transitionWidth: 1,    bounce: false, colors: P3 },
  { showType: 'Static', direction: 'Left to Right',  speed: 50,  size: 100, splits: 1, transition: 'Both Edges', transitionWidth: 0,    bounce: false, colors: P3 },
  { showType: 'Chase',  direction: 'Middle to Ends', speed: 120, size: 100, splits: 2, transition: 'Both Edges', transitionWidth: 1,    bounce: false, colors: P5 },
];

const SEGMENTS = 79;
const FRAMES = 600;
const GAMMA = 1.7;

// --- fixture manager work, current implementation ---
const applyGammaPow = (v) => Math.round(Math.pow(v / 255, GAMMA) * 255);

// --- fixture manager work, lookup table variant ---
// inputs are integers 0-255 (engine colours are validated integers and every fade
// result is Math.round'ed), so the table is exact, not an approximation. Anything
// outside that domain falls through to the original computation.
const GAMMA_LUT = new Uint8Array(256);
for (let i = 0; i < 256; i++) GAMMA_LUT[i] = Math.round(Math.pow(i / 255, GAMMA) * 255);
const applyGammaLut = (v) => (Number.isInteger(v) && v >= 0 && v <= 255 ? GAMMA_LUT[v] : applyGammaPow(v));

// stub sACN sink so the DMX writes are represented but do no I/O
const sink = new Uint8Array(8 * 513);
let sinkGuard = 0;
const sacnSet = (u, c, v) => { sink[u * 513 + (c % 513)] = v; sinkGuard += v; };

function runVariant(EngineClass, applyGamma, frames) {
  const engines = SHOWS.map((s) => {
    const e = new EngineClass({ ...s });
    e.setFixtureCount(SEGMENTS);
    return e;
  });

  // segments look like what calculateAllFixtureSegments produces
  const segments = Array.from({ length: SEGMENTS }, (_, i) => ({
    universe: 1 + ((i / 170) | 0),
    startAddress: 1 + (i % 170) * 3,
    colorMode: i % 4 === 0 ? 'RGBW' : 'RGB',
    highlight: false,
  }));

  // warm up
  for (let f = 0; f < 80; f++) {
    for (const e of engines) { e.configure({ ...SHOWS[0], colors: SHOWS[0].colors }); e.run(); e.getFixtureColor(0); }
  }

  let engNs = 0n, patchNs = 0n;
  for (let f = 0; f < frames; f++) {
    const t0 = process.hrtime.bigint();
    // processEngineInstances: the fixture manager reconfigures every engine every frame
    for (let i = 0; i < engines.length; i++) {
      engines[i].configure({
        showType: SHOWS[i].showType, direction: SHOWS[i].direction, speed: SHOWS[i].speed,
        size: SHOWS[i].size, splits: SHOWS[i].splits, transition: SHOWS[i].transition,
        transitionWidth: SHOWS[i].transitionWidth, bounce: SHOWS[i].bounce, colors: SHOWS[i].colors,
      });
      engines[i].run();
    }
    const t1 = process.hrtime.bigint();

    // processPatchAndOutputShows -> applyShowToFixtures
    for (let i = 0; i < engines.length; i++) {
      const e = engines[i];
      e.setFixtureCount(SEGMENTS);
      for (let s = 0; s < SEGMENTS; s++) {
        const col = e.getFixtureColor(s);
        const white = Math.min(col.red, col.green, col.blue);
        const r = applyGamma(col.red), g = applyGamma(col.green), b = applyGamma(col.blue), w = applyGamma(white);
        const seg = segments[s];
        sacnSet(seg.universe, seg.startAddress, r);
        sacnSet(seg.universe, seg.startAddress + 1, g);
        sacnSet(seg.universe, seg.startAddress + 2, b);
        if (seg.colorMode === 'RGBW') sacnSet(seg.universe, seg.startAddress + 3, w);
      }
    }
    const t2 = process.hrtime.bigint();

    engNs += t1 - t0;
    patchNs += t2 - t1;
  }

  const ms = (n) => Number(n) / 1e6 / frames;
  return { eng: ms(engNs), patch: ms(patchNs) };
}

console.log(`Whole-frame A/B  —  4 engines, ${SEGMENTS} segments, ${FRAMES} frames, node ${process.version}\n`);

const a = runVariant(Baseline, applyGammaPow, FRAMES);
const b = runVariant(Optimised, applyGammaPow, FRAMES);
const c = runVariant(Optimised, applyGammaLut, FRAMES);

const row = (label, r) =>
  label.padEnd(38) +
  r.eng.toFixed(3).padStart(9) +
  r.patch.toFixed(3).padStart(9) +
  (r.eng + r.patch).toFixed(3).padStart(9);

console.log('variant'.padEnd(38) + 'eng'.padStart(9) + 'patch'.padStart(9) + 'total'.padStart(9) + '   (ms/frame)');
console.log('-'.repeat(74));
console.log(row('baseline engine + Math.pow gamma', a));
console.log(row('cached engine  + Math.pow gamma', b));
console.log(row('cached engine  + gamma LUT', c));

console.log('\nspeedup vs baseline');
console.log(`  engine phase : ${(a.eng / b.eng).toFixed(2)}x`);
console.log(`  patch phase  : ${(a.patch / c.patch).toFixed(2)}x`);
console.log(`  whole frame  : ${((a.eng + a.patch) / (c.eng + c.patch)).toFixed(2)}x`);

// verify the gamma LUT is bit-identical over its whole domain
let lutOk = true;
for (let i = 0; i < 256; i++) if (applyGammaLut(i) !== applyGammaPow(i)) lutOk = false;
console.log(`\ngamma LUT identical to Math.pow across all 256 inputs: ${lutOk ? 'YES' : 'NO - DO NOT SHIP'}`);
console.log(`(sink guard ${sinkGuard} - keeps the optimiser from eliding the DMX writes)`);
