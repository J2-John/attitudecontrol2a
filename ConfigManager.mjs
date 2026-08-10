// ConfigManager.mjs
// configuration data module for the Attitude Control 2.A app
// copyright 2024 Drew Shipps, J Squared Systems


// this module creates a single instance of the ConfigManager javascript object,
// which coordinates the configuration data across all other modules



// import modules
import fs from 'fs';
import eventHub from './EventHub.mjs';

import Logger from './Logger.mjs';
const logger = new Logger('ConfigManager');



// variables
const CONFIG_FILE_PATH = './';  // path to save the config JSON file to



// Define the ConfigManager class to handle everything about the device's configuration
class ConfigManager {

	// constructor
	constructor() {
		// create the this.config property for all config to be stored in
		this.config = {};
		this.filePath = CONFIG_FILE_PATH + 'config.json';

		// The exact string we last wrote to disk, used to skip writes when nothing changed.
		// saveToFile() is called on every sync, so without this the whole file is rewritten
		// once per second even when byte-identical.
		//
		// HISTORY, so this does not get lost a second time: this guard was added in 09192e9
		// ("Reduce SD wear"), which took measured writes from 4,545 MB/day to 0. It was then
		// deleted in 02a7061 ("Config hash protocol, and four updater fixes"), which had
		// nothing to do with it - an accidental revert in a merge. The regression went
		// unnoticed for a day because the config-hash protocol landed in the same commit and
		// cut writes to ~2,553 MB/day, so the number still looked like an improvement.
		// Restored 2026-08-10 after measuring 2,553 MB/day on the bench device.
		//
		// This is not a micro-optimisation. Continuous rewriting of config.json is the
		// established cause of the fleet's SD card failures, including AC-0020135.
		this.lastWrittenSerialized = null;

		// log levels
		this.logLevels = ['none', 'minimal', 'interval', 'detail'];
	}


	// initialization function 
	init() {
		this.loadFromFile();
	}


	// load configuration from file
	loadFromFile() {
		// try to load the configuration data from the saved JSON file
		try {
			// load the raw data as a string from the file at this path
			const rawData = fs.readFileSync(this.filePath);

			// parse JSON data
			const parsedData = JSON.parse(rawData);

			// replace current config with the data from the file
			this.config = JSON.parse(rawData);

			// seed the write guard with the normalized form of what is already on disk, so
			// an unchanged config after boot does not trigger a pointless rewrite
			this.lastWrittenSerialized = JSON.stringify(this.config, null, 2);

			// log success
			logger.info('Successfully loaded configuration data from local JSON file!');

			// emit an event that we succesfully loaded the config (note that this is a oneTimeEvent)
            eventHub.emit('moduleStatus', { 
                name: 'ConfigManager', 
                status: 'operational',
                data: 'Successfully loaded configuration data from local JSON file!',
                oneTimeEvent: true,
            });
		} catch (error) {
			// log the error
			logger.error(`Error loading configuration: ${error.message}`);

			// emit an event that there was an error (note that this is a one time event)
            eventHub.emit('moduleStatus', { 
                name: 'ConfigManager', 
                status: 'errored',
                data: `Error loading configuration: ${error.message}`,
                oneTimeEvent: true,
            });
		}
	}


	// save configuration to file
	saveToFile() {
		// try to save the config to a file
		try {
			// log that we're trying
			if (this.checkLogLevel('detail')) {
				logger.info('Saving configuration to file...');
			}

			// Serialize once, then skip the write entirely if it matches what is already on
			// disk. The server sends the full config on a change and this function is called
			// on every sync, so the overwhelming majority of these calls write identical
			// bytes. See the note on lastWrittenSerialized in the constructor before removing.
			const serialized = JSON.stringify(this.config, null, 2);

			if (serialized === this.lastWrittenSerialized) {
				// nothing changed - don't touch the SD card
				if (this.checkLogLevel('detail')) {
					logger.info('Configuration unchanged, skipping write to file.');
				}

				return;
			}

			// Write to a temporary file first, then rename over the real one. rename is
			// atomic, so losing power mid-write cannot leave a truncated config.json that
			// fails to parse on next boot.
			const tempPath = this.filePath + '.tmp';
			fs.writeFileSync(tempPath, serialized);
			fs.renameSync(tempPath, this.filePath);

			// only record it as written after both steps succeeded
			this.lastWrittenSerialized = serialized;

			// log success
			if (this.checkLogLevel('detail')) {
				logger.info('Configuration saved successfully.');
			}

			// emit an event that we succesfully saved the config (note that this is a oneTimeEvent)
            eventHub.emit('moduleStatus', { 
                name: 'ConfigManager', 
                status: 'operational',
                data: 'Successfully saved configuration data to local JSON file!',
                oneTimeEvent: true,
            });
		} catch (error) {
			// log the error
			logger.error(`Error saving configuration: ${error.message}`);

			// emit an event that there was an error (note that this is a one time event)
            eventHub.emit('moduleStatus', { 
                name: 'ConfigManager', 
                status: 'errored',
                data: `Error saving configuration: ${error.message}`,
                oneTimeEvent: true,
            });
		}
	}


	// update() - update the configuration with new data from the server
	update(newData) {
		// try to update the config with the new data, else log a failure
		try {
			// log that we're updating the config
			if (this.checkLogLevel('detail')) {
				logger.info('Updating configuration with new data...');
			}

			// set this.config to the merged objects: this.config (original) and newData (new)
			this.config = this.mergeObjects(this.config, newData);

			// log success message
			if (this.checkLogLevel('detail')) {
				logger.info('Successfully updated configuration!');
			}

			// emit an event we successfully updated config
            eventHub.emit('moduleStatus', { 
                name: 'ConfigManager', 
                status: 'operational',
                data: `Successfully updated configuration.`,
                oneTimeEvent: true,
            });

			// save to file
			this.saveToFile();

			// log that we updated & saved
			if (this.checkLogLevel('detail')) {
				logger.info('Successfully updated and saved configuration!');
			}
		} catch (error) {
			// log the error
			logger.error(`Error updating configuration: ${error.message}`);

			// emit an event that there was an error (note that this is a one time event)
            eventHub.emit('moduleStatus', { 
                name: 'ConfigManager', 
                status: 'errored',
                data: `Error updating configuration: ${error.message}`,
                oneTimeEvent: true,
            });
		}
	}


	// utility function to merge two objects
	// - If a key is present in A but not in B, it remains unchanged in A. 
	// - If a key is present in both A and B, the value from B overwrites the value in A.
	// - If a key is present only in B, it is added to A.
	mergeObjects(objA, objB) {
	    // Iterate over the keys of object B
	    Object.keys(objB).forEach(function(key) {
	        // Update object A with values from object B
	        objA[key] = objB[key];
	    });

	    // Return the updated object A
	    return objA;
	}


	// ----- GETTER METHODS FOR DIFFERENT PARTS OF CONFIGURATION ------
	
	// fixtures
	getFixtures() {
        const data = this.config?.fixtures;

        // if undefined then log that we have an error and return empty array
        if (data === undefined) {
        	// only log error if this.config is actually defined. otherwise, we just haven't gotten any config data yet
        	if (!Object.keys(this.config).length === 0) {
        		logger.error(`Error accessing fixtures!`);
        	}

        	// TODO either way, emit an error to the module status tracker

            return [];
        }

        return data;
	}

	// zones
	getZones() {
        const data = this.config?.zones;

        // if undefined then log that we have an error and return empty array
        if (data === undefined) {
            logger.error(`Error accessing zones!`);
            return [];
        }

        return data;
	}

	getFixtureTypes() {
		return this.config.fixtureTypes ?? [];
	}

	// shows
	getShows() {
        return this.config.shows ?? [];
	}

	// scheduleBlocks
	getScheduleBlocks() {
		return this.config.scheduleBlocks ?? [];
	}

	// eventBlocks
	getEventBlocks() {
		return this.config.eventBlocks ?? [];
	}

	// customBlocks 
	getCustomBlocks() {
		return this.config.customBlocks ?? [];
	}
	
	// overrides
	getOverrides() {
		return this.config.overrides ?? [];
	}
	
	// senses
	getAttitudeSenses() {
		return this.config.attitudeSenses ?? [];
	}
	
	// emits
	getAttitudeEmits() {
		return this.config.attitudeEmits ?? [];
	}
	
	// webOverrides
	getWebOverrides() {
		return this.config.webOverrides ?? [];
	}

	// timezone
	getDeviceTimezone() {
		// try to get the parameter, else throw/log an error and return a default
		try {
			// ? is the safe optional chaining operator that safely grabs those properties
	        const timezone = this.config?.timezone;

	        // if undefined then we have an error
	        if (timezone === undefined) {
	            throw new Error('Timezone is missing!');
	        }

	        // else return the grabbed tiemzone
	        return timezone;
	    } catch (error) {
	    	// log the error to logger
	        logger.error(`Error accessing config.timezone: ${error.message}`);

	        // return default
	        return 'America/Chicago';
	    }
	}

	// assigned to location or not
	getAssignedToLocation() {
		return this.config?.assignedToLocation ?? true;
	}

	// reboot
	getReboot() {
		return this.config?.reboot ?? false;
	}

	// restart
	getRestart() {
		return this.config?.restart ?? false;
	}

	// update
	getUpdate() {
		return this.config?.update ?? false;
	}

	// autoupdate
	getAutoupdate() {
		return this.config?.autoupdate ?? false;
	}




	// the fingerprint of the config the server last sent us. Echoed back on every sync so the
	// server can answer "nothing changed" in a few hundred bytes instead of resending the
	// whole configuration. Null on a device that has never received one, which makes the
	// server send everything - so a device with no hash is always correct, just chattier.
	getConfigHash() {
		return this.config?.configHash ?? null;
	}


	// get the config file path
	getConfigFilePath() {
		return this.filePath;
	}


	// check the current log level against the specified level. 
	// if we're at that level, or any more specific level, then return true. otherwise return false
	checkLogLevel(level) {
	    // Get the index of the current log level and the given level in the logLevels array
	    const currentLevelIndex = this.logLevels.indexOf(this.config.logLevel ?? 'detail');
	    const levelIndex = this.logLevels.indexOf(level);

	    // Return true if the current log level index is greater than or equal to the given level index
	    return currentLevelIndex >= levelIndex;
	}
}



// Create an instance of the ConfigManager and initialize it
const configManager = new ConfigManager();

// Export the configManager instance for use in other modules
export default configManager;