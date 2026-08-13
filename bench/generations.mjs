// bench/generations.mjs
// Covers the two things 2.A.11 adds to ShowTableStore that nothing else exercises:
//
//   1. SHOW GENERATIONS - which shows this device is allowed to render itself, and the
//      split validity rule that follows from it. A server-only show has no local renderer
//      to diverge from, so the engine fingerprint cannot be the test for its tables.
//
//   2. dropShowTables - the server's kill switch. Table playback is the rendering path for
//      every show once enabled, and there is no shell into the fleet, so being able to say
//      "stop, render locally" from the server is the difference between a switch and a hope.
//
// Run: node bench/generations.mjs

import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { brotliCompressSync } from 'zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import showTableStore, { isDeviceRenderable } from '../ShowTableStore.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Same fingerprint the store computes for itself, so a table can be built that it accepts.
const ENGINE = (() => {
	const h = createHash('sha1');
	for (const f of ['AttitudeEngine3.mjs', 'ShowTypes.js', 'Directions.js', 'Transitions.js']) {
		h.update(readFileSync(path.join(HERE, '..', f), 'utf8').replace(/\r\n/g, '\n'));
	}
	return h.digest('hex').slice(0, 12);
})();

let pass = 0, fail = 0;
function check(name, ok, detail) {
	if (ok) { pass++; console.log(`PASS  ${name}`); }
	else { fail++; console.log(`FAIL  ${name}${detail ? '  -- ' + detail : ''}`); }
}

function table(showId, segments, frames, opts = {}) {
	const buf = Buffer.alloc(frames * segments * 4, 7);
	return {
		showId, segments, frames,
		format: opts.format ?? 1,
		engine: opts.engine ?? ENGINE,
		hash: opts.hash ?? ('h' + showId + '-' + segments),
		b64: brotliCompressSync(buf).toString('base64'),
	};
}

function reset() {
	showTableStore.tables.clear();
	showTableStore.cursors.clear();
	showTableStore.needs.clear();
	showTableStore.stats = { hits: 0, misses: 0, applied: 0, refused: 0, frames: 0 };
	showTableStore.setRenderableShows(new Map());
}

// ---------- 1. which generations this firmware will render itself ----------

check('legacy show with no engineVersion is renderable', isDeviceRenderable({ id: 1 }) === true);
check('engineVersion null is renderable', isDeviceRenderable({ id: 1, engineVersion: null }) === true);
check('engineVersion "" is renderable', isDeviceRenderable({ id: 1, engineVersion: '' }) === true);
check('engineVersion "2A" is renderable', isDeviceRenderable({ id: 1, engineVersion: '2A' }) === true);
check('engineVersion "2B" is NOT renderable', isDeviceRenderable({ id: 1, engineVersion: '2B' }) === false);
check('engineVersion "3.0" is NOT renderable', isDeviceRenderable({ id: 1, engineVersion: '3.0' }) === false);
check('a missing show is not renderable', isDeviceRenderable(null) === false);

// ---------- 2. split validity: fingerprint only where divergence is possible ----------

reset();
showTableStore.setRenderableShows(new Map([[10, true], [20, false]]));

showTableStore.applyFromResponse({ showTables: [table(10, 4, 2, { engine: 'deadbeef0000' })] });
check('renderable show: a table from a different engine is REFUSED',
	showTableStore.tables.size === 0 && showTableStore.stats.refused === 1);

showTableStore.applyFromResponse({ showTables: [table(20, 4, 2, { engine: 'deadbeef0000' })] });
check('server-only show: engine fingerprint is not the test, table is accepted',
	showTableStore.tables.size === 1 && showTableStore.stats.applied === 1);

reset();
showTableStore.setRenderableShows(new Map([[20, false]]));
showTableStore.applyFromResponse({ showTables: [table(20, 4, 2, { format: 99 })] });
check('server-only show: an unreadable table FORMAT is still refused',
	showTableStore.tables.size === 0 && showTableStore.stats.refused === 1);

// A gateway built before the format field existed sends none. Those tables are format 1 by
// definition, and refusing them would revert the fleet to local rendering for as long as the
// firmware was ahead of the server - which is precisely the window a staged rollout creates.
reset();
showTableStore.setRenderableShows(new Map([[10, true]]));
const noFormat = table(10, 4, 2);
delete noFormat.format;
showTableStore.applyFromResponse({ showTables: [noFormat] });
check('a table with NO format field is accepted as format 1',
	showTableStore.tables.size === 1 && showTableStore.stats.refused === 0,
	'refused=' + showTableStore.stats.refused);

reset();
showTableStore.setRenderableShows(new Map([[10, true]]));
const nullFormat = table(10, 4, 2, { format: null });
showTableStore.applyFromResponse({ showTables: [nullFormat] });
check('a table with a null format is accepted as format 1',
	showTableStore.tables.size === 1 && showTableStore.stats.refused === 0);

reset();
showTableStore.setRenderableShows(new Map([[10, true]]));
showTableStore.applyFromResponse({ showTables: [table(10, 4, 2, { format: 'banana' })] });
check('a table with a nonsense format is still refused',
	showTableStore.tables.size === 0 && showTableStore.stats.refused === 1);

reset();
// nothing registered at all - an id we have never heard of must take the stricter rule
showTableStore.applyFromResponse({ showTables: [table(77, 4, 2, { engine: 'deadbeef0000' })] });
check('unknown show id defaults to the STRICTER rule',
	showTableStore.tables.size === 0 && showTableStore.stats.refused === 1);

reset();
showTableStore.setRenderableShows(new Map([[10, true]]));
showTableStore.applyFromResponse({ showTables: [table(10, 4, 2)] });
check('renderable show with a matching engine is accepted',
	showTableStore.tables.size === 1 && showTableStore.stats.applied === 1);

// ---------- 3. the kill switch ----------

reset();
showTableStore.setRenderableShows(new Map([[10, true], [11, true]]));
showTableStore.registerNeed(10, 4);
showTableStore.registerNeed(11, 4);
showTableStore.applyFromResponse({ showTables: [table(10, 4, 2), table(11, 4, 3)] });
check('two tables held before the drop', showTableStore.tables.size === 2);

showTableStore.applyFromResponse({ dropShowTables: true });
check('dropShowTables clears every table', showTableStore.tables.size === 0);
check('dropShowTables clears the playback cursors', showTableStore.cursors.size === 0);
check('dropShowTables leaves needs intact, so tables come back if re-enabled',
	showTableStore.needs.size === 2, 'needs=' + showTableStore.needs.size);
check('a dropped store reports a miss, which makes the device render locally',
	showTableStore.get(10, 4) === null);
check('isFullyCovered is false after a drop, so the engine runs again',
	showTableStore.isFullyCovered(10) === false);
check('the drop is visible in the PERF line', showTableStore.summary().indexOf('dropped=1') !== -1,
	showTableStore.summary());

// a drop arriving with tables in the same reply must drop first, then apply
reset();
showTableStore.setRenderableShows(new Map([[10, true], [11, true]]));
showTableStore.applyFromResponse({ showTables: [table(10, 4, 2)] });
showTableStore.applyFromResponse({ dropShowTables: true, showTables: [table(11, 4, 2)] });
check('a reply that drops AND carries a table ends holding only the new one',
	showTableStore.tables.size === 1 && showTableStore.tables.has('11:4'));

// harmless repeats
reset();
showTableStore.applyFromResponse({ dropShowTables: true });
check('dropping an empty store is a no-op', showTableStore.tables.size === 0);
showTableStore.applyFromResponse({ dropShowTables: false });
check('dropShowTables:false does nothing', showTableStore.tables.size === 0);
showTableStore.applyFromResponse(null);
showTableStore.applyFromResponse({});
check('a null or empty response is survivable', true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
