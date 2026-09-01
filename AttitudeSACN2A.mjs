// AttitudeSACN2A.mjs
// sACN communication module for the Attitude Control 2.A app
// copyright 2024 Drew Shipps, J Squared Systems


// this module creates a single instance of the AttitudeSACN javascript object,
// which is responsible for sending sACN data out to lighting fixtures



// ==================== IMPORT ====================
import eventHub from './EventHub.mjs';
import e131 from 'e131';

import Logger from './Logger.mjs';
const logger = new Logger('AttitudeSACN');



// ==================== VARIABLES ====================
const DMX_INTERVAL_SPEED = 24;  // interval speed for DMX in milliseconds 
const DEBUG_FPS = false;  // enable or disable FPS debugging


// multicastGroupFor - the E1.31 multicast address for a universe.
//
// The e131 PACKAGE exports only Client and Server; getMulticastGroup lives in
// e131/lib/e131.js and is not reachable as e131.getMulticastGroup(). Calling it
// that way throws, and because initialize() catches its own errors the module
// would have reported 'errored' and never started the DMX interval - every
// location dark, with a log line instead of a crash. Reproduced verbatim from
// e131/lib/e131.js rather than reaching into the package's internals, which
// would break on any repackaging.
function multicastGroupFor(universe) {
	if (!Number.isInteger(universe) || universe < 1 || universe > 63999) {
		throw new RangeError(`universe should be in the range [1-63999], got ${universe}`);
	}
	return '239.255.' + (universe >> 8) + '.' + (universe & 0xff);
}



// ==================== CLASS DEFINITION ====================
class AttitudeSACN {

	// constructor
	constructor() {
		// Initialize arrays to hold clients, packets, and slot data
		this.clients = [];
		this.packets = [];
		this.slotsDatas = [];

		// Destination routing. `clientsByHost` is one e131 client per DESTINATION
		// rather than one per universe, and `routes[u]` lists the hosts universe
		// u+1 should be sent to. A destination is either a multicast group or a
		// unicast address; e131.Client treats an integer as a universe (and
		// resolves it to its multicast group) and a string as a literal host.
		this.clientsByHost = new Map();
		this.routes = [];

		// One sequence number per universe, owned here rather than by the e131
		// client - see processDMX for why that distinction matters once a
		// universe has more than one destination.
		this.sequenceNumbers = [];
		
		// Default number of universes, can be changed in initialize
		this.universes = 4;
		
		// Frames per second counter
		this.fps = 0;
		
		// Variables to control DMX interval
		this.dmxIntervalActive = false;
		this.dmxInterval = null;

		// variable to track errored or not
		this.errored = false;

		// variable to track white backup mode
		this.whiteBackupMode = false;

		// set an interval for FPS once per second
		setInterval(() => {
			if (DEBUG_FPS) {
				// if debugging FPS, actually log the FPS to console
				logger.info(`DMX over sACN status fps: ${this.fps}`);
			}

			// emit an event that the module is operational and note the FPS
			if (!this.errored) {
		        eventHub.emit('moduleStatus', { 
		            name: 'AttitudeSACN', 
		            status: 'operational',
		            data: 'FPS: ' + this.fps,
		        });
			}

			// reset fps counter
			this.fps = 0;
		}, 1000);
	}


	// Method to initialize the sACN system with a given number of universes
	initialize(univ) {
		// try catch errors
		try {
			// Set the number of universes
			this.universes = univ;

			// Log initialization info
			logger.info(`Initializing with ${this.universes} universes at a ${DMX_INTERVAL_SPEED}ms interval...`);

			// Loop through each universe to set up clients and packets
			for (let i = 0; i < this.universes; i++) {
				// Every universe starts out routed to its multicast group,
				// which is byte-for-byte what this module did before routing
				// existed. If setRoutes() is never called, this box behaves
				// exactly as it always has - that is the property that makes
				// this change safe to ship to a live fleet.
				const multicastHost = multicastGroupFor(i + 1);
				this.routes[i] = [multicastHost];
				this.clients[i] = this.getClient(multicastHost);
				this.sequenceNumbers[i] = 0;

				// Create a packet for each client
				this.packets[i] = this.clients[i].createPacket(512);
				
				// Get slots data from the packet
				this.slotsDatas[i] = this.packets[i].getSlotsData();

				// Set source name, universe, and options for each packet
				this.packets[i].setSourceName('Attitude sACN Client');
				this.packets[i].setUniverse(i + 1);
				this.packets[i].setOption(this.packets[i].Options.PREVIEW, false);
				this.packets[i].setPriority(this.packets[i].DEFAULT_PRIORITY);

				// initialize slotsData to white
				for (let c = 0; c < 512; c++) {
					this.slotsDatas[i][c] = 255;
				}
			}

			// start DMX interval for sending packets out via client.send()
			this.dmxIntervalActive = true;
			this.dmxInterval = setInterval(() => {
	            this.processDMX();
	        }, DMX_INTERVAL_SPEED);

			// Log that the system is initialized
			logger.info(`System initialized, now outputting DMX over sACN!`);

			// emit an event that the system is initialized
	        eventHub.emit('moduleStatus', { 
	            name: 'AttitudeSACN', 
	            status: 'initialized',
	            data: '',
	        });
		} catch (error) {
			// Log the error!
			logger.error(`Error while initializing AttitudeSACN! ${error}`);

			// emit an event that the system had an error while initializing
	        eventHub.emit('moduleStatus', { 
	            name: 'AttitudeSACN', 
	            status: 'errored',
	            data: `Error while initializing AttitudeSACN! ${error}`,
	        });
		}
	}


	// getClient - one e131 client per destination host, created on demand and
	// reused. A client is a UDP socket; making a fresh one per frame would leak
	// file descriptors on a box that runs for months.
	getClient(host) {
		let client = this.clientsByHost.get(host);
		if (!client) {
			client = new e131.Client(host);
			this.clientsByHost.set(host, client);
		}
		return client;
	}


	// setRoutes - replace the destination list for every universe.
	//
	// `routesByUniverse` is an array indexed by universe number MINUS ONE, each
	// entry an array of destination hosts. A universe with an empty or missing
	// entry falls back to its multicast group rather than going silent: a
	// routing table that is wrong should degrade to the old behaviour, not to
	// no output. Fixtures going dark is a worse failure than a duplicate frame.
	setRoutes(routesByUniverse) {
		try {
			if (!Array.isArray(routesByUniverse)) {
				throw new Error('routesByUniverse must be an array');
			}

			let changed = false;

			for (let i = 0; i < this.universes; i++) {
				let hosts = routesByUniverse[i];

				// fall back to multicast for anything missing or malformed
				if (!Array.isArray(hosts) || hosts.length === 0) {
					hosts = [multicastGroupFor(i + 1)];
				}

				// `null` means "this universe's multicast group" - the caller
				// decides policy, this module owns the address arithmetic.
				hosts = hosts.map(h => (h === null ? multicastGroupFor(i + 1) : h));

				// keep only well-formed, de-duplicated host strings
				hosts = [...new Set(hosts.filter(h => typeof h === 'string' && h.length > 0))];
				if (hosts.length === 0) {
					hosts = [multicastGroupFor(i + 1)];
				}

				const before = (this.routes[i] || []).join(',');
				if (before !== hosts.join(',')) changed = true;

				this.routes[i] = hosts;

				// make sure a client exists for every host we are about to use
				for (const h of hosts) this.getClient(h);
			}

			if (changed) {
				logger.info(`sACN routing updated: ${this.describeRoutes()}`);
			}
		} catch (error) {
			// A bad routing table must never take sACN down. Log it and keep
			// sending on whatever routes were already in place.
			logger.error(`Error while setting sACN routes, keeping previous routing! ${error}`);
		}
	}


	// describeRoutes - a compact, loggable summary of where each universe goes
	describeRoutes() {
		const parts = [];
		for (let i = 0; i < this.universes; i++) {
			const hosts = this.routes[i] || [];
			if (hosts.length === 1 && hosts[0] === multicastGroupFor(i + 1)) continue;
			parts.push(`u${i + 1}->[${hosts.join(' ')}]`);
		}
		return parts.length ? parts.join(' ') : 'all universes multicast (default)';
	}


	// Method to set DMX values for specific channels in specific universes
	set(u, c, v) {
		// Ensure universe, channel, and value are within valid ranges
		if (u > 0 && u <= this.universes) {
			if (c > 0 && c <= 512) {
				if (v >= 0 && v <= 255) {
					// Set the slot data value
					this.slotsDatas[u - 1][c - 1] = v;
				}
			}
		}
	}


	// processDMX - function to process a frame of DMX and send it to sACN
	processDMX() {
		try {
			// Increment FPS counter
			this.fps++;

			// Loop through each universe to send packets
			for (let u = 0; u < this.universes; u++) {
				// if we're in white backup mode, set all channels on this universe to 255
				if (this.whiteBackupMode) {
					for (let c = 0; c < 512; c++) {
						this.slotsDatas[u][c] = 255;
					}
				}

				// THE SEQUENCE NUMBER IS OURS, not the library's.
				//
				// e131's Client.send() calls packet.incrementSequenceNumber()
				// inside its own send callback. With one destination that is
				// exactly right. With N destinations it fires N times per frame,
				// so the sequence advances by N per frame instead of by 1.
				//
				// That is wrong twice over. By E1.31 the sequence number belongs
				// to the source and universe, not to a delivery - the same frame
				// sent to two places is one packet delivered twice, and both
				// receivers should see the same number. And it breaks the only
				// loss diagnostic an Emit-8 has: its parser counts a difference
				// greater than 1 as missing packets, because on that hardware a
				// sequence hole is the ONLY evidence of a dropped datagram (the
				// W6300 has no receive-overflow flag). A location with an Emit-8
				// and an Emit-1 has two destinations on that universe, so a
				// perfectly healthy link would report 50% packet loss forever,
				// on exactly the mixed sites where the number matters most.
				//
				// So the counter is kept here and stamped before each frame. The
				// library's post-send increment still happens and is simply
				// overwritten next frame. With a single destination the observable
				// behaviour is byte-for-byte what it has always been: +1 a frame.
				const hosts = this.routes[u] || [];
				if (hosts.length > 0) {
					this.packets[u].setSequenceNumber(this.sequenceNumbers[u]);
					this.sequenceNumbers[u] = (this.sequenceNumbers[u] + 1) & 0xFF;

					for (let d = 0; d < hosts.length; d++) {
						const client = this.clientsByHost.get(hosts[d]);
						if (!client) continue;
						client.send(this.packets[u], () => {
							// Sent callback
						});
					}
				}
			}

			// disable errored flag so that FPS counter starts
			this.errored = false;
		} catch (error) {
			// note the error so the FPS counter will stop
			this.errored = true;

			// Log the error
			logger.error(`Error while processing DMX: ${error}`);

			// emit an event that the system had an error
	        eventHub.emit('moduleStatus', { 
	            name: 'AttitudeSACN', 
	            status: 'errored',
	            data: `Error while processing DMX: ${error}`,
	        });

		}
	}


	// enable or disable white backup mode
	setWhiteBackupMode(value) {
		if (value == true) {
			// set white backup mode to true
			this.whiteBackupMode = true;

			// log a warning that we are in white backup mode
			logger.warn('White Backup Mode is now ENABLED! All fixtures will be white!');
		} else if (value == false) {
			// if we were previously in white backup mode, log a message that we are out of white backup mode
			if (this.whiteBackupMode) {
				logger.warn('White Backup Mode is now disabled. Fixtures will return to standard shows.');
			}

			// set white backup mode to false
			this.whiteBackupMode = false;
		} else {
			logger.error('Unknown white backup mode setting.')
		}
	}
}



// ==================== EXPORT ====================
const attitudeSACN = new AttitudeSACN();
export default attitudeSACN;
