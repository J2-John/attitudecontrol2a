// AttitudeScheduler.mjs
// schedule processing module for the Attitude Control 2.A app
// copyright 2024 Drew Shipps, J Squared Systems


// this module creates a single instance of the AttitudeScheduler javascript object,
// which then processes the schedule for this device



// ==================== IMPORT ====================
import Logger from './Logger.mjs';
const logger = new Logger('AttitudeScheduler');

import eventHub from './EventHub.mjs';
import configManager from './ConfigManager.mjs';
import attitudeSenseManager from './AttitudeSenseManager.mjs';

import { DateTime } from 'luxon';



// ==================== VARIABLES ====================
const PROCESS_SCHEDULE_INTERVAL = 1000;  // interval speed for recalculating the schedule in milliseconds
// might make this something configurable by the server later
const MAX_ZONES_COUNT = 10;  // max number of zones in the patch
const LOG_INDIVIDUAL_SCHEDULE_LEVELS = false;



// ==================== CLASS DEFINITION ====================
class AttitudeScheduler {

	// constructor
	constructor() {
		// setup timezones
		this.timezoneString = 'America/Chicago';
		this.currentTimestamp;

		// setup variables to hold current time
		this.now = {};
		this.now.month = 1;
		this.now.day = 1;
		this.now.weekday = 1;
		this.now.hour = 1;
		this.now.minute = 1;

		// setup variables to hold the different components of the configuration of the schedule blocks
		this.scheduleBlocks = [];
		this.customBlocks = [];
		this.overrides = [];
		this.webOverrides = [];

        // setup variable to hold active pulse override objects
        this.activePulseOverrides = [];

		// setup variables to hold the processed show ids lists. ex: [104, 1, 0, 37, 0]
		this.processedShowIds = {};
		this.processedShowIds.defaultWeeklySchedule = new Array(MAX_ZONES_COUNT).fill(0);
        this.processedShowIds.customScheduleBlocks = new Array(MAX_ZONES_COUNT).fill(0);
        this.processedShowIds.overrides = new Array(MAX_ZONES_COUNT).fill(0);
        this.processedShowIds.webOverrides = new Array(MAX_ZONES_COUNT).fill(0);
        this.processedShowIds.final = new Array(MAX_ZONES_COUNT).fill(0);

        // setup variable to hold the interval
        this.processScheduleInterval;
	}


	// Initialize the scheduler and start the interval
    init() {
        // Start the scheduling interval to run processSchedule function
        this.processScheduleInterval = setInterval(() => {
            // TEMPORARY INSTRUMENTATION
            if (!globalThis.__ATTPERF) { globalThis.__ATTPERF = { udpPackets: 0, udpBytes: 0, schedCalls: 0, schedNs: 0n, senseTriggers: 0 }; }
            const __t = process.hrtime.bigint();
            this.processSchedule();
            globalThis.__ATTPERF.schedCalls++;
            globalThis.__ATTPERF.schedNs += (process.hrtime.bigint() - __t);
        }, PROCESS_SCHEDULE_INTERVAL);

        // bind senseDataListener callback to senseData event emitted
        eventHub.on('senseData', this.senseDataListener.bind(this));

        logger.info('Initialized the scheduler and started the processSchedule interval!');

		// emit an event that we initialized the scheduler
        eventHub.emit('moduleStatus', { 
            name: 'AttitudeScheduler', 
            status: 'operational',
            data: '[]',
        });
    }

    // function that listents for new sense data. bound to eventHub in init()
    senseDataListener() {
    	// process the schedule an extra time, since new data came in from the sense
    	//  - this is intended to catch quick bursts coming from the sense for pulse triggers
    	// 	  that might not otherwise be caught by the standard once per second processing of the schedule
    	//  - this could be a potential cause of unecesary load spent processing the schedule, 
    	//    but idk if it'll be an issue

		// log that we're processing the schedule from the sense data listener
		if (configManager.checkLogLevel('interval')) {
			logger.info('Processing schedule from sense data listener callback...');
		}

		// actuall process schedule
		// TEMPORARY INSTRUMENTATION
		if (!globalThis.__ATTPERF) { globalThis.__ATTPERF = { udpPackets: 0, udpBytes: 0, schedCalls: 0, schedNs: 0n, senseTriggers: 0 }; }
		globalThis.__ATTPERF.senseTriggers++;
		const __t2 = process.hrtime.bigint();
    	this.processSchedule();
		globalThis.__ATTPERF.schedCalls++;
		globalThis.__ATTPERF.schedNs += (process.hrtime.bigint() - __t2);
    }

    // process the schedule at regular intervals
    processSchedule() {
    	// try to process schedule
    	try {
    		// grab the most up to date schedule config blocks & timestamp from configManager
    		this.updateScheduleConfigration();

    		// update the current timestamp based on timezone in config and 
    		this.updateCurrentTime();

    		// process each component of the schedule
    		this.processWeeklySchedule();
    		this.processCustomScheduleBlocks();
    		this.processOverrides();
    		this.processWebOverrides();

    		// layer the schedule
    		this.layerScheduleToCreateFinal();

    		// log the final output schedule
			if (configManager.checkLogLevel('interval')) {
    			logger.info('Processed schedule and determined final show ids: ' + JSON.stringify(this.processedShowIds?.final));
    		}

    		// check if any part of processing the schedule failed, putting us in degraded mode
    		let currentStatus = 'operational';
    		if (this.degraded) { currentStatus = 'degraded'; }

			// emit an event as to whether we are operational or degraded, but include processed show ids regardless
	        eventHub.emit('moduleStatus', { 
	            name: 'AttitudeScheduler', 
	            status: currentStatus,
	            data: JSON.stringify(this.processedShowIds?.final),
	        });
    	} catch (error) {
    		// else log error
            logger.error(`Error processing schedule: ${error}`);

			// emit an event that there was an error!
	        eventHub.emit('moduleStatus', { 
	            name: 'AttitudeScheduler', 
	            status: 'errored',
	            data: `Error processing schedule: ${error}`,
	        });
        }
    }


    // getFinalSchedule - getter function to return the final processed schedule
    getFinalSchedule() {
		// try to get the parameter, else throw/log an error and return a default
		try {
			// ? is the safe optional chaining operator that safely grabs those properties
	        const finalSchedule = this.processedShowIds?.final;

	        // if undefined then we have an error
	        if (finalSchedule === undefined) {
	            throw new Error('processedShowIds or .final is invalid!');
	        }

	        // else return the grabbed tiemzone
	        return finalSchedule;
	    } catch (error) {
	    	// log the error to logger
	        logger.error(`Error accessing this.processedShowIds.final: ${error.message}`);

			// emit an event that there was an error!
	        eventHub.emit('moduleStatus', { 
	            name: 'AttitudeScheduler', 
	            status: 'errored',
	            data: `Error accessing this.processedShowIds.final: ${error.message}`,
	        });

	        // return default (an array of zeroes)
	        return new Array(MAX_ZONES_COUNT).fill(0);
	    }
    }


    // updateScheduleConfigration - update the internal data about the schedule here with the data from the configManager
    updateScheduleConfigration() {
		// get current time from device config timezone
		this.timezoneString = configManager.getDeviceTimezone();

		// get schedule/custom/override blocks
    	this.scheduleBlocks = configManager.getScheduleBlocks();
		this.eventBlocks = configManager.getEventBlocks();
		this.customBlocks = configManager.getCustomBlocks();
		this.overrides = configManager.getOverrides();
		this.webOverrides = configManager.getWebOverrides();
	}


	// updateCurrentTime - update the internal time variables based on timezone
	updateCurrentTime() {
		// get the current local time
		var local = DateTime.local();

		// rezone the current local time based on the timezone string saved
		var rezoned = local.setZone(this.timezoneString);

		// update current timestamp
		this.currentTimestamp = rezoned;

		this.now = {};
		this.now.month = rezoned.month;
		this.now.day = rezoned.day;
		this.now.weekday = (rezoned.weekday % 7 + 1); // offset for luxon thinking about days of week differently
		this.now.hour = rezoned.hour;
		this.now.minute = rezoned.minute;

		// log the current time
		if (configManager.checkLogLevel('interval')) {
			logger.info(`Current time in ${this.timezoneString} is ${this.currentTimestamp.toFormat("ccc LLL d yyyy H:mm:ss 'GMT'ZZ (ZZZZ)")}`);
		}
	}


    // process the weekly schedule itself
    processWeeklySchedule() {
    	// try to process the weekly schedule
    	try {
    		// reset the weekly schedule variable to array of zeroes
    		this.processedShowIds.defaultWeeklySchedule = new Array(MAX_ZONES_COUNT).fill(0);

    		// find the current schedule block
		    const currentScheduleBlock = this.scheduleBlocks.find(block => 
		        block.day === this.now.weekday &&
		        block.start - 1 <= this.now.hour &&
		        block.start - 1 + block.height > this.now.hour
		    );

		    // if undefined, that means there's no block on the schedule grid for this point in time
		    if (currentScheduleBlock == undefined) {
		    	// log (optional)
			    if (configManager.checkLogLevel('detail')) {
			    	logger.info('No block assigned to this point in time on the default weekly schedule grid.');
			    }

		    	// in this case we just need zeroes
            	this.processedShowIds.defaultWeeklySchedule = new Array(MAX_ZONES_COUNT).fill(0);
		    } else {
			    // find the actual event block from the ID referenced in current schedule block
			    const eventBlock = this.eventBlocks.find(itm => itm.id === currentScheduleBlock.eventBlockId);

			    // if a block was found, then pull the showdata out and map it to the defaultWeeklySchedule
			    if (eventBlock) {
			        this.processedShowIds.defaultWeeklySchedule = [...eventBlock.showdata];

			        // Fill remaining spots with 0 if necessary
			        while (this.processedShowIds.defaultWeeklySchedule.length < MAX_ZONES_COUNT) {
			            this.processedShowIds.defaultWeeklySchedule.push(0);
			        }
			    }
		    }

		    // log that we finished (optional)
		    if (configManager.checkLogLevel('detail')) {
		    	logger.info('Processed default weekly schedule: ' + JSON.stringify(this.processedShowIds.defaultWeeklySchedule));
		    }
    	} catch (error) {
    		// else log error
            logger.error(`Error processing weekly schedule: ${error}`);

            // set degraded flag to true
            // note that we're only going to emit an event after finishing processing the schedule
            // so that we can still know the final show IDs being processed, even if part of the processing is degraded
            this.degraded = true;

            // default array to zeroes, which will make this part of the schedule processing transparent
            this.processedShowIds.defaultWeeklySchedule = new Array(MAX_ZONES_COUNT).fill(0);
    	}
    }


    // process the custom schedule blocks (pre-schedule overrides)
    processCustomScheduleBlocks() {
    	// try processing custom blocks
    	try {
    		// reset the custom schedule blocks variable to array of zeroes
    		this.processedShowIds.customScheduleBlocks = new Array(MAX_ZONES_COUNT).fill(0);

    		// iterate over each custom block
    		this.customBlocks.forEach(thisBlock => {
    			// variable to hold if this block applies to today
				let thisBlockShouldBeToday = false;

				// validate that we aren't using the old type of custom block with singular month/days
				if (thisBlock.month !== undefined && thisBlock.day !== undefined) {
					let blockName = thisBlock?.name ?? 'no name found';
					logger.warn('Custom block "' + blockName
					 + '" was built prior to the introduction of start dates and end dates in custom schedule blocks. '
					 + 'Please delete and rebuild this custom schedule block. (Skipping processing for this block)');
					return;
		        }

		        // if the any of the month/day start/end values are undefined, throw an error
		        if (thisBlock.startMonth == undefined || thisBlock.startDay == undefined ||
		            thisBlock.endMonth == undefined || thisBlock.endDay == undefined) {
	        		throw new Error('Invalid start/end month/day for this block.');
		    	}

		    	// now setup the monthday stamps, which establish whether we are currently within the month/day combo selected
			    const startMonthDayStamp = thisBlock.startMonth * 100 + thisBlock.startDay;
			    const endMonthDayStamp = thisBlock.endMonth * 100 + thisBlock.endDay;
			    const currentMonthDayStamp = this.now.month * 100 + this.now.day;

			    // massive if statement to check if we are within the timespan for this block (note that some wrap around the new year)
			    if (
			        (endMonthDayStamp >= startMonthDayStamp && currentMonthDayStamp >= startMonthDayStamp && currentMonthDayStamp <= endMonthDayStamp) ||
			        (endMonthDayStamp < startMonthDayStamp && (currentMonthDayStamp >= startMonthDayStamp || currentMonthDayStamp <= endMonthDayStamp))
			    ) {
			        thisBlockShouldBeToday = true;
			        if (endMonthDayStamp < startMonthDayStamp) {
			        	if (configManager.checkLogLevel('detail')) {
			        		logger.info('This schedule block wraps around the new year.');
			        	}
			        }
			    }

			    // if it is determnied that this block should be run today, then we need to check the time of day
				if (thisBlockShouldBeToday) {
					// calculate raw time numbers in number of minutes for current, start, and end
				    const currentTimeNumber = this.now.hour * 60 + this.now.minute;
				    const thisBlockStartNumber = thisBlock.startHour * 60 + thisBlock.startMinute;
				    const thisBlockEndNumber = thisBlock.endHour * 60 + thisBlock.endMinute;

				    // see if we are within those numbers
				    if (currentTimeNumber >= thisBlockStartNumber && currentTimeNumber < thisBlockEndNumber) {
				    	// log that we're running this custom block
				    	if (configManager.checkLogLevel('detail')) {
				    		logger.info(`Running custom schedule block "${thisBlock.name}"`);
				    	}

				    	// pull the showdata out of this custom block and 
				    	this.processedShowIds.customScheduleBlocks = this.layerAnOverride(this.processedShowIds.customScheduleBlocks, thisBlock.showdata);

				    	// fill remaining spots with 0 if necessary
				        while (this.processedShowIds.defaultWeeklySchedule.length < MAX_ZONES_COUNT) {
				            this.processedShowIds.defaultWeeklySchedule.push(0);
				        }
				    }
				}
			});

		    // log that we finished (optional)
		    if (configManager.checkLogLevel('detail')) {
		    	logger.info('Processed custom schedule blocks: ' + JSON.stringify(this.processedShowIds.customScheduleBlocks));
		    }
    	} catch (error) {
    		// else log error
            logger.error(`Error processing custom schedule blocks: ${error}`);

            // set degraded flag to true
            this.degraded = true;

            // default array to zeroes, which will make this part of the schedule processing transparent
            this.processedShowIds.customScheduleBlocks = new Array(MAX_ZONES_COUNT).fill(0);
    	}
    }


    // process the overrides from the attitude sense or other ext. devices
    processOverrides() {
    	// try processing overrides
    	try {
    		// reset the overrides variable to array of zeroes
    		this.processedShowIds.overrides = new Array(MAX_ZONES_COUNT).fill(0);

    		// grab the attitude senses from the config manager
    		// i hate javascript
    		// because i had to use JSON.parse/stringify to make a full copy of the attitudeSenses object
    		// so that the stuff we do later in this function doesn't screw it up
    		// causing the override_id for some ports to flicker
    		let attitudeSenses = JSON.parse(JSON.stringify(configManager.getAttitudeSenses()));

    		// grab the overrides from the config manager
    		let overrides = configManager.getOverrides();

    		// iterate over each sense
    		attitudeSenses.forEach(attitudeSense => {
    			// get the most up-to-date port data from the Attitude Sense manager
    			let sensePortData = attitudeSenseManager.getSensePortDataById(attitudeSense.id);

    			// console.log(`----- Processing sense ID : ${attitudeSense.id}, port data ${sensePortData} -----`)

			    // iterate over each sense port and add a portNumber to it
			    for (let p = 0; p < attitudeSense.data.length; p++) {
			    	attitudeSense.data[p].portNumber = p + 1;
			    }

    			// sort the ports by priority (if priority exists).
    			// sort order is by priority, then reverse order. meaning port 1 is top priority
    			let ports = attitudeSense.data;
			    let sortedPorts = ports.sort((a, b) => {
			        const aPriority = (typeof a.priority === 'number') ? a.priority : Infinity;
			        const bPriority = (typeof b.priority === 'number') ? b.priority : Infinity;

			        // If priorities are different, sort by priority
			        if (aPriority !== bPriority) {
			            return aPriority - bPriority;
			        }
			        // If priorities are the same or not found, sort by original index (reverse order)
			        return ports.indexOf(b) - ports.indexOf(a);
			    });

			    // iterate over the sorted ports
			    sortedPorts.forEach(port => {
			    	// find the whether this port is active or not
			    	// based on whether this port number (-1 for 0 based counting) in the array is true or false
			    	let isThisPortActive = sensePortData[port.portNumber - 1] ?? false;

		    		// if there's no override assigned to this port, skip to next port
		    		// - updated this validation to account for null
		    		const portOverrideId = parseInt(port.override_id);
					if (!Number.isInteger(portOverrideId) || portOverrideId <= 0) {
						return;
					}

		    		// find the override that is associated to this port
		    		let override = overrides.find(override => override.id === parseInt(port.override_id));

		    		// if no override found, log an error and return
		    		if (override === undefined) {
		    			logger.error(`Couldn't find an override with id ${port.override_id}!`);
		    			return;
		    		}

	    			// check port mode
	    			if (port.mode == 'toggle') {
	    				// if the port is active, then we need to layer in the override
	    				if (isThisPortActive) {
		    				// grab the showdata from the override
		    				let showsdata = JSON.parse(override.showsdata);

		    				// layer the showdata onto the overrides layer
		    				this.processedShowIds.overrides = this.layerAnOverride(this.processedShowIds.overrides, showsdata);
	    				}
	    			} else if (port.mode == 'pulse') {
	    				// if it's pulse

	    				// if the port is active, then we need to update the activePulseOverrides list
	    				if (isThisPortActive) {

	    					// Parse duration
							var duration = parseInt(port.timeLength, 10);
							if (!Number.isInteger(duration) || duration <= 0) {
		    					logger.error(`Invalid duration for port ${port.portNumber} override id ${override.id}`);
								return;
							}

							// Get current time
							var now = new Date();
							var activeUntil = new Date(now);

							// Add time based on timeMode
							switch (port.timeMode) {
								case 'sec':
									activeUntil.setSeconds(activeUntil.getSeconds() + duration);
									break;
								case 'min':
									activeUntil.setMinutes(activeUntil.getMinutes() + duration);
									break;
								case 'hour':
									activeUntil.setHours(activeUntil.getHours() + duration);
									break;
								default:
									console.warn("Invalid timeMode");
									return;
							}

							// calculate the difference in seconds for logging below
							let diff = new Date(activeUntil) - now;
							diff = Math.round(diff/1000);

						    // log that the override was just activated for x seconds
						    if (configManager.checkLogLevel('detail')) {
							    logger.info(`New pulse override (sense id ${attitudeSense.id}, port ${port.portNumber}) was just activated for ${diff} seconds.`);
							}

							// try to find an existing override and update it
							const existing = this.activePulseOverrides.find(o =>
								o.attitudeSenseId === attitudeSense.id &&
								o.portNumber === port.portNumber
							);

							// check if existing was found
							if (existing) {
								// if so, update the activeUntil time on it
								existing.activeUntil = activeUntil;
							} else {
								// or add a new override
								this.activePulseOverrides.push({
									attitudeSenseId: attitudeSense.id,
									portNumber: port.portNumber,
									activeUntil: activeUntil
								});
							}
	    				}


	    				// regardless of port active or not, we need to check if its active in the activePulseOverrides list
	    				let currentTime = new Date();

	    				// attempt to find the relevant activePulseOverride
						const found = this.activePulseOverrides.find(o =>
							o.attitudeSenseId === attitudeSense.id &&
							o.portNumber === port.portNumber
						);

						if (found) {
							// if it's currently active (because date is less than activeUntil)
							if (currentTime < new Date(found.activeUntil)) {
								// calculate the difference in seconds for logging below
								let diff = new Date(found.activeUntil) - currentTime;
								diff = Math.round(diff/1000);

							    // log that the override is active for x more seconds
							    if (configManager.checkLogLevel('detail')) {
								    logger.info(`Pulse override (sense id ${found.attitudeSenseId}, port ${found.portNumber}) is currently active for ${diff} more seconds.`);
								}

			    				// grab the showdata from the override
			    				let showsdata = JSON.parse(override.showsdata);

			    				// layer the showdata onto the overrides layer
			    				this.processedShowIds.overrides = this.layerAnOverride(this.processedShowIds.overrides, showsdata);
							} else {
							    // log that the override expired and we removed it
							    if (configManager.checkLogLevel('detail')) {
								    logger.info(`Removing active pulse override (sense id ${found.attitudeSenseId}, port ${found.portNumber}) from list because it expired.`);
								}

								// otherwise remove the expired override
								const index = this.activePulseOverrides.indexOf(found);
								if (index !== -1) {
									this.activePulseOverrides.splice(index, 1);
								}
							}
						}
	    			} else {
	    				logger.error(`Unknown port mode ${port.mode}!`);
	    			}
			    });
			});

		    // console.error('Processed overrides: ' + JSON.stringify(this.processedShowIds.overrides));

		    // log that we finished (optional)
		    if (configManager.checkLogLevel('detail')) {
			    logger.info('Processed overrides: ' + JSON.stringify(this.processedShowIds.overrides));
			}
    	} catch (error) {
    		// else log error
            logger.error(`Error processing external overrides: ${error}`);

            // set degraded flag to true
            this.degraded = true;

            // default array to zeroes, which will make this part of the schedule processing transparent
            this.processedShowIds.overrides = new Array(MAX_ZONES_COUNT).fill(0);
    	}
    }


    // process web overrides
    processWebOverrides() {
    	// try processing web overrides
    	try {
    		// reset the web overrides variable to array of zeroes
    		this.processedShowIds.webOverrides = new Array(MAX_ZONES_COUNT).fill(0);

    		// loop through each web override in reverse order
		    this.webOverrides.slice().reverse().forEach(webOverride => {
		    	// if it's active
		        if (webOverride.active) {
		        	// if it doesn't have a web override assigned to it
		        	if (webOverride.override_id == 0) {
		        		// log a warning that this web override doesn't have an associated override
				    	if (configManager.checkLogLevel('detail')) {
				    		logger.warn(`Web override "${webOverride.name}" is active but doesn't have an override block selected!`);
				    	}

				    	// continue to the next override
				    	return;
		        	}

			    	// log that we're running this web override
			    	if (configManager.checkLogLevel('detail')) {
			    		logger.info(`Running active web override "${webOverride.name}"`);
			    	}

		            // Find the override object associated with this port
		            const override = this.overrides.find(obj => obj.id === webOverride.override_id);

		            // if valid override found
		            if (override) {
			            // next grab the showdata out and parse it as JSON (not sure why it's being flattened into a string?, 
			            // but that's irrelevant to this module)
			            const overrideShowData = JSON.parse(override.showsdata);

			            // now map the showdata from the override to the webOverrides layer
		                this.processedShowIds.webOverrides = this.layerAnOverride(this.processedShowIds.webOverrides, [...overrideShowData]);
		            } else {
		            	// throw an error since this override couldnt be found
		            	throw new Error('Invalid override_id for this web overrride!');
		            }
		        }
		    });

		    // log that we finished (optional)
		    if (configManager.checkLogLevel('detail')) {
			    logger.info('Processed web overrides: ' + JSON.stringify(this.processedShowIds.webOverrides));
			}
    	} catch (error) {
    		// else log error
            logger.error(`Error processing web overrides: ${error}`);

            // set degraded flag to true
            this.degraded = true;

            // default array to zeroes, which will make this part of the schedule processing transparent
            this.processedShowIds.webOverrides = new Array(MAX_ZONES_COUNT).fill(0);
    	}
    }


    // layerScheduleToCreateFinal - layers the different schedule components to create a final schedule
    layerScheduleToCreateFinal() {
    	// layer each schedule show IDs map
    	var defaultAndCustom = this.layerAnOverride(this.processedShowIds.defaultWeeklySchedule, this.processedShowIds.customScheduleBlocks);
    	var andOverrides = this.layerAnOverride(defaultAndCustom, this.processedShowIds.overrides);
    	var andWebOverrides = this.layerAnOverride(andOverrides, this.processedShowIds.webOverrides);

    	// assign this to the final processed layer
    	this.processedShowIds.final = andWebOverrides;
    }


    // layerAnOverride - takes a base and layers in the override above it, handling zone/group mis-matches appropriately
	layerAnOverride(base, layer) {
		return base.map((zone, z) => {
			// Check if the layer for this zone is an array (indicating groups)
			if (Array.isArray(layer[z])) {
				// Ensure zone is treated as an array
				const oldZoneData = Array.isArray(zone) ? zone : [zone];
				
				return layer[z].map((group, g) => {
					if (group > 0) {
						// Group is set to override, so use the new layer data for this group
						return group;
					} else {
						// Group is set to no change, so use the old zone data
						return oldZoneData[g] !== undefined ? oldZoneData[g] : oldZoneData[0];
					}
				});
			} else if (layer[z] > 0) {
				// Zone is set to override, so use the new layer data for this zone
				return layer[z];
			} else {
				// Zone is set to base, so use the base data for this zone
				return zone;
			}
		});
	}
}



// ==================== EXPORT ====================
const attitudeScheduler = new AttitudeScheduler();
export default attitudeScheduler;
