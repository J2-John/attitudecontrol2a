// bench/module-smoke.mjs
// Loads every module the firmware entrypoint loads, then checks the method contracts between
// modules that call into each other.
//
// WHY THIS EXISTS: on 2026-08-10 a release shipped a fixture manager calling
// engine.setFrameInterval() alongside an engine that did not have it. The device installed
// cleanly, stayed up, kept syncing, and passed update.sh's health check - while
// AttitudeFixtureManager threw on every single frame and no DMX moved. The lights froze.
//
// golden.mjs and defects.mjs could not have caught it: both exercise AttitudeEngine3 in
// ISOLATION and never load the fixture manager, so a cross-file contract break is invisible
// to them. This check takes about a second and closes that gap.
//
//   node bench/module-smoke.mjs        exit 0 = the firmware can at least load and wire up

const MODULES = [
  'Logger.mjs', 'EventHub.mjs', 'AttitudeScheduler.mjs', 'AttitudeFixtureManager.mjs',
  'AttitudeSACN2A.mjs', 'AttitudeLED2A.mjs', 'AttitudeSenseManager.mjs',
  'AttitudeEmitManager.mjs', 'IdManager.mjs', 'ConfigManager.mjs', 'NetworkModule.mjs',
  'StatusTracker.mjs', 'ModuleStatusTracker.mjs', 'MacrosModule.mjs', 'UDPManager.mjs',
  'ShowTableStore.mjs', 'AttitudeEngine3.mjs',
];

// Methods one module calls on another. Every entry here is a real call site; if the callee
// stops providing one, the caller throws at runtime rather than at load, which is exactly the
// failure this file exists to prevent.
const CONTRACTS = [
  { on: 'AttitudeEngine3', methods: [
      'run', 'configure', 'setFixtureCount', 'getFixtureColor',
      'incrementFrameCounter',   // AttitudeFixtureManager, table-covered path
      'setFrameInterval',        // AttitudeFixtureManager.generateEngineInstances
    ] },
  { on: 'showTableStore', methods: [
      'advance', 'registerNeed', 'get', 'offsetFor', 'isFullyCovered',
      'getHashes', 'getNeeds', 'applyFromResponse', 'summary', 'resetWindow',
    ] },
];

let failures = 0;
const fail = (msg) => { console.log('FAIL  ' + msg); failures++; };
const pass = (msg) => console.log('PASS  ' + msg);

for (const m of MODULES) {
  try {
    await import('../' + m);
    pass('loads ' + m);
  } catch (err) {
    fail(`loading ${m}: ${err.message}`);
  }
}

// engine instance contract
try {
  const { AttitudeEngine3 } = await import('../AttitudeEngine3.mjs');
  const engine = new AttitudeEngine3({
    showType: 'Static', direction: 'Left to Right', speed: 50, size: 100, splits: 1,
    transition: 'Both Edges', transitionWidth: 0, bounce: false,
    colors: [{ red: 1, green: 2, blue: 3 }],
  });
  for (const method of CONTRACTS[0].methods) {
    if (typeof engine[method] === 'function') pass(`AttitudeEngine3.${method}()`);
    else fail(`AttitudeEngine3 is missing ${method}() - a caller will throw at runtime`);
  }
} catch (err) {
  fail('constructing AttitudeEngine3: ' + err.message);
}

// table store contract
try {
  const store = (await import('../ShowTableStore.mjs')).default;
  for (const method of CONTRACTS[1].methods) {
    if (typeof store[method] === 'function') pass(`showTableStore.${method}()`);
    else fail(`ShowTableStore is missing ${method}() - AttitudeFixtureManager will throw`);
  }
} catch (err) {
  fail('loading ShowTableStore: ' + err.message);
}

console.log(`\n${failures === 0 ? 'firmware modules load and all contracts are satisfied' : failures + ' FAILURE(S) - do not ship'}`);

// Several modules start intervals on import (sACN FPS counter, status trackers), so the event
// loop will not drain on its own. Exit explicitly.
process.exit(failures === 0 ? 0 : 1);
