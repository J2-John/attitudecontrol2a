// bench/golden.mjs
// Captures a fingerprint of engine output across a wide parameter sweep.
// Usage:
//   node bench/golden.mjs capture out.json     # record from current engine
//   node bench/golden.mjs verify  out.json     # compare current engine to record
//
// Any behavioural change to AttitudeEngine3 shows up as a differing hash.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { AttitudeEngine3 } from '../AttitudeEngine3.mjs';

const C = (r, g, b) => ({ red: r, green: g, blue: b });

const COLOR_SETS = [
  [C(255, 180, 60)],
  [C(255, 0, 0), C(0, 0, 255)],
  [C(255, 0, 0), C(255, 255, 255), C(0, 0, 255)],
  [C(255, 0, 0), C(255, 128, 0), C(0, 255, 0), C(0, 128, 255), C(128, 0, 255)],
  [C(12, 200, 7), C(3, 3, 3), C(250, 1, 99), C(0, 0, 0), C(255, 255, 255), C(40, 40, 200), C(9, 250, 250)],
];

const SHOWTYPES = ['Static', 'All', 'Chase', 'Pulse'];
const DIRECTIONS = ['Left to Right', 'Right to Left', 'Middle to Ends', 'Ends to Middle'];
const TRANSITIONS = ['Both Edges', 'Leading Edge', 'Trailing Edge'];
const SIZES = [1, 10, 25, 100, 200];
const SPLITS = [1, 2, 5];
const TWIDTHS = [0, 0.25, 1];
const SPEEDS = [10, 90, 180];
const FIXCOUNTS = [12, 79];

// Deterministic pseudo-random so the sweep is reproducible but broad.
let seed = 1337;
function rnd(n) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; }

// Two parameter regions are excluded from the equivalence sweep because the
// CURRENT engine cannot execute them, so there is no baseline to compare to.
// Both are defects, confirmed by execution 2026-08-10, and are fixed separately:
//   - Pulse with exactly 1 colour  -> expandPixelDataLength() spins forever on an
//     empty array. Hard hang of the JS thread, not an exception.
//   - Pulse with a large intermediate array (roughly colours >= 10 at size 200)
//     -> push(...arr) exceeds the argument limit, RangeError, swallowed by run().
// bench/defects.mjs covers these cases explicitly.
function isExcluded(p) {
  if (p.showType !== 'Pulse') return false;
  if (p.colors.length === 1) return true;
  if (p.size > 100) return true;
  return false;
}

function buildCases() {
  const cases = [];
  // exhaustive over the axes that interact most
  for (const showType of SHOWTYPES) {
    for (const direction of DIRECTIONS) {
      for (const transition of TRANSITIONS) {
        for (const transitionWidth of TWIDTHS) {
          cases.push({
            showType, direction, transition, transitionWidth,
            speed: SPEEDS[rnd(SPEEDS.length)],
            size: SIZES[rnd(SIZES.length)],
            splits: SPLITS[rnd(SPLITS.length)],
            bounce: rnd(2) === 1,
            colors: COLOR_SETS[rnd(COLOR_SETS.length)],
          });
        }
      }
    }
  }
  // plus a randomised tail over every axis including size/splits/colors
  for (let i = 0; i < 150; i++) {
    cases.push({
      showType: SHOWTYPES[rnd(SHOWTYPES.length)],
      direction: DIRECTIONS[rnd(DIRECTIONS.length)],
      transition: TRANSITIONS[rnd(TRANSITIONS.length)],
      transitionWidth: TWIDTHS[rnd(TWIDTHS.length)],
      speed: SPEEDS[rnd(SPEEDS.length)],
      size: SIZES[rnd(SIZES.length)],
      splits: SPLITS[rnd(SPLITS.length)],
      bounce: rnd(2) === 1,
      colors: COLOR_SETS[rnd(COLOR_SETS.length)],
    });
  }
  return cases;
}

const FRAMES = 24;

function fingerprint(params, fixtureCount) {
  // 'Random' direction is excluded from the sweep: it uses Math.random at
  // construction, so it is not reproducible across processes by design.
  const engine = new AttitudeEngine3(params);
  engine.setFixtureCount(fixtureCount);
  const h = createHash('sha1');
  for (let f = 0; f < FRAMES; f++) {
    engine.run();
    const all = engine.getFixtureColor();
    for (let i = 0; i < fixtureCount; i++) {
      const c = all[i] ?? { red: -1, green: -1, blue: -1 };
      h.update(`${c.red},${c.green},${c.blue};`);
    }
    // also fingerprint the indexed accessor, which is the path the fixture
    // manager actually uses
    const one = engine.getFixtureColor(Math.min(fixtureCount - 1, f % fixtureCount));
    h.update(`|${one.red},${one.green},${one.blue}|`);
  }
  return h.digest('hex').slice(0, 16);
}

function runSweep() {
  const cases = buildCases().filter((p) => !isExcluded(p));
  const out = [];
  for (const params of cases) {
    for (const fc of FIXCOUNTS) {
      let hash;
      try {
        hash = fingerprint(params, fc);
      } catch (e) {
        hash = 'THREW:' + String(e.message).slice(0, 60);
      }
      out.push({ k: JSON.stringify(params) + '#' + fc, h: hash });
    }
  }
  return out;
}

const mode = process.argv[2];
const file = process.argv[3] || 'bench/golden.json';

if (mode === 'capture') {
  const res = runSweep();
  writeFileSync(file, JSON.stringify(res, null, 0));
  const threw = res.filter((r) => r.h.startsWith('THREW')).length;
  console.log(`captured ${res.length} fingerprints -> ${file}  (${threw} of them are thrown errors, recorded as-is)`);
} else if (mode === 'verify') {
  const prev = JSON.parse(readFileSync(file, 'utf8'));
  const now = runSweep();
  const prevMap = new Map(prev.map((r) => [r.k, r.h]));
  let same = 0, diff = 0;
  const examples = [];
  for (const r of now) {
    const p = prevMap.get(r.k);
    if (p === undefined) continue;
    if (p === r.h) same++;
    else { diff++; if (examples.length < 8) examples.push({ case: r.k, was: p, now: r.h }); }
  }
  console.log(`identical: ${same}   DIFFERENT: ${diff}   (of ${now.length})`);
  for (const e of examples) {
    console.log('\n  MISMATCH ' + e.case);
    console.log('    was ' + e.was + '   now ' + e.now);
  }
  process.exit(diff === 0 ? 0 : 1);
} else {
  console.log('usage: node bench/golden.mjs capture|verify [file]');
  process.exit(2);
}
