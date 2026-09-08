// engine-drift.mjs
// Fail when the three copies of the show engine stop being the same file.
//
//   node bench/engine-drift.mjs [gatewayRepo] [laravelRepo]
//   node bench/engine-drift.mjs ../attitude-ws-gateway ../attitudelighting
//
// WHY THIS EXISTS
//
// The engine lives in three places and every one of them renders shows for a customer:
//
//   attitudecontrol2a/AttitudeEngine3.mjs                  the device, 40Hz, on the wall
//   attitude-ws-gateway/engine/AttitudeEngine3.mjs         the server, rendering frame tables
//   attitudelighting/public/js/engine/AttitudeEngine3.mjs  the browser, the editor's live preview
//
// The first two are kept in step deliberately and a fingerprint enforces it at runtime: a table
// stamped with a different engine fingerprint is refused and the device renders locally. The
// THIRD copy has no guard of any kind. It has silently fallen behind four times. On 2026-08-12 it
// was found a full release back, still carrying the single-colour Pulse infinite loop, and it
// hung the show editor tab for anyone who opened such a show.
//
// The operations handbook lists "guard the three engine copies against drift" as an open item and
// notes that nothing prevents a repeat. This is that guard.
//
// It REFUSES rather than skips. A missing repo is a failure, not a pass - this project's own rule
// is that a false pass is worse than a failure, and a drift check that quietly finds nothing to
// check is exactly the tooling that reassures instead of refusing.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIRMWARE = path.resolve(HERE, '..');

// The same four files, in the same order, that ShowTableStore.mjs and the gateway's
// showtables.js hash to produce the engine fingerprint. Keep this list identical to both.
const ENGINE_FILES = ['AttitudeEngine3.mjs', 'ShowTypes.js', 'Directions.js', 'Transitions.js'];

const gatewayRepo = process.argv[2] || path.resolve(FIRMWARE, '..', 'attitude-ws-gateway');
const laravelRepo = process.argv[3] || path.resolve(FIRMWARE, '..', 'attitudelighting');

const COPIES = [
    { label: 'firmware (device)', dir: FIRMWARE },
    { label: 'gateway  (server tables)', dir: path.join(gatewayRepo, 'engine') },
    { label: 'browser  (editor preview)', dir: path.join(laravelRepo, 'public', 'js', 'engine') },
];

// Line endings are normalised for the same reason the runtime fingerprint normalises them:
// autocrlf is on in the Windows clones, and a CRLF checkout must not read as drift.
function readNormalised(file) {
    return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

function fingerprint(dir) {
    const h = crypto.createHash('sha1');
    for (const f of ENGINE_FILES) {
        h.update(readNormalised(path.join(dir, f)));
    }
    return h.digest('hex').slice(0, 12);
}

let failed = false;
const results = [];

for (const copy of COPIES) {
    try {
        const missing = ENGINE_FILES.filter((f) => !fs.existsSync(path.join(copy.dir, f)));

        if (missing.length) {
            results.push({ ...copy, error: 'missing ' + missing.join(', ') });
            failed = true;
            continue;
        }

        results.push({ ...copy, fingerprint: fingerprint(copy.dir) });
    } catch (error) {
        results.push({ ...copy, error: error.message });
        failed = true;
    }
}

console.log('');
console.log('engine fingerprint per copy');
console.log('');

for (const r of results) {
    const value = r.error ? 'ERROR: ' + r.error : r.fingerprint;
    console.log('  ' + r.label.padEnd(28) + value);
    if (!r.error) { console.log('  ' + ''.padEnd(28) + r.dir); }
}

console.log('');

const fingerprints = results.filter((r) => !r.error).map((r) => r.fingerprint);
const unique = [...new Set(fingerprints)];

if (!failed && unique.length === 1) {
    console.log('PASS  all three engine copies are identical (' + unique[0] + ')');
    process.exit(0);
}

// Which files actually differ, so the fix is obvious rather than a hunt.
if (unique.length > 1) {
    console.log('DRIFT DETECTED. Files that differ from the firmware copy:');
    console.log('');

    for (const copy of COPIES.slice(1)) {
        for (const f of ENGINE_FILES) {
            const theirs = path.join(copy.dir, f);
            const ours = path.join(FIRMWARE, f);

            if (!fs.existsSync(theirs)) { continue; }

            if (readNormalised(ours) !== readNormalised(theirs)) {
                console.log('  ' + copy.label + '  ->  ' + f);
                console.log('      diff ' + ours + ' ' + theirs);
            }
        }
    }

    console.log('');
    console.log('The firmware copy is the source of truth. Re-vendor, do not hand-edit:');
    console.log('  copy the four files from the firmware repo over each of the other two,');
    console.log('  then re-run this check and bench/table-equivalence.mjs.');
    console.log('');
    console.log('Remember the deploy order: changing the engine rolls the fingerprint, so every');
    console.log('server-rendered table is refused until the GATEWAY ships the same engine. That');
    console.log('degrades safely - devices fall back to local rendering - but ship the server');
    console.log('side first or the fleet renders locally in the gap.');
}

console.log('');
console.log('FAIL  the three engine copies are not the same file');
process.exit(1);
