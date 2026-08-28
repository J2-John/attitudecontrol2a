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
// packet. Devices announce once per second; a minute of silence means it is
// gone, and its universes should fall back to multicast rather than being
// unicast into a hole.
const EMIT_ADDRESS_TTL_MS = 60000;

// Matches what an Emit-8 calls itself in telemetry. The server-side model
// field is authoritative when present; this is the fallback so that routing
// works before anyone has to change the web app.
const EMIT8_NAME_PATTERN = /emit[\s._-]*8/i;




// ==================== CLASS DEFINITION ====================
class AttitudeEmitManager {

	// constructor
	constructor() {
		// bind functions
		this.handleNewEmitData = this.handleNewEmitData.bind(this);

		// id -> { ip, name, universes[], isEmit8, lastSeen }
		// Populated from telemetry. The box has always received this; it simply
		// had nowhere to put it.
		this.discovered = new Map();
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

			// log the incoming emit packet
			if (configManager.checkLogLevel('detail')) {
				logger.info(`New packet of TYPE=2 from emit ID: ${object.ID} with universe ${object.UNIVERSE}`);
			}

			// log any reported errors
			if (typeof object.ERRORS === 'string' && object.ERRORS.length > 0) {
				logger.error(`Emit device ID ${object.ID} reported error: ${object.ERRORS}`);
			}

			// construct packet
			const emitDataPacket = {
				timestamp: new Date().toISOString(),
				name: object.NAME,
				type: object.TYPE,
				id: object.ID,
				version: object.VERSION,
				packet_no: object.PACKET_NO,
				reported_universe: object.UNIVERSE,
				reported_identify_mode: object.IDENTIFY,
				errors: object.ERRORS || '',
			};

			// Remember where this device lives, so sACN can be unicast to it.
			// _SOURCE_IP is attached by UDPManager from the datagram itself and
			// is the one field here a device cannot lie about by claiming it.
			if (typeof object._SOURCE_IP === 'string' && object._SOURCE_IP.length > 0) {
				const universes = Array.isArray(object.UNIVERSES)
					? object.UNIVERSES.filter(u => Number.isInteger(u) && u >= 1)
					: (Number.isInteger(object.UNIVERSE) ? [object.UNIVERSE] : []);

				this.discovered.set(object.ID, {
					ip: object._SOURCE_IP,
					name: typeof object.NAME === 'string' ? object.NAME : '',
					universes,
					isEmit8: typeof object.NAME === 'string'
						&& EMIT8_NAME_PATTERN.test(object.NAME),
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



	// validateEmitDataObject - validate that the emit data object includes all required parameters
	validateEmitDataObject(obj) {
		// Validate TYPE is 2 (Emit)
		if (obj.TYPE !== 2) {
			logger.warn(`Rejected emit packet: TYPE must be 2 but got ${obj?.TYPE}`);
			return false;
		}

		// Validate ID is integer ≥ 1
		if (!Number.isInteger(obj.ID) || obj.ID < 1) {
			logger.warn(`Rejected emit packet: ID must be an integer ≥ 1 but got ${obj?.ID}`);
			return false;
		}

		// Validate UNIVERSE is integer ≥ 1
		if (!Number.isInteger(obj.UNIVERSE) || obj.UNIVERSE < 1) {
			logger.warn(`Rejected emit packet: UNIVERSE must be an integer ≥ 1 but got ${obj?.UNIVERSE}`);
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


	// universesFor - which universes a configured device is assigned.
	// Tolerates the single-integer field that exists today and the array that
	// an eight-universe device needs.
	universesFor(emit) {
		if (Array.isArray(emit?.assigned_universes)) {
			return emit.assigned_universes.filter(u => Number.isInteger(u) && u >= 1);
		}
		return Number.isInteger(emit?.assigned_universe) && emit.assigned_universe >= 1
			? [emit.assigned_universe]
			: [];
	}


	// computeRoutes - decide, per universe, where this LOCATION's sACN goes.
	//
	//   Emit-8 assigned, nothing else   -> unicast, and multicast too UNLESS
	//                                      this location has opted out
	//   no Emit-8                       -> multicast, exactly as before
	//   both an Emit-8 and an Emit-1    -> both
	//
	// Multicast is only ever dropped when configManager.getSuppressSacnMulticast()
	// says this location has been checked. Third-party sACN receivers are in use
	// at many sites and none of them appear in attitudeEmits, so the set of
	// devices assigned here is NOT the set of devices listening. Inferring
	// "nothing else needs multicast" from an assignment list would silently
	// black out equipment this box has never heard of.
	//
	// The decision is per location because each control box only ever sees and
	// feeds its own site. Suppressing multicast where nothing needs it keeps a
	// site's cheap unmanaged switches from flooding eight universes to every
	// port, which is the practical reason to bother.
	//
	// Two deliberate safety valves:
	//   - an Emit-8 that is assigned but has not yet been heard from has no
	//     address to unicast to, so that universe KEEPS multicast until it
	//     announces itself. Boot order must not black out a site.
	//   - any universe that ends up with no destination at all falls back to
	//     multicast inside AttitudeSACN.setRoutes().
	computeRoutes(universeCount) {
		const emitList = configManager.getAttitudeEmits();
		const now = Date.now();

		// prune addresses we have not heard from recently
		for (const [id, rec] of this.discovered) {
			if (now - rec.lastSeen > EMIT_ADDRESS_TTL_MS) this.discovered.delete(id);
		}

		const unicastByUniverse = new Map();   // universe -> Set of IPs
		let anyNonEmit8 = false;
		let anyEmit8 = false;
		let anyEmit8Undiscovered = false;

		for (const emit of emitList) {
			const seen = this.discovered.get(emit?.id);
			const universes = this.universesFor(emit);
			if (universes.length === 0) continue;

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

		// Multicast stays on unless ALL of these hold: the location has opted
		// out, every Emit here is an Emit-8, and every one of them is actually
		// reachable by unicast. Any doubt at all keeps multicast.
		const optedOut = configManager.getSuppressSacnMulticast();
		const keepMulticast = !optedOut || !anyEmit8 || anyNonEmit8 || anyEmit8Undiscovered;

		const routes = [];
		for (let u = 1; u <= universeCount; u++) {
			const hosts = [];
			const unicast = unicastByUniverse.get(u);
			if (unicast) hosts.push(...unicast);
			if (keepMulticast || hosts.length === 0) hosts.push(null);   // null = multicast
			routes[u - 1] = hosts;
		}

		return { routes, keepMulticast, optedOut, anyEmit8, anyNonEmit8, anyEmit8Undiscovered };
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
			const emitList = configManager.getAttitudeEmits();

			// loop through each emit device in the list
			for (const emit of emitList) {
				const id = emit.id;
				const universe = emit.assigned_universe;
				const identify = emit.assigned_identify_mode;

				// validate ID
				if (!Number.isInteger(id) || id < 1) {
					logger.warn(`Skipping emit with invalid ID: ${id}`);
					continue;
				}

				// validate universe number
				if (!Number.isInteger(universe) || universe < 1) {
					logger.warn(`Skipping emit ID ${id}: invalid universe: ${universe}`);
					continue;
				}

				// validate identify flag
				if (typeof identify !== 'boolean') {
					logger.warn(`Skipping emit ID ${id}: invalid identify flag: ${identify}`);
					continue;
				}

				// construct UDP packet for this emit device
				const packet = {
					DEST_TYPE: 2,
					DEST_ID: id,
					UNIVERSE_SET: universe,
					IDENTIFY: identify,
				};

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
