// MacrosModule.mjs
// macro control module for the Attitude Control 2.A app
// copyright 2024 Drew Shipps, J Squared Systems


// this module creates a single instance of the MacrosModule javascript object,
// which handles the reboot, restart, update, and autoupdate controls for the device



// import modules
import { exec, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import eventHub from './EventHub.mjs';

import Logger from './Logger.mjs';
const logger = new Logger('MacrosModule');

import configManager from './ConfigManager.mjs';



// variables
const SAMPLE_INTERVAL = 15000;  // interval for how often to process macros (should be 15000ms)
const LAPTOP_MODE = (process.platform == 'darwin');
const MACROS_PROCESSING_TIMEOUT = 60000;  // should be 60000ms

// ---------------------------------------------------------------- the legacy-updater bootstrap
//
// Roughly 500 SD cards were provisioned with the pre-2026-08-08 updater, and
// they cannot be re-imaged. That script is 26 lines with no `set -e`, no `-f`
// on curl, and not one return value checked; it ends with an unconditional
// `echo "...complete!"`, so a failed download, a failed unzip and a failed
// rsync all report success. A box can sit for weeks taking no updates while
// every one of them looks like it worked. Box 151 did exactly that.
//
// The way out does not need the cards to change, because the old updater's
// rsync copies the WHOLE repo tree - update.sh included. So:
//
//   cycle 1  the old script runs on a flag and replaces itself with this one,
//            along with the rest of the app. It cannot verify any of that, and
//            does not need to.
//   cycle 2  the new code - this file - comes up, notices the real updater has
//            never run here, and runs it once. On a box cycle 1 brought current
//            that lands on update.sh's `already-current` path, which exits
//            BEFORE the snapshot, the rsync and any restart: it downloads,
//            compares versions, writes attitude-build.json and quits. On a box
//            where cycle 1 only half-worked it performs a real, validated,
//            health-checked, roll-back-able update instead.
//
// Either way a device that asks for one update ends up on current code with a
// build record that says so, and every device that ever asks again is running
// an updater that cannot lie about the answer.
//
// This is deliberately NOT tied to the update flag. A box whose flag is set
// once and whose cycle 1 succeeded would otherwise need a second flag to get a
// verified record, and nobody would know which boxes those were.
const LEGACY_BOOTSTRAP_DELAY = 90000;   // let the app settle and the network come up first
const LEGACY_BOOTSTRAP_MIN_API = 2;     // see ATT_UPDATER_API in update.sh
const LEGACY_BOOTSTRAP_MAX_ATTEMPTS = 3;
const LEGACY_BOOTSTRAP_RETRY_MS = 6 * 60 * 60 * 1000;
const BUILD_STATE_FILE = 'attitude-build.json';
const BOOTSTRAP_STATE_FILE = '.attitude-bootstrap.json';



// Define the MacrosModule class
class MacrosModule {

    // constructor
    constructor() {
        // interval for processing macros
        this.sampleInterval = SAMPLE_INTERVAL;

        // variables
        this.rebootQueuedFromServer = false;
        this.restartQueuedFromServer = false;
        this.updateQueuedFromServer = false;

        this.rebootCommandSuccess = false;
        this.restartCommandSuccess = false;
        this.updateCommandSuccess = false;

        this.rebootCommandResults = '';
        this.restartCommandResults = '';
        this.updateCommandResults = '';

        // emit an event that the macros module is operational
        eventHub.emit('moduleStatus', { 
            name: 'MacrosModule', 
            status: 'operational',
            data: '',
        });
    }


    // initialize the sampling process
    init() {
        setInterval(() => {
            // process macros
            this.processMacros();
        }, this.sampleInterval);

        // One shot, delayed. See the long note above LEGACY_BOOTSTRAP_DELAY.
        // unref'd so it can never be the reason this process stays alive.
        const t = setTimeout(() => this.bootstrapLegacyUpdater(), LEGACY_BOOTSTRAP_DELAY);
        if (typeof t?.unref === 'function') t.unref();
    }


    // Read ATT_UPDATER_API out of the updater on disk. 1 means the old script,
    // which does not carry the marker at all - absence is the answer, not an
    // error. null means there is no updater here to reason about.
    readUpdaterApi(updaterPath) {
        let text;
        try {
            text = fs.readFileSync(updaterPath, 'utf8');
        } catch (error) {
            return null;
        }
        // Anchored to the start of a line so the marker cannot be matched inside
        // a comment that merely mentions it - including the one in this file, if
        // these two ever end up concatenated by a packaging step.
        const m = text.match(/^ATT_UPDATER_API=(\d+)/m);
        return m ? Number(m[1]) : 1;
    }


    readBootstrapState(file) {
        try {
            return JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch (error) {
            return { attempts: 0, lastAttempt: 0 };
        }
    }


    // Cycle 2. Runs at most once on a device that has never run the real
    // updater, and never again after that updater has written a build state.
    bootstrapLegacyUpdater() {
        try {
            const home = os.homedir();
            const buildState = path.join(home, BUILD_STATE_FILE);
            const bootstrapState = path.join(home, BOOTSTRAP_STATE_FILE);
            const updater = path.join(process.cwd(), 'update.sh');

            // 1. The real updater has already run here and recorded what it did.
            //    Nothing to bootstrap, now or ever.
            if (fs.existsSync(buildState)) { return; }

            // 2. Is the updater on disk one we can trust to be honest? On a box
            //    where cycle 1 has not happened yet this is still the old
            //    script, and launching THAT would just produce another cheerful
            //    lie - and, worse, a restart 30 seconds later for nothing.
            const api = this.readUpdaterApi(updater);
            if (api === null) {
                logger.warn('No update.sh found - this device cannot update itself.');
                return;
            }
            if (api < LEGACY_BOOTSTRAP_MIN_API) {
                logger.warn(`This device still has the legacy updater (API ${api}). It will be `
                    + `replaced the first time an update is flagged from the server; nothing `
                    + `can be verified here until then.`);
                return;
            }

            // 3. Attempt cap. If update.sh dies without writing a build state -
            //    killed, out of disk, no network - the check above stays false
            //    forever, and without this we would relaunch it on every boot.
            const state = this.readBootstrapState(bootstrapState);
            const attempts = Number(state.attempts) || 0;
            const since = Date.now() - (Number(state.lastAttempt) || 0);
            if (attempts >= LEGACY_BOOTSTRAP_MAX_ATTEMPTS) { return; }
            if (attempts > 0 && since < LEGACY_BOOTSTRAP_RETRY_MS) { return; }

            // Written BEFORE the spawn, not after. The updater restarts this
            // process, so anything recorded afterwards may never be recorded.
            try {
                fs.writeFileSync(bootstrapState, JSON.stringify({
                    attempts: attempts + 1,
                    lastAttempt: Date.now(),
                    note: 'first run of the real updater on a device provisioned with the legacy one',
                }));
            } catch (error) {
                // If we cannot record the attempt we must not make it, or a
                // read-only home directory becomes a reboot loop.
                logger.error(`Could not record the bootstrap attempt: ${error}. Not launching.`);
                return;
            }

            // rsync from a zip should preserve the executable bit, but a device
            // that cannot run its own updater is not a failure worth inheriting
            // from an archive's metadata.
            try { fs.chmodSync(updater, 0o755); } catch (error) { /* not fatal */ }

            logger.info(`This device has never run the validating updater (API ${api}). `
                + `Running it once to establish a verified build record. `
                + `Attempt ${attempts + 1} of ${LEGACY_BOOTSTRAP_MAX_ATTEMPTS}.`);

            // Detached, for exactly the reason handleUpdate() is - see the note
            // there. An updater that is a child of the process it restarts gets
            // killed by that restart.
            const child = spawn('./update.sh', [], {
                detached: true,
                stdio: 'ignore',
                cwd: process.cwd(),
            });
            child.unref();
        } catch (error) {
            // Best effort by definition. A device that fails to bootstrap must
            // still run lights.
            logger.error(`Legacy updater bootstrap failed: ${error}`);
        }
    }


    // process macros
    processMacros() {
        // log that we're now processing device macros
        if (configManager.checkLogLevel('interval')) {
            logger.info(`Processing device macros at ${ new Date().toLocaleTimeString() }`);
        }

        // get updated config from configManager
        this.getUpdatedConfig();


        // create a timeout Promise that will reject if it takes longer than 30 seconds
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => {
                reject(new Error(`Timeout: Macro execution took longer than ${MACROS_PROCESSING_TIMEOUT}ms`));
            }, MACROS_PROCESSING_TIMEOUT); // timout length
        });


        // run the three different macro functions as promises
        Promise.race([
            Promise.all([this.handleReboot(), this.handleRestart(), this.handleUpdate()]), // race these three promises 
            timeoutPromise // with the timeout promise
        ])
        .then((results) => {
            // log success
            if (configManager.checkLogLevel('detail')) {
                logger.info(`Completed processing device macros!`);
            }

            // emit an event that the MacrosModule finished
            eventHub.emit('moduleStatus', { 
                name: 'MacrosModule', 
                status: 'operational',
                data: 'Completed processing device macros!',
            });

            // emit macros event, to send completed data back to server
            this.emitMacrosEvent();
        })
        .catch((error) => {
            // log the error
            logger.error(`Error processing device macros: ${error}`);

            // emit an event that we had an error
            eventHub.emit('moduleStatus', { 
                name: 'MacrosModule', 
                status: 'errored',
                data: `Error processing device macros: ${error}`,
            });

            // emit macros event back to server regardless
            this.emitMacrosEvent();
        });
    }


    // get updated config from configManager
    getUpdatedConfig() {
        this.rebootQueuedFromServer = configManager.getReboot();
        this.restartQueuedFromServer = configManager.getRestart();
        this.updateQueuedFromServer = configManager.getUpdate();
    }


    // handle reboot command
    handleReboot() {
        // return a promise
        return new Promise((resolve, reject) => {
        
            // check if a reboot command has been queued from the server
            if (this.rebootQueuedFromServer == true) {

                // check if we're running on laptop or raspi
                if (!LAPTOP_MODE) {

                    // Command to schedule a restart in 1 minute
                    const command = 'sudo shutdown -r +1';

                    // Execute the command
                    exec(command, (error, stdout, stderr) => {
                        if (error) {
                            // set the rebootCommandSuccess variable to false, since the reboot failed
                            this.rebootCommandSuccess = false;

                            // set the rebootCommandResults variable to the error text
                            this.rebootCommandResults = error;

                            // log the error
                            logger.error(`Device reboot command failed with error: ${error}`);

                            // emit an event that we had an error
                            eventHub.emit('moduleStatus', { 
                                name: 'MacrosModule', 
                                status: 'errored',
                                data: `Device reboot command failed with error: ${error}`,
                            });

                            // resolve with the error text
                            resolve(this.rebootCommandResults);
                        } else {
                            // otherwise success, so set this.rebootCommandSuccess to true to indicate that the command was successful
                            this.rebootCommandSuccess = true;

                            // set the rebootCommandResults variable to the success output from console
                            if (stdout.length > 0) {
                                this.rebootCommandResults = stdout;
                            } else {
                                this.rebootCommandResults = stderr;
                            }

                            // log the success
                            logger.info(`Device reboot activated successfully with message: ${this.rebootCommandResults}`);

                            // emit a success event
                            eventHub.emit('moduleStatus', { 
                                name: 'MacrosModule', 
                                status: 'operational',
                                data: `Device reboot activated successfully with message: ${this.rebootCommandResults}`,
                            });

                            // resolve with the success text
                            resolve(`Device reboot activated successfully with message: ${this.rebootCommandResults}`);
                        }
                    });
                } else {
                    // log that we're on laptop mode
                    logger.warn(`Device reboot activated, but LAPTOP_MODE is true!`);

                    // since we're in laptop mode, we'll fake that we completed the reboot successfully
                    this.rebootCommandSuccess = true;
                    this.rebootCommandResults = '-- activated device reboot on laptop --';

                    // resolve with the success text
                    resolve(this.rebootCommandResults);
                }
            } else {
                // otherwise, we don't need to reboot, so ensure that rebootCommandResults is reset
                this.rebootCommandSuccess = false;
                this.rebootCommandResults = '';

                // resolve with a n/a message
                resolve('No reboot queued from server.');
            }
        });
    }


    // handle restart command
    handleRestart() {
        // return a promise
        return new Promise((resolve, reject) => {
            // check if a restart command has been queued from the server
            if (this.restartQueuedFromServer == true) {

                // get the file path for the config.json file
                let configFilePath = configManager.getConfigFilePath();

                // try to remove it and restart pm2
                try {
                    // syncronously remove the 
                    fs.unlinkSync(configFilePath);

                    // restart pm2 asyncronosly after 30 seconds.
                    // this is intended to give the network module a second to let the server know
                    // that the delete config part worked
                    this.restartPm2Async();

                    // set this.restartCommandSuccess to true to indicate that the command was successful
                    this.restartCommandSuccess = true;

                    // set the restartCommandResults variable to a success string
                    this.restartCommandResults = 'config.json successfully deleted and pm2 restart queued for 30 seconds from now!';

                    // log the success
                    logger.info(`config.json successfully deleted and pm2 restart queued for 30 seconds from now!`);

                    // emit a success event
                    eventHub.emit('moduleStatus', { 
                        name: 'MacrosModule', 
                        status: 'operational',
                        data: `config.json successfully deleted and pm2 restart queued for 30 seconds from now!`,
                    });

                    // resolve with the success text
                    resolve(this.restartCommandResults);
                } catch (error) {
                    // else catch any errors with deleting the file or restarting pm2

                    // set the restartCommandSuccess variable to false, since the restart failed
                    this.restartCommandSuccess = false;

                    // set the restartCommandResults variable to the error text
                    if (error.code === 'ENOENT') {
                        this.restartCommandResults = `File not found: ${configFilePath}`;
                    } else {
                        this.restartCommandResults = `An error occurred while deleting ${configFilePath}: ${error}`;
                    }

                    // log the error
                    logger.error(this.restartCommandResults);

                    // emit an event that we had an error
                    eventHub.emit('moduleStatus', { 
                        name: 'MacrosModule', 
                        status: 'errored',
                        data: this.restartCommandResults,
                    });

                    // resolve with the error text
                    resolve(this.restartCommandResults);
                }
            } else {
                // otherwise, we don't need to restart, so ensure that restartCommandResults is reset
                this.restartCommandSuccess = false;
                this.restartCommandResults = '';

                // resolve with a n/a message
                resolve('No restart queued from server.');
            }
        });
    }


    // handle update command
    handleUpdate() {
        // return a promise
        return new Promise((resolve, reject) => {

            // check if an update command has been queued from the server
            if (this.updateQueuedFromServer == true) {

                // log that an update was queued
                logger.info('Update queued from server!');

                // LAUNCH THE UPDATER DETACHED, AND DO NOT WAIT FOR IT.
                //
                // exec() made update.sh a CHILD OF THIS PROCESS. The first thing it does is
                // restart this process. pm2's default kill signal is SIGINT and it kills the
                // whole tree, so every macro-triggered update killed the updater seconds after
                // it installed the files - before the health check, before the rollback could
                // arm, before the build state was written.
                //
                // The files were already in place, so updates appeared to work. They just
                // completed unwatched. That is why the fleet census shows nearly every device
                // reporting "already-current" and almost none reporting "updated": the run that
                // actually installs has never survived to record what it did.
                //
                // detached:true puts the updater in its own session and process group, so a
                // tree kill aimed at this app no longer reaches it. It outlives us, restarts us,
                // watches the result and rolls back if it has to - which is the whole point of
                // having an updater that health checks.
                //
                // We therefore cannot read its output any more, and should not want to: the
                // outcome lands in attitude-build.json, which StatusTracker already reports on
                // the normal status cycle. Waiting for a process whose job is to kill us was
                // never going to work.
                try {
                    const child = spawn('./update.sh', [], {
                        detached: true,
                        stdio: 'ignore',
                        cwd: process.cwd(),
                    });

                    // let it go - without this, node keeps a handle to it and waits
                    child.unref();

                    this.updateCommandSuccess = true;
                    this.updateCommandResults = 'Update launched. This app will be restarted by the updater; the outcome is reported in the build state.';

                    logger.info(this.updateCommandResults);

                    // NOTE: restartPm2Async() is deliberately NOT called here.
                    //
                    // It schedules "sleep 30; pm2 restart all". Until now it never fired,
                    // because the callback it sat in was never reached - the updater killed us
                    // first. Now that the updater survives, it WOULD fire: thirty seconds into
                    // the health check, restarting the app mid-watch, which the watcher would
                    // correctly read as a crash and roll back a perfectly good build.
                    //
                    // update.sh restarts the app itself, at the right moment, and watches what
                    // happens next. Nothing else should be restarting anything.

                    eventHub.emit('moduleStatus', {
                        name: 'MacrosModule',
                        status: 'operational',
                        data: this.updateCommandResults,
                    });

                    resolve(this.updateCommandResults);
                } catch (error) {
                    this.updateCommandSuccess = false;
                    this.updateCommandResults = `An error occurred launching the update: ${error}`;

                    logger.error(this.updateCommandResults);

                    eventHub.emit('moduleStatus', {
                        name: 'MacrosModule',
                        status: 'errored',
                        data: this.updateCommandResults,
                    });

                    resolve(this.updateCommandResults);
                }
            } else {
                // otherwise, we don't need to update, so ensure that updateCommandResults is reset
                this.updateCommandSuccess = false;
                this.updateCommandResults = '';

                // resolve with a n/a message
                resolve('No update queued from server.');
            }
        });
    }



    async restartPm2Async() {
        // Command to async restart PM2 after 30 sec
        const command = 'sleep 30; pm2 restart all';

        // Execute the command
        exec(command, (error, stdout, stderr) => {
            if (error) {
                // log the error
                logger.error(`PM2 restart command failed with error: ${error}`);
            } else {
                // otherwise success

                // the problem here is that this code will never execute,
                // because if the pm2 restart all command is successful
                // then this code will be killed and restarted anyway

                // we'll go ahead and log the success, but this message will probably never be seen by anyone
                logger.info(`PM2 restart command success!`);
            }
        });
    }



    // emit a macros event to the system
    emitMacrosEvent() {
        // check if any macros had been queued from the server
        if (this.rebootQueuedFromServer || this.restartQueuedFromServer || this.updateQueuedFromServer) {

            // log
            if (configManager.checkLogLevel('detail')) {
                logger.info(`At least one macro was queued by the server. Sending macros event with results back to server...`);
            }

            // setup the macros data object
            let macrosData = {
                rebootQueuedFromServer: this.rebootQueuedFromServer,
                rebootCommandSuccess: this.rebootCommandSuccess,
                rebootCommandResults: this.rebootCommandResults,

                restartQueuedFromServer: this.restartQueuedFromServer,
                restartCommandSuccess: this.restartCommandSuccess,
                restartCommandResults: this.restartCommandResults,

                updateQueuedFromServer: this.updateQueuedFromServer,
                updateCommandSuccess: this.updateCommandSuccess,
                updateCommandResults: this.updateCommandResults,
            }

            // log macrosData before sending to network module
            // console.log('macrosData', macrosData);

            // emit a network event to let the server know about the macros statuses
            eventHub.emit('macrosStatus', macrosData);
        }
    }
}



// Create an instance of MacrosModule
const macrosModule = new MacrosModule();

// Export the macrosModule instance for use in other modules
export default macrosModule;
