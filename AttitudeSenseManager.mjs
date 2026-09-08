// AttitudeSenseManager.mjs
// Attitude sense communication module for the Attitude Control 2.A app
// copyright 2024 Drew Shipps, J Squared Systems


// this module creates a single instance of the AttitudeSenseManager javascript object,
// which controls the attitude sense units connected to this system



// ==================== IMPORT ====================
import eventHub from './EventHub.mjs';
import dgram from 'dgram';
import configManager from './ConfigManager.mjs';

import Logger from './Logger.mjs';
const logger = new Logger('AttitudeSenseManager');



// ==================== VARIABLES ====================
const LAPTOP_MODE = (process.platform == 'darwin');

// How long a sense packet stays valid before the unit is treated as absent.
//
// mostRecentPacketFromEachSense had no expiry at all: set, has, get, and nothing else. A sense
// that had EVER been heard from was always "found", however long ago. So a unit powered down or
// unplugged while a port was asserted latched that port active FOREVER - a toggle-mode override
// stayed layered on every pass, for days, outranking both the weekly schedule and custom blocks,
// with no way to dislodge it. Pulse mode was worse: its self-expiry is defeated because the port
// still reads active, so activeUntil is refreshed on every tick and the pulse re-arms forever.
//
// The comment on getSensePortDataById already promised the correct behaviour ("default response
// if ID is not found is array of zeroes so that no ports will be active"); it just never applied
// to a stale unit. AttitudeEmitManager has exactly this TTL, with a written rationale.
//
// SET THIS AGAINST THE SENSE FIRMWARE'S REAL ANNOUNCE INTERVAL. Too short and live triggers get
// dropped. 60s matches EMIT_ADDRESS_TTL_MS and is comfortably longer than the observed rate.
const SENSE_PACKET_TTL_MS = 60000;





// ==================== CLASS DEFINITION ====================
class AttitudeSenseManager {

	// constructor
	constructor() {
		// create an array to hold the most recent packet from each sense
		this.mostRecentPacketFromEachSense = new Map();

        // Bind the handleNewSenseData function to the current instance
        // this fixes the issues with calling this.validateSenseDataObject() inside handleNewSenseData
        this.handleNewSenseData = this.handleNewSenseData.bind(this);
	}


	// initialize the client for receiving data from attitude sense units
	init() {
		try {
			// log that we are initializing the client (optional)
			// logger.info(`Initializing Attitude Sense Manager...`);

			// attach a hanlder function to the message received function
			eventHub.on('receivedUDP', this.handleNewSenseData);

			// log that we completed the initialization process
	        logger.info('Completed initialization of Attitude Sense Manager for listening to Attitude Sense devices.');

			// emit an event that we initialized the client for UDP
	        eventHub.emit('moduleStatus', { 
	            name: 'AttitudeSenseManager', 
	            status: 'operational',
	            data: '',
	        });
	    } catch (error) {
			// log that we failed to initialize
	        logger.error(`Failed to initialize UDP client! ${error}`);

			// emit an event that we initialized the client for UDP
	        eventHub.emit('moduleStatus', { 
	            name: 'AttitudeSenseManager', 
	            status: 'errored',
	            data: `Failed to initialize UDP client! ${error}`,
	        });
	    }
	}


	// handleNewSenseData - function to handle the data packet received from the sense
	handleNewSenseData(object) {
		// wrap the processing logic in a try catch in case of errors
		try {
			// skip packets that are not from TYPE 1 devices (i.e. not from Attitude Sense units)
			if (object?.TYPE !== 1) {
				if (configManager.checkLogLevel('detail')) {
					logger.info(`Skipped non-sense UDP packet or invalid TYPE: ${object?.TYPE}`);
				}
				return;
			}

			// validate the packet
			this.validateSenseDataObject(object);

    		// if detail log level, log that we just got a status packet
			if (configManager.checkLogLevel('detail')) {
    			logger.info(`New packet of TYPE=1 from sense ID: ${object.ID} with data ${object.DATA}`);
    		}

    		// console.log(`New packet from sense ID: ${object.ID} with data ${object.DATA}`);

    		// update the map with the most recent packet from each sense
            // stamp arrival time so a unit that goes quiet can age out (see SENSE_PACKET_TTL_MS)
            this.mostRecentPacketFromEachSense.set(object.ID, { ...object, receivedAt: Date.now() });

            // process the data array from the sense's ports (string to array)
            const processedDataArrray = this.processSensePortData(object.DATA);

            // create a packet for sending to the server with all data about this sense packet
            const senseDataPacket = {
				timestamp: new Date().toISOString(),
				name: object.NAME,
				type: object.TYPE,
				id: object.ID,
				version: object.VERSION,
				packet_no: object.PACKET_NO,
				data: processedDataArrray,
			};

			// emit an event with the new sense data packet
			// network module will pick this up and send it to the server
			eventHub.emit('senseData', senseDataPacket);

    		// if interval log level, log that we finished processing the packet
			if (configManager.checkLogLevel('interval')) {
    			logger.info(`Processed packet from sense ID: ${object.ID} with data ${object.DATA}`);
    		}

    		// always emit a module status event
	        eventHub.emit('moduleStatus', { 
	            name: 'AttitudeSenseManager', 
	            status: 'operational',
	            data: '',
	        });
		} catch (error) {
    		// else log error
            logger.error(`Error processing client message: ${error}`);

			// emit an event that there was an error
	        eventHub.emit('moduleStatus', { 
	            name: 'AttitudeSenseManager', 
	            status: 'errored',
	            data: `Error processing client message: ${error}`,
	        });
        }
	}


	// validateSenseDataObject - validate that the sense data object includes all of the necesary parameters
	validateSenseDataObject(obj) {
		// Check if TYPE property exists and is equal to 1
		if (obj.TYPE !== 1) {
			throw new Error("Invalid TYPE property. It must be equal to 1.");
		}

		// Check if ID property exists and is an integer
		if (!Number.isInteger(obj.ID)) {
			throw new Error("Invalid ID property. It must be an integer.");
		}

		// Check if DATA property exists and follows the specified format
		const dataPattern = /^([01],){15}[01]$/;
		if (typeof obj.DATA !== 'string' || !dataPattern.test(obj.DATA)) {
			throw new Error("Invalid DATA property. It must be a string of 16 numbers (0 or 1) separated by commas.");
		}

        // Check if NAME property exists and is a string
        if (typeof obj.NAME !== 'string') {
            throw new Error("Invalid NAME property. It must exist and be a string.");
        }

        // Check if VERSION property exists
        if (typeof obj.VERSION === 'undefined') {
            throw new Error("Invalid VERSION property. It must exist.");
        }

        // Check if PACKET_NO property exists
        if (typeof obj.PACKET_NO === 'undefined') {
            throw new Error("Invalid PACKET_NO property. It must exist.");
        }

		return true;
	}


	// processSensePortData and turn it into an array of integers
	processSensePortData(dataString) {
	    // Split the string by commas and convert each item to an integer
	    return dataString.split(',').map(Number);
	}


	// getSensePortDataById - get the most recent port data for a sense unit based on ID
	// default response if ID is not found is array of zeroes so that no ports will be active
	getSensePortDataById(id) {
		// Convert the ID to an integer
	    const intId = parseInt(id);

		// Check if the ID exists in the map AND is still fresh. A packet older than the TTL
		// means the unit has gone quiet, and a silent sense must read as "no ports active"
		// rather than holding whatever it last reported - see SENSE_PACKET_TTL_MS.
	    const dataPacket = this.mostRecentPacketFromEachSense.get(intId);
	    const isFresh = dataPacket
	        && typeof dataPacket.receivedAt === 'number'
	        && (Date.now() - dataPacket.receivedAt) < SENSE_PACKET_TTL_MS;

	    if (isFresh) {
	        // Convert the DATA string to an array
	        return this.processSensePortData(dataPacket.DATA);
	    } else {
	    	// a stale entry is dropped so it cannot be served again, and so a returning unit
	    	// starts clean rather than inheriting its own pre-outage state
	    	if (dataPacket) {
	    		this.mostRecentPacketFromEachSense.delete(intId);
	    		logger.warn(`Sense ID ${id} has not reported within ${SENSE_PACKET_TTL_MS}ms - treating its ports as inactive.`);
	    	}

    		// if detail log level, log that this sense couldn't be found
			if (configManager.checkLogLevel('detail')) {
    			logger.warn(`getSensePortDataById: Sense ID ${id} couldn't be found!`);
    		}

	        // Return an array of 16 zeroes if the ID is not found
	        return Array(16).fill(0);
	    }
	}
}



// Create an instance of AttitudeSenseManager and initialize it
const attitudeSenseManager = new AttitudeSenseManager();

// Export the attitudeLED instance for use in other modules
export default attitudeSenseManager;