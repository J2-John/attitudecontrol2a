// UDPManager.mjs
// Centralized UDP communication manager for the Attitude Control 2.A app
// Handles outbound message sending and inbound message receiving
// copyright 2025 Drew Shipps, J Squared Systems


// this module creates a single instance of the UDPManager javascript object,
// which handles UDP communication for all device types in the Attitude system



// ==================== IMPORT ====================
import eventHub from './EventHub.mjs';
import dgram from 'dgram';
import configManager from './ConfigManager.mjs';

import Logger from './Logger.mjs';
const logger = new Logger('UDPManager');



// ==================== VARIABLES ====================
const LAPTOP_MODE = (process.platform == 'darwin');
const UDP_PORT = 6455;  // All devices listen on this port
const BROADCAST_IP = '255.255.255.255';



// ==================== CLASS DEFINITION ====================
class UDPManager {

	// constructor
	constructor() {
		// packet number counter used to assign PACKET_NO to outbound messages
		this.packetCounter = 1;

		// Bind the handleMessage function to the current instance
		this.handleMessage = this.handleMessage.bind(this);
	}


	// init - initialize the UDP socket and prepare to receive messages
	init() {
		try {
			// create the UDP socket
			this.socket = dgram.createSocket('udp4');

			// bind the socket to the correct port
			this.socket.bind(UDP_PORT, () => {
				// enable broadcast mode
				this.socket.setBroadcast(true);
			});

			// attach handler function for received messages
			this.socket.on('message', this.handleMessage);

			// log successful init
			logger.info(`UDPManager initialized on port ${UDP_PORT}`);

			// emit module status event
			eventHub.emit('moduleStatus', { 
				name: 'UDPManager',
				status: 'operational',
				data: '',
			});
		} catch (error) {
			// log failure to init
			logger.error(`Failed to initialize UDP socket: ${error}`);

			// emit error status
			eventHub.emit('moduleStatus', { 
				name: 'UDPManager',
				status: 'errored',
				data: `Failed to initialize UDP socket: ${error}`,
			});
		}
	}


	// handleMessage - process an incoming UDP message
	handleMessage(message, info) {
		// TEMPORARY INSTRUMENTATION - count all inbound datagrams before any parsing
		if (!globalThis.__ATTPERF) { globalThis.__ATTPERF = { udpPackets: 0, udpBytes: 0, schedCalls: 0, schedNs: 0n, senseTriggers: 0 }; }
		globalThis.__ATTPERF.udpPackets++;
		globalThis.__ATTPERF.udpBytes += message.length;

		try {
			// parse message into JSON
			let parsed = JSON.parse(message.toString());

			// validate structure of the incoming packet
			const isValid = this.validateIncomingPacket(parsed);
			if (!isValid) return; // ignore bad packets

			// emit the validated packet to the entire system
			eventHub.emit('receivedUDP', parsed);

			// optionally log the event if detail logging is enabled
			if (configManager.checkLogLevel('detail')) {
				logger.info(`Received packet from ${info.address}: ${JSON.stringify(parsed)}`);
			}
		} catch (error) {
			// log parsing or validation errors
			logger.error(`Invalid UDP packet received: ${error}`);
		}
	}



	// send - send a UDP broadcast message with standardized fields and auto packet number
	send(payloadObject) {
		try {
			// validate that payloadObject is an object
			if (typeof payloadObject !== 'object' || payloadObject === null || Array.isArray(payloadObject)) {
				throw new Error('Payload must be a valid JavaScript object.');
			}

			// validate DEST_TYPE
			const destType = payloadObject.DEST_TYPE;
			if (![1, 2].includes(destType)) {
				throw new Error(`Invalid DEST_TYPE: must be 1 or 2, got ${destType}`);
			}

			// validate DEST_ID
			const destId = payloadObject.DEST_ID;
			if (!Number.isInteger(destId) || destId < 1) {
				throw new Error(`Invalid DEST_ID: must be an integer >= 1, got ${destId}`);
			}

			// build message with standard fields
			const message = {
				...payloadObject,
				NAME: 'Attitude Control',
				TYPE: 0,
				PACKET_NO: this.packetCounter,
			};

			// packet counter loops over at 200
			this.packetCounter = (this.packetCounter % 200) + 1;

			// convert to JSON string
			const jsonString = JSON.stringify(message);

			// broadcast to the network
			this.socket.send(jsonString, 0, jsonString.length, UDP_PORT, BROADCAST_IP);

			// optionally log the status complete if detail logging is enabled
			if (configManager.checkLogLevel('detail')) {
				logger.info(`Sent UDP packet: ${jsonString}`);
			}
		} catch (error) {
			logger.error(`UDPManager send() failed: ${error}`);
		}
	}



	// validateIncomingPacket - validate structure and type safety of incoming packets
	validateIncomingPacket(obj) {
		// ignore packets from ourselves (TYPE = 0 means it's a control packet sent by this system)
		if (obj?.TYPE === 0) {
			return false; // silently skip, no need to warn
		}
		
		// confirm TYPE is either 1 (Sense) or 2 (Emit)
		if (![1, 2].includes(obj?.TYPE)) {
			logger.warn(`UDP packet rejected: invalid or missing TYPE (${obj?.TYPE})`);
			return false;
		}

		// required keys
		const requiredKeys = ['NAME', 'TYPE', 'ID', 'VERSION'];
		for (const key of requiredKeys) {
			if (typeof obj[key] === 'undefined') {
				logger.warn(`UDP packet rejected: missing required key '${key}'`);
				return false;
			}
		}

		// if we reach here, the packet is considered valid
		return true;
	}

}



// create the instance
const udpManager = new UDPManager();

// export for use in other modules
export default udpManager;
