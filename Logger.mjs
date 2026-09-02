// Logger.mjs
// a logger module for the Attitude Control 2.A app
// copyright 2024 Drew Shipps, J Squared Systems


// import modules
import npmlog from 'npmlog';
import eventHub from './EventHub.mjs';


// variables & options
const LAPTOP_MODE = (process.platform == 'darwin');
const DEV_MODE = false; // if set to true, logs will still show even on raspberry pi units

const MAX_TIME_SINCE_DUPLICATE_LOG_SHOWN = 5000; // max interval in ms to ensure duplicate logs are still shown at some point
const CLEANUP_INTERVAL = 10000; // interval to clean up old log entries in ms
const SUPER_HIGH_DUPLICATE_COUNT = 250; // # of duplicates before rate of showing duplicates scales back
const SUPER_HIGH_DUPLICATE_RATE = 60000; // rate at which super high duplicate counts are shown


// create the class
class Logger {

	// constructor
	constructor(moduleName) {
		// moduleName: the name of the module using this instance of logger
		this.moduleName = moduleName;

		// hold on to the previous logEntry
	    this.lastLogEntry = null;

	    // hold on to the # of duplicate logs in a row
	    this.duplicateLogCount = 0;

	    // hold on to the timestamp since the last duplicate log was shown
    	this.duplicateLogTimestamp = null;

    	// store recent log entries and their counts in a map
    	this.logHistory = new Map();

		// Timer to clean up old log entries.
		//
		// unref'd: this timer must not be the reason the process stays alive. In
		// the app it never is - the UDP sockets, the DMX engine and the network
		// queue all hold handles, and a process whose only remaining handle is a
		// log-cleanup timer has nothing left to log about. In the test runner it
		// was: every `new Logger()` at import time held the child open, which is
		// why the suite needed --test-force-exit, and --test-force-exit calls
		// process.exit() before the TAP stream has drained. The visible symptom
		// was a run reporting 64 tests, then 61, then 55, always dropping a
		// SUFFIX of the file, always exiting 0 with `# fail 0`. Tests that never
		// ran cannot fail, so the newest tests in a file were the least likely
		// to be enforced - the exact opposite of what a suite is for.
		this.cleanupTimer = setInterval(() => {
            // clean up old logs function
            this.cleanupOldLogs();
        }, CLEANUP_INTERVAL);
		if (typeof this.cleanupTimer?.unref === 'function') this.cleanupTimer.unref();
	}


	// log - primary method for logging data through logger
	log(type, message) {
		// clean up the type parameter (trim & lowercase)
		type = type.trim().toLowerCase();

		// generate a duplicateLogEntryKey to serve as the key in the map for this log
		const duplicateLogEntryKey = `${type} | ${message}`;

		// check if this log entry key exists in the logHistory map
		if (this.logHistory.has(duplicateLogEntryKey)) {
			// if it does exist, then we have a duplicate log

			// grab the duplicateLogEntry object out of the map
			const duplicateLogEntry = this.logHistory.get(duplicateLogEntryKey);

			// update the duplicate log count
			duplicateLogEntry.count++;

			// update the last timestamp, which was the last time a new duplicate was added
			duplicateLogEntry.lastTimestamp = Date.now();

			// calculate the max time for the interval depending on the # of duplicate logs
			let maxTimeAdjustedForCount = MAX_TIME_SINCE_DUPLICATE_LOG_SHOWN;

			// once duplicate log count is super high, we get the gist, so scale back the rate at which duplicates are shown
			if (duplicateLogEntry.count > SUPER_HIGH_DUPLICATE_COUNT) {
				maxTimeAdjustedForCount = SUPER_HIGH_DUPLICATE_RATE; // scale back the rate
			}

			// if it's been more than MAX_TIME seconds since this duplicate log has been shown
			if (Date.now() - duplicateLogEntry.lastShown > maxTimeAdjustedForCount) {
				// create a log entry, print it, and emit the event
				let duplicateMessage = `${duplicateLogEntry.count} DUPLICATES | ${duplicateLogEntry.message}`;
				this.createPrintAndEmitLogEntry(type, duplicateMessage);

				// update the lastShown parameter on the duplicateLogEntry to the current timestamp
				// lastShown is the last time this duplicate log was actually printed to console
				duplicateLogEntry.lastShown = Date.now();
			}
		} else {
			// if it doesn't exist in the logHistory map, we need to add it

			// create a duplicateLogEntry object to store this log entry, and data regarding any further duplicates
			const duplicateLogEntry = {
				timestamp: new Date().toISOString(),
				module: this.moduleName,
				type: type,
				message: message,
				count: 1,
				lastTimestamp: Date.now(),
				lastShown: Date.now(),
			}

			// save this duplicateLogEntry under the key from earlier
			this.logHistory.set(duplicateLogEntryKey, duplicateLogEntry);

			// create a log entry, print it, and emit the event
			this.createPrintAndEmitLogEntry(type, message);
		}
	}


	// cleanupOldLogs - cleans up old logs in the logHistory map
	// print any that haven't been shown (lastShown) in 10 seconds or more
	// remove any that haven't been updated (lastTimestamp) in 10 seconds or more
	cleanupOldLogs() {
		// iterate over each duplicateLogEntry in the logHistory map
		this.logHistory.forEach((duplicateLogEntry, key) => {
			// calculate the difference in ms since the last time this duplicate was shown or a new one was added
			let lastShownDiff = Date.now() - duplicateLogEntry.lastShown;
			let lastTimestampDiff = Date.now() - duplicateLogEntry.lastTimestamp;

			// calculate if the number of logs in this duplicate is > than super high count
			let notALotOfLogs = duplicateLogEntry.count < SUPER_HIGH_DUPLICATE_COUNT;

			// if this log both hasn't been shown and hasn't been updated in CLEANUP_INTERVAL
			if (lastShownDiff >= CLEANUP_INTERVAL && lastTimestampDiff >= CLEANUP_INTERVAL) {
				// then it can safely be deleted
				this.logHistory.delete(key);
			} else if (lastShownDiff >= CLEANUP_INTERVAL && notALotOfLogs) {
				// otherwise, if this log hasn't been shown in a while AND it's not super high count, then show it

				// create a log entry, print it, and emit the event
				let duplicateMessage = `${duplicateLogEntry.count} DUPLICATES | ${duplicateLogEntry.message}`;
				this.createPrintAndEmitLogEntry(duplicateLogEntry.type, duplicateMessage);
			}
		});
	}


	// createPrintAndEmitLogEntry - create a log entry object, print it to console, and emit a log event
	createPrintAndEmitLogEntry(type, message) {
		// now create a standard logEntry object for this log.
		// this logEntry object is what will be printed and sent to the network module
		const logEntry = {
			timestamp: new Date().toISOString(),
			module: this.moduleName,
			type: type,
			message: message,
		};

		// now log the new message in console
		this.printLogToConsole(logEntry);

		// emit a log event to send this log to the network module
		this.emitLogEvent(logEntry);
	}


	// printLogToConsole - actually take a log entry and print it to console
	printLogToConsole(logEntry) {
		// clean up the type parameter (trim & lowercase)
		logEntry.type = logEntry.type.trim().toLowerCase();

		// switch case for the different types of logs
		switch (logEntry.type) {
			// NOTE: disabled actual console.logs for raspi so that we don't fill up the SD card with logs

			// for standard info logs
			case 'info':
				// check if in laptop mode to use pretty npmlog, else use console (for raspi & PM2)
				if (LAPTOP_MODE) {
					npmlog.info(logEntry.module, logEntry.message);
				} else if (DEV_MODE) {
					console.info(`INFO | ${logEntry.module} | ${logEntry.message}`);
				}

				break;

			// for warning logs
			case 'warn':
				if (LAPTOP_MODE) {
					npmlog.warn(logEntry.module, logEntry.message);
				} else if (DEV_MODE) {
					console.warn(`WARN | ${logEntry.module} | ${logEntry.message}`);
				}

				break;

			// for error logs
			case 'error':
				if (LAPTOP_MODE) {
					npmlog.error(logEntry.module, logEntry.message);
				} else if (DEV_MODE) {
					console.error(`ERR! | ${logEntry.module} | ${logEntry.message}`);
				}

				break;

			// default fallback behavior
			default:
				if (LAPTOP_MODE) {
					npmlog.warn(logEntry.module, `UNKNOWN LOG TYPE "${logEntry.type}" WITH MESSAGE: ${logEntry.message}`);
				} else if (DEV_MODE) {
					console.warn(`UNKNOWN LOG TYPE "${logEntry.type}" | ${logEntry.module} | ${logEntry.message}`);
				}
		}
	}


	// emitLogEvent - emit a log event to eventHub
	emitLogEvent(logEntry) {
		// emit 'log' event to the eventHub, which can then be picked up by the network module to send to server
		eventHub.emit('log', logEntry);
	}


	// provide a method for info logs directly to simplify code to logger.info(message) instead of logger.log('info', message)
	info(message) {
		this.log('INFO', message);
	}

	// provide a method for warn logs
	warn(message) {
		this.log('WARN', message);
	}

	// provide a method for error logs
	error(message) {
		this.log('ERROR', message);
	}
}


// export the Logger class
export default Logger;