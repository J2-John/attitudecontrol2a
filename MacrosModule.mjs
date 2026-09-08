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

// How long to wait before restarting pm2, and how hard to try.
//
// The delay gives the network module time to tell the server that the config delete worked
// before this process disappears. 30 s against a 1 Hz sync is very generous, and it is left
// alone: shortening it is unnecessary risk on the fleet's only remote-restart path.
//
// The attempts exist because the first pm2 restart is documented to fail - see the comment on
// restartPm2Async. update.sh uses three; matching it keeps one number to reason about.
const PM2_RESTART_DELAY_SECONDS = 30;
const PM2_RESTART_ATTEMPTS = 3;
const PM2_RESTART_ATTEMPT_LIST = '1 2 3';   // literal, not $(seq) - see pm2RestartCommand
const PM2_RESTART_RETRY_SECONDS = 5;
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

        // Set when a pm2 restart fails after all its attempts, and never cleared by this
        // process: the only thing that resolves it is the restart finally happening, which kills
        // the process. See restartPm2Async.
        this.restartFailure = null;

        this.rebootCommandResults = '';

        // Seams, not configuration. Production never changes either of these; they exist so a
        // test can execute THIS method rather than a restatement of it. The previous tests for
        // the macro handlers passed on Windows precisely because nothing there could launch a
        // shell, which is how seven of them came to prove nothing.
        this.execCommand = exec;
        // A LITERAL LIST, NOT $(seq). update.sh uses `for restart_attempt in 1 2 3` and that is
        // not a stylistic choice: on a /bin/sh without seq the command substitution yields
        // nothing, the loop body runs ZERO times, and the script falls straight to `exit 1` -
        // byte-identical to three genuine pm2 failures, with the only evidence on stderr, which
        // the callback ignored. Reproduced on dash: `sh: 1: seq: not found`, exit 1, pm2 never
        // invoked. The fleet's only remote-restart path would silently do nothing while
        // reporting a failure that implies pm2 was tried.
        this.pm2RestartCommand = 'sleep ' + PM2_RESTART_DELAY_SECONDS + '; '
            + 'for i in ' + PM2_RESTART_ATTEMPT_LIST + '; do '
            + 'pm2 restart all && exit 0; '
            + 'sleep ' + PM2_RESTART_RETRY_SECONDS + '; '
            + 'done; exit 1';
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


    // Should cycle 2 run here, and why?
    //
    // Split out from the launching so the DECISION can be tested on any
    // platform. The launch cannot: it spawns a bash script that only exists on
    // a device. Left inside one method, the whole thing was untestable
    // anywhere but Linux - and worse, on Windows every "it must not launch"
    // assertion passed because nothing there can launch, which is a vacuous
    // pass rather than a skip.
    //
    // Returns { go, reason, warn }. `reason` is the sentence a person needs
    // when they are looking at a box that is not doing what they expected.
    bootstrapDecision() {
        const home = os.homedir();
        const updater = path.join(process.cwd(), 'update.sh');

        // 1. The real updater has already run here and recorded what it did.
        //    Nothing to bootstrap, now or ever - whatever the outcome was.
        //    Re-running it because we did not like the answer is a rollback loop.
        if (fs.existsSync(path.join(home, BUILD_STATE_FILE))) {
            return { go: false, reason: 'the validating updater has already run here' };
        }

        // 2. Is the updater on disk one we can trust to be honest? On a box
        //    where cycle 1 has not happened yet this is still the old script,
        //    and launching THAT would just produce another cheerful lie - and,
        //    worse, a restart 30 seconds later for nothing.
        const api = this.readUpdaterApi(updater);
        if (api === null) {
            return { go: false, warn: true,
                reason: 'No update.sh found - this device cannot update itself.' };
        }
        if (api < LEGACY_BOOTSTRAP_MIN_API) {
            return { go: false, warn: true,
                reason: `This device still has the legacy updater (API ${api}). It will be `
                    + `replaced the first time an update is flagged from the server; nothing `
                    + `can be verified here until then.` };
        }

        // 3. Attempt cap. If update.sh dies without writing a build state -
        //    killed, out of disk, no network - check 1 stays false forever, and
        //    without this we would relaunch it on every boot.
        const state = this.readBootstrapState(path.join(home, BOOTSTRAP_STATE_FILE));
        const attempts = Number(state.attempts) || 0;
        const since = Date.now() - (Number(state.lastAttempt) || 0);
        if (attempts >= LEGACY_BOOTSTRAP_MAX_ATTEMPTS) {
            return { go: false,
                reason: `gave up after ${attempts} attempts to run the validating updater` };
        }
        if (attempts > 0 && since < LEGACY_BOOTSTRAP_RETRY_MS) {
            return { go: false, reason: 'a recent attempt has not aged out yet' };
        }

        return { go: true, api, attempts,
            reason: `never run the validating updater (API ${api})` };
    }


    // Cycle 2. Runs at most once on a device that has never run the real
    // updater, and never again after that updater has written a build state.
    bootstrapLegacyUpdater() {
        try {
            const home = os.homedir();
            const bootstrapState = path.join(home, BOOTSTRAP_STATE_FILE);
            const updater = path.join(process.cwd(), 'update.sh');

            const decision = this.bootstrapDecision();
            if (!decision.go) {
                if (decision.warn) logger.warn(decision.reason);
                return;
            }
            const { api, attempts } = decision;

            // PRE-FLIGHT BEFORE THE ATTEMPT IS RECORDED.
            //
            // The attempt has to be written before the spawn - the updater restarts us - which
            // means an updater that cannot launch at all still consumes one of
            // LEGACY_BOOTSTRAP_MAX_ATTEMPTS. On a worn card that is three attempts across two
            // retry windows and then a permanent "gave up", with no verified build record ever.
            // Checking first costs nothing and keeps the budget for attempts that could work.
            //
            // The chmod is hoisted above this for the same reason it exists below: a lost
            // executable bit should be repaired, not counted as a failure.
            try { fs.chmodSync(updater, 0o755); } catch (error) { /* not fatal */ }

            try {
                fs.accessSync(updater, fs.constants.X_OK);
            } catch (error) {
                logger.error(`Cannot launch the updater for the legacy bootstrap: ${updater} is `
                    + `missing or not executable (${error.code ?? error.message}). Not counting `
                    + `this as an attempt.`);
                return;
            }

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

            // (the defensive chmod is now hoisted above the attempt write - see the
            // pre-flight note there. rsync from a zip should preserve the executable bit, but a
            // device that cannot run its own updater is not a failure worth inheriting from an
            // archive's metadata.)

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

            // spawn reports a failure to LAUNCH - not executable, not found -
            // as an asynchronous 'error' event, and a ChildProcess with no
            // listener for it throws that error globally. The try/catch around
            // this block cannot catch it, because by then we have returned. On
            // a device whose update.sh lost its executable bit that would take
            // the whole app down, which is a much worse outcome than not
            // updating.
            child.on('error', (err) => {
                logger.error(`Could not launch the updater: ${err}. This device will `
                    + `not have a verified build record until an update is flagged.`);
            });

            // let it go - without this, node keeps a handle to it and waits
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
        //
        // The handle is kept so the loser of the race can be cancelled. Promise.race settles on
        // the first promise but does not cancel the others, so every macro cycle used to leave a
        // 60s timer pending - and processMacros runs every 15s, so up to four of them were alive
        // at once, each holding a closure and keeping the event loop busy long after the work
        // finished. Harmless in production, but it is a leak, and it made any test that drives
        // processMacros hang for a full minute after it had already passed.
        let timeoutHandle = null;
        const timeoutPromise = new Promise((_, reject) => {
            timeoutHandle = setTimeout(() => {
                reject(new Error(`Timeout: Macro execution took longer than ${MACROS_PROCESSING_TIMEOUT}ms`));
            }, MACROS_PROCESSING_TIMEOUT); // timout length
        });

        const clearMacroTimeout = () => {
            if (timeoutHandle) { clearTimeout(timeoutHandle); timeoutHandle = null; }
        };


        // RETURNED, so a caller can await the cycle. init() drives this from a setInterval and
        // ignores the result, which is why it was never returned - but a test that cannot await
        // it has to re-emit the completion event by hand, and a test that re-emits by hand
        // passes even when the code it is checking is wrong. That escaped a mutation run.
        return Promise.race([
            Promise.all([this.handleReboot(), this.handleRestart(), this.handleUpdate()]), // race these three promises 
            timeoutPromise // with the timeout promise
        ])
        .then((results) => {
            clearMacroTimeout();

            // log success
            if (configManager.checkLogLevel('detail')) {
                logger.info(`Completed processing device macros!`);
            }

            // emit an event that the MacrosModule finished
            //
            // An outstanding restart failure OUTRANKS this. The restart is attempted ~40 s after
            // the macro completes, so by the time it fails this handler has already reported
            // 'operational' - and would do so again every 15 s, erasing the failure from the one
            // status the tracker keeps. A device that deleted its config.json and never restarted
            // must not read as healthy.
            eventHub.emit('moduleStatus', {
                name: 'MacrosModule',
                status: this.restartFailure ? 'errored' : 'operational',
                data: this.restartFailure || 'Completed processing device macros!',
            });

            // emit macros event, to send completed data back to server
            this.emitMacrosEvent();
        })
        .catch((error) => {
            clearMacroTimeout();

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

                    // WHAT THIS FLAG ATTESTS, precisely: config.json was deleted. It does NOT
                    // attest that pm2 restarted - that has not been attempted yet and will not
                    // be for another 30 seconds.
                    //
                    // Reporting success here is nonetheless the RIGHT direction, and the reason
                    // is worth writing down because the instinct is to "fix" it the other way.
                    // The server flag is `deleteconfig`, and the delete has genuinely happened
                    // and is durable. Consider the alternative: report failure, and if the
                    // restart then succeeds, this process dies mid-report, the flag stays set,
                    // and on the next cycle the device deletes its config and restarts AGAIN -
                    // a restart loop on the fleet's only remote-restart path. A wrongly-withheld
                    // success costs one stale in-memory config until something restarts the
                    // device; a wrongly-reported failure costs a loop. Same asymmetry the update
                    // guard reasons from.
                    //
                    // The restart's own outcome therefore needs its own channel, and it has one:
                    // restartPm2Async reports a failure on `moduleStatus`, which is emitted every
                    // cycle regardless of whether any macro is still queued. See that method.
                    this.restartCommandSuccess = true;

                    // Says "queued", not "restarted" - the string was already honest, and stays
                    // that way. Only the number is now derived from the constant.
                    this.restartCommandResults = 'config.json successfully deleted and pm2 restart '
                        + 'queued for ' + PM2_RESTART_DELAY_SECONDS + ' seconds from now!';

                    // log the success
                    logger.info(this.restartCommandResults);

                    // emit a success event
                    eventHub.emit('moduleStatus', {
                        name: 'MacrosModule',
                        status: 'operational',
                        data: this.restartCommandResults,
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
                // PRE-FLIGHT, AND IT HAS TO BE SYNCHRONOUS.
                //
                // spawn() does NOT throw for a missing or non-executable update.sh. It reports
                // that asynchronously, as an 'error' event - verified: spawn('./update.sh') in a
                // directory with no update.sh returns a ChildProcess without throwing, and the
                // ENOENT arrives on a later tick. The try/catch below cannot see it.
                //
                // Two consequences, and both are the failure this fleet cannot afford:
                //
                //   1. updateCommandSuccess was set TRUE, so macrosStatus told the server the
                //      update had succeeded and the server CLEARED THE UPDATE FLAG - with no
                //      updater having run. The device stays on its old firmware, the server
                //      believes it updated, and the flag that is the only channel to that device
                //      has been spent. That is a site visit.
                //   2. A ChildProcess 'error' with no listener is an uncaught exception. The app
                //      goes down.
                //
                // The bootstrap path in this same file already guards both - it chmods the
                // updater and registers an 'error' listener, with a comment explaining exactly
                // this hazard. That was added in 2.A.19 and never carried across to here, which
                // is the drift class this review keeps finding, this time inside one file.
                //
                // The synchronous check is the load-bearing half: handleUpdate() resolves
                // immediately and emitMacrosEvent() runs on the next microtask, so an async
                // 'error' arrives too late to correct what was already reported. Only a check
                // made BEFORE the spawn can keep the flag.
                const updater = path.join(process.cwd(), 'update.sh');

                // rsync from a zip should preserve the executable bit, but a device that cannot
                // run its own updater is not a failure worth inheriting from archive metadata.
                // Same defence, same reasoning, as the bootstrap path.
                try { fs.chmodSync(updater, 0o755); } catch (error) { /* not fatal */ }

                try {
                    fs.accessSync(updater, fs.constants.X_OK);
                } catch (error) {
                    this.updateCommandSuccess = false;
                    this.updateCommandResults = `Cannot launch the updater: ${updater} is missing `
                        + `or not executable (${error.code ?? error.message}). The update flag is `
                        + `deliberately NOT acknowledged, so the server keeps it and this device `
                        + `can retry once the updater is restored.`;

                    logger.error(this.updateCommandResults);

                    eventHub.emit('moduleStatus', {
                        name: 'MacrosModule',
                        status: 'errored',
                        data: this.updateCommandResults,
                    });

                    resolve(this.updateCommandResults);
                    return;
                }

                try {
                    const child = spawn('./update.sh', [], {
                        detached: true,
                        stdio: 'ignore',
                        cwd: process.cwd(),
                    });

                    // RESOLVE FROM THE EVENTS, NOT FROM spawn() RETURNING.
                    //
                    // spawn() returning a ChildProcess means nothing about whether the updater
                    // launched. Exactly one of 'spawn' and 'error' always follows, on a later
                    // tick, and that is the only place the outcome is actually known.
                    //
                    // An earlier version of this fix set updateCommandSuccess = true here and
                    // corrected it from an 'error' listener. That was WORSE THAN THE BUG IT
                    // REPLACED, and the ordering is why: handleUpdate() resolves immediately,
                    // emitMacrosEvent() runs on the next microtask, and the 'error' event lands
                    // after it. So macrosStatus reported success, the server cleared the update
                    // flag, and the correction was never sent - emitMacrosEvent() only emits
                    // when a macro is queued, and by then the flag was gone. Measured across
                    // three real cycles: reported true, then silence.
                    //
                    // Before that version, the same input threw an uncaught exception. The
                    // macrosStatus payload was only ENQUEUED and drains on the ~1s sync, so the
                    // pm2 restart discarded it and the flag survived. Accidentally safe. Turning
                    // that into a cleared flag would have stranded the device.
                    //
                    // 'spawn' has been emitted since Node 15.1; the fleet runs 16.20.2.
                    let settled = false;

                    child.once('spawn', () => {
                        if (settled) { return; }
                        settled = true;

                        // let it go - without this, node keeps a handle to it and waits
                        child.unref();

                        this.updateCommandSuccess = true;
                        this.updateCommandResults = 'Update launched. This app will be restarted by the updater; the outcome is reported in the build state.';

                        logger.info(this.updateCommandResults);

                        eventHub.emit('moduleStatus', {
                            name: 'MacrosModule',
                            status: 'operational',
                            data: this.updateCommandResults,
                        });

                        resolve(this.updateCommandResults);
                    });

                    // Never absent, for two reasons. A ChildProcess 'error' with no listener is
                    // an uncaught exception, so the crash would land on the device that most
                    // needs to stay up to receive its next flag. And this is the only signal
                    // that distinguishes a launch from a failure to launch - the pre-flight
                    // above cannot see a corrupt update.sh, because access(X_OK) tests the
                    // permission bits while the kernel resolves the shebang only at exec.
                    child.once('error', (err) => {
                        if (settled) { return; }
                        settled = true;

                        this.updateCommandSuccess = false;
                        this.updateCommandResults = `The updater failed to launch: ${err}. The `
                            + `update flag is deliberately NOT acknowledged, so the server keeps `
                            + `it and this device can retry.`;

                        logger.error(this.updateCommandResults);

                        eventHub.emit('moduleStatus', {
                            name: 'MacrosModule',
                            status: 'errored',
                            data: this.updateCommandResults,
                        });

                        resolve(this.updateCommandResults);
                    });

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



    // restartPm2Async - the restart half of the delete-config-and-restart macro.
    //
    // WHAT THIS FIXES
    //
    // The old form was `sleep 30; pm2 restart all`, fired once, with a callback that only
    // logged. Three things followed from that, and the third is the one that matters:
    //
    //   1. ONE ATTEMPT, on a call that is documented to fail on its first try. From
    //      INCIDENT-update-flag-lost-between-syncs, observed two devices out of two:
    //        AC-0020151  18:25:11  pm2 restart attempt 1 of 3 failed  -> succeeded 18 min later
    //        AC-0020140  19:08:23  pm2 restart attempt 1 of 3 failed  -> succeeded 22 s later
    //      Those lines come from update.sh, which retries three times and therefore recovers.
    //      This path had no retry at all, so the same first-attempt failure simply meant the
    //      device never restarted. The incident doc calls this "the most valuable unexplained
    //      thing left"; it is still unexplained, and retrying is what update.sh does about it.
    //
    //   2. NOTHING RECORDED THE OUTCOME. The callback logged to the device's own log, which is
    //      only useful to someone already looking at that device.
    //
    //   3. A FAILURE WAS STRUCTURALLY UNREPORTABLE - the same trap as the updater-launch defect
    //      fixed in batch 5. handleRestart() reports success as soon as config.json is deleted,
    //      the server clears `deleteconfig`, so `restartQueuedFromServer` is false by the time
    //      this callback fires ~30 s later - and emitMacrosEvent() only emits while a macro is
    //      queued. So the correction had no channel to travel on. It still does not, which is
    //      why the failure now goes out on `moduleStatus` instead: that stream is emitted every
    //      cycle regardless of any macro flag, so it is the one channel still open.
    //
    // The 30-second delay and `pm2 restart all` are both unchanged, deliberately - see the
    // note at the end of this comment.
    //
    // The retry loop stays inside the shell rather than becoming JS timers. That survives a bare
    // parent exit - the child holds the sleep - but NOT a process-group kill, and pm2's default
    // kill signal is SIGINT delivered to the whole tree, which handleUpdate's comment two hundred
    // lines above already says. Demonstrated: exec() does not detach, parent and child share a
    // pgid, and a group signal takes both. So this is a weak property, not the guarantee an
    // earlier version of this comment claimed. The reason to keep the loop in the shell is
    // simplicity; the reason to keep it at all is the documented first-attempt failure.
    async restartPm2Async() {
        const command = this.pm2RestartCommand;

        return new Promise((resolve) => {
            this.execCommand(command, (error, stdout, stderr) => {
                if (error) {
                    // stderr is the ONLY thing that separates "pm2 failed three times" from "the
                    // shell could not run the loop at all". It was captured and discarded.
                    const detail = (stderr && String(stderr).trim())
                        ? ` (stderr: ${String(stderr).trim().slice(0, 200)})`
                        : '';

                    this.restartCommandResults = `config.json was deleted, but the pm2 restart `
                        + `failed after up to ${PM2_RESTART_ATTEMPTS} attempts: ${error.message}`
                        + detail;

                    logger.error(this.restartCommandResults);

                    // The macro channel is gone by now (see 3 above). moduleStatus is not.
                    eventHub.emit('moduleStatus', {
                        name: 'MacrosModule',
                        status: 'errored',
                        data: this.restartCommandResults,
                    });

                    // STICKY. ModuleStatusTracker keeps ONE status per module name, and
                    // processMacros emits 'operational' on completion every 15 s - so this
                    // errored status was overwritten before a network send could carry it,
                    // roughly half the time. The comment claiming moduleStatus is "the one
                    // channel still open" was only true for the instant it was emitted.
                    this.restartFailure = this.restartCommandResults;

                    resolve(false);
                } else {
                    // Usually never reached: a successful `pm2 restart` kills this process
                    // before the callback can run. Its absence is not evidence of failure,
                    // which is exactly why the failure branch above has to be the loud one.
                    logger.info('PM2 restart command success!');

                    resolve(true);
                }
            });
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
