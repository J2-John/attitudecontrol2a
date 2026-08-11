// bench/resolution.mjs
// What does RETURN_DATA_ARRAY_LENGTH actually buy?
//
// Builds variants of the engine at different base-array lengths, then measures three
// separate things, because "quality" here is three different things:
//
//   1. CPU        - ms per frame at a realistic segment count
//   2. Coverage   - what fraction of the pattern never reaches a fixture at all.
//                   getFixtureColor decimates with stride floor(L / N), so the tail
//                   L - N*floor(L/N) is sampled by nothing. In a moving show that tail
//                   is a hitch once per cycle.
//   3. Motion     - how often a frame is identical to the one before it. The rotation
//                   distance is rounded to whole base pixels, so when the per-frame
//                   advance falls below one pixel the pattern freezes and then jumps.
//
// Run: node bench/resolution.mjs

import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';

const LENGTHS = [5000, 2500, 2000, 1000, 500];
const TMP = new URL('./.resolution-tmp/', import.meta.url);

const C = (r, g, b) => ({ red: r, green: g, blue: b });
const P2 = [C(255, 0, 0), C(0, 0, 255)];
const P5 = [C(255, 0, 0), C(255, 128, 0), C(0, 255, 0), C(0, 128, 255), C(128, 0, 255)];
const P25 = Array.from({ length: 25 }, (_, i) => C((i * 37) % 256, (i * 91) % 256, (i * 53) % 256));

const SHOWS = [
  { name: 'Chase 5col sz25 tw0.25 sp90',  showType: 'Chase',  direction: 'Left to Right', speed: 90,  size: 25,  splits: 1, transition: 'Both Edges', transitionWidth: 0.25, bounce: false, colors: P5 },
  { name: 'Chase 2col sz100 tw1 sp10',    showType: 'Chase',  direction: 'Left to Right', speed: 10,  size: 100, splits: 1, transition: 'Both Edges', transitionWidth: 1,    bounce: false, colors: P2 },
  { name: 'All   5col tw1 sp60',          showType: 'All',    direction: 'Left to Right', speed: 60,  size: 100, splits: 1, transition: 'Both Edges', transitionWidth: 1,    bounce: false, colors: P5 },
  { name: 'Pulse 5col sz20 sp90',         showType: 'Pulse',  direction: 'Left to Right', speed: 90,  size: 20,  splits: 1, transition: 'Both Edges', transitionWidth: 0.25, bounce: false, colors: P5 },
  { name: 'Chase 25col sz10 tw1 sp10',    showType: 'Chase',  direction: 'Left to Right', speed: 10,  size: 10,  splits: 1, transition: 'Both Edges', transitionWidth: 1,    bounce: false, colors: P25 },
  { name: 'Static 5col tw1',              showType: 'Static', direction: 'Left to Right', speed: 50,  size: 100, splits: 1, transition: 'Both Edges', transitionWidth: 1,    bounce: false, colors: P5 },
];

const FIXTURE_COUNTS = [12, 79, 240];
const FRAMES = 300;

// ---------- build one engine module per base length ----------
try { rmSync(TMP, { recursive: true, force: true }); } catch {}
mkdirSync(TMP, { recursive: true });

const source = readFileSync(new URL('../AttitudeEngine3.mjs', import.meta.url), 'utf8');
const engines = {};
for (const L of LENGTHS) {
  const patched = source
    .replace(/const RETURN_DATA_ARRAY_LENGTH = \d+;/, `const RETURN_DATA_ARRAY_LENGTH = ${L};`)
    .replace(/from '\.\/(ShowTypes|Directions|Transitions)\.js'/g, "from '../../$1.js'");
  const file = new URL(`./engine-${L}.mjs`, TMP);
  writeFileSync(file, patched);
  engines[L] = (await import(file.href)).AttitudeEngine3;
}

// ---------- helpers ----------
function capture(EngineClass, params, fixtureCount, frames) {
  const engine = new EngineClass({ ...params });
  engine.setFixtureCount(fixtureCount);
  const out = [];
  for (let f = 0; f < frames; f++) {
    engine.run();
    const all = engine.getFixtureColor();
    const row = new Uint8Array(fixtureCount * 3);
    for (let i = 0; i < fixtureCount; i++) {
      const c = all[i] ?? { red: 0, green: 0, blue: 0 };
      row[i * 3] = c.red; row[i * 3 + 1] = c.green; row[i * 3 + 2] = c.blue;
    }
    out.push(row);
  }
  return out;
}

function timePerFrame(EngineClass, params, fixtureCount, frames) {
  const engine = new EngineClass({ ...params });
  engine.setFixtureCount(fixtureCount);
  for (let f = 0; f < 100; f++) { engine.run(); engine.getFixtureColor(); }
  const t0 = process.hrtime.bigint();
  for (let f = 0; f < frames; f++) {
    engine.run();
    for (let i = 0; i < fixtureCount; i++) engine.getFixtureColor(i);
  }
  return Number(process.hrtime.bigint() - t0) / 1e6 / frames;
}

// fraction of frames that are byte-identical to the previous frame
function freezeRate(rows) {
  let frozen = 0;
  for (let f = 1; f < rows.length; f++) {
    let same = true;
    const a = rows[f], b = rows[f - 1];
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { same = false; break; }
    if (same) frozen++;
  }
  return (100 * frozen) / (rows.length - 1);
}

// mean absolute per-channel change between consecutive frames - how much the picture
// actually moves each frame. A show that freezes then jumps has the same average as a
// smooth one, so this is reported next to the freeze rate, not instead of it.
function meanStep(rows) {
  let total = 0, n = 0;
  for (let f = 1; f < rows.length; f++) {
    const a = rows[f], b = rows[f - 1];
    for (let i = 0; i < a.length; i++) { total += Math.abs(a[i] - b[i]); n++; }
  }
  return total / n;
}

// largest per-channel jump between physically adjacent fixtures, averaged over frames.
// On a smooth fade this is the banding measure: bigger steps between neighbours = coarser.
function meanAdjacentJump(rows, fixtureCount) {
  let total = 0, n = 0;
  for (const row of rows) {
    for (let i = 1; i < fixtureCount; i++) {
      for (let c = 0; c < 3; c++) total += Math.abs(row[i * 3 + c] - row[(i - 1) * 3 + c]);
      n += 3;
    }
  }
  return total / n;
}

const coverage = (L, N) => (100 * N * Math.floor(L / N)) / L;

// ---------- 1. coverage is pure arithmetic, no engine needed ----------
console.log('1. PATTERN COVERAGE  -  percent of the base array that any fixture ever samples');
console.log('   getFixtureColor strides by floor(L/N); the remainder is never shown.\n');
console.log('   L'.padEnd(8) + FIXTURE_COUNTS.map((n) => `N=${n}`.padStart(12)).join(''));
console.log('   ' + '-'.repeat(6 + 12 * FIXTURE_COUNTS.length));
for (const L of LENGTHS) {
  console.log(
    ('   ' + L).padEnd(8) +
    FIXTURE_COUNTS.map((n) => (coverage(L, n).toFixed(1) + '%').padStart(12)).join('')
  );
}

// ---------- 2. CPU ----------
console.log('\n\n2. CPU  -  ms per frame, one engine, 79 segments (median of 3)\n');
console.log('   L'.padEnd(8) + 'ms/frame'.padStart(11) + 'vs 5000'.padStart(11) + '   show');
console.log('   ' + '-'.repeat(48));
const cpuTotals = {};
for (const L of LENGTHS) cpuTotals[L] = 0;
for (const show of SHOWS) {
  const { name, ...params } = show;
  const base = [];
  for (const L of LENGTHS) {
    const samples = [0, 1, 2].map(() => timePerFrame(engines[L], params, 79, FRAMES));
    samples.sort((a, b) => a - b);
    base.push({ L, ms: samples[1] });
    cpuTotals[L] += samples[1];
  }
  const ref = base.find((x) => x.L === 5000).ms;
  for (const { L, ms } of base) {
    console.log(
      ('   ' + L).padEnd(8) +
      ms.toFixed(3).padStart(11) +
      (ms > 0 ? (ref / ms).toFixed(2) + 'x' : '-').padStart(11) +
      '   ' + (L === 5000 ? name : '')
    );
  }
  console.log('');
}
console.log('   totals across all six shows:');
for (const L of LENGTHS) {
  console.log(
    ('   ' + L).padEnd(8) +
    cpuTotals[L].toFixed(3).padStart(11) +
    (cpuTotals[5000] / cpuTotals[L]).toFixed(2).padStart(10) + 'x'
  );
}

// ---------- 3. motion quality ----------
console.log('\n\n3. MOTION  -  frozen frames (identical to previous) and mean per-frame change');
console.log('   at 79 segments. A high freeze rate is visible stutter, not smooth slow motion.\n');
for (const show of SHOWS) {
  const { name, ...params } = show;
  console.log('   ' + name);
  console.log('      L'.padEnd(11) + 'frozen'.padStart(10) + 'step'.padStart(9) + 'adjJump'.padStart(10));
  for (const L of LENGTHS) {
    const rows = capture(engines[L], params, 79, FRAMES);
    console.log(
      ('      ' + L).padEnd(11) +
      (freezeRate(rows).toFixed(1) + '%').padStart(10) +
      meanStep(rows).toFixed(2).padStart(9) +
      meanAdjacentJump(rows, 79).toFixed(2).padStart(10)
    );
  }
  console.log('');
}

// ---------- 4. how different does it actually look ----------
console.log('\n4. DIFFERENCE FROM L=5000  -  mean and max per-channel difference, frame for');
console.log('   frame, 79 segments. Includes phase drift, so read it as "does this render the');
console.log('   same show", not as an error bar.\n');
console.log('   L'.padEnd(8) + 'meanDiff'.padStart(11) + 'maxDiff'.padStart(10) + '  show');
console.log('   ' + '-'.repeat(52));
for (const show of SHOWS) {
  const { name, ...params } = show;
  const ref = capture(engines[5000], params, 79, FRAMES);
  for (const L of LENGTHS) {
    if (L === 5000) continue;
    const rows = capture(engines[L], params, 79, FRAMES);
    let total = 0, n = 0, max = 0;
    for (let f = 0; f < ref.length; f++) {
      for (let i = 0; i < ref[f].length; i++) {
        const d = Math.abs(ref[f][i] - rows[f][i]);
        total += d; n++; if (d > max) max = d;
      }
    }
    console.log(
      ('   ' + L).padEnd(8) +
      (total / n).toFixed(2).padStart(11) +
      String(max).padStart(10) +
      '  ' + (L === 2500 ? name : '')
    );
  }
  console.log('');
}

try { rmSync(TMP, { recursive: true, force: true }); } catch {}
