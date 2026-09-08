// AttitudeControl2A.js
// primary JS app for Attitude Control firmware (2nd gen), version 2.A
// copyright 2024 Drew Shipps, J Squared Systems




// ==================== IMPORT ====================
import Logger from './Logger.mjs';
const logger = new Logger('AttitudeControl2A');

import eventHub from './EventHub.mjs';

import attitudeScheduler from './AttitudeScheduler.mjs';
import attitudeFixtureManager from './AttitudeFixtureManager.mjs';
import attitudeSACN from './AttitudeSACN2A.mjs';
import attitudeLED from './AttitudeLED2A.mjs';
import attitudeSenseManager from './AttitudeSenseManager.mjs';
import attitudeEmitManager from './AttitudeEmitManager.mjs';

import idManager from './IdManager.mjs';
import configManager from './ConfigManager.mjs';
import networkModule from './NetworkModule.mjs';
import statusTracker from './StatusTracker.mjs';
import moduleStatusTracker from './ModuleStatusTracker.mjs';
import macrosModule from './MacrosModule.mjs';
import renderWatchdog from './RenderWatchdog.mjs';
import udpManager from './UDPManager.mjs';



// ==================== INITIALIZATION SEQUENCE ====================

// initial logs
logger.info('Attitude Control Device Firmware (2nd gen) v2.A');
logger.info('Copyright 2024 Drew Shipps, J Squared Systems');
logger.info('System initializing at time ' + new Date());


// initialize sACN (to ensure that we go to white DMX on fixtures)
setTimeout(() => {
	attitudeSACN.initialize(16); // init with 16 universes
}, 10);


// initialize config manager and id manager
setTimeout(() => {
	idManager.init();
	configManager.init();
}, 20);


// initialize network module so it can begin listening for messages
setTimeout(() => {
	networkModule.init();
}, 30);


// initialize LED panel
setTimeout(() => {
	attitudeLED.init();
}, 40);


// initialize status trackers
setTimeout(() => {
	statusTracker.init();
	moduleStatusTracker.init();
}, 50);


// initialize schedule and fixtures
setTimeout(() => {
	attitudeScheduler.init();
	attitudeFixtureManager.init();

	// Frozen-output watchdog. Started alongside the fixture manager because it watches that
	// module's frames, and given its own timer rather than being called from processFixtures -
	// a status emitted from inside that function competes with the degraded/operational pair it
	// already emits per frame, and ModuleStatusTracker's hold window decides which survives.
	//
	// Dependencies are passed in rather than imported by the watchdog, so its tests drive the
	// real tick() with a fake clock and a fake event hub instead of restating it.
	renderWatchdog.init({ eventHub, attitudeSACN, logger });
}, 60);


// initialize macros module
setTimeout(() => {
	macrosModule.init();
}, 70);


// initialize UDP Manager
setTimeout(() => {
	udpManager.init();
}, 80);


// initialize sense and emit modules
setTimeout(() => {
	attitudeSenseManager.init();
	attitudeEmitManager.init();
}, 90);


// initialization sequence complete!
setTimeout(() => {
	logger.info('Device initialization sequence complete!');
}, 100);


