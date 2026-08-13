// MacrosModule.mjs
// macro control module for the Attitude Control 2.A app
// copyright 2024 Drew Shipps, J Squared Systems


// this module creates a single instance of the MacrosModule javascript object,
// which handles the reboot, restart, update, and autoupdate controls for the device



// import modules
import { exec, spawn } from 'child_process';
import fs from 'fs';
import eventHub from './EventHub.mjs';

import Logger from './Logger.mjs';
const logger = new Logger('MacrosModule');

import configManager from './ConfigManager.mjs';



// variables
const SAMPLE_INTERVAL = 15000;  // interval for how often to process macros (should be 15000ms)
const LAPTOP_MODE = (process.platform == 'darwin');
const MACROS_PROCESSING_TIMEOUT = 60000;  // should be 60000ms



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
