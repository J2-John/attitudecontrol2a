// bench/defects.mjs
// Regression tests for the two engine defects found 2026-08-10.
// Run: node bench/defects.mjs      (exit 0 = both fixed)
//
// Both are reachable from show data alone - no unusual hardware or network state.

import { AttitudeEngine3 } from '../AttitudeEngine3.mjs';

const C = (r, g, b) => ({ red: r, green: g, blue: b });
const mk = (n) => Array.from({ length: n }, (_, i) => C((i * 10) % 256, (i * 7) % 256, (i * 3) % 256));

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
  if (!ok) failures++;
};

// Discover RETURN_DATA_ARRAY_LENGTH rather than hard-coding it, so these tests stay valid if
// the base resolution is changed. A Static show always fills exactly one full buffer.
const PIXELS = (() => {
  const probe = new AttitudeEngine3({
    showType: 'Static', direction: 'Left to Right', speed: 50, size: 100, splits: 1,
    transition: 'Both Edges', transitionWidth: 0, bounce: false, colors: [C(1, 2, 3)],
  });
  probe.setFixtureCount(1);
  probe.run();
  return probe.pixelData.length;
})();
console.log(`(base array length detected: ${PIXELS})\n`);

// ---------------------------------------------------------------------------
// Defect 1: Pulse show with exactly one colour
//
// calculatePulseEffect's colour loop starts at index 1, so a single colour produced
// an EMPTY pixelData. expandPixelDataLength() then looped forever trying to grow an
// empty array up to length - an infinite loop, not a throw. run()'s try/catch cannot
// catch a hang. The device's single JS thread stops: no rendering, no sACN, no sync,
// no telemetry, no logs. It presents as a dead unit, and with serveo down there is no
// remote shell to recover it.
// ---------------------------------------------------------------------------
{
  const params = {
    showType: 'Pulse', direction: 'Left to Right', speed: 90, size: 25, splits: 1,
    transition: 'Both Edges', transitionWidth: 0.25, bounce: false, colors: [C(255, 0, 0)],
  };
  const engine = new AttitudeEngine3(params);
  engine.setFixtureCount(79);

  const t0 = Date.now();
  engine.run();
  const elapsed = Date.now() - t0;

  check('Pulse with 1 colour terminates', elapsed < 1000, `${elapsed} ms`);
  check('Pulse with 1 colour fills the array', engine.pixelData.length === PIXELS, `length ${engine.pixelData.length}`);

  const colors = engine.getFixtureColor();
  const solid = colors.every((c) => c && c.red === 255 && c.green === 0 && c.blue === 0);
  check('Pulse with 1 colour renders that colour solid', solid);
}

// ---------------------------------------------------------------------------
// Defect 2: large Pulse intermediate arrays
//
// Pulse builds (colours - 1) x (5000 x size/100 + 5000) pixels before trimming. At
// size 200 with 10+ colours that is 135,000+ pixels, and expandPixelDataLength used
// push(...array), which passes one argument per element. Past the engine's argument
// limit that throws RangeError, which run() swallows - the show silently rendered as
// the fallback colour instead of erroring visibly.
// ---------------------------------------------------------------------------
{
  for (const [count, size] of [[10, 200], [15, 200], [25, 200], [25, 100]]) {
    const params = {
      showType: 'Pulse', direction: 'Left to Right', speed: 90, size, splits: 1,
      transition: 'Both Edges', transitionWidth: 0.25, bounce: false, colors: mk(count),
    };
    const engine = new AttitudeEngine3(params);
    engine.setFixtureCount(79);

    let swallowed = null;
    const realError = console.error;
    console.error = (...a) => { swallowed = a.map(String).join(' '); };
    engine.run();
    console.error = realError;

    check(
      `Pulse ${count} colours at size ${size} renders without a swallowed error`,
      swallowed === null && engine.pixelData.length === PIXELS,
      swallowed ? swallowed.slice(0, 70) : `length ${engine.pixelData.length}`
    );
  }
}

// ---------------------------------------------------------------------------
// Guard: expanding an empty array must throw rather than hang, whatever the caller
// ---------------------------------------------------------------------------
{
  const engine = new AttitudeEngine3({
    showType: 'Static', direction: 'Left to Right', speed: 50, size: 100, splits: 1,
    transition: 'Both Edges', transitionWidth: 0, bounce: false, colors: [C(1, 2, 3)],
  });
  engine.pixelData = [];
  let threw = false;
  const t0 = Date.now();
  try { engine.expandPixelDataLength(); } catch (e) { threw = true; }
  check('expandPixelDataLength on an empty array throws instead of hanging', threw && Date.now() - t0 < 1000);
}

console.log(`\n${failures === 0 ? 'all defect tests passed' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
