// AttitudeEmitManager.mjs
// Attitude emit management & communication module for the Attitude Control 2.A app
// copyright 2025 Drew Shipps, J Squared Systems

// this module creates a single instance of the AttitudeEmitManager javascript object,
// which controls the attitude emit units connected to this system



// ==================== IMPORT ====================
import eventHub from './EventHub.mjs';
import configManager from './ConfigManager.mjs';
import udpManager from './UDPManager.mjs';
import attitudeSACN from './AttitudeSACN2A.mjs';

import Logger from './Logger.mjs';
const logger = new Logger('AttitudeEmitManager');



// ==================== VARIABLES ====================
const LAPTOP_MODE = (process.platform == 'darwin');
const BROADCAST_EMIT_ASSIGNMENTS_DELAY = 1000;

// How long a discovered device's address stays usable after its last telemetry
// packet. A minute of silence means it is gone, and its universes should fall
// back to multicast rather than being unicast into a hole.
//
// This number is a CONTRACT with the device firmware, not a local choice. A
// device announcing less often than this gets pruned while it is still working,
// and pruning one Emit-8 sets anyEmit8Undiscovered, which puts the WHOLE
// LOCATION back on multicast - so one device's announce interval changes how
// every other device at that site is fed. The Emit-8 announces every 10 s, six
// chances inside this window.
//
// The firmware does have a _Static_assert that names EMIT_ADDRESS_TTL_MS - but
// it tests against its OWN hand-copied literal (BOX_ADDRESS_TTL_MS, announce.c),
// so changing the number here will NOT fail the firmware build. An earlier
// version of this comment claimed it would. Both numbers move by hand.
//
// The interval the existing Emit-1 firmware uses is not recorded anywhere and
// has not been measured here. An earlier version of this comment asserted once
// per second; nothing in this repo establishes that. It does not affect this
// code - the TTL is generous either way - but do not build on it.
const EMIT_ADDRESS_TTL_MS = 60000;

// Matches what an Emit-8 calls itself in telemetry. The server-side model
// field is authoritative when present; this is the fallback so that routing
// works before anyone has to change the web app.
const EMIT8_NAME_PATTERN = /emit[\s._-]*8/i;

// The largest universe E1.31 defines. Used to clamp what a device reports and
// what the server assigns, so a nonsense number never becomes a multicast group
// address the standard does not define.
const MAX_UNIVERSE = 63999;

// A ceiling on how many ports a single device may claim. Not a product limit -
// an Emit-16 would pass this happily - but a bound on how much memory one
// device can make this box allocate by announcing, on a segment where nothing
// is authenticated.
const MAX_REPORTED_PORTS = 64;

// The DEVICE_ID is the chip id an Emit-8 is born with: 16 hex characters from
// the RP2350's unique id. It is the ENROLLMENT KEY, and the reason 2.A.18
// exists.
//
// The distinction that matters: an ID is assigned by the server and a device
// does not have one until someone enrolls it, whereas a DEVICE_ID exists from
// the first second the device is powered and survives re-assignment, a factory
// reset, and a move to another site. Keying discovery on ID meant every
// unenrolled device in a rack collided on the same key 0 - the second one to
// announce overwrote the first, and only one of them could ever be found.
//
// Bounded and character-restricted because this string becomes a Map key and is
// echoed to the server.
const DEVICE_ID_PATTERN = /^[0-9A-F]{8,32}$/;

// A ceiling on how many devices are remembered at once. A real site has a
// handful and records age out after EMIT_ADDRESS_TTL_MS, so this is never
// approached in normal operation - it exists because the map is now keyed on a
// string a device chooses for itself, on a segment where nothing is
// authenticated, and this process runs for months without restarting.
const MAX_DISCOVERED = 256;

// How many discovery records one source address may hold. A real site has one
// device per address; this is the bound that actually matters, because the
// global cap alone is defeated by a single host announcing under many chip ids.
// Four rather than one so that a device legitimately changing its identity - a
// reflash, a re-enrollment - is not fighting its own stale record.
// 16, not a smaller number: this is a security bound, but it is also a hard
// devices-per-address limit, and one address legitimately holding several
// devices is a shape that exists (a bridge, a routed segment, a duplicate
// lease). 16 is far past any real per-address count and still leaves a flood
// from one host holding 16 of 256 slots.
const MAX_PER_SOURCE = 16;

// Warning suppression. WARN_REARM_MS is how long the same condition stays quiet
// before it is worth saying again - long enough that a permanent fault is one
// line a shift, short enough that someone looking at today's log sees it.
const WARN_REARM_MS  = 60 * 60 * 1000;
const WARN_KEYS_MAX  = 64;
const WARN_BURST     = 20;
const WARN_PER_SECOND = 1 / 30;   // two a minute, sustained




// ==================== CLASS DEFINITION ====================
class AttitudeEmitManager {

	// constructor
	constructor() {
		// bind functions
		this.handleNewEmitData = this.handleNewEmitData.bind(this);

		// key -> { ip, deviceId, id, name, ports, universes[], isEmit8, lastSeen }
		//
		// The key is `dev:<DEVICE_ID>` for anything that reports a chip id, and
		// `id:<ID>` for the older firmware that does not. See DEVICE_ID_PATTERN
		// above for why it is not the ID.
		//
		// Populated from telemetry. The box has always received this; it simply
		// had nowhere to put it.
		this.discovered = new Map();

		// Things already complained about. Every warning in this module fires
		// from a path that repeats - the announce is every ten seconds and the
		// assignment broadcast is every second - and these lines are queued to
		// the server. Without suppression, one device with broken firmware is
		// 86,400 identical log entries a day.
		//
		// Insertion-ordered, so the oldest key is the first one out.
		this.warned = new Map();

		// A token bucket on top of the per-key dedupe, because the two floods
		// have different shapes and the per-key set only stops one of them.
		// Sixty-five misconfigured rows, or a device inventing a new bad chip
		// id every announce, produce a NEW key every time - which a per-key set
		// cannot suppress at all. This bounds the module's warnings by RATE
		// regardless of how many distinct conditions there are.
		this.warnTokens = WARN_BURST;
		this.warnRefilledAt = Date.now();
		this.warnSuppressed = 0;
	}


	// initialize the emit manager
	init() {
		try {
			// attach a listener for relevant UDP packets
			eventHub.on('receivedUDP', this.handleNewEmitData);

			// Start loop to send updates once per second
			setInterval(() => {
				this.broadcastEmitAssignments();
			}, BROADCAST_EMIT_ASSIGNMENTS_DELAY);

			// log success
			logger.info('Completed initialization of Attitude Emit Manager.');

			// emit status event
	        eventHub.emit('moduleStatus', { 
	            name: 'AttitudeEmitManager', 
	            status: 'operational',
	            data: '',
	        });
		} catch (error) {
			// log failure
			logger.error(`Failed to initialize Attitude Emit Manager! ${error}`);

			// emit status error event
			eventHub.emit('moduleStatus', {
				name: 'AttitudeEmitManager',
				status: 'errored',
				data: `Failed to initialize: ${error}`,
			});
		}
	}


	// handleNewEmitData - function to handle the data packet received from an Attitude Emit device
	handleNewEmitData(object) {
		try {
			// skip if not TYPE 2
			if (object?.TYPE !== 2) {
				if (configManager.checkLogLevel('detail')) {
					logger.info(`Skipped non-emit UDP packet or invalid TYPE: ${object?.TYPE}`);
				}
				return;
			}

			// validate the packet
			if (!this.validateEmitDataObject(object)) return;

			const deviceId = this.normalizeDeviceId(object.DEVICE_ID);

			// What each PORT reports, position preserved: entry i is port i+1,
			// and 0 means that port has no universe.
			//
			// Preserving the slot rather than compacting the list is not a style
			// choice. A plain `.filter()` on [1, 0, 5] yields [1, 5], which
			// silently moves port 3's universe onto port 2 - and the same
			// mistake, found and fixed in the server-side map, would light the
			// wrong fixtures on every port after a blank one. Both ends of this
			// protocol now keep the slot.
			const reportedPortMap = Array.isArray(object.UNIVERSES)
				? object.UNIVERSES.slice(0, MAX_REPORTED_PORTS).map(u =>
					(Number.isInteger(u) && u >= 1 && u <= MAX_UNIVERSE) ? u : 0)
				: (Number.isInteger(object.UNIVERSE) && object.UNIVERSE >= 1
					? [object.UNIVERSE] : []);

			// PORTS is what makes an Emit-2 or Emit-4 free on the server side -
			// the management page loops to this number instead of parsing a
			// model name. Fall back to the length of what was reported so a
			// device predating the field still counts as one port.
			const ports = (Number.isInteger(object.PORTS)
				&& object.PORTS >= 1 && object.PORTS <= MAX_REPORTED_PORTS)
				? object.PORTS
				: (reportedPortMap.length || 1);

			// log the incoming emit packet
			if (configManager.checkLogLevel('detail')) {
				logger.info(`New packet of TYPE=2 from emit ID: ${object.ID}`
					+ `${deviceId ? ` (device ${deviceId})` : ''}`
					+ ` with universe ${object.UNIVERSE}`);
			}

			// Log any errors the device reports about itself.
			//
			// Budgeted and attributed, both because of this change. Before
			// 2.A.18 an ID-0 packet was rejected in validation and never reached
			// this line, so an UNENROLLED device could not reach it at all -
			// and an unenrolled device is the one most likely to be reporting a
			// fault, being fresh out of the box on a bench. Left as it was, one
			// such unit produced 8,640 lines a day reading "Emit device ID 0
			// reported error: ...", which names no device.
			if (typeof object.ERRORS === 'string' && object.ERRORS.length > 0) {
				// The key is truncated because ERRORS is device-supplied: a 20 KB
				// string would otherwise be retained verbatim as a Map key, 64
				// of them at a time, on a box with an SD card for a disk.
				const who = deviceId ? `device ${deviceId} (ID ${object.ID})` : `ID ${object.ID}`;
				this.logOnce('error',
					`emiterr:${deviceId || object.ID}:${object.ERRORS.slice(0, 64)}`,
					`Emit ${who} reported error: ${object.ERRORS}`);
			}

			// construct packet
			//
			// device_id, reported_ports and reported_universes are what the
			// server enrolls from. An unenrolled device sends id 0, so id alone
			// cannot identify it and the server has nothing to create a record
			// against; device_id is the field that makes the enrollment page
			// possible at all.
			const emitDataPacket = {
				timestamp: new Date().toISOString(),
				name: typeof object.NAME === 'string' ? object.NAME : '',
				type: object.TYPE,
				id: object.ID,
				// null, not '' - the server may well end up resolving or
				// upserting on this field, and an empty string is a value that
				// every legacy device in the fleet would collide on. Absent is
				// the honest answer for a device that has no chip id.
				device_id: deviceId || null,
				version: typeof object.VERSION === 'string' ? object.VERSION : String(object.VERSION ?? ''),
				packet_no: object.PACKET_NO,
				reported_universe: object.UNIVERSE,
				reported_universes: reportedPortMap,
				reported_ports: ports,
				reported_identify_mode: object.IDENTIFY,
				errors: object.ERRORS || '',
			};

			// Remember where this device lives, so sACN can be unicast to it.
			// _SOURCE_IP is attached by UDPManager from the datagram itself and
			// is the one field here a device cannot lie about by claiming it.
			//
			// `universes` here is what the device REPORTS it is doing. Routing
			// deliberately does not use it - computeRoutes reads the assigned
			// universes from config instead, because the server's assignment is
			// what is authoritative and a device echoing its own belief back
			// would let a stale device pin its own routing. It is captured so
			// that reported-versus-assigned can be compared, which is what
			// `reported_universes` on the server is for.
			const key = this.discoveryKey(deviceId, object.ID);
			if (key && typeof object._SOURCE_IP === 'string' && object._SOURCE_IP.length > 0) {
				const name = typeof object.NAME === 'string' ? object.NAME : '';

				// At the cap, EVICT THE STALEST rather than refusing the new
				// one. Refusing looks safer and is not: it means whoever filled
				// the map first keeps it, so a device forging chip ids could
				// permanently lock a real Emit-8 out of discovery - and an
				// Emit-8 that is not discovered gets no unicast, which for a
				// device fed on one socket by design means it gets nothing at
				// all. Evicting keeps the cap and keeps the newest device
				// findable; the loser is whatever has been quiet longest.
				if (!this.discovered.has(key)) this.makeRoomFor(object._SOURCE_IP);

				this.discovered.set(key, {
					ip: object._SOURCE_IP,
					deviceId,
					id: object.ID,
					name,
					ports,
					universes: reportedPortMap.filter(u => u >= 1),
					// When this device was FIRST heard, carried across
					// refreshes. Used to break an ID collision in favour of
					// the incumbent - see computeRoutes.
					firstSeen: this.discovered.get(key)?.firstSeen ?? Date.now(),
					// Name only, deliberately - NOT `ports > 1`. Inferring it
					// from the port count reads as an improvement and is a
					// behaviour change in the dangerous direction: this flag
					// decides whether a location DROPS MULTICAST, and `ports`
					// falls back to the length of the reported array, so a
					// pre-PORTS device reporting two universes would silently
					// take its whole location unicast-only. `ports` is recorded
					// for the server either way.
					isEmit8: EMIT8_NAME_PATTERN.test(name),
					lastSeen: Date.now(),
				});
			}

			// emit to the system
			eventHub.emit('attitudeEmitDataReceived', emitDataPacket);

			// update module status
			eventHub.emit('moduleStatus', { 
				name: 'AttitudeEmitManager', 
				status: 'operational',
				data: '',
			});
		} catch (error) {
			logger.error(`Error processing emit packet: ${error}`);
			eventHub.emit('moduleStatus', { 
				name: 'AttitudeEmitManager', 
				status: 'errored',
				data: `Error processing emit packet: ${error}`,
			});
		}
	}



	// evictStalest - make room for one new device if the map is at its cap.
	//
	// UNENROLLED records go first, whatever their age. A device that has been
	// given an ID by the server is one this site is actually using, possibly as
	// a unicast destination right now; a device announcing ID 0 is a candidate
	// for enrollment and nothing depends on it. Ordering by age alone let a
	// flood of forged ID-0 announces evict the real Emit-8 that was feeding the
	// building - it recovered on its next announce, so the site flapped between
	// unicast and multicast rather than going dark, but it should not be
	// possible at all. Enrolled records are only touched when there is nothing
	// else left.
	// makeRoomFor - enforce both caps before a NEW key is admitted.
	//
	// The per-source cap does the real work. Ranking the global cap on whether a
	// record is "enrolled" looked like a defence and was not: `rec.id` is a
	// number the announcing device puts in its own packet, so a flood only had
	// to claim ID 1 - or better, the ID of the device it wanted to displace - to
	// rank as enrolled and evict the real Emit-8 that was feeding the building.
	// Bounding how many records ONE ADDRESS can hold is not something the
	// contents of a packet can talk its way around.
	makeRoomFor(ip) {
		// One address, MAX_PER_SOURCE records. Oldest of that address's own
		// records goes, so the newcomer costs nobody else a slot.
		const mine = [];
		for (const [k, rec] of this.discovered) if (rec.ip === ip) mine.push([k, rec]);
		if (mine.length >= MAX_PER_SOURCE) {
			mine.sort((a, b) => (a[1].lastSeen ?? 0) - (b[1].lastSeen ?? 0));
			for (let i = 0; i <= mine.length - MAX_PER_SOURCE; i++) {
				this.discovered.delete(mine[i][0]);
			}
			this.warnOnce(`source-cap:${ip}`,
				`${ip} is announcing under more than ${MAX_PER_SOURCE} device ids; `
				+ `only its most recent ${MAX_PER_SOURCE} are being kept.`);
		}

		while (this.discovered.size >= MAX_DISCOVERED) {
			let oldestKey = null;
			let oldestRank = null;
			for (const [k, rec] of this.discovered) {
				// Purely by age. Any richer ordering here would be ordering on
				// fields the device itself supplies - see above.
				const rank = Number.isFinite(rec.lastSeen) ? rec.lastSeen : 0;
				if (oldestRank === null || rank < oldestRank) { oldestRank = rank; oldestKey = k; }
			}
			if (oldestKey === null) return;
			this.discovered.delete(oldestKey);
			this.warnOnce('discovered-cap',
				`Discovery map hit its ${MAX_DISCOVERED}-device cap; evicting the `
				+ `device heard from longest ago. More devices are announcing on this `
				+ `segment than any site should have.`);
		}
	}


	// warnOnce - log a warning about a condition, at most once per re-arm
	// window and never faster than the module's warning budget.
	//
	// The key describes the CONDITION, not the moment: two devices with the same
	// fault share a key, and a condition that is still broken an hour later says
	// so again rather than going silent forever.
	//
	// Two mechanisms, because there are two floods and one mechanism stops one
	// of them. The per-key window handles the common case - the same fault
	// repeating at 1 Hz. The token bucket handles the case a per-key set cannot
	// touch at all: a NEW key every time, from sixty-five misconfigured rows or
	// from a device inventing a fresh bad chip id on every announce. The first
	// version of this used a bare Set cleared at 64 entries, which meant
	// suppression fell to ZERO at 65 distinct conditions - unbounded, in the
	// exact scenario it was written to bound.
	warnOnce(key, message) {
		this.logOnce('warn', key, message);
	}


	logOnce(level, key, message) {
		const now = Date.now();

		const last = this.warned.get(key);
		if (last !== undefined && now - last < WARN_REARM_MS) return;

		// refill, capped at the burst size
		const elapsed = now - this.warnRefilledAt;
		if (elapsed > 0) {
			this.warnTokens = Math.min(WARN_BURST,
				this.warnTokens + (elapsed / 1000) * WARN_PER_SECOND);
			this.warnRefilledAt = now;
		}

		if (this.warnTokens < 1) {
			this.warnSuppressed++;
			return;
		}
		this.warnTokens -= 1;

		this.warned.set(key, now);
		if (this.warned.size > WARN_KEYS_MAX) {
			// oldest key out; a Map iterates in insertion order
			this.warned.delete(this.warned.keys().next().value);
		}

		if (this.warnSuppressed > 0) {
			const n = this.warnSuppressed;
			this.warnSuppressed = 0;
			logger.warn(`${n} further messages from the emit manager were suppressed `
				+ `to keep the log queue bounded.`);
		}
		if (level === 'error') logger.error(message); else logger.warn(message);
	}


	// normalizeDeviceId - the chip id, upper-cased, or '' if there isn't a usable one.
	//
	// Returning '' rather than throwing means a malformed DEVICE_ID degrades the
	// device to the old rules instead of taking its telemetry down: it is still
	// heard, it just cannot be enrolled until whatever produced the bad string
	// is fixed.
	normalizeDeviceId(v) {
		if (typeof v !== 'string') return '';
		const s = v.trim().toUpperCase();
		return DEVICE_ID_PATTERN.test(s) ? s : '';
	}


	// discoveryKey - the key a device is remembered under. Null when there is
	// neither a chip id nor an assigned ID, i.e. nothing to remember it by.
	discoveryKey(deviceId, id) {
		if (deviceId) return `dev:${deviceId}`;
		return (Number.isInteger(id) && id >= 1) ? `id:${id}` : null;
	}


	// validateEmitDataObject - validate that the emit data object includes all required parameters
	validateEmitDataObject(obj) {
		// Validate TYPE is 2 (Emit)
		if (obj.TYPE !== 2) {
			logger.warn(`Rejected emit packet: TYPE must be 2 but got ${obj?.TYPE}`);
			return false;
		}

		const deviceId = this.normalizeDeviceId(obj.DEVICE_ID);

		// A DEVICE_ID that is present but unusable is worth naming once: it is
		// the difference between a device that CANNOT be enrolled and one that
		// has not been yet, and nothing else in the system would ever say so.
		//
		// Once, though - not on every announce. The device sending it repeats
		// every ten seconds and these lines are queued to the server.
		if (!deviceId && typeof obj.DEVICE_ID !== 'undefined') {
			const shown = String(obj.DEVICE_ID).slice(0, 64);
			this.warnOnce(`baddevid:${shown}`,
				`Emit packet has an unusable DEVICE_ID; the device can be heard `
				+ `but not enrolled: ${JSON.stringify(shown)}`);
		}

		// A device carrying a chip id is allowed to be UNENROLLED. ID 0 is
		// exactly what a factory-fresh Emit-8 announces, and rejecting that
		// packet is what kept this box from ever seeing a device it could
		// enroll - the announce arrived, was thrown away here, and the device
		// sat on the bench looking dead.
		//
		// UNIVERSE 0 is allowed alongside it, but note that the CURRENT Emit-8
		// firmware does not send it: an unconfigured unit announces
		// UNIVERSE 1 / UNIVERSES [1..8], the bench default, because it decided
		// that saying "not configured" with a 0 was worse than reporting what
		// it is doing (announce.c, lazy_init). The two sides disagree about
		// how to say "unassigned" and the firmware is the one that should move,
		// now that this box treats 0 as a blank port - otherwise a brand new
		// unit shows up on the enrollment page already owning universes 1-8.
		// Until it does, UNIVERSE 0 is a case this relaxation covers and no
		// shipping device produces.
		//
		// Without a chip id there is nothing to enroll and no way to address the
		// device, so the original rules stand: a legacy packet with ID 0 is
		// malformed and there is nothing useful to do with it.
		const minId = deviceId ? 0 : 1;
		if (!Number.isInteger(obj.ID) || obj.ID < minId) {
			logger.warn(`Rejected emit packet: ID must be an integer ≥ ${minId} but got ${obj?.ID}`);
			return false;
		}

		const minUniverse = deviceId ? 0 : 1;
		if (!Number.isInteger(obj.UNIVERSE) || obj.UNIVERSE < minUniverse) {
			logger.warn(`Rejected emit packet: UNIVERSE must be an integer ≥ ${minUniverse} but got ${obj?.UNIVERSE}`);
			return false;
		}

		// Validate NAME, VERSION, and PACKET_NO exist
		const requiredKeys = ['NAME', 'VERSION', 'PACKET_NO'];
		for (const key of requiredKeys) {
			if (typeof obj[key] === 'undefined') {
				logger.warn(`Rejected emit packet: missing required key '${key}'`);
				return false;
			}
		}

		// Passed all validation checks
		return true;
	}



	// isEmit8 - is this configured device an Emit-8?
	//
	// The server's own field wins when it is there. Falling back to the name a
	// device reports means routing starts working before the web app has to
	// change, but it is a fallback: a device naming itself is weaker evidence
	// than the assignment record saying what it is.
	isEmit8(emit, seen) {
		const model = emit?.model ?? emit?.type ?? emit?.device_type;
		if (typeof model === 'string' && EMIT8_NAME_PATTERN.test(model)) return true;
		if (typeof model === 'string' && model.length > 0) return false;
		return Boolean(seen?.isEmit8);
	}


	// portMapFor - the assignment as a PER-PORT array: entry i is port i+1, and
	// 0 means that port has no universe. Null when the server has not sent the
	// multi-port shape for this device at all, which is how the two wire formats
	// are told apart downstream.
	//
	// Position is load-bearing here in a way it is not in universesFor(). This
	// array goes on the wire and the device applies it by index, so compacting
	// [1, 0, 5] to [1, 5] would put universe 5 on port 2 - the wrong fixtures,
	// lit convincingly, with nothing reporting a fault.
	// Two refusals in here, both of which exist because this array arrives from
	// the server and the server's shape is going to change while boxes in the
	// field are running.
	//
	//   an EMPTY array is not the multi-port shape. `assigned_universes: []` is
	//   what an array-cast column, an unfilled relation or a plucked-to-nothing
	//   serializer produces on EVERY emit record the moment the field is added.
	//   Taking the multi-port branch on it would send UNIVERSE_SET: 0 to every
	//   Emit-1 in the fleet on the next one-second tick, with no box update and
	//   no config edit - the entire installed base dark from a server deploy.
	//
	//   an array whose entries are ALL the wrong type is a shape change, not an
	//   assignment. ['1','2',…] coerces entry-by-entry to [0,0,…], which is a
	//   valid, deliberate, blank-every-port instruction. Refusing it falls back
	//   to the scalar, and a device with no valid scalar is skipped - the same
	//   thing that happens today when an assignment is missing.
	//
	// A SINGLE bad entry among good ones is different and is allowed through as
	// a blank port: null and 0 are how the server says "this port is unassigned",
	// and one wrong-typed slot among seven right ones is a data problem, not a
	// deploy.
	portMapFor(emit) {
		const raw = emit?.assigned_universes;
		if (!Array.isArray(raw) || raw.length === 0) return null;

		const kept = raw.slice(0, MAX_REPORTED_PORTS);
		const map = kept.map(u => (Number.isInteger(u) && u >= 1 && u <= MAX_UNIVERSE) ? u : 0);

		// Entries that were MEANT to be a universe and are not one. A null,
		// undefined or 0 is a deliberate blank and does not count.
		const badTypes = kept.filter(u =>
			u !== null && u !== undefined && u !== 0
			&& !(Number.isInteger(u) && u >= 1 && u <= MAX_UNIVERSE)).length;

		if (badTypes > 0) {
			this.warnOnce(`portmap:${emit?.id}:${badTypes}/${kept.length}`,
				`Emit ID ${emit?.id}: ${badTypes} of ${kept.length} assigned universes `
				+ `are not usable universe numbers: ${JSON.stringify(kept).slice(0, 120)}`);
		}
		if (badTypes === kept.length) return null;

		// An all-blank map alongside a valid single-universe assignment is a
		// shape artefact, not an instruction. `[]` is not the only way a
		// serializer says nothing - a per-port relation padded to PORTS from
		// nullable rows produces [null, null, ...], which reaches here with
		// badTypes 0 (null IS how the server says "this port is blank") and
		// would blank a legacy record that has a perfectly good scalar.
		//
		// Where there is NO scalar to lose, an all-zero map is kept and sent:
		// that is the deliberate "you are enrolled, nothing assigned yet"
		// instruction, and it is how a device learns its own ID.
		// ...but ONLY where the server has not said this is a multi-port device.
		// Getting that condition wrong reverses the rule: on a record the server
		// HAS called multi-port, an all-blank map is the operator unassigning
		// every port in the new UI, and `assigned_universe` is the stale value
		// in the OLD column. Letting the old column win there would put a
		// universe back on a device someone deliberately cleared, drop the site
		// off multicast, and take DEST_DEVICE_ID off the packet so the device
		// could no longer be told its ID.
		//
		// The evidence has to be about PORTS and has to come from the server -
		// `ports`, or a model name. Not device_id, which is a plain DB column
		// that will end up populated on Emit-1 rows too, and not the array's
		// own length, since a serializer padding every row to a default of 8 is
		// exactly the accident being guarded against.
		// Same accessor isEmit8() uses. Reading only `model` here meant one
		// record could answer the question two ways: `type: 'Emit-8'` made it an
		// Emit-8 for routing - dropping the location off multicast - and not a
		// multi-port device for this guard.
		const model = emit?.model ?? emit?.type ?? emit?.device_type;
		const multiPort = (Number.isInteger(emit?.ports) && emit.ports > 1)
			|| (typeof model === 'string' && EMIT8_NAME_PATTERN.test(model));

		const scalarUsable = Number.isInteger(emit?.assigned_universe)
			&& emit.assigned_universe >= 1 && emit.assigned_universe <= MAX_UNIVERSE;

		if (!map.some(u => u >= 1) && !multiPort && scalarUsable) {
			this.warnOnce(`portmap-blank:${emit?.id}`,
				`Emit ID ${emit?.id}: assigned_universes is entirely blank and nothing `
				+ `says this is a multi-port device, so its single universe `
				+ `(${emit.assigned_universe}) is being used rather than blanking it.`);
			return null;
		}

		return map;
	}


	// universesFor - which universes a configured device is assigned.
	// Tolerates the single-integer field that exists today and the array that
	// an eight-universe device needs. Derived from portMapFor so the routing
	// set and the wire format can never disagree about what is assigned.
	//
	// Order and holes genuinely do not matter here - the caller only asks "does
	// this universe go to this box" - so flattening is correct in this one place.
	universesFor(emit) {
		const map = this.portMapFor(emit);
		if (map) return map.filter(u => u >= 1);
		// No upper bound here, on purpose. This function decides whether a
		// device COUNTS - a device with no universes sets neither
		// anyNonEmit8 nor anyEmit8Undiscovered, so clamping here would turn
		// a data-entry typo into a decision to stop multicasting for the
		// whole site. The bound belongs on the egress path, where sending a
		// nonsense universe is the actual harm, and it is applied there.
		return Number.isInteger(emit?.assigned_universe) && emit.assigned_universe >= 1
			? [emit.assigned_universe]
			: [];
	}


	// seenFor - find the discovery record for a configured device.
	//
	// When the server names a device_id, that is the ONLY thing matched. It does
	// not fall back to the ID, and the difference matters: falling back would
	// unicast this location's universes to whatever else happened to answer to
	// that number, which is the exact mix-up a chip id exists to prevent. A
	// server that has not sent a device_id yet still matches by ID, so nothing
	// in the field changes until the server starts sending one.
	seenFor(emit, byId) {
		const deviceId = this.normalizeDeviceId(emit?.device_id);
		const byNumber = Number.isInteger(emit?.id) ? byId.get(emit.id) : undefined;
		if (!deviceId) return byNumber;

		const exact = this.discovered.get(`dev:${deviceId}`);
		if (exact) return exact;

		// One fallback, and only one: a device that reports NO chip id at all.
		// An Emit-1 has never claimed one, so it cannot contradict what the
		// server says this assignment is, and a server that fills device_id in
		// on every record must not make the existing fleet undiscoverable.
		// A device reporting a DIFFERENT chip id is a different device, and
		// matching it here is precisely the mix-up this field prevents.
		return byNumber && !byNumber.deviceId ? byNumber : undefined;
	}


	// computeRoutes - decide, per universe, where this LOCATION's sACN goes.
	//
	//   no Emit-8                       -> multicast, exactly as before
	//   Emit-8 assigned, nothing else   -> unicast only
	//   both an Emit-8 and an Emit-1    -> both
	//
	// The discriminator is "does this location HAVE an Emit-8", because a
	// location with an Emit-8 assigned to it never has third-party sACN gear on
	// it. That is a deployment rule (John, 2026-08-28), not something this code
	// worked out from the assignment list - and the distinction matters. An
	// earlier version tried to infer "nothing else needs multicast" from the
	// list being all Emit-8s, which is invalid reasoning: third-party receivers
	// are in use across the fleet and appear nowhere in attitudeEmits, so that
	// inference would have blacked out equipment the box has never heard of.
	// The rule is sound where the inference was not, so the flag that used to
	// gate this is gone.
	//
	// The decision is per location because each control box only ever sees and
	// feeds its own site. Dropping multicast where nothing needs it keeps a
	// site's cheap unmanaged switches from flooding eight universes to every
	// port, which is the practical reason to bother.
	//
	// Three deliberate safety valves, all of which prevent the only bad outcome
	// here - a receiver that needed multicast and stopped getting it:
	//   - a non-Emit-8 anywhere in this location's list keeps multicast. An
	//     Emit-1 receives by multicast and nothing else feeds it.
	//   - an Emit-8 that is assigned but has not yet been heard from has no
	//     address to unicast to, so multicast STAYS until it announces itself.
	//     Boot order must not black out a site.
	//   - configManager.getForceSacnMulticast() pins a location back to
	//     multicast unconditionally, for the site that turns out to be an
	//     exception to the deployment rule. Off by default.
	//   - and any universe that still ends up with no destination at all falls
	//     back to multicast inside AttitudeSACN.setRoutes().
	computeRoutes(universeCount) {
		// Array.isArray, not a bare read. attitudeEmits is merged from the
		// server payload with no shape validation, and a non-array there used
		// to throw out of for..of - which, because updateSACNRouting() and
		// the ONLY pruning of `discovered` both live inside broadcastEmit-
		// Assignments' single try/catch, froze the routing table, froze the
		// discovery map, and stopped every assignment, silently, for as long
		// as the config stayed that way.
		const configured = configManager.getAttitudeEmits();
		const emitList = Array.isArray(configured) ? configured : [];
		const now = Date.now();

		// Prune addresses we have not heard from recently, and index what is
		// left by assigned ID for the configured devices the server has not
		// given a device_id yet. Built here, in the pass that already walks
		// every record, rather than maintained alongside the map - an index
		// that is rebuilt cannot go stale.
		const byId = new Map();
		for (const [key, rec] of this.discovered) {
			if (now - rec.lastSeen > EMIT_ADDRESS_TTL_MS) {
				this.discovered.delete(key);
				continue;
			}
			if (Number.isInteger(rec.id) && rec.id >= 1) {
				// Two live records can claim one ID: a device re-enrolled under
				// a new chip id, an old record that has not aged out, or -
				// since nothing on this segment is authenticated - something
				// claiming an ID that is not its own.
				//
				// The INCUMBENT wins, not the most recent. Preferring the most
				// recent means anything can take over a site's routing at any
				// moment by announcing; preferring the earliest means it has to
				// win the race at boot and then hold it, and the loser is
				// named in the log either way. The chip id buys no
				// authentication until the server puts device_id in the config
				// and seenFor() can pin on it - see seenFor.
				const prev = byId.get(rec.id);
				if (!prev) {
					byId.set(rec.id, rec);
				} else {
					// Infinity, not 0, for a record with no firstSeen: an
					// unknown age must not DISPLACE a known incumbent. A bare
					// `<` here compared undefined and was false in both
					// directions, so the winner was whichever key the Map
					// happened to reach first - the same data, two answers.
					const a = rec.firstSeen ?? Infinity;
					const b = prev.firstSeen ?? Infinity;
					// Equal ages - including two records that both lack one -
					// fall back to the chip id, so the answer is a property of
					// the two devices rather than of Map insertion order. It is
					// arbitrary, but the same two devices give the same answer
					// every time, which is what makes a report reproducible.
					if (a < b || (a === b && (rec.deviceId || '') < (prev.deviceId || ''))) {
						byId.set(rec.id, rec);
					}
					this.warnOnce(`idclash:${rec.id}`,
						`Two devices are both claiming emit ID ${rec.id} `
						+ `(${prev.ip} and ${rec.ip}). Routing is going to the one `
						+ `heard from first. This is a site fault, not a device one.`);
				}
			}
		}

		const unicastByUniverse = new Map();   // universe -> Set of IPs
		let anyNonEmit8 = false;
		let anyEmit8 = false;
		let anyEmit8Undiscovered = false;

		for (const emit of emitList) {
			if (!emit || typeof emit !== 'object') continue;

			const seen = this.seenFor(emit, byId);
			const universes = this.universesFor(emit);
			if (universes.length === 0) continue;

			// A record this box will not SEND to must not change where sACN
			// GOES. broadcastEmitAssignments skips an id below 1, so a record
			// like that describes a device that will never be told which
			// universes to listen on - dropping multicast for it would unicast
			// to a device that was never configured to expect it.
			if (!Number.isInteger(emit.id) || emit.id < 1) {
				anyEmit8Undiscovered = true;
				this.warnOnce(`badid:${emit.id}`,
					`An emit assignment has an unusable ID (${emit.id}); it cannot be `
					+ `sent to, so its universes are staying on multicast.`);
				continue;
			}

			if (!this.isEmit8(emit, seen)) {
				anyNonEmit8 = true;
				continue;
			}

			anyEmit8 = true;

			if (!seen?.ip) {
				// assigned but silent - keep multicast alive for its universes
				anyEmit8Undiscovered = true;
				continue;
			}

			for (const u of universes) {
				if (!unicastByUniverse.has(u)) unicastByUniverse.set(u, new Set());
				unicastByUniverse.get(u).add(seen.ip);
			}
		}

		// Multicast drops only when ALL of these hold: this location has an
		// Emit-8, every Emit here is an Emit-8, every one of them is actually
		// reachable by unicast, and the location has not been pinned to
		// multicast. Any doubt at all keeps multicast.
		const forced = configManager.getForceSacnMulticast();
		const keepMulticast = forced || !anyEmit8 || anyNonEmit8 || anyEmit8Undiscovered;

		const routes = [];
		for (let u = 1; u <= universeCount; u++) {
			const hosts = [];
			const unicast = unicastByUniverse.get(u);
			if (unicast) hosts.push(...unicast);
			if (keepMulticast || hosts.length === 0) hosts.push(null);   // null = multicast
			routes[u - 1] = hosts;
		}

		return { routes, keepMulticast, forced, anyEmit8, anyNonEmit8, anyEmit8Undiscovered };
	}


	// updateSACNRouting - push the computed routing into the sACN module
	updateSACNRouting() {
		try {
			const universeCount = attitudeSACN.universes;
			const { routes } = this.computeRoutes(universeCount);

			// `null` in a route list means "this universe's multicast group".
			// AttitudeSACN resolves it, because that is where the e131 import
			// lives and this module has no business knowing how a universe
			// number becomes 239.255.0.x.
			attitudeSACN.setRoutes(routes);
		} catch (error) {
			logger.error(`Error updating sACN routing: ${error}`);
		}
	}


	// broadcastEmitAssignments - broadcast universe and identify assignments to all known Attitude Emit devices
	broadcastEmitAssignments() {
		try {
			// grab the list of emit devices from the config manager
			// see computeRoutes for why this is guarded rather than read
			const raw = configManager.getAttitudeEmits();
			const emitList = Array.isArray(raw) ? raw : [];
			if (!Array.isArray(raw)) {
				this.warnOnce('emitlist-shape',
					`attitudeEmits in the config is not an array (${typeof raw}); `
					+ `no assignments can be sent until the server sends a list.`);
			}

			// loop through each emit device in the list
			for (const emit of emitList) {
				// A null or non-object entry used to throw out of this loop and
				// take EVERY device's assignment with it, because the whole
				// broadcast shares one try/catch. One bad config record should
				// cost one device, not the site.
				if (!emit || typeof emit !== 'object') {
					this.warnOnce('emit-entry-shape',
						`Skipping a malformed entry in the emit list: ${JSON.stringify(emit)}`);
					continue;
				}

				const id = emit.id;
				const identify = emit.assigned_identify_mode;

				// validate ID
				if (!Number.isInteger(id) || id < 1) {
					this.warnOnce(`send-badid:${id}`, `Skipping emit with invalid ID: ${id}`);
					continue;
				}

				// validate identify flag
				// Note this takes the device's UNIVERSE assignment down with it,
				// not just its identify state. That is pre-existing behaviour and
				// is left alone deliberately - changing which field can veto an
				// assignment is not a change to make in the same release as the
				// wire format.
				if (typeof identify !== 'boolean') {
					this.warnOnce(`send-badidentify:${id}`,
						`Skipping emit ID ${id}: invalid identify flag: ${identify}`);
					continue;
				}

				// construct UDP packet for this emit device
				// Addressing by chip id is what lets a device that has never
				// been enrolled be told what its ID is. It announces with ID 0,
				// matches this packet on the chip id it was born with, and
				// adopts DEST_ID as its own.
				//
				// Deliberately NOT a separate ID_SET field: DEST_ID already
				// carries the number, and two fields that have to agree is one
				// more thing to get wrong.
				//
				// It is attached ONLY on the multi-port path, deliberately. The
				// shipping Emit-1 parser's tolerance for keys it does not know
				// is not established anywhere, and the moment the server starts
				// filling device_id in on every emit row - which it will, it is
				// a DB column - an ungated field would put a new key and a
				// bigger datagram in front of every device in the fleet at
				// once. Tying the new field to the new shape means a legacy
				// record produces a byte-identical packet no matter what the
				// server puts in that column.
				const portMap = this.portMapFor(emit);
				const deviceId = this.normalizeDeviceId(emit.device_id);
				let packet;

				if (portMap) {
					// Multi-port shape. UNIVERSE_SET stays port 1's universe so
					// the field means exactly what it has always meant, and it
					// is written FROM the array rather than from a second
					// source - a device told one thing in the scalar and
					// another in the array is a mismatch nobody would look for.
					//
					// A map of all zeros is sent, not skipped: it is how an
					// enrolled-but-unassigned device learns its ID and gets to
					// a known state instead of being ignored.
					packet = {
						DEST_TYPE: 2,
						DEST_ID: id,
						UNIVERSE_SET: portMap[0],
						UNIVERSES_SET: portMap,
						IDENTIFY: identify,
					};
					if (deviceId) packet.DEST_DEVICE_ID = deviceId;
				} else {
					// Legacy single-universe shape, unchanged. Every Emit-1 in
					// the field reads UNIVERSE_SET and nothing else, and a
					// device with no valid universe is still skipped rather
					// than sent a zero it has no handling for.
					const universe = emit.assigned_universe;
					if (!Number.isInteger(universe) || universe < 1 || universe > MAX_UNIVERSE) {
						this.warnOnce(`send-baduniverse:${id}:${universe}`,
							`Skipping emit ID ${id}: invalid universe: ${universe}`);
						continue;
					}
					// Key order matches 2.A.17 exactly. JSON.stringify preserves
					// insertion order, so a reordered object is a different
					// datagram even though it is the same document - and
					// "byte-identical for the existing fleet" is a claim worth
					// being able to make literally.
					packet = {
						DEST_TYPE: 2,
						DEST_ID: id,
						UNIVERSE_SET: universe,
						IDENTIFY: identify,
					};
				}

				// send the packet via the UDP manager
				udpManager.send(packet);

				// optionally log the sent packet
				if (configManager.checkLogLevel('detail')) {
					logger.info(`Sent assignment to emit ID ${id}: ${JSON.stringify(packet)}`);
				}
			}

			// recompute where sACN should go, now that assignments and
			// discovery are both as fresh as they are going to get
			this.updateSACNRouting();

			// emit success module status
			eventHub.emit('moduleStatus', { 
				name: 'AttitudeEmitManager', 
				status: 'operational',
				data: '',
			});
		} catch (error) {
			// catch and report any internal error
			logger.error(`Error broadcasting emit assignments: ${error}`);
			eventHub.emit('moduleStatus', { 
				name: 'AttitudeEmitManager', 
				status: 'errored',
				data: `Error broadcasting emit assignments: ${error}`,
			});
		}
	}

}



// Create an instance of AttitudeEmitManager and initialize it
const attitudeEmitManager = new AttitudeEmitManager();

// Export the instance for use in other modules
export default attitudeEmitManager;
