// AttitudeFixtureManager.mjs
// manages and processes fixtures for the Attitude Control 2.A app
// copyright 2024 Drew Shipps, J Squared Systems


// this module creates a single instance of the AttitudeFixtureManager javascript object,
// which then takes the fixtures, schedule, shows, and engine to calculate DMX values



// ==================== IMPORT ====================
import Logger from './Logger.mjs';
const logger = new Logger('AttitudeFixtureManager');

import eventHub from './EventHub.mjs';
import configManager from './ConfigManager.mjs';
import attitudeScheduler from './AttitudeScheduler.mjs';
import attitudeSACN from './AttitudeSACN2A.mjs';

// import engine
import { AttitudeEngine3 } from './AttitudeEngine3.mjs';
import { SHOWTYPES } from './ShowTypes.js';
import { DIRECTIONS } from './Directions.js';
import { TRANSITIONS } from './Transitions.js';



// ==================== VARIABLES ====================
const DMX_FRAME_INTERVAL = 25;  // interval speed in milliseconds for each DMX frame (should be 25ms)
const GAMMA = 1.7;

// How often the frame-rate summary is recomputed. The summary string is attached to the
// module status this class already emits every frame, so this only controls how often the
// numbers refresh - it adds no extra traffic.
const PERF_WINDOW_MS = 10000;



// ==================== CLASS DEFINITION ====================
class AttitudeFixtureManager {

	// constructor
	constructor() {
		// variables to hold fixture/shows/schedule configuration
		this.zonesList = [];
		this.fixturesList = [];
		this.showsList = [];
		this.schedule = new Array(10).fill(0);

		// variable to hold instances of the AttitudeEngine for each show
		// each engineInstance should include an object with the engine and show ID
		this.engineInstances = [];

		// variable to hold the processFixtures interval ID
		this.processFixturesInterval;

		// ---- frame timing ----
		// Plain numbers updated in place; nothing here allocates per frame. Rolled up into
		// perfSummary once every PERF_WINDOW_MS and reported via the existing module status.
		this.perfFrames = 0;
		this.perfWindowStart = 0;
		this.perfLastFrameStart = 0;
		this.perfMaxFrameMs = 0;
		this.perfMaxGapMs = 0;
		this.perfSummary = '';
	}


	// start the DMX frame interval for running the engine
    init() {
        // Start the scheduling interval to run processFixtures function
        this.processFixturesInterval = setInterval(() => {
            this.processFixtures();
        }, DMX_FRAME_INTERVAL);

        // log succcess message
        logger.info('Initialized the fixture manager and started the process fixtures interval!');

		// emit an event that we initialized the fixture manager
        eventHub.emit('moduleStatus', { 
            name: 'AttitudeFixtureManager', 
            status: 'operational',
            data: '',
        });
    }


    // processFixtures - master function that runs every 25ms to process fixtures/shows/schedule,
    // run engine, then send values to sACN/DMX
    processFixtures() {
    	// Stamp the start of the frame before any work. The gap since the previous frame
    	// start is how we see the render loop being starved by something else on the thread -
    	// a large maxgap with a small maxframe means this function is fine and is simply not
    	// being called on time.
    	const frameStart = performance.now();

    	if (this.perfLastFrameStart) {
    		const gapMs = frameStart - this.perfLastFrameStart;
    		if (gapMs > this.perfMaxGapMs) { this.perfMaxGapMs = gapMs; }
    	}
    	this.perfLastFrameStart = frameStart;

    	// try to process fixtures
    	try {
    		// check if we are assigned to a location or not
    		if (configManager.getAssignedToLocation()) {
	    		// get fixtures/zones/shows configManager and schedule from attitudeScheduler
	        	this.getConfigration();

	        	// find unique show IDs in schedule
				this.uniqueShowIds = this.findUniqueNumbers(this.schedule);

				// generate/remove engine instances if needed
				this.generateEngineInstances();

				// process each engine instance, updating engine config if necesary and running engine
				this.processEngineInstances();

	        	// process the patch and schedule, then grab the output data from the engine and apply it to DMX
	        	this.processPatchAndOutputShows();

	    		// log the interval
	    		if (configManager.checkLogLevel('detail')) {
	    			logger.info('Successfully finished processing fixtures/shows/schedule and output data to sACN!');
	        	}

				// emit an event that we successfully processed everything
		        eventHub.emit('moduleStatus', { 
		            name: 'AttitudeFixtureManager', 
		            status: 'operational',
		            data: this.perfSummary || 'Processed fixtures/shows/schedule and sent DMX to AttitudeSACN module!',
		        });
		    } else {
		    	// otherwise we aren't assigned to a location, so set everything to white
		    	for (let u = 1; u <= 8; u++) {
		    		for (let c = 1; c <= 512; c++) {
		    			attitudeSACN.set(u, c, 255);
		    		}
		    	}

	    		// log the interval
	    		if (configManager.checkLogLevel('detail')) {
	    			logger.info('Device is unassigned, so no fixtures to process. Successfully output white to all channels!');
	        	}

				// emit an event that we successfully output white
		        eventHub.emit('moduleStatus', { 
		            name: 'AttitudeFixtureManager', 
		            status: 'operational',
		            data: 'Device is unassigned, so no fixtures to process. Successfully output white to all channels!',
		        });
		    }
    	} catch (error) {
    		// else log error
            logger.error(`Error processing fixtures: ${error}`);

			// emit an event that we had an error
	        eventHub.emit('moduleStatus', { 
	            name: 'AttitudeFixtureManager', 
	            status: 'errored',
	            data: `Error processing fixtures: ${error}`,
	        });
        } finally {
        	// count the frame whether or not it succeeded - a frame that threw still consumed
        	// time, and excluding failures would flatter the numbers exactly when they matter
        	this.recordFrame(frameStart);
        }
    }


    // recordFrame - fold one frame into the running totals, and roll them up into a summary
    // string once per window. Wrapped in its own try/catch: telemetry must never be the
    // reason a device stops rendering.
    recordFrame(frameStart) {
    	try {
    		const now = performance.now();
    		const frameMs = now - frameStart;

    		if (frameMs > this.perfMaxFrameMs) { this.perfMaxFrameMs = frameMs; }
    		this.perfFrames++;

    		// first frame after boot: start the window here rather than counting a partial one
    		if (!this.perfWindowStart) {
    			this.perfWindowStart = now;
    			this.perfFrames = 0;
    			this.perfMaxFrameMs = 0;
    			this.perfMaxGapMs = 0;
    			return;
    		}

    		const windowMs = now - this.perfWindowStart;
    		if (windowMs < PERF_WINDOW_MS) { return; }

    		// fps is measured, not assumed - frames actually completed divided by real elapsed
    		// time. The interval is set to 25ms (40fps); anything well below that means the
    		// device is not keeping up.
    		const fps = (this.perfFrames * 1000) / windowMs;

    		this.perfSummary = 'fps=' + fps.toFixed(1)
    			+ ' maxframe=' + this.perfMaxFrameMs.toFixed(1) + 'ms'
    			+ ' maxgap=' + this.perfMaxGapMs.toFixed(1) + 'ms'
    			+ ' engines=' + this.engineInstances.length
    			+ ' fixtures=' + (this.fixturesList ? this.fixturesList.length : 0)
    			+ ' zones=' + (this.zonesList ? this.zonesList.length : 0);

    		this.perfFrames = 0;
    		this.perfWindowStart = now;
    		this.perfMaxFrameMs = 0;
    		this.perfMaxGapMs = 0;
    	} catch (error) {
    		// deliberately silent - a broken counter is not worth a log line every 25ms
    	}
    }


    // getConfigration - update the internal data about the schedule here by getting the most recent data from the configManager
    getConfigration() {
		// get schedule/custom/override blocks
		this.zones = configManager.getZones();
		this.fixtures = configManager.getFixtures();
		this.shows = configManager.getShows();
		this.schedule = attitudeScheduler.getFinalSchedule();
	}


	// process the patch and schedule, then grab the output data from the engine and apply it to DMX
	processPatchAndOutputShows() {

		// iterate over each zone
		this.zones.forEach((zone, index) => {
			// try catch
			try {
				// grab the scheduled show or shows for this zone
				let currentZoneSchedule = this.schedule[index] ?? 0;

				// check if there's groups in the schedule
				if (currentZoneSchedule.length > 0) {
					// check if there's groups in the zone
					if (zone.groups.length > 0) {
						// iterate over each group
						zone.groups.forEach((group, groupIndex) => {
							// try catch
							try {
								// grab the show for this group
								let currentGroupShowId = currentZoneSchedule[groupIndex] ?? 0;

								// grab the fixtures for this show
								// make sure to always return an array of items using Array.of and spread syntax
								let fixturesForThisShow = Array.of(...this.fixtures.filter(item => item.zoneNumber == (index + 1)
																 && item.groupNumber == (groupIndex + 1)));

								// apply this show ID to these fixtures
								this.applyShowToFixtures(currentGroupShowId, fixturesForThisShow);
							} catch (error) {
								// log the error while processing this group
								logger.error(`Error while processing zone ${index+1} group ${groupIndex+1}: ${error.message}`);

								// emit an event that we had an error (degraded state only)
						        eventHub.emit('moduleStatus', { 
						            name: 'AttitudeFixtureManager', 
						            status: 'degraded',
						            data: `Error while processing zone ${index+1} group ${groupIndex+1}: ${error.message}`,
						        });
							}
						});
					} else {
						// if not then we have a weird error
						throw new Error('This zone has groups in the schedule, but not in the zone!');
					}
				} else {
					// otherwise no groups in this zone, so all fixtures tied to this zone should be used
					// make sure to always return an array of items using Array.of and spread syntax
					let fixturesForThisShow = Array.of(...this.fixtures.filter(itm => itm.zoneNumber == (index + 1)));

					// apply this show ID to these fixtures
					this.applyShowToFixtures(currentZoneSchedule, fixturesForThisShow);
				}
			} catch (error) {
				let zoneName = zone.name;
				if (zoneName == undefined) {
					zoneName = index;
				}

				// log the error
				logger.error(`Error while processing zone ${zoneName}: ${error}`);

				// emit an event that we had an error 
				// (note that since this error only applies to this zone, we are only in a degraded state, not full error)
		        eventHub.emit('moduleStatus', { 
		            name: 'AttitudeFixtureManager', 
		            status: 'degraded',
		            data: `Error while processing zone ${zoneName}: ${error}`,
		        });
			}
		});
	}


	// applyShowToFixtures - given a show ID and array of fixtures, apply the show to the fixtures
	applyShowToFixtures(showId, fixtures) {
		// console.log(showId);

		// validate fixtures
		if (fixtures == undefined || fixtures.length == undefined) {
			throw new Error('Fixtures or fixtures length is undefined!');
		}

		// validate the number of fixtures
		if (fixtures.length == 0) {
			// logger.info('No fixtures for this show. Skipping.');
			return;
		}

		// get the engineInstance for this show id
	    let engineInstance = this.engineInstances.find(itm => itm.showId === showId);

	    // check if it's undefined
	    if (engineInstance == undefined && !(showId == 0)) {
	    	throw new Error(`Unable to find an engne instance for show id ${showId}!`);
	    }

	    // calculate all fixture segments (handling single, multicount, and segmented fixtures)
	    let fixtureSegments = this.calculateAllFixtureSegments(fixtures);

	    // set the number of total segments to calculate for,
	    // as long as the show id is not zero. If it's zero, we're just outputting black to all anyway.
	    if (!(showId == 0)) {
		    engineInstance.engine.setFixtureCount(fixtureSegments.length);
		}

	    // now try to apply this show to the fixtures by iterating over each
		try {
			fixtureSegments.forEach((fixtureSegment, index) => {
				// variable to hold the color for this fixture (default to black)
				let thisFixtureColor = {
					red: 0,
					green: 0,
					blue: 0,
					white: 0,
				}

				// if the current show id isn't zero
				if (!(showId == 0)) {
					// get the color corresponding to this pixel
					thisFixtureColor = engineInstance.engine.getFixtureColor(index);

					// process a white value for this color from RGB
					thisFixtureColor.white = this.calculateWhiteFromRGB(thisFixtureColor);
				}

				// now run a gamma curve function on this color
				thisFixtureColor = this.calculateColorGamma(thisFixtureColor);

				// check if this fixture should be highlighted
				if (fixtureSegment.highlight) {
					// if so, set the color to full white (regardless of the engine color from previously)
					thisFixtureColor = {
						red: 255,
						green: 255,
						blue: 255,
						white: 255,
					}
				}

				// check color type & output DMX values
				if (fixtureSegment.colorMode == 'RGB') {
					// rgb
					attitudeSACN.set(fixtureSegment.universe, fixtureSegment.startAddress, thisFixtureColor.red);
					attitudeSACN.set(fixtureSegment.universe, fixtureSegment.startAddress+1, thisFixtureColor.green);
					attitudeSACN.set(fixtureSegment.universe, fixtureSegment.startAddress+2, thisFixtureColor.blue);
				} else if (fixtureSegment.colorMode == 'RGBW') {
					attitudeSACN.set(fixtureSegment.universe, fixtureSegment.startAddress, thisFixtureColor.red);
					attitudeSACN.set(fixtureSegment.universe, fixtureSegment.startAddress+1, thisFixtureColor.green);
					attitudeSACN.set(fixtureSegment.universe, fixtureSegment.startAddress+2, thisFixtureColor.blue);
					attitudeSACN.set(fixtureSegment.universe, fixtureSegment.startAddress+3, thisFixtureColor.white);
				} else {
					throw new Error(`Unknown fixture color mode ${fixtureSegment.colorMode}`);
				}
			});
		} catch (error) {
			logger.error(`Error while applying show ${showId} to ${fixtureSegments.length} fixtures: ${error.message}`);

			// emit an event that we had an error (degraded state only)
	        eventHub.emit('moduleStatus', { 
	            name: 'AttitudeFixtureManager', 
	            status: 'degraded',
	            data: `Error while applying show ${showId} to ${fixtureSegments.length} fixtures: ${error.message}`,
	        });
		}
	}


	// calculateAllFixtureSegments - process all fixtures, multicount fixtures, and segmented fixtures into a patch list
	calculateAllFixtureSegments(fixturesList) {
	    // Initialize an empty array to store the result
	    const resultList = [];

	    // grab the possible fixture types from configManager
	    const fixtureTypes = configManager.getFixtureTypes();

	    // Iterate through each fixture in the fixturesList
	    for (const thisFixture of fixturesList) {
	        // Find the fixture type using a hypothetical findFixtureType function
	        const thisFixtureType = fixtureTypes.find(itm => itm.id == thisFixture.type);

	        // Calculate channels per segment based on fixture type
	        const channelsPerSegment = thisFixtureType.channels / thisFixtureType.segments || thisFixtureType.channels;

	        // Determine how to handle each fixture based on its type and configuration
	        if (thisFixtureType.multicountonefixture) {
	            // Handle fixtures with multiple counts for one fixture
	            for (let i = 0; i < thisFixture.quantity; i++) {
	                const newObject = {
	                    universe: thisFixture.universe,
	                    startAddress: thisFixture.startAddress + (channelsPerSegment * i),
	                    colorMode: thisFixtureType.color,
	                    highlight: thisFixture.highlight ?? false,
	                };
	                resultList.push(newObject);
	            }
	        } else if (thisFixtureType.segments > 1) {
	            // Handle fixtures with multiple segments
	            for (let i = 0; i < thisFixtureType.segments; i++) {
	                const newObject = {
	                    universe: thisFixture.universe,
	                    startAddress: thisFixture.startAddress + (channelsPerSegment * i),
	                    colorMode: thisFixtureType.color,
	                    highlight: thisFixture.highlight ?? false,
	                };
	                resultList.push(newObject);
	            }
	        } else {
	            // Handle single fixtures
	            const newObject = {
	                universe: thisFixture.universe,
	                startAddress: thisFixture.startAddress,
	                colorMode: thisFixtureType.color,
                    highlight: thisFixture.highlight ?? false,
	            };
	            resultList.push(newObject);
	        }
	    }

	    // Return the final resultList containing all generated objects
	    return resultList;
	}


	// processEngineInstances - process each engine instance
	processEngineInstances() {
		// iterate over each engineInstance
		this.engineInstances.forEach(engineInstance => {
			// update engine instance configuration based on show

		    // find the show corresponding to this engineInstance
		    const show = this.shows.find(itm => itm.id === engineInstance.showId);

		    // check to make sure this show exists
		    if (typeof show !== 'undefined') {
			    // check if this show is designed for the current engine
			    if (show.engineVersion == '2A') {
			    	// if so, update the parameters on the engine to match the show
		            engineInstance.engine.configure({
			            showType: show.showType,
			            direction: show.direction,
			            speed: show.speed,
			            size: show.size,
			            splits: show.splits,
			            transition: show.transition,
			            transitionWidth: show.transitionWidth,
			            bounce: show.bounce,
			            colors: show.colors,
			        });
			    } else {
			    	// otherwise this show needs ot be translated to run properly.
			    	try {
				    	// this holds the new show names as keyed to match the old show type ids
				    	let newShowTypes = ['Static', 'All', 'All', 'Chase', 'Chase', 'Chase'];
				    	let translatedShowType = newShowTypes[show.type - 1];

				    	// depending on the show type, we may need to set the transition width (default to 0.0)
				    	let translatedTransitionWidth = 0;
				    	if (show.type == 2 || show.type == 6) {
				    		// if the show type is 2 (All Fade) or 6 (fluid chase) then transition width should be 1.0
				    		translatedTransitionWidth = 1;
				    	} else if (show.type == 5) {
				    		// if the show type is 5 (fade chase) then transition width should be 0.25
				    		translatedTransitionWidth = 0.25;
				    	}

				    	// this holds the new directions as keyed to match the old direction numbers
				    	let newDirections = ['Left to Right', 'Right to Left', 'Middle to Ends', 'Ends to Middle'];
				    	let translatedDirection = newDirections[show.direction];

				    	// the old speed is an integer from 0 - 100. Let's translate that to a value 10 - 180
				    	let translatedSpeed = Math.round(show.speed * 1.7 + 10);

				    	// the old size is an integer 1 - 20, so map that to some new values
				    	let newSizeValues = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16, 20, 25, 33, 50, 100];
				    	let translatedSize = newSizeValues[show.size - 1];

				    	// splits should translate exactly as normal
				    	let translatedSplits = Math.round(show.splits);

				    	// now let's process colors
				    	let translatedColors = show.colorsList.map(color => {
					        // Destructure the color array into red, green, and blue components
					        const [red, green, blue] = color;
					        
					        // Create an object with the required keys and assign values
					        // If all components are 255, it is white; otherwise, set white to 0
					        const colorObject = {
					            red: red,
					            green: green,
					            blue: blue,
					        };

					        return colorObject;
					    });


				    	// configure the engine instance with the paramters from the translated show data
			            engineInstance.engine.configure({
				            showType: translatedShowType,
				            direction: translatedDirection,
				            speed: translatedSpeed,
				            size: translatedSize,
				            splits: translatedSplits,
				            transition: 'Both Edges',
				            transitionWidth: translatedTransitionWidth,
				            bounce: false,
				            colors: translatedColors,
				        });

			            // log that this show was translated
	    				if (configManager.checkLogLevel('detail')) {
			    			logger.info(`Show ${show.name} was successfully translated to the new engine!`);
			    		}
			        } catch (error) {
			        	// otherwise log that we had an error translating it
				    	// we're still going to process this show later, so that the fixtures it should run on will default 
				    	// to gray (128,128,128) instead of black or no signal
				    	logger.error(`Show ${show.name} is not compatible with the new engine and failed to translate with error: ${error}`);

						// emit an event that we are in a warning phase, bcause this show is incompatible
				        eventHub.emit('moduleStatus', { 
				            name: 'AttitudeFixtureManager', 
				            status: 'degraded',
				            data: `Show ${show.name} is not compatible with the new engine and failed to translate with error: ${error}`,
				        });
			        }
			    }
			} else {
				// otherwise the show does not exist

				// configure the engine to take the fixtures white
				engineInstance.engine.configure({
		            showType: 'Static',
		            direction: 'Left to Right',
		            speed: 50,
		            size: 100,
		            splits: 1,
		            transition: 'Both Edges',
		            transitionWidth: 0,
		            bounce: false,
		            colors: [ { red: 255, green: 255, blue: 255 } ],
		        });

	            // log that this show was not found
				if (configManager.checkLogLevel('minimal')) {
	    			logger.warn(`Show ID ${engineInstance.showId} was not found! Some fixtures will be white!`);
	    		}

		        // emit an event that we are in a degraded state, bcause this show does not exist
		        eventHub.emit('moduleStatus', { 
		            name: 'AttitudeFixtureManager', 
		            status: 'degraded',
		            data: `Show ID ${engineInstance.showId} was not found! Some fixtures will be white!`,
		        });
			}

		    // now actually run the engine to process colors
		    engineInstance.engine.run();
		});
	}


	// generateEngineInstances - generate any new engineInstances needed, and remove any not needed, based on this.uniqueShowIds
	generateEngineInstances() {
	    const uniqueIdSet = new Set(this.uniqueShowIds);

	    // Create a map of current engineInstances for quick lookup
	    const showMap = new Map();
	    this.engineInstances.forEach(show => {
	        showMap.set(show.showId, show);
	    });

	    // Filter the engineInstances list to only include items in uniqueIds
	    this.engineInstances = this.engineInstances.filter(show => uniqueIdSet.has(show.showId));

	    // Add new items for each id in uniqueIds if not already present
	    this.uniqueShowIds.forEach(id => {
	        if (!showMap.has(id)) {
	        	// create the engine object
	        	// whatever config is here will be the default for any invalid shows (ie. 1st gen engine shows)
	        	let engine = new AttitudeEngine3({
		            showType: SHOWTYPES.STATIC,
		            direction: DIRECTIONS.LR,
		            speed: 50,
		            size: 100,
		            splits: 1,
		            transition: TRANSITIONS.BOTH,
		            transitionWidth: 0,
		            bounce: false,
		            colors: [
		                { red: 128, green: 128, blue: 128 },
		            ]
		        });

		        // now push this to the engineInstances list
	            this.engineInstances.push({
	            	showId: id,
	            	engine: engine,
	            });
	        }
	    });
	}


	// finds all unique numbers in the input array. used to find unique show IDs to process shows. Skips zeroes.
	findUniqueNumbers(inputArray) {
	    // Create a Set to store unique numbers
	    const uniqueNumbers = new Set();

	    // Helper function to process each element
	    function processElement(element) {
	        if (Array.isArray(element)) {
	            element.forEach(processElement); // Recursively process nested arrays
	        } else if (typeof element === 'number' && element != 0) { // skip zeros in array
	            uniqueNumbers.add(element); // Add number to the Set
	        }
	    }

	    // Process each element in the input array
	    inputArray.forEach(processElement);

	    // Convert the Set back to an array and return
	    return [...uniqueNumbers];
	}


	// calculates the white value for RGBW fixtures from an RGB value
	calculateWhiteFromRGB(rgb) {
	    // Destructure red, green, and blue from the rgb object
	    const { red, green, blue } = rgb;
	    
	    // Calculate the minimum value among red, green, and blue
	    const minValue = Math.min(red, green, blue);
	    
	    // Return the minimum value
	    return minValue;
	}


	// run the input RGBW value through a gamma curve function
	calculateColorGamma(input) {
		return {
		    red: this.applyGamma(input.red),
		    green: this.applyGamma(input.green),
		    blue: this.applyGamma(input.blue),
		    white: this.applyGamma(input.white)
	  	};
	}


	// actually apply gamma to a value
	applyGamma(value) {
  		return Math.round(Math.pow(value / 255, GAMMA) * 255);
	}
}



// ==================== EXPORT ====================
const attitudeFixtureManager = new AttitudeFixtureManager();
export default attitudeFixtureManager;