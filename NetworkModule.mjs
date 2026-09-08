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

import configManager, { TRANSPORT_ONLY_KEYS } from './ConfigManager.mjs';
import showTableStore from './ShowTableStore.mjs';
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

// Hard ceiling on the offline backlog file, in bytes.
//
// There was no cap of any kind. MAX_MESSAGES_TO_RESEND_AT_ONCE bounds the RESEND batch, not the
// file. Combined with the read-modify-rewrite this used to do, an outage wrote bytes
// proportional to the SQUARE of its length - measured on this module, counting bytes at the
// syscall:
//
//     1 min   ->    60 writes,   16.7 KB file,     0.50 MB written
//     5 min   ->   300 writes,   83.5 KB file,    12.27 MB written
//    15 min   ->   900 writes,  250.5 KB file,   110.20 MB written
//    60 min   ->  3600 writes, 1002.0 KB file,  1761.74 MB written
//
// Five times the outage, twenty-five times the bytes. One hour offline carrying a single log
// line per second wrote 1.76 GB to the card - on a fleet whose established failure mode is SD
// card wear, and this file had none of the protection config.json got. After the change the
// same hour writes 0.49 MB, and growth is linear.
//
// 8 MB is deliberately generous: at a few hundred bytes per record that is tens of thousands of
// queued messages, far more than MAX_MESSAGES_TO_RESEND_AT_ONCE drains in any plausible
// recovery, and still small enough that a compaction is cheap.
const MAX_MISSED_MESSAGES_BYTES = 8 * 1024 * 1024;

// When the cap is hit, compact down to this fraction of it by dropping the OLDEST records.
// Well below 1 so compaction is rare rather than firing again on the very next append.
const COMPACT_TO_FRACTION = 0.6;



// How many records at the FRONT of a given payload were replayed from the backlog file and are
// therefore still on disk awaiting confirmation. Keyed on the payload array itself so it cannot
// be read by a different request - see performNetworkRequest for the three defects that caused.
const backlogCountFor = new WeakMap();

// Test seam, and a deliberately awkward one.
//
// The count is module-private precisely so a test cannot conjure the interleaving it is meant to
// exercise. The previous tests set an instance field by hand and therefore passed for the wrong
// reason: `requestGeneration++` with a stale count is not what a real second request does, and
// the three defects that field caused were all invisible to them. Prefer driving
// performNetworkRequest; use this only where a test genuinely needs to observe the value.
export function _backlogCountFor(payload) {
	return backlogCountFor.get(payload) ?? 0;
}


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

		// Monotonic stamp for HTTP requests, so a late response from a superseded request can be
		// recognised and ignored rather than overwriting newer state.
		this.requestGeneration = 0;

		// The abort window, as an instance field rather than a bare constant so a test can prove
		// the abort actually fires without waiting fifteen real seconds. Production never changes
		// it. A mutation that removes the abort signal has to be OBSERVABLE for the test to be
		// worth anything, and it is not observable in under 15s otherwise.
		this.httpTimeoutMs = NETWORK_REQUEST_TIMEOUT_MS;

		// NOTE: the count of replayed records is NOT held here. It describes ONE request's
		// payload, and two requests are in flight whenever an HTTP request hangs past the 15 s
		// gate - so an instance field is read by the wrong one. See backlogCountFor.
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

    	// BACKLOG FIRST, THEN THE SPLICE. The order is the fix, not a tidy-up.
    	//
    	// This used to splice the payload and THEN load the backlog into the queue, so a batch
    	// read off the disk did not go out until the NEXT tick - a full second later - while
    	// already having been deleted from the file. It existed only in RAM for that whole second.
    	// A power cut, a pm2 restart or a read-only remount in that window lost it permanently,
    	// and the queue carries macrosStatus, which is the acknowledgement that clears the update
    	// flag. Loading first puts the batch in the payload it is about to be confirmed by.
    	//
    	// THE BATCH IS RETURNED, NOT PUSHED ONTO THE QUEUE, and it is placed at the FRONT of the
    	// payload. Both halves of that matter:
    	//
    	//   Order. Backlog records are older than this tick's records. The server iterates the
    	//   payload applying as it goes - `for (const item of payload)` in the gateway's
    	//   processPayload, and the same shape in DeviceController::sync - so whichever copy comes
    	//   LAST wins. With the backlog at the end, the OLDER value won: a device that had rolled
    	//   back to a blocked firmware version replayed the safe version it used to run, the
    	//   gateway remembered that, and handed it the update flag - feeding the exact rollback
    	//   loop the guard exists to stop. Oldest-first restores last-write-wins to mean newest.
    	//
    	//   Returning rather than pushing. Deriving the boundary from payload.length assumed
    	//   nothing else touched the queue between the push and the splice, and eventHub.emit ->
    	//   logListener -> queue.push is synchronous, so a single stray log line between the two
    	//   would have silently mis-sliced the payload on the failure path. The count now comes
    	//   from the batch itself.
    	const backlogBatch = this.loadMissedNetworkMessagesFlag
    		? this.loadMissedNetworkMessages()
    		: [];

    	// grab the entire current queue into a payload for this particular request (this clears the queue)
    	const ownRecords = this.queue.splice(0, this.queue.length);

    	const payload = backlogBatch.length > 0
    		? backlogBatch.concat(ownRecords)
    		: ownRecords;

    	// THE COUNT TRAVELS WITH THE PAYLOAD, not on `this`.
    	//
    	// It used to be an instance field, and that is wrong whenever two requests overlap -
    	// which is routine, not exotic: an HTTP request hangs, the 15 s gate opens, the socket
    	// comes back, and the next tick goes out over the WebSocket while the first is still
    	// alive. Three separate failures came out of that one field:
    	//
    	//   the WS request succeeds and commits, then the HTTP abort fires, reads the ZEROED
    	//   count, and re-queues records the gateway already acknowledged and the drain already
    	//   erased - which the next failing tick writes back onto the card;
    	//
    	//   or the abort fires first, consumes the count belonging to the WS request, and
    	//   commitBacklogDrain then no-ops on a batch the server HAS confirmed, so it is sent
    	//   again;
    	//
    	//   or the newer request's count is applied to the older request's payload and silently
    	//   deletes the device's own records - including any macrosStatus in them.
    	//
    	// A WeakMap keyed on the payload array fixes all three: each request's count is reachable
    	// only from its own payload, and it is collected with it if the request never settles.
    	if (backlogBatch.length > 0) {
    		backlogCountFor.set(payload, backlogBatch.length);
    	}
    	// console.log('PAYLOAD', payload);

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

    		// Server-rendered show tables. tableNeeds is the (showId, segments) pairs currently
    		// being played - the server cannot work these out itself, because the schedule is
    		// evaluated here. tableHashes is what we already hold, so unchanged tables are not
    		// resent. Both are small: a handful of short strings.
    		tableHashes: showTableStore.getHashes(),
    		tableNeeds: showTableStore.getNeeds(),
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
		// AN ACTUAL ABORT, plus a generation stamp.
		//
		// NETWORK_REQUEST_TIMEOUT_MS only ever gated whether this module would let ITSELF start
		// another request. The fetch had no AbortController and no timeout of its own, so a hung
		// request stayed alive forever: after 15s a second one was launched alongside it, and the
		// first could return LATER than the second, clear the shared requestInProgress flag, and
		// merge a stale configuration over a newer one. Repeated partial hangs accumulated
		// sockets and memory on exactly the path the device falls back to when the gateway is
		// already in trouble.
		//
		// The generation counter is the second half. Aborting stops the request, but a response
		// already in flight can still land; comparing generations makes a late reply inert
		// instead of authoritative.
		//
		// It is bumped by BOTH transports (see sendViaWebSocket). It used to be bumped only
		// here, so a WebSocket request could not supersede an in-flight HTTP one - and the
		// reconnect path makes that the common case, not an exotic one: an HTTP request hangs
		// during a gateway blip, the socket comes back, the next tick goes over WebSocket and
		// succeeds, and then the abort fires and the stale HTTP handler still believed itself
		// current. Depending on which of the two landed first that either re-appended records
		// the server had just acknowledged, or left the drain unable to make progress.
		const generation = ++this.requestGeneration;

		const controller = new AbortController();
		const abortTimer = setTimeout(() => {
			controller.abort();
		}, this.httpTimeoutMs);

		// Never hold the process open on this timer's account.
		if (typeof abortTimer.unref === 'function') { abortTimer.unref(); }

		const isCurrent = () => (generation === this.requestGeneration);

		fetch(this.url, {
		    method: 'POST',
		    headers: {
		        'Content-Type': 'application/json', // Set the Content-Type header to indicate JSON data
		    },
		    body: JSON.stringify(requestObject), // Convert the request object to a JSON string and set as the request body
		    signal: controller.signal,
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
			clearTimeout(abortTimer);

			// A reply from a superseded request must not touch current state. Before the
			// generation stamp, a slow response could land after a newer one and merge a stale
			// configuration into the device.
			if (!isCurrent()) {
				logger.warn('Discarding a late HTTP response from a superseded request.');
				return;
			}

    		this.onNetworkRequestSuccess(payload, data);
		})

		// and catch any errors that occur
		.catch(error => {
			clearTimeout(abortTimer);

			if (!isCurrent()) {
				// Superseded, and usually because WE aborted it. Do NOT fail it again - that
				// would double-count the error and re-report a failure for a request that has
				// already been replaced.
				//
				// But the payload is not the newer request's to lose. The newer request owns
				// only the BACKLOG portion, which is still on disk and will be re-read; the
				// device's own records were spliced out of the queue and exist nowhere else.
				// Dropping them here cost one second of telemetry - and any macrosStatus
				// acknowledgement in it - on every 15-second hang. Put them back.
				const orphaned = this.stripBacklogPortion(payload);

				if (orphaned.length > 0) {
					logger.warn('Re-queuing ' + orphaned.length + ' record(s) from a superseded '
						+ 'HTTP request.');

					this.queue.unshift(...orphaned);
				}

				return;
			}

			const reason = (error && error.name === 'AbortError')
				? new Error(`HTTP request aborted after ${this.httpTimeoutMs}ms`)
				: error;

    		this.onNetworkRequestError(payload, reason);
		});
    }


    // send the request over the WebSocket gateway. The response arrives asynchronously via
    // the 'message' handler registered in connectWebSocket(), which resolves this.pendingPayload.
    sendViaWebSocket(requestObject, payload) {
    	try {
    		// Supersede any in-flight HTTP request. The counter is shared by both transports
    		// precisely so that a WebSocket request taking over from a hung HTTP one makes that
    		// one's late reply inert - see the comment in sendViaHttp.
    		this.requestGeneration++;

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


    // The inbound half of the WebSocket transport, as its own method so the tests can drive
    // it directly. A test that has to restate a handler passes happily after the handler
    // changes underneath it - the gateway's own suite did exactly that, and stayed green
    // after the fix it existed to protect was deleted.
    handleWebSocketMessage(raw) {
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

    	const body = raw.toString();

    	// A GATEWAY ERROR REPLY IS A FAILED SYNC, NOT A SUCCESSFUL ONE.
    	//
    	// The gateway answers a rejected sync with {"error": "..."} - a bad serial, an
    	// unknown device id, an internal fault. Everything below this line used to hand that
    	// straight to onNetworkRequestSuccess, and the consequences ran three deep:
    	//
    	//   1. errorCounter was reset to 0, so a device whose every sync was being REFUSED
    	//      reported itself online and never entered the missed-message path. Its queued
    	//      logs and statuses were spliced off and discarded on each tick, so the failure
    	//      was invisible from both ends.
    	//   2. handleResponse JSON-parsed the error and passed it to configManager.update(),
    	//      which merges every top-level key into this.config and persists it - writing
    	//      `"error": "Invalid device id"` into config.json on the SD card.
    	//   3. mergeObjects has no delete path, so once written the key stayed for the life
    	//      of the card, re-parsed on every boot. Same shape as the show-table blobs the
    	//      TRANSPORT_ONLY_KEYS strip in handleResponse was added to stop.
    	//
    	// The HTTP transport never had this: fetch throws on a non-2xx before it can reach
    	// onNetworkRequestSuccess. It is specific to the WebSocket path - which, with
    	// ENABLE_WEBSOCKET_TRANSPORT true, is the path the fleet actually uses.
    	//
    	// Routing to the error handler re-queues the payload, so nothing is lost: the data
    	// goes back on the queue and is retried, exactly as it is for a transport failure.
    	let isErrorReply = false;
    	try {
    		const parsed = JSON.parse(body);
    		// DETECT A SUCCESS, DO NOT ENUMERATE FAILURES.
    		//
    		// This matched exactly one shape - `{"error": "<string>"}` - so every other rejection
    		// the gateway or a proxy can emit was handled as a SUCCESS. Verified against the real
    		// handler: `{"error":{"code":422,...}}`, `{"message":"Unauthenticated."}` and
    		// `{"errors":{...}}` each reset errorCounter to 0, so a device whose every sync was
    		// refused reported itself online and never queued - and each was merged into
    		// config.json by configManager.update() and persisted to the SD card, where
    		// mergeObjects has no delete path so it survives every boot. That is verbatim the
    		// three-deep failure this branch was written to stop.
    		//
    		// A real sync reply always carries device_id (see DeviceController::sync and the
    		// gateway's response builder). Requiring that is a whitelist, and a whitelist cannot
    		// be outflanked by a rejection shape nobody anticipated.
    		isErrorReply = !(parsed !== null
    			&& typeof parsed === 'object'
    			&& parsed.device_id !== undefined);
    	} catch (parseError) {
    		// Unparseable. Leave it to handleResponse, which already swallows this and is
    		// where the existing behaviour for a malformed body lives.
    	}

    	if (isErrorReply) {
    		this.onNetworkRequestError(payload, new Error(`Gateway rejected the sync: ${body}`));
    		return;
    	}

    	this.onNetworkRequestSuccess(payload, body);
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

		// The server has the payload, so the backlog records that rode in it can finally leave
		// the disk. Before this they were deleted the moment they were READ, which is what made
		// a crash during recovery lose them.
		this.commitBacklogDrain(payload);

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

		const ownRecords = this.stripBacklogPortion(payload);

		// if error count is greater than the max, then we need to start saving the missed data to a file,
		// instead of just to the queue, so that it can be re-sent later
		if (this.errorCounter > MAX_ERROR_COUNT) {
			this.savePayloadToFile(ownRecords);
		} else {
			// otherwise, these messages should just be added back to the queue and re-sent to server.
    		// unshift the queue by adding this payload (which failed) to the front
    		this.queue.unshift(...ownRecords);
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
    		this.handleWebSocketMessage(raw);
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

    		// Strip transport-only keys before the config manager sees them.
    		//
    		// configManager.update() merges EVERY top-level key of the reply into this.config
    		// and then persists it, so the base64 show-table blobs were being written into
    		// config.json on the SD card - in direct violation of the rule ShowTableStore
    		// states in its own header ("Tables live in memory only. They are never written to
    		// the SD card. Continuous writing of config.json is the established cause of this
    		// fleet's card failures."). The store honoured that rule; this transport did not.
    		//
    		// mergeObjects has no delete path, so once a blob landed it stayed for the life of
    		// the card: re-parsed on every boot, and re-serialised on every saveToFile() -
    		// including by the byte-compare guard that now had to stringify megabytes just to
    		// decide not to write. Up to MAX_NEEDS_PER_SYNC tables can arrive at once, and the
    		// write is synchronous, on the same thread as the 25ms DMX loop.
    		//
    		// ConfigManager.loadFromFile() purges any blob an earlier build already persisted -
    		// this fix alone would never have cleaned an affected card.
    		const configData = {};
    		for (const key of Object.keys(data)) {
    			if (!TRANSPORT_ONLY_KEYS.includes(key)) { configData[key] = data[key]; }
    		}

    		// update the config manager with the new data
    		configManager.update(configData);

    			// Apply any server-rendered show tables. Entirely best-effort: applyFromResponse
    			// swallows anything malformed, and a refused or missing table simply means we keep
    			// rendering that show locally, exactly as today.
    			showTableStore.applyFromResponse(data);

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


    // savePayloadToFile - append the current payload to missedNetworkMessages.json
    //
    // APPEND, not read-modify-rewrite. This used to load the entire backlog, parse it, push the
    // new records on, re-stringify the whole thing (pretty-printed) and rewrite the file - once
    // per second for the length of an outage. See MAX_MISSED_MESSAGES_BYTES for the measured
    // cost. Each write is now proportional to the NEW data only.
    //
    // The file is newline-delimited JSON, one record per line, which is what makes an append
    // possible at all. loadMissedNetworkMessagesJSONFromFile still reads the old single-JSON-
    // array format, so a device carrying a backlog written by an older build loses nothing.
    savePayloadToFile(payload) {
    	// Nothing to write. The old code still rewrote the entire file in this case, and it is
    	// the COMMON case: payload is a splice of the queue and is frequently empty.
    	// ConfigManager has had exactly this guard, for the same reason, since 2026-08-10.
    	if (!Array.isArray(payload) || payload.length === 0) {
    		return;
    	}

    	try {
    		let serialized = '';

    		for (const record of payload) {
    			// One malformed record must not cost the whole payload. A circular structure is
    			// the realistic case - a status object that has picked up a self-reference.
    			try {
    				serialized += JSON.stringify(record) + '\n';
    			} catch (recordError) {
    				logger.warn('Skipping an unserializable missed message: ' + recordError.message);
    			}
    		}

    		if (serialized.length === 0) {
    			return;
    		}

    		// A LEGACY FILE MUST BE CONVERTED BEFORE ANYTHING IS APPENDED TO IT.
    		//
    		// loadMissedNetworkMessagesJSONFromFile decides the format from the first character:
    		// '[' means the old single-JSON-array format, and it parses the WHOLE file at once.
    		// Appending a newline-delimited record to such a file produces `[...]\n{...}`, which
    		// that parse rejects - so the reader returns [] for the ENTIRE file, the drain flag is
    		// set to false, and the device stops queueing to disk for the life of that boot.
    		//
    		// Reproduced end to end: a 301-record legacy backlog carrying a macrosStatus ack, one
    		// append, 0 records readable, ack unrecoverable. The ~500 cards provisioned with the
    		// pre-2026-08-08 build are exactly the population holding this format, and the trigger
    		// is any one of them being offline for six seconds - long enough for errorCounter to
    		// cross MAX_ERROR_COUNT and reach this function.
    		//
    		// This is a regression from making the file append-only: the old read-modify-rewrite
    		// happened to keep the file in one format. Converting first restores that property at
    		// the cost of one rewrite, once, on the first append after an update.
    		try {
    			const head = fs.readFileSync(this.filePath, 'utf8').trimStart().slice(0, 1);

    			if (head === '[') {
    				const converted = this.loadMissedNetworkMessagesJSONFromFile();

    				logger.info('Converting a legacy missed-messages file (' + converted.length
    					+ ' record(s)) to newline-delimited format before appending.');

    				this.saveMissedNetworkMessagesJSONToFile(converted);
    			}
    		} catch (error) {
    			// no file yet, or unreadable - the append below handles both
    		}

    		// A PARTIAL FINAL LINE MUST NOT FUSE WITH THE NEXT RECORD.
    		//
    		// appendFileSync is not atomic, so losing power mid-append leaves a truncated line
    		// with no newline. Appending straight onto it concatenates the stub and the next
    		// record into one unparseable line, so the power cut costs TWO records instead of
    		// one - and if the second is the macrosStatus ack, the device stays on old firmware.
    		// Reproduced: [A, B, <stub>] + [D, E] reads back as [A, B, E]; D is destroyed.
    		try {
    			const size = fs.statSync(this.filePath).size;

    			if (size > 0) {
    				const tail = Buffer.alloc(1);
    				const fd = fs.openSync(this.filePath, 'r');

    				try { fs.readSync(fd, tail, 0, 1, size - 1); } finally { fs.closeSync(fd); }

    				if (tail[0] !== 0x0a) { serialized = '\n' + serialized; }
    			}
    		} catch (error) {
    			// no file yet, or unreadable - the append below handles both
    		}

    		fs.appendFileSync(this.filePath, serialized);

    		// Enforce the ceiling. Only reads and rewrites when the cap is actually crossed, so
    		// the normal path stays proportional to the new data.
    		this.compactMissedMessagesIfOversized();

    		if (configManager.checkLogLevel('detail')) {
    			logger.info('Appended ' + payload.length + ' missed message(s) to the backlog file.');
    		}
    	} catch (error) {
    		// A backlog we cannot write is not worth taking the device down for.
    		logger.warn('Unable to append to the missed messages file: ' + error.message);
    	}
    }


    // compactMissedMessagesIfOversized - drop the OLDEST records once the file passes its cap
    //
    // Oldest-first because the newest telemetry is the useful telemetry: on a long outage the
    // log line from four hours ago is not worth an SD card. The drop is logged loudly, because
    // silently discarding a device's telemetry is exactly the kind of thing that gets
    // discovered months later.
    compactMissedMessagesIfOversized() {
    	let size = 0;

    	try {
    		size = fs.statSync(this.filePath).size;
    	} catch (error) {
    		return;   // no file yet, nothing to compact
    	}

    	if (size <= MAX_MISSED_MESSAGES_BYTES) {
    		return;
    	}

    	const records = this.loadMissedNetworkMessagesJSONFromFile();
    	const target = Math.floor(MAX_MISSED_MESSAGES_BYTES * COMPACT_TO_FRACTION);

    	// Walk backwards from the newest, keeping records until the byte budget is spent.
    	const kept = [];
    	let bytes = 0;

    	for (let i = records.length - 1; i >= 0; i--) {
    		let line;

    		try {
    			line = JSON.stringify(records[i]);
    		} catch (error) {
    			continue;
    		}

    		if (bytes + line.length + 1 > target) {
    			break;
    		}

    		bytes += line.length + 1;
    		kept.unshift(records[i]);
    	}

    	const dropped = records.length - kept.length;

    	this.saveMissedNetworkMessagesJSONToFile(kept);

    	logger.warn('Missed-message backlog exceeded ' + MAX_MISSED_MESSAGES_BYTES
    		+ ' bytes; dropped the ' + dropped + ' oldest record(s), kept ' + kept.length + '.');
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

    		// (The count used to live on `this` and had to be cleared here; it now travels with
    		// the payload, so an abandoned request cannot leave a stale one behind at all.)
    		//
    		// Kept as a note because the interleaving it describes is the reason for that change:
    		//
    		// It used to survive here, and a stale count is not a cosmetic problem: it describes
    		// a payload that no longer exists. The interleaving that bites is a read failure on a
    		// worn card - this fleet's established failure mode. Request A loads 250 records and
    		// hangs; fifteen seconds later the timeout gate lets a new tick through; readFileSync
    		// throws EIO, so this branch runs and leaves the count at 250; request B carries two
    		// fresh records, succeeds, and commitBacklogDrain cheerfully slices 250 records off a
    		// file it can now read again. That is silent, permanent loss of records that were
    		// never sent - the exact loss this whole mechanism exists to prevent, moved out of
    		// the crash window and onto the success path.
    		return [];
    	}

    	// READ WITHOUT TRUNCATING. The file is not rewritten here any more.
    	//
    	// This used to remove the batch from the file the moment it was read, so the records
    	// existed only in RAM until a later sync happened to succeed. A crash in that window lost
    	// them, and the queue carries macrosStatus - the acknowledgement that clears the update
    	// flag - so this was not merely "some logs went missing".
    	//
    	// Durable queue items are now removed only once the server has confirmed them, in
    	// commitBacklogDrain(). The cost of that choice is at-least-once rather than at-most-once
    	// delivery: a crash between a successful send and the commit re-sends the batch. For logs
    	// and status rows a duplicate is obviously better than a hole.
    	// Returned to the caller, which puts them at the FRONT of the payload and sets
    	// the count on the payload itself, via backlogCountFor. See performNetworkRequest.
    	return parsedData.slice(0, MAX_MESSAGES_TO_RESEND_AT_ONCE);
    }


    // stripBacklogPortion - separate a failed payload's replayed records from the device's own.
    //
    // The backlog records are still in the file - they were read without being removed - so
    // putting them back in the queue would duplicate every one of them on every failed retry,
    // and an outage is exactly when retries fail repeatedly. The device's OWN records exist
    // nowhere else and must survive.
    //
    // They are the HEAD of the payload, not the tail: performNetworkRequest puts the older
    // backlog first so the server's last-write-wins ordering resolves to the newest value.
    //
    // The count is consumed here. A count larger than the payload it describes means the two
    // have come apart, which is a bug rather than a condition to absorb quietly - the old
    // Math.max(0, ...) clamp turned exactly that into an empty payload, silently discarding the
    // device's own records including any macrosStatus acknowledgement in them. Say so and keep
    // the records.
    stripBacklogPortion(payload) {
    	const count = backlogCountFor.get(payload) ?? 0;
    	backlogCountFor.delete(payload);   // unconfirmed; the file still holds them

    	if (count <= 0) { return payload; }

    	if (count > payload.length) {
    		logger.error('Backlog accounting is inconsistent: ' + count + ' replayed record(s) '
    			+ 'claimed against a payload of ' + payload.length + '. Keeping the whole payload.');

    		return payload;
    	}

    	return payload.slice(count);
    }


    // commitBacklogDrain - drop the confirmed batch from the front of the backlog file.
    //
    // Called ONLY from the success path. Until this runs the records are still on disk, which is
    // the entire point: nothing leaves durable storage until the server has acknowledged it.
    commitBacklogDrain(payload) {
    	const confirmed = backlogCountFor.get(payload) ?? 0;

    	if (confirmed <= 0) { return; }

    	backlogCountFor.delete(payload);

    	try {
    		const remaining = this.dropLeadingBacklogRecords(confirmed);

    		// null means the file was not successfully rewritten. The records stay on disk and
    		// get re-sent, which is the safe direction - but the flag must NOT be cleared, or the
    		// drain stops on a device whose backlog is still full.
    		if (remaining === null) {
    			logger.error('Backlog drain not committed. ' + confirmed + ' record(s) will be '
    				+ 're-sent; leaving the file alone is the safe direction.');

    			return;
    		}

    		if (remaining === 0) {
    			// nothing left, so stop draining until something fails again
    			this.loadMissedNetworkMessagesFlag = false;
    		}

    		if (configManager.checkLogLevel('detail')) {
    			logger.info('Confirmed ' + confirmed + ' backlog record(s); ' + remaining + ' left.');
    		}
    	} catch (error) {
    		// A failure here re-sends the batch next time rather than losing it. Leaving the file
    		// alone is the safe direction.
    		logger.error('Unable to commit the backlog drain: ' + error.message);
    	}
    }


    // dropLeadingBacklogRecords - remove the first `count` records from the backlog file.
    //
    // Returns the number of records left, or null if the file could not be rewritten - the
    // caller needs that distinction, because "nothing left" and "could not write" look identical
    // from the outside and only one of them means the drain is finished.
    //
    // The newline-delimited path slices LINES rather than parsing the file. Draining used to
    // parse every record in the file twice per batch - once to take 250, once here to drop them
    // - and the parse is where the time goes. Measured on the previous shape: 20,000 records
    // drained in 80 ticks read 336 MB and spent 4.3 s of synchronous CPU, about 54 ms per tick,
    // on the same event loop that owns the 25 ms render and 24 ms sACN timers. A long outage
    // therefore ended in visible stutter for the length of the recovery.
    //
    // A line that fails to parse is counted as consumed here but was skipped by the reader, so a
    // corrupt line among the confirmed batch causes a RE-SEND of the records after it, never a
    // loss. Duplicates are already the accepted trade of at-least-once delivery; losing records
    // is not, and this errs in that direction on purpose. A partial line is expected only as the
    // FINAL line (appendFileSync is not atomic), which is never inside a confirmed batch.
    dropLeadingBacklogRecords(count) {
    	let rawData = '';

    	try {
    		rawData = fs.readFileSync(this.filePath, 'utf8');
    	} catch (error) {
    		logger.error('Unable to read the missed messages file to commit a drain: ' + error.message);

    		return null;
    	}

    	const trimmed = rawData.trim();

    	if (trimmed.length === 0) { return 0; }

    	// legacy single-array format has no line structure, so it costs a full parse. It is
    	// rewritten as newline-delimited records on the way out, so this happens at most once.
    	if (trimmed[0] === '[') {
    		const parsed = this.loadMissedNetworkMessagesJSONFromFile();
    		const left = parsed.slice(count);

    		return this.saveMissedNetworkMessagesJSONToFile(left) ? left.length : null;
    	}

    	const lines = trimmed.split('\n').filter((line) => line.trim().length > 0);
    	const remaining = lines.slice(count);

    	try {
    		fs.writeFileSync(this.filePath, remaining.length > 0 ? remaining.join('\n') + '\n' : '');
    	} catch (error) {
    		logger.error('Unable to truncate the missed messages file: ' + error.message);

    		return null;
    	}

    	return remaining.length;
    }


    // loadMissedNetworkMessagesJSONFromFile - read the backlog, in either format
    //
    // Reads newline-delimited JSON (what savePayloadToFile now writes) AND the old single
    // JSON-array format, so a device that updates while carrying a backlog does not lose it.
    // The format is decided by the first non-whitespace character, not a flag or a filename.
    //
    // A truncated final line is expected rather than exceptional: appendFileSync is not atomic,
    // so losing power mid-append leaves a partial line. One unparseable line now costs that
    // line - the old code returned [] for the entire file on any parse error, silently
    // discarding everything the device had queued.
    loadMissedNetworkMessagesJSONFromFile() {
    	let rawData = '';

    	try {
			rawData = fs.readFileSync(this.filePath, 'utf8');
    	} catch (error) {
    		// no file is the normal state - only worth a line at detail level
    		if (configManager.checkLogLevel('detail')) {
    			logger.info('No missed messages file at ' + this.filePath);
    		}

    		return [];
    	}

    	const trimmed = rawData.trim();

    	if (trimmed.length === 0) {
    		return [];
    	}

    	// legacy format: one JSON array for the whole file
    	if (trimmed[0] === '[') {
    		try {
    			const parsed = JSON.parse(trimmed);

    			if (Array.isArray(parsed)) {
    				logger.info('Read ' + parsed.length + ' missed message(s) in the legacy array '
    					+ 'format; they will be rewritten as newline-delimited records.');

    				return parsed;
    			}
    		} catch (error) {
    			logger.warn('Unable to parse the legacy missed messages file: ' + error.message);
    		}

    		return [];
    	}

    	// newline-delimited records
    	const records = [];
    	let skipped = 0;

    	for (const line of trimmed.split('\n')) {
    		if (line.trim().length === 0) { continue; }

    		try {
    			records.push(JSON.parse(line));
    		} catch (error) {
    			skipped++;
    		}
    	}

    	if (skipped > 0) {
    		logger.warn('Skipped ' + skipped + ' unparseable line(s) in the missed messages file '
    			+ '(a partial final line is expected after a power loss mid-append).');
    	}

    	return records;
    }


    // saveMissedNetworkMessagesJSONToFile - full rewrite of the backlog, in the new format
    //
    // Only two callers, both of which genuinely need to rewrite the whole file: the drain path
    // (which removes the records it just queued) and compaction. Every APPEND goes through
    // savePayloadToFile instead. Note the pretty-printing is gone - `null, 2` was 30-40% of the
    // bytes of a file nothing reads by eye.
    saveMissedNetworkMessagesJSONToFile(data) {
    	// now try to save this to a file
    	try {
    		let serialized = '';

    		for (const record of (Array.isArray(data) ? data : [])) {
    			try {
    				serialized += JSON.stringify(record) + '\n';
    			} catch (recordError) {
    				// drop the one record rather than the file
    			}
    		}

    		fs.writeFileSync(this.filePath, serialized);

    		if (configManager.checkLogLevel('detail')) {
	    		logger.info('Saved the current payload to the missedNetworkMessages.json file!');
	    	}

    		return true;
    	} catch (error) {
    		// log a warning that the file couldn't be saved
    		logger.error('Unable to save the network queue to a file, error: ' + error.message);

    		// REPORTED, not just logged. commitBacklogDrain has to know whether the truncation it
    		// asked for actually happened: on a read-only remount - this fleet's established
    		// failure mode - the write fails here, the caller's try/catch never fires because
    		// nothing was rethrown, and the caller went on to declare the drain finished on a
    		// file that still held every record. That stops the drain outright on a device whose
    		// backlog is full.
    		return false;
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
