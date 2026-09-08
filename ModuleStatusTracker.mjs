// ModuleStatusTracker.mjs
// this single-instance module tracks statuses of other modules for the Attitude Control 2.A app
// it also handles updating the color of the LED board
// copyright 2024 Drew Shipps, J Squared Systems



// import modules
import fs from 'fs';

import eventHub from './EventHub.mjs';
import attitudeLED from './AttitudeLED2A.mjs';
import attitudeSACN from './AttitudeSACN2A.mjs';

import Logger from './Logger.mjs';
const logger = new Logger('StatusTracker');

import configManager from './ConfigManager.mjs';



// variables
const SAMPLE_INTERVAL = 3000;  // interval for how often to check module statuses (should be 15000ms)
const SEND_TO_NETWORK_INTERVAL = 15000; // interval for how often to send module statuses to the server
const UNRESPONSIVE_THRESHOLD = 35;  // number of seconds before considering a module unresponsive

// How long a non-operational status is held before an 'operational' report may overwrite it.
//
// This was the bare literal 5 compared against a Date difference - which is MILLISECONDS, so
// the window was 5ms, not 5 seconds. The comment above the check said "1 second" and the dead
// console.log beside it said "5 sec"; nobody had noticed the units.
//
// What it actually cost: a TRANSIENT degraded is overwritten by the next frame's operational
// 25ms later. With SAMPLE_INTERVAL at 3s and SEND_TO_NETWORK_INTERVAL at 15s, a status that
// lives 25ms has essentially no chance of ever being sampled or reported - so intermittent
// faults were invisible fleet-wide. (A PERSISTENT per-frame error was reported correctly even
// at 5ms, because the two emits land ~1ms apart inside one frame.)
//
// Expect a step change in reported degradations after this ships. That is the point.
const NON_OPERATIONAL_HOLD_MS = 5000;



// ---------------------------------------------------------------------------
// LOCAL STATUS FILE
//
// The same status we send to the server, also written to a local file so that update.sh
// can read it. update.sh is a shell script with no way to see inside this process, so
// before this file existed the only things it could check after an update were that the
// pid stayed up and that a socket was open on :443.
//
// Both of those were true on 2026-08-11 while AttitudeFixtureManager threw on every single
// frame. The update passed its health check, no rollback fired, and the lights stopped.
// A false pass is worse than a failure, so this closes that hole: the updater can now
// require positive proof that fixtures are actually being processed before it accepts a
// build. It also catches a wedged event loop, which the socket check cannot - the
// WebSocket stays open whether or not anything is still running.
//
// WRITTEN TO A MEMORY-BACKED FILESYSTEM, NEVER THE SD CARD. Repeatedly rewriting a small
// file in place is the established cause of card failure on this fleet (AC-0020135, on
// config.json). At one write every SAMPLE_INTERVAL this would be ~29k writes a day to the
// same erase block. /dev/shm is tmpfs on every image we run; /tmp is the fallback.
//
// Deliberately NOT JSON: the only consumer is a bash script on a device with no jq.
// ---------------------------------------------------------------------------
const LOCAL_STATUS_MARKER = 'ATTITUDE_STATUS_FILE_V1';   // update.sh greps this file, and this source, for this exact string
const LOCAL_STATUS_FILENAME = 'attitude-status';
const LOCAL_STATUS_DIRS = ['/dev/shm', '/run/shm', '/tmp'];



// Define the ModuleStatusTracker class
class ModuleStatusTracker {

    // constructor
    constructor() {
        // minimum and maximum interval to send a status update
        this.sampleInterval = SAMPLE_INTERVAL;

        // variable to hold on to each module's current status
        this.modules = [];

        // variable to hold the overall status
        this.overallStatus = 'initializing';

        // variable to hold the timestamp for the last sent packet
        // initial value needs to be current time minus send interval, so that the first packet will send
        this.lastStatusSentToNetworkTimestamp = (new Date() - SEND_TO_NETWORK_INTERVAL);

        // where the local status file is being written, resolved on first write
        this.localStatusPath = null;

        // set once we have given up on writing it, so we do not retry every sample forever
        this.localStatusUnavailable = false;

        // bind an event listener for each moduleStatus event
        eventHub.on('moduleStatus', this.moduleStatusListener.bind(this));
    }


    // initialization function
    init() {
        // start the interval for status sampling
        setInterval(() => {
            this.processAllModulesStatus();
        }, this.sampleInterval);

        // run once immediately
        this.processAllModulesStatus();
    }


    // process the status of all modules
    processAllModulesStatus() {
        // wrap the system status processing in a try catch, in case there's errors with os
        try {
            if (configManager.checkLogLevel('interval')) {
                logger.info(`Processing current status of all modules at ${ new Date().toLocaleTimeString() }`);
            }

            // iterate over each module to check if any modules are unresponsive
            const currentTime = Date.now();
            this.modules.forEach(module => {
                const timeElapsed = (currentTime - module.timestamp) / 1000; // Time elapsed in seconds
                
                // check if this module is a one time status module
                // meaning that it's not going to be unresponsive because it only runs when needed
                let isAOneTimeStatusModule = module.oneTimeEvent === true ? true : false;

                if (timeElapsed > UNRESPONSIVE_THRESHOLD && !isAOneTimeStatusModule) {
                    module.status = 'unresponsive';
                    module.data = `Unresponsive for last ${this.timeAgoStringOnly(timeElapsed)}`;
                }
            });

            // copy the modules list, but without any oneTimeEvent properties
            const copyOfModulesToSend = this.modules.map(obj => {
                // Create a shallow copy of the object
                let newObj = { ...obj };
                
                // Remove the oneTimeEvent property if it exists
                if (newObj.hasOwnProperty('oneTimeEvent')) {
                    delete newObj.oneTimeEvent;
                }
                
                return newObj;
            });

            // process module statuses: update led panel, activate white backup, and set overall status
            this.processModuleStatuses();

            // create an object with each module's current status in it (for final network send)
            const currentModuleStatus = {
                timestamp: new Date(),
                overallStatus: this.overallStatus,
                modules: copyOfModulesToSend,
            };

            // TEMP log the current module status object
            // console.log('currentModuleStatus', currentModuleStatus);


            // write the same picture to a local file, for update.sh to health check against
            this.writeLocalStatusFile(currentModuleStatus);

            // calculate the difference between the current time and the last time we sent data to the network
            let difference = new Date() - this.lastStatusSentToNetworkTimestamp;

            // if the difference is greater than the interval, we need to send to network again
            if (difference > SEND_TO_NETWORK_INTERVAL) {
                // emit an event that the current system status has been processed (which should then be picked up by network module)
                eventHub.emit('moduleStatusUpdate', currentModuleStatus);

                // save the current time to the last sent timestamp
                this.lastStatusSentToNetworkTimestamp = new Date();
            }            
        } catch (error) {
            logger.error(`Error processing status of all modules: ${error}`);
        }
    }


    // isMemoryBacked - is this directory on a tmpfs/ramfs mount?
    //
    // The entire reason this file is not written to the SD card is erase-block wear: at one
    // write per sample it is roughly 29,000 writes a day to the same few blocks, which is how
    // AC-0020135's card died by way of config.json. A fallback that silently lands on the card
    // would give that back without anyone noticing, so each candidate directory is checked
    // rather than assumed. /dev/shm and /run/shm are tmpfs everywhere we run; /tmp is only
    // sometimes, and this is what tells the difference.
    //
    // If we cannot tell, the answer is no. Losing this diagnostic costs an update rollback,
    // which is visible and recoverable. Being wrong the other way costs a card.
    isMemoryBacked(dir) {
        try {
            const mounts = fs.readFileSync('/proc/mounts', 'utf8').split('\n');

            // longest matching mount point wins - /dev/shm must not be judged by /
            let best = null;
            for (const line of mounts) {
                const parts = line.split(' ');
                if (parts.length < 3) { continue; }

                const point = parts[1];
                const type = parts[2];
                const prefix = (point === '/') ? '/' : point + '/';

                if (dir === point || dir.indexOf(prefix) === 0) {
                    if (best === null || point.length > best.point.length) {
                        best = { point: point, type: type };
                    }
                }
            }

            return best !== null && (best.type === 'tmpfs' || best.type === 'ramfs');
        } catch (error) {
            return false;
        }
    }


    // resolveLocalStatusPath - pick the first memory-backed directory we can actually write to.
    // Resolved once, at the first write, rather than at import time: this module is constructed
    // while the app is still starting up and a throw there would take the whole app down.
    resolveLocalStatusPath() {
        for (const dir of LOCAL_STATUS_DIRS) {
            if (!this.isMemoryBacked(dir)) { continue; }

            const candidate = dir + '/' + LOCAL_STATUS_FILENAME;
            try {
                fs.writeFileSync(candidate + '.probe', LOCAL_STATUS_MARKER);
                fs.unlinkSync(candidate + '.probe');
                return candidate;
            } catch (error) {
                // try the next one
            }
        }
        return null;
    }


    // writeLocalStatusFile - write the current status where update.sh can read it.
    //
    // Best effort in every sense: this is a diagnostic, and nothing about the running of the
    // lights depends on it. Any failure is swallowed so that a full or read-only filesystem
    // cannot stop us reporting status to the server, which matters far more.
    writeLocalStatusFile(currentModuleStatus) {
        if (this.localStatusUnavailable) { return; }

        try {
            if (this.localStatusPath === null) {
                this.localStatusPath = this.resolveLocalStatusPath();

                if (this.localStatusPath === null) {
                    this.localStatusUnavailable = true;
                    logger.warn('Could not write a local status file to any of ' + LOCAL_STATUS_DIRS.join(', ') + ' - update.sh will not be able to health check rendering on this device');
                    return;
                }
            }

            // frames rendered in the last second, lifted out of the fixture manager's PERF
            // report. This is the positive proof the updater is after: not "the process is
            // alive" but "fixtures were processed". -1 means we do not know yet, which is
            // normal for the first second after a restart.
            let renderFps = -1;
            const fixtureModule = this.findModuleByName('AttitudeFixtureManager');
            if (fixtureModule && typeof fixtureModule.data === 'string') {
                const match = fixtureModule.data.match(/renderfps=(\d+)/);
                if (match) { renderFps = Number(match[1]); }
            }

            // An unassigned device legitimately never renders anything - it outputs white and
            // reports operational. The updater has to know the difference, or it would roll
            // back every good build on a device that has not been assigned to a location yet.
            // -1 on failure, NOT 0.
            //
            // The updater treats assigned=0 as "legitimately not rendering - pass without
            // requiring frames", which is the escape hatch for a device with no location. If
            // a build that breaks config loading also reported 0, that escape hatch would
            // become the error path, and the updater would pass exactly the build it should
            // reject. -1 is neither, so it falls through to needing a real frame rate.
            let assigned = -1;
            try {
                assigned = configManager.getAssignedToLocation() ? 1 : 0;
            } catch (error) {
                assigned = -1;
            }

            let contents = 'marker=' + LOCAL_STATUS_MARKER + '\n'
                + 'epoch=' + Math.floor(Date.now() / 1000) + '\n'
                + 'at=' + new Date().toISOString() + '\n'
                + 'overall=' + this.overallStatus + '\n'
                + 'assigned=' + assigned + '\n'
                + 'renderfps=' + renderFps + '\n';

            for (const module of currentModuleStatus.modules) {
                // one line per module, names are ours and contain no spaces or newlines
                contents += 'mod.' + module.name + '=' + module.status + '\n';
            }

            // write and rename, so the updater can never read a half-written file
            const tempPath = this.localStatusPath + '.tmp';
            fs.writeFileSync(tempPath, contents);
            fs.renameSync(tempPath, this.localStatusPath);
        } catch (error) {
            // Do NOT give up on a write failure. A transient one - a full /tmp, a directory
            // that went away - would otherwise leave a stale file behind forever, and a stale
            // file reads to the updater as a dead device and would roll back a good build.
            // Drop the resolved path so the next sample picks a directory again.
            this.localStatusPath = null;
            logger.warn(`Could not write the local status file: ${error.message}`);
        }
    }


    // processModuleStatuses - check on the status of important modules. set led panel, white backup, and overall status accordingly
    processModuleStatuses() {
        // if SACN is errored, then go full red on the LED panel
        if (this.getModuleStatusByName('AttitudeSACN') == 'errored') {
            // E is just solid red no flash
            attitudeLED.setColor('E');

            // set the overall condition of the device to send to network
            this.overallStatus = 'errored';

            return;
        }


        // check if these modules have errored. if so, we need to go to white backup mode
        if (this.getModuleStatusByName('AttitudeScheduler') == 'errored'
            || this.getModuleStatusByName('AttitudeFixtureManager') == 'errored') {

            // set LED to cyan for white backup mode
            attitudeLED.setColor('C');

            // activate white backup mode
            attitudeSACN.setWhiteBackupMode(true);

            // set the overall condition of the device to send to network
            this.overallStatus = 'white';

            return;
        } else {
            // unless these modules have errored, then we should ensure white backup mode is disabled
            attitudeSACN.setWhiteBackupMode(false);
        }


        // if these modules are degraded or offline, there's an issue, but not a full on crash
        if (this.getModuleStatusByName('AttitudeScheduler') == 'degraded'
            || this.getModuleStatusByName('AttitudeFixtureManager') == 'degraded'
            || this.getModuleStatusByName('ConfigManager') == 'errored'
            || this.getModuleStatusByName('StatusTracker') == 'errored'
            || this.getModuleStatusByName('NetworkModule') == 'errored') {

            // set LED to blue (F) since we have an issue of some sort
            attitudeLED.setColor('F');

            // set the overall condition of the device to send to network
            this.overallStatus = 'degraded';

            return;
        }


        // if none are degraded and none are errored, then we can check network
        if (this.getModuleStatusByName('NetworkModule') == 'online') {
            // online is rainbow (A)
            attitudeLED.setColor('A');

            // set the overall condition of the device to send to network
            this.overallStatus = 'online';

            return;
        }

        if (this.getModuleStatusByName('NetworkModule') == 'offline') {
            // offline is purple (B)
            attitudeLED.setColor('B');

            // set the overall condition of the device to send to network
            this.overallStatus = 'offline';

            return;
        }
    }


    // moduleStatusListener - handler for moduleStatus events
    moduleStatusListener(newModuleStatus) {
        // add a timestamp to the new object
        newModuleStatus.timestamp = new Date();

        // Find the index of the module with the given name
        const index = this.modules.findIndex(module => module.name === newModuleStatus.name);

        if (index !== -1) {
            // If found, update the existing entry  

            // check to make sure the existing one isnt an error, and we're within 1 second of it
            if (newModuleStatus.status == 'operational' 
                && (this.modules[index].status == 'degraded' || this.modules[index].status == 'errored')
                && ((newModuleStatus.timestamp - this.modules[index].timestamp) < NON_OPERATIONAL_HOLD_MS)) {
                // console.log('tried to add a new status that was operational within 5 sec of a non operational status');

                // console.log('new one was ', newModuleStatus)
                // console.log('old one was ', this.modules[index])
            } else {
                this.modules[index] = newModuleStatus;
            }
        } else {
            // If not found, add a new entry
            this.modules.push(newModuleStatus);
        }
    }


    // get a module's status by name
    getModuleStatusByName(name) {
        return this.findModuleByName(name)?.status ?? '';
    }


    // find a module by name
    findModuleByName(moduleName) {
        return this.modules.find(module => module.name === moduleName);
    }


    // timeAgo - gives a human readable, single unit of time
    timeAgoStringOnly(timeElapsed) {
        const timeDifference = timeElapsed; // Time elapsed in seconds

        const units = [
            // { name: 'year', seconds: 31536000 },
            // { name: 'month', seconds: 2592000 },
            // { name: 'week', seconds: 604800 },
            // { name: 'day', seconds: 86400 },
            { name: 'hour', seconds: 3600 },
            { name: 'minute', seconds: 60 },
            { name: 'second', seconds: 1 }
        ];

        for (const unit of units) {
            const interval = Math.floor(timeDifference / unit.seconds);
            if (interval >= 1) {
                return `${interval} ${unit.name}${interval > 1 ? 's' : ''}`;
            }
        }
    }
}



// Create an instance of ModuleStatusTracker
const moduleStatusTracker = new ModuleStatusTracker();

// Export the moduleStatusTracker instance for use in other modules
export default moduleStatusTracker;
