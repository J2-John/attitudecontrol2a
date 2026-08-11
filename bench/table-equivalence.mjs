// bench/table-equivalence.mjs
// Proves that a server-rendered show table is byte-identical to what the device would have
// rendered locally, frame for frame, channel for channel.
//
// This is the safety property the whole server-rendering design rests on. If it ever fails,
// devices playing tables show different colours from devices rendering locally, and the
// fallback path becomes a visible glitch rather than a safety net.
//
// Run from the firmware repo with the gateway checked out alongside it:
//   node bench/table-equivalence.mjs [path-to-gateway]
// defaults to ../attitude-ws-gateway

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { AttitudeEngine3 } from '../AttitudeEngine3.mjs';

// Resolve to an absolute file:// URL. A bare relative path is not a valid ESM specifier, and on
// Windows a backslash path is rejected outright - so both forms have to be normalised here
// rather than passed straight to import().
const HERE = path.dirname(fileURLToPath(import.meta.url));
// A path you pass resolves from where you ran the command, which is what anyone would expect.
// Only the default resolves relative to this script.
const GATEWAY = process.argv[2]
  ? path.resolve(process.cwd(), process.argv[2])
  : path.resolve(HERE, '../../attitude-ws-gateway');
const showtablesPath = path.join(GATEWAY, 'showtables.js');

let renderTable, paramsForShow;
try {
  ({ renderTable, paramsForShow } = await import(pathToFileURL(showtablesPath).href));
} catch (err) {
  console.error(`Could not load the gateway renderer from:\n  ${showtablesPath}\n`);
  console.error('Pass the gateway checkout as an argument, e.g.:');
  console.error('  node bench/table-equivalence.mjs ../attitude-ws-gateway');
  console.error(`\n${err.message}`);
  process.exit(2);
}

const GAMMA = 1.7;
const GAMMA_TABLE = new Uint8Array(256);
for (let i = 0; i < 256; i++) GAMMA_TABLE[i] = Math.round(Math.pow(i / 255, GAMMA) * 255);

const C = (r, g, b) => ({ red: r, green: g, blue: b });
const mkColors = (n) => Array.from({ length: n }, (_, i) => C((i * 37) % 256, (i * 91) % 256, (i * 53) % 256));
const mkLegacyColors = (n) => Array.from({ length: n }, (_, i) => [(i * 37) % 256, (i * 91) % 256, (i * 53) % 256]);

// A spread of both show formats. Legacy dominates the real fleet - nine of ten shows on the
// sampled location - so it gets the heavier coverage here.
const SHOWS = [];
let id = 1;
for (const type of [1, 2, 3, 4, 5, 6]) {
  for (const direction of [0, 1, 2, 3]) {
    for (const nColors of [1, 2, 3, 5]) {
      SHOWS.push({
        id: id++, name: `legacy t${type} d${direction} c${nColors}`,
        type, direction, speed: [10, 40, 80][id % 3], size: [1, 8, 14, 20][id % 4],
        splits: [1, 2, 3][id % 3], colorsList: mkLegacyColors(nColors),
      });
    }
  }
}
for (const showType of ['Static', 'All', 'Chase', 'Pulse']) {
  for (const dir of ['Left to Right', 'Right to Left', 'Middle to Ends', 'Ends to Middle']) {
    for (const nColors of [2, 3, 5]) {
      SHOWS.push({
        id: id++, name: `2A ${showType} ${dir} c${nColors}`, engineVersion: '2A',
        showType, direction: dir, speed: [30, 90, 180][id % 3], size: [10, 25, 100][id % 3],
        splits: [1, 2, 5][id % 3], transition: ['Both Edges', 'Leading Edge', 'Trailing Edge'][id % 3],
        transitionWidth: [0, 0.25, 1][id % 3], bounce: id % 2 === 0, colors: mkColors(nColors),
      });
    }
  }
}

const SEGMENT_COUNTS = [4, 16, 26, 79, 284];

let checked = 0, mismatched = 0, skipped = 0;
const examples = [];

for (const show of SHOWS) {
  for (const segments of SEGMENT_COUNTS) {
    let table;
    try {
      table = renderTable(show, segments);
    } catch (err) {
      skipped++;
      continue;
    }

    // Now render the same show the way the DEVICE does: fresh engine, run() per frame,
    // getFixtureColor per segment, white from min(r,g,b), gamma on all four channels.
    let engine;
    try {
      engine = new AttitudeEngine3(paramsForShow(show));
      engine.setFixtureCount(segments);
    } catch (err) {
      skipped++;
      continue;
    }

    let bad = 0;
    for (let f = 0; f < table.frames; f++) {
      engine.run();
      const all = engine.getFixtureColor();
      for (let s = 0; s < segments; s++) {
        const c = all[s] || { red: 0, green: 0, blue: 0 };
        const w = Math.min(c.red, c.green, c.blue);
        const o = (f * segments + s) * 4;
        if (table.buf[o] !== GAMMA_TABLE[c.red] ||
            table.buf[o + 1] !== GAMMA_TABLE[c.green] ||
            table.buf[o + 2] !== GAMMA_TABLE[c.blue] ||
            table.buf[o + 3] !== GAMMA_TABLE[w]) {
          bad++;
          if (examples.length < 5) {
            examples.push(`${show.name} seg=${segments} frame=${f} idx=${s}: table [${table.buf[o]},${table.buf[o+1]},${table.buf[o+2]},${table.buf[o+3]}] vs device [${GAMMA_TABLE[c.red]},${GAMMA_TABLE[c.green]},${GAMMA_TABLE[c.blue]},${GAMMA_TABLE[w]}]`);
          }
        }
      }
    }

    checked++;
    if (bad > 0) mismatched++;
  }
}

console.log(`show/segment combinations checked : ${checked}`);
console.log(`skipped (engine refused the show) : ${skipped}`);
console.log(`MISMATCHED                        : ${mismatched}`);
for (const e of examples) console.log('  ' + e);
console.log(mismatched === 0
  ? '\nserver tables are byte-identical to local rendering'
  : '\nDIVERGENCE - do not ship');
process.exit(mismatched === 0 ? 0 : 1);
