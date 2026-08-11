// ShowTableStore.mjs
// Holds server-rendered show tables and plays them back in place of local rendering.
// copyright 2026 J Squared Systems
//
// A table is one show's full animation cycle, pre-rendered for a specific segment count, with
// gamma and the white channel already applied. Playing a frame is then a copy rather than a
// render - measured at ~50x less CPU on a thermally throttled device, which is where it matters.
//
// DESIGN RULES, in order of importance:
//
//  1. THIS MUST NEVER BE ABLE TO TAKE A SITE DARK. Every lookup can return null and every
//     failure path is silent-and-fall-back. If anything at all is wrong - no table, wrong
//     engine version, corrupt payload, bad length - the fixture manager renders locally exactly
//     as it does today. There is no remote shell into the fleet; a bad table must degrade to
//     the old behaviour, never to darkness.
//
//  2. Tables live in memory only. They are never written to the SD card. Continuous writing of
//     config.json is the established cause of this fleet's card failures, and a reboot simply
//     means rendering locally for the second or two it takes to refetch.
//
//  3. Demand driven. The device reports which (showId, segments) pairs it needs, because the
//     schedule is evaluated here, not on the server.

import Logger from './Logger.mjs';
const logger = new Logger('ShowTableStore');

import fs from 'fs';
import zlib from 'zlib';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import path from 'path';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Fingerprint of the ENGINE SOURCE we are running, not our firmware version. The server
// vendors a copy of the engine and stamps every table with the same fingerprint; if the two
// ever drift, tables are refused and we render locally. Keying on content rather than release
// number means tables survive firmware updates that do not touch the engine, and are rejected
// the instant one does. Line endings are normalised so a CRLF checkout cannot cause a false
// mismatch.
let LOCAL_ENGINE_VERSION = 'unknown';
try {
	const h = crypto.createHash('sha1');
	for (const f of ['AttitudeEngine3.mjs', 'ShowTypes.js', 'Directions.js', 'Transitions.js']) {
		h.update(fs.readFileSync(path.join(HERE, f), 'utf8').replace(/\r\n/g, '\n'));
	}
	LOCAL_ENGINE_VERSION = h.digest('hex').slice(0, 12);
} catch (error) {
	// non-fatal - an unknown fingerprint simply means every table is refused and we render
}

const MAX_TABLES = 40;              // bounded so a churning schedule cannot grow memory forever
const NEED_TTL_MS = 60000;          // stop asking for a table 60s after it was last used
const MAX_NEEDS_PER_SYNC = 8;

class ShowTableStore {

	constructor() {
		this.tables = new Map();    // "showId:segments" -> table
		this.needs = new Map();     // "showId:segments" -> { showId, segments, lastSeen }
		this.cursors = new Map();   // "showId:segments" -> frame index
		this.stats = { hits: 0, misses: 0, applied: 0, refused: 0, frames: 0 };
	}

	key(showId, segments) { return showId + ':' + segments; }

	// ---------- used by AttitudeFixtureManager ----------

	// Record that this show is being played at this segment count, so it gets requested.
	registerNeed(showId, segments) {
		if (!showId || !segments) return;
		const k = this.key(showId, segments);
		const existing = this.needs.get(k);
		if (existing) { existing.lastSeen = Date.now(); return; }
		this.needs.set(k, { showId, segments, lastSeen: Date.now() });
	}

	// Returns a playable table for this frame, or null to render locally.
	get(showId, segments) {
		const t = this.tables.get(this.key(showId, segments));
		if (!t) { this.stats.misses++; return null; }
		this.stats.hits++;
		return t;
	}

	// True when every registered need for this show currently has a table, which is what lets
	// the fixture manager skip running the engine at all.
	isFullyCovered(showId) {
		let sawOne = false;
		for (const need of this.needs.values()) {
			if (need.showId !== showId) continue;
			sawOne = true;
			if (!this.tables.has(this.key(need.showId, need.segments))) return false;
		}
		return sawOne;
	}

	// Advance every table's playback position by one frame. Called once per frame by the
	// fixture manager, before the patch phase, so all groups sharing a show stay in phase.
	advance() {
		this.stats.frames++;
		for (const [k, t] of this.tables) {
			const next = (this.cursors.get(k) ?? 0) + 1;
			this.cursors.set(k, next >= t.frames ? 0 : next);
		}
	}

	// Byte offset of the current frame within a table.
	offsetFor(showId, segments) {
		const k = this.key(showId, segments);
		const t = this.tables.get(k);
		if (!t) return -1;
		return (this.cursors.get(k) ?? 0) * t.stride;
	}

	// ---------- used by NetworkModule ----------

	getHashes() {
		const out = [];
		for (const t of this.tables.values()) out.push(t.hash);
		return out;
	}

	getNeeds() {
		const now = Date.now();
		const out = [];
		for (const [k, need] of this.needs) {
			if (now - need.lastSeen > NEED_TTL_MS) { this.needs.delete(k); continue; }
			if (out.length < MAX_NEEDS_PER_SYNC) out.push({ showId: need.showId, segments: need.segments });
		}
		return out;
	}

	// Apply tables from a sync response. Wrapped end to end: a malformed table must cost us
	// that table and nothing else.
	applyFromResponse(data) {
		if (!data || !Array.isArray(data.showTables) || data.showTables.length === 0) return;

		for (const entry of data.showTables) {
			try {
				if (!entry || typeof entry.b64 !== 'string') { this.stats.refused++; continue; }

				// Refuse anything not built by our own engine build - see the note on
				// LOCAL_ENGINE_VERSION above.
				if (entry.engine !== LOCAL_ENGINE_VERSION) {
					this.stats.refused++;
					logger.warn(`Refused a table for show ${entry.showId}: built by engine ${entry.engine}, we run ${LOCAL_ENGINE_VERSION}`);
					continue;
				}

				const segments = Number(entry.segments);
				const frames = Number(entry.frames);
				if (!Number.isInteger(segments) || !Number.isInteger(frames) || segments < 1 || frames < 1) {
					this.stats.refused++; continue;
				}

				const buf = zlib.brotliDecompressSync(Buffer.from(entry.b64, 'base64'));
				const expected = frames * segments * 4;
				if (buf.length !== expected) {
					this.stats.refused++;
					logger.warn(`Refused a table for show ${entry.showId}: expected ${expected} bytes, got ${buf.length}`);
					continue;
				}

				const k = this.key(Number(entry.showId), segments);

				// Preserve playback position across a replacement so an edited show does not
				// visibly jump to the start of its cycle.
				const previous = this.cursors.get(k) ?? 0;

				this.tables.set(k, {
					showId: Number(entry.showId),
					segments,
					frames,
					stride: segments * 4,
					hash: entry.hash,
					buf,
				});
				this.cursors.set(k, previous % frames);
				this.stats.applied++;

				if (this.tables.size > MAX_TABLES) {
					const oldest = this.tables.keys().next().value;
					this.tables.delete(oldest);
					this.cursors.delete(oldest);
				}
			} catch (error) {
				this.stats.refused++;
				logger.error(`Error applying a show table: ${error.message}`);
			}
		}
	}

	// short summary for the PERF line
	summary() {
		return 'tables=' + this.tables.size
			+ ' hit=' + this.stats.hits
			+ ' miss=' + this.stats.misses
			+ ' applied=' + this.stats.applied
			+ ' refused=' + this.stats.refused;
	}

	resetWindow() { this.stats.hits = 0; this.stats.misses = 0; }
}

const showTableStore = new ShowTableStore();
export default showTableStore;
