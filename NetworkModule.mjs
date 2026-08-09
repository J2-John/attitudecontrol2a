// NetworkModule.mjs
// network module for the Attitude Control 2.A app
// copyright 2024 Drew Shipps, J Squared Systems


// this module creates a single instance of the NetworkModule javascript object,
// which processes all requests to the Attitude Lighting server



// import modules
import fs from 'fs';
import eventHub from './EventHub.mjs';
import fetch from 'node-fetch';
import WebSocketImpl from 'ws';

import Logger from './Logger.mjs';
const logger = new Logger('NetworkModule');

import configManager from './ConfigManager.mjs';
import idManager from './IdManager.mjs';



// variables
const API_URL = 'https://attitude.lighting/api/v1/device/sync';  // URL to hit with a POST request
const WS_URL = 'wss://attitude.lighting/ws';  // WebSocket gateway URL, tried before falling back to API_URL

const USE_LOCALHOST = false;  // set to true to use the attitudelighting.test API_URL instead (FOR DEVELOPMENT ONLY)
const LAPTOP_MODE = (process.platform == 'darwin');  // checks whether we're running on macos (laptop mode) or not

const PING_INTERVAL = 1000;  // interval in ms to ping the server (should be 1000ms)
const MAX_ERROR_COUNT = 5; // max number of failed requests before payload will be saved to missed messages queue
const NETWORK_REQUEST_TIMEOUT_MS = 15000;  // number of milliseconds to wait before considering the last request to have timed out

// WebSocket gateway is tried first for every request; if it's unavailable, unreachable, or
// drops mid-flight, this module transparently falls back to the HTTP transport above with
// no change in behavior from the server's point of view. Set to false to force HTTP-only
// (e.g. if the gateway needs to be pulled from rotation for troubleshooting).
const ENABLE_WEBSOCKET_TRANSPORT = true;
const WS_CONNECT_TIMEOUT_MS = 5000;  // how long to wait for the WS handshake before giving up on this attempt
const WS_RECONNECT_INTERVAL_MS = 30000;  // how often to retry connecting the WebSocket while on the HTTP fallback
const WS_RESPONSE_TIMEOUT_MS = 10000;  // fail a WebSocket request if the gateway never answers

const VERBOSE_LOGGING = false;

const MISSED_MESSAGES_FILE_PATH = './';  // path to save the config JSON file to
const MAX_MESSAGES_TO_RESEND_AT_ONCE = 250;



// Define the NetworkModule class to handle network communication
class NetworkModule {

	// constructor
    constructor(interval) {
        // Initialize the request interval
        this.interval = interval;

        // init URL endpoint to API_URL
        this.url = API_URL;

        // check if we're on laptop mode and USE_LOCALHOST is true, if so then use the attitudelighting.test API url.
        // this is added to make absolutely sure that we only use the attitudelighting.test API URL if we're running on
        // macOS laptop for development, and to ensure that production devices can NEVER use this url
        if (USE_LOCALHOST && LAPTOP_MODE) {
        	this.url = 'http://attitudelighting.test/api/v1/device/sync';
        }

        // WebSocket transport state. this.ws is only ever a socket in the OPEN state;
        // as soon as it closes/errors it's nulled out and performNetworkRequest falls
        // straight back to HTTP on its very next call.
        this.wsUrl = WS_URL;
        if (USE_LOCALHOST && LAPTOP_MODE) {
        	this.wsUrl = 'ws://attitudelighting.test/ws';
        }
        this.ws = null;
        this.wsConnecting = false;
        this.wsReconnectTimer = null;
        this.pendingPayload = null;  // payload currently in flight over the WebSocket, awaiting a response message
        this.wsResponseTimer = null;  // fails the in-flight WebSocket request if no response arrives

        // Initialize queue of objects that are pending to be sent to the server
        // these objects might be logs, current status objects, data from external devices, etc.
        this.queue = [];

        // queue object structure
        /*
        {
		    type: 'log',
		    timestamp: '2024-06-30T12:00:00',
		    data: {
		        message: 'An error occurred in Module X',
		        severity: 'error'
		    }
		}
		*/

		// init the request in progress system
	  	this.requestInProgress = false;
	  	this.lastRequestTimestamp = Date.now();

		// Init missed messages system
		this.errorCounter = 0;
		this.filePath = MISSED_MESSAGES_FILE_PATH + 'missedNetworkMessages.json';
		this.loadMissedNetworkMessagesFlag = true; 
		// this has to default to true. we have to assume, upon app start, that there have been missed messages, 
		// and that the device was power cycled or something


    	// keep a counter to increment the sequenceNumber for each log entry packet. 
    	// the sequence number helps keep up with the order of logs for 
    	this.logSequenceNumberCounter = 5;
    }


    // init function
    init() {
    	// log the initialization
    	logger.info('Initializing network module...');

    	// emit initializing event
    	eventHub.emit('moduleStatus', { 
			name: 'NetworkModule', 
			status: 'initializing',
			data: '',
		});

        // start the interval for sending network requests
        this.startInterval();

        // kick off a WebSocket connection attempt in the background; performNetworkRequest
        // will use it once open, and keeps using HTTP until then (or if it later drops)
        if (ENABLE_WEBSOCKET_TRANSPORT) {
        	this.connectWebSocket();
        }

        // bind event listeners for logging and status updates
        eventHub.on('log', this.logListener.bind(this));
        eventHub.on('systemStatusUpdate', this.systemStatusUpdateListener.bind(this));
        eventHub.on('moduleStatusUpdate', this.moduleStatusUpdateListener.bind(this));
        eventHub.on('macrosStatus', this.macrosStatusListener.bind(this));
        eventHub.on('senseData', this.senseDataListener.bind(this));
        eventHub.on('attitudeEmitDataReceived', this.attitudeEmitDataListener.bind(this));

        // add some initial log message to the queue to show that we are initializing the system
        this.queue.push({
        	type: 'log',
        	timestamp: new Date(),
        	data: {
				timestamp: new Date().toISOString(),
				sequenceNumber: 1,
				module: 'RESTART',
				type: 'warn',
				message: '--------------------------------------------------',
		    },
        });

        this.queue.push({
        	type: 'log',
        	timestamp: new Date(),
        	data: {
				timestamp: new Date().toISOString(),
				sequenceNumber: 2,
				module: 'AttitudeControl2A',
				type: 'info',
				message: 'Attitude Control Device Firmware (2nd gen) v2.A',
		    },
        });

        this.queue.push({
        	type: 'log',
        	timestamp: new Date(),
        	data: {
				timestamp: new Date().toISOString(),
				sequenceNumber: 3,
				module: 'AttitudeControl2A',
				type: 'info',
				message: 'Copyright 2024 Drew Shipps, J Squared Systems',
		    },
        });

        this.queue.push({
        	type: 'log',
        	timestamp: new Date(),
        	data: {
				timestamp: new Date().toISOString(),
				sequenceNumber: 4,
				module: 'AttitudeControl2A',
				type: 'info',
				message: 'System initializing on ' + new Date(),
		    },
        });

    	// log the initialization
    	logger.info('Network module initialization complete!');
    }


    // method to start the interval for sending network requests
    startInterval() {
    	// log the start of the interval
    	logger.info(`Starting network request interval at ${this.interval}ms...`);

        setInterval(() => {
            this.performNetworkRequest();
        }, this.interval);
    }


    // perform a network request to send queued data to the server
    performNetworkRequest() {
    	// grab the current time
    	const now = Date.now();

    	// check if we're already running a request
    	if (this.requestInProgress && this.lastRequestTimestamp && (now - this.lastRequestTimestamp) < NETWORK_REQUEST_TIMEOUT_MS) {
    		// since we're already running a request and it hasn't timed out yet, log this
    		if (configManager.checkLogLevel('interval')) {
	    		logger.info(`Network request already in progress and not timed out yet (${ new Date().toLocaleTimeString() })`);
	    	}

		    // simply return the function
		    return;
	  	}

	  	// if there was a previous request that timed out, log that we're running a new one
	  	if (this.requestInProgress) {
    		logger.warn(`Previous network request timed out! Performing new network request at ${ new Date().toLocaleTimeString() }`);
	  	} else {
	  		// otherwise log that this is a brand new normal request
	  		if (configManager.checkLogLevel('interval')) {
	    		logger.info(`Performing network request at ${ new Date().toLocaleTimeString() }`);
	    	}
	  	}

	  	// update the timestamp and request in progress flags
	  	this.requestInProgress = true;
	  	this.lastRequestTimestamp = now;

    	// grab the entire current queue into a payload for this particular request (this clears the queue)
    	const payload = this.queue.splice(0, this.queue.length);
    	// console.log('PAYLOAD', payload);

    	// if necesary, add missed messages to the queue
    	if (this.loadMissedNetworkMessagesFlag) {
    		this.loadMissedNetworkMessages();
    	}

    	// create an object for the actual request
    	const requestObject = {
    		device_id: idManager.getId(),
    		serialnumber: idManager.getSerialNumber(),
    		payload: payload,

    		// Fingerprint of the configuration we are currently holding. If it matches what the
    		// server has, the response comes back without the configuration in it - which is the
    		// overwhelming majority of syncs. ConfigManager.update() merges only the keys present
    		// in a response, so a reply that omits the config leaves ours untouched.
    		configHash: configManager.getConfigHash(),
    	};

    	// log the entire request object
    	// console.log(JSON.stringify(requestObject));

    	// prefer the WebSocket gateway when it's connected; otherwise fall back to HTTP.
    	// Both paths funnel into the same onNetworkRequestSuccess/onNetworkRequestError
    	// methods, so error counting, missed-message handling, and moduleStatus events
    	// behave identically regardless of which transport carried this particular request.
    	if (this.isWebSocketConnected()) {
    		this.sendViaWebSocket(requestObject, payload);
    	} else {
    		this.sendViaHttp(requestObject, payload);
    	}
    }


    // send the request over HTTP (the original transport, and the permanent fallback)
    sendViaHttp(requestObject, payload) {
		fetch(this.url, {
		    method: 'POST',
		    headers: {
		        'Content-Type': 'application/json', // Set the Content-Type header to indicate JSON data
		    },
		    body: JSON.stringify(requestObject), // Convert the request object to a JSON string and set as the request body
		})

		// handle the response asynchronously
		.then(response => {
			// check response status (response.ok will return true if the HTTP code is anything 200-299)
		    if (!response.ok) {
		    	// if not ok, throw an error
		        throw new Error(`Request failed with status ${response.status}`);
		    }

			// log a success message
			if (configManager.checkLogLevel('minimal')) {
	    		logger.info(`${response.status} ${response.statusText} request successful! Connected to attitude.lighting server!`);
	    	}

		    // return the body text of the response
		    return response.text();
		})

		// then handle the data from the response
		.then(data => {
    		this.onNetworkRequestSuccess(payload, data);
		})

		// and catch any errors that occur
		.catch(error => {
    		this.onNetworkRequestError(payload, error);
		});
    }


    // send the request over the WebSocket gateway. The response arrives asynchronously via
    // the 'message' handler registered in connectWebSocket(), which resolves this.pendingPayload.
    sendViaWebSocket(requestObject, payload) {
    	try {
    		this.pendingPayload = payload;

    		// An open-but-unresponsive socket produces no transport error, so without this the
    		// payload would be silently discarded when the next request overwrites pendingPayload.
    		// Fail it explicitly instead, which re-queues the data and drops back to HTTP.
    		this.clearWebSocketResponseTimer();
    		this.wsResponseTimer = setTimeout(() => {
    			this.wsResponseTimer = null;

    			logger.warn('WebSocket request timed out with no response from the gateway. Falling back to HTTP.');

    			// fails the pending payload back into the queue and schedules a reconnect
    			this.handleWebSocketFailure();

    			// drop the socket so the next tick picks HTTP
    			if (this.ws) {
    				try {
    					this.ws.terminate();
    				} catch (terminateError) {
    					// already gone - nothing to do
    				}
    			}
    		}, WS_RESPONSE_TIMEOUT_MS);

    		this.ws.send(JSON.stringify(requestObject));
    	} catch (error) {
    		this.clearWebSocketResponseTimer();
    		this.pendingPayload = null;
    		this.onNetworkRequestError(payload, error);
    		this.handleWebSocketFailure();
    	}
    }


    // cancel the in-flight WebSocket response timer, if one is running
    clearWebSocketResponseTimer() {
    	if (this.wsResponseTimer) {
    		clearTimeout(this.wsResponseTimer);
    		this.wsResponseTimer = null;
    	}
    }


    // shared success handling for both transports
    onNetworkRequestSuccess(payload, rawData) {
		// no matter the result, change the flag to indicate that the request is no longer in progress
		this.requestInProgress = false;

		// if there had previously been errors, then flag that we need to grab the missed messages out of local file storage
		if (this.errorCounter > MAX_ERROR_COUNT) {
			this.loadMissedNetworkMessagesFlag = true;

			if (configManager.checkLogLevel('detail')) {
    			logger.info('Successfully reconnected to the attitude.lighting server! Begin restoring missed network messages.');
    		}

			// emit a moduleStatus event since we just reconnected
    		eventHub.emit('moduleStatus', {
    			name: 'NetworkModule',
    			status: 'operational',
    			data: 'Successfully reconnected to the attitude.lighting server!',
    		});
		} else {
			// otherwise, we've been online, so emit a moduleStatus event that we are online
    		eventHub.emit('moduleStatus', {
    			name: 'NetworkModule',
    			status: 'online',
    			data: 'Connected to the attitude.lighting server!',
    		});
		}

		// reset the error counter
		this.errorCounter = 0;

		// handle the response data
		this.handleResponse(rawData);

	    // NOTE: because of the error handling logic below,
	    // errors here in processing of received data will cause a re-transfer of previous data.
	    // So it's important to try to avoid errors here in this function when processing response data
	    // after data is succesfully sent to server.
    }


    // shared error handling for both transports
    onNetworkRequestError(payload, error) {
		// even though it's an error, still change the flag to indicate that the request is no longer in progress
		this.requestInProgress = false;

		// log error to logger, which will show in console and queue log to be sent to server
		logger.error(`Error during network request: ${error.message}`);

		// emit an event because we are currently offline
		eventHub.emit('moduleStatus', {
			name: 'NetworkModule',
			status: 'offline',
			data: `Error during network request: ${error.message}`,
		});

		// add this error to the counter
		this.errorCounter++;

		// if error count is greater than the max, then we need to start saving the missed data to a file,
		// instead of just to the queue, so that it can be re-sent later
		if (this.errorCounter > MAX_ERROR_COUNT) {
			this.savePayloadToFile(payload);
		} else {
			// otherwise, these messages should just be added back to the queue and re-sent to server.
    		// unshift the queue by adding this payload (which failed) to the front
    		this.queue.unshift(...payload);
		}
    }


    // whether the WebSocket transport is currently usable
    isWebSocketConnected() {
    	return !!(this.ws && this.ws.readyState === WebSocketImpl.OPEN);
    }


    // attempt to establish the WebSocket connection to the gateway. Safe to call repeatedly;
    // no-ops if already connected or an attempt is already in progress.
    connectWebSocket() {
    	if (this.wsConnecting || this.isWebSocketConnected()) {
    		return;
    	}
    	this.wsConnecting = true;

    	if (configManager.checkLogLevel('detail')) {
    		logger.info(`Attempting WebSocket connection to ${this.wsUrl}...`);
    	}

    	let socket;
    	try {
    		socket = new WebSocketImpl(this.wsUrl);
    	} catch (error) {
    		logger.warn(`Failed to open WebSocket: ${error.message}`);
    		this.wsConnecting = false;
    		this.scheduleWebSocketReconnect();
    		return;
    	}

    	// if the handshake itself hangs, give up on this attempt and fall back to HTTP;
    	// scheduleWebSocketReconnect (triggered by the resulting 'close') will try again later
    	const connectTimeout = setTimeout(() => {
    		if (socket.readyState !== WebSocketImpl.OPEN) {
    			logger.warn(`WebSocket connection attempt to ${this.wsUrl} timed out, using HTTP for now.`);
    			socket.terminate();
    		}
    	}, WS_CONNECT_TIMEOUT_MS);

    	socket.on('open', () => {
    		clearTimeout(connectTimeout);
    		this.wsConnecting = false;
    		this.ws = socket;

    		logger.info('WebSocket connection established! Using WebSocket transport for device sync.');
    		eventHub.emit('moduleStatus', {
    			name: 'NetworkModule',
    			status: 'online',
    			data: 'Connected to the attitude.lighting server via WebSocket!',
    		});
    	});

    	socket.on('message', (raw) => {
    		this.clearWebSocketResponseTimer();

    		// Ignore unsolicited messages. The gateway is request/response only, and treating a
    		// stray or duplicate message as a successful response would reset the error counter
    		// and apply its body as device configuration.
    		if (!this.pendingPayload) {
    			logger.warn('Received a WebSocket message with no request pending. Ignoring it.');
    			return;
    		}

    		const payload = this.pendingPayload;
    		this.pendingPayload = null;
    		this.onNetworkRequestSuccess(payload, raw.toString());
    	});

    	socket.on('close', () => {
    		clearTimeout(connectTimeout);
    		this.wsConnecting = false;
    		if (this.ws === socket) {
    			this.ws = null;
    		}
    		this.handleWebSocketFailure();
    	});

    	socket.on('error', (error) => {
    		// 'close' always follows 'error' for the ws package, which does the actual cleanup/reconnect scheduling
    		logger.warn(`WebSocket error: ${error.message}`);
    	});
    }


    // called whenever the WebSocket is not (or is no longer) usable: fails any in-flight
    // request immediately (rather than waiting out the HTTP-style timeout) so
    // performNetworkRequest picks HTTP on its very next tick, and schedules a reconnect attempt.
    handleWebSocketFailure() {
    	this.clearWebSocketResponseTimer();

    	if (this.pendingPayload) {
    		const payload = this.pendingPayload;
    		this.pendingPayload = null;
    		this.onNetworkRequestError(payload, new Error('WebSocket connection closed'));
    	}

    	this.scheduleWebSocketReconnect();
    }


    // retry the WebSocket connection periodically while on the HTTP fallback
    scheduleWebSocketReconnect() {
    	if (this.wsReconnectTimer || !ENABLE_WEBSOCKET_TRANSPORT) {
    		return;
    	}

    	this.wsReconnectTimer = setTimeout(() => {
    		this.wsReconnectTimer = null;
    		this.connectWebSocket();
    	}, WS_RECONNECT_INTERVAL_MS);
    }


    // Handle the response data from the server
    handleResponse(rawData) {
    	// wrap this logic in a try/catch, so that errors here will be caught instead of causing us to resend data in the fetch function
    	try {
    		// actually process the response data from the server here
			if (configManager.checkLogLevel('detail')) {
    			logger.info('Processing response data from server...');
    		}

    		// JSON parse the raw data from the server
    		let data = JSON.parse(rawData);

    		// update the config manager with the new data
    		configManager.update(data);

    		// log success
    		if (configManager.checkLogLevel('detail')) {
    			logger.info('Successfully processed response data from server!');
    		}
    	} catch (error) {
			// log error to logger, which will show in console and queue log to be sent to server
    		logger.error(`Error during response handling: ${error.message}`);

			// emit an event because we had an error handling this response
    		eventHub.emit('moduleStatus', { 
    			name: 'NetworkModule', 
    			status: 'errored',
    			data: `Error during response handling: ${error.message}`,
    		});
    	}
    }


    // add data into the queue for sending to the server
    // takes the type (a string such as 'log') and the data payload, creates an object, and adds it to queue
    enqueueData(type, data) {
        this.queue.push({
        	type: type,
        	timestamp: new Date(),
        	data: data,
        });
    }


    // event listener for log events
    // this function is bound to the event that's triggered when a 'log' is fired from the eventHub
    // it then grabs that log and adds it to the queue
    logListener(log) {
    	// we need to add a sequence number to each log, but we can't do it in the logger module
    	// because that module has a unique instance for each module it's used in, so the counter
    	// wouldn't work across different modules.

    	// instead, we add the sequence number here in the logListener function in the network module,
    	// which only has one instance
    	log.sequenceNumber = this.logSequenceNumberCounter;

    	// now that we've added the sequence number, we can enque the data
        this.enqueueData('log', log);

		// increment the sequence number counter
		this.logSequenceNumberCounter++;

		// not currently planning on resetting the logSequenceCounter here at all. it'll automatically
		// be reset when the device is power cycled. 
    }


    // systemStatusUpdateListener for systemStatus updated events
    systemStatusUpdateListener(currentSystemStatus) {
    	this.enqueueData('systemStatus', currentSystemStatus);
    }


    // moduleStatusUpdateListener for moduleStatus updated events
    moduleStatusUpdateListener(currentModuleStatus) {
    	this.enqueueData('moduleStatus', currentModuleStatus);
    }


    // macrosStatusListener for macrosStatus events
    macrosStatusListener(currentMacrosStatus) {
    	this.enqueueData('macrosStatus', currentMacrosStatus);
    }


    // senseDataListener for senseData events
    senseDataListener(currentSenseData) {
    	this.enqueueData('senseData', currentSenseData);
    }


    // attitudeEmitDataListener for attitudeEmitDataReceived events
    attitudeEmitDataListener(currentEmitData) {
    	this.enqueueData('attitudeEmitDataReceived', currentEmitData);
    }


    // savePayloadToFile - takes the current payload and adds it to the file missedNetworkMessages.json
    savePayloadToFile(payload) {
    	// variable to hold the parsed data from the missed messages file
    	let parsedData = this.loadMissedNetworkMessagesJSONFromFile();

    	// collect the queueToSaveToFile: the array of the previous data in the queue, plus the new payload added at the end
    	let queueToSaveToFile = parsedData;
    	queueToSaveToFile.push(...payload);

    	// save to file
    	this.saveMissedNetworkMessagesJSONToFile(queueToSaveToFile);
    }


    // loadMissedNetworkMessages - load the messages that we missed out of the JSON and add them to the queue
    loadMissedNetworkMessages() {
    	// quick log that we are loading missed messages
    	if (configManager.checkLogLevel('detail')) {
			logger.info('Loading missed messages from local JSON file...');
		}

    	// variable to hold the parsed data from the missed messages file
    	let parsedData = this.loadMissedNetworkMessagesJSONFromFile();

    	// if there's no data
    	if (parsedData.length == 0) {
    		// log that all missed messages have been resent
    		if (configManager.checkLogLevel('detail')) {
    			logger.info('No missed messages left to resend!');
    		}

    		// change this flag to false since we're done resending missed messages
    		this.loadMissedNetworkMessagesFlag = false;

    		return;
    	}

    	// hold the current set of items that should be added to queue
    	let currentMessagesToResend = this.grabAndRemoveFirstItems(parsedData, MAX_MESSAGES_TO_RESEND_AT_ONCE);

    	// add them to the queue
    	this.queue.push(...currentMessagesToResend);

    	// save whatever was left and can't be sent this round back to the JSON file
    	// this might be an empty array, which is fine, because that will then ensure that we're done.
    	this.saveMissedNetworkMessagesJSONToFile(parsedData);
    }


    // loadMissedNetworkMessagesJSONFromFile - actually load and process the JSON file, with appropriate error checking & logging
    loadMissedNetworkMessagesJSONFromFile() {
    	// variable to hold the raw data string from the missed messages file
    	let rawData = '[]';

    	// try to load the raw data as a string from the file at this path
    	try {
			rawData = fs.readFileSync(this.filePath);
    	} catch (error) {
    		// log a warning that no file was found
    		logger.warn('No file found at ' + this.filePath + ' (error: ' + error.message + ')');
    	}

    	// variable to hold the parsed data
    	let parsedData = [];

    	// try to parse the JSON
    	try {
			parsedData = JSON.parse(rawData);
    	} catch (error) {
    		// log a warning that JSON couldnt be parsed
    		logger.warn('Unable to parse JSON data, error: ' + error.message);
    	}

    	return parsedData;
    }


    // loadMissedNetworkMessagesJSONFromFile - actually load and process the JSON file, with appropriate error checking & logging
    saveMissedNetworkMessagesJSONToFile(data) {
    	// now try to save this to a file
    	try {
    		fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2));

    		if (configManager.checkLogLevel('detail')) {
	    		logger.info('Saved the current payload to the missedNetworkMessages.json file!');
	    	}
    	} catch (error) {
    		// log a warning that the file couldn't be saved
    		logger.error('Unable to save the network queue to a file, error: ' + error.message);
    	}
    }


    // grab the first count number of items from an array
	grabAndRemoveFirstItems(arr, count) {
		// Handle the case where count is greater than the length of the array
		if (count >= arr.length) {
			const allItems = arr.slice(); // Make a copy of the array
			arr.length = 0; // Clear the array
			return allItems;
		}

		// Grab the first 'count' items
		const items = arr.slice(0, count);

		// Remove the first 'count' items from the array
		arr.splice(0, count);

		return items;
	}
}



// Create an instance of the NetworkModule and initialize it with the config variables at the top of this file
const networkModule = new NetworkModule(PING_INTERVAL);

// Export the network module instance for use in other modules
export default networkModule;
