// StatusTracker.mjs
// status tracking module for the Attitude Control 2.A app
// copyright 2024 Drew Shipps, J Squared Systems


// this module creates a single instance of the StatusTracker javascript object,
// which dynamically tracks the current OS-level system status and sends it to the network module



// import modules
import os from 'os';
import fs from 'fs';
import eventHub from './EventHub.mjs';

import Logger from './Logger.mjs';
const logger = new Logger('StatusTracker');

import configManager from './ConfigManager.mjs';



// variables
const SAMPLE_INTERVAL = 15000;  // interval for how often to check system status (should be 15000ms)



// Define the StatusTracker class
class StatusTracker {

    // constructor
    constructor() {
        // minimum and maximum interval to send a status update
        this.sampleInterval = SAMPLE_INTERVAL;

        // emit an event that the statusTracker is initializing
        eventHub.emit('moduleStatus', { 
            name: 'StatusTracker', 
            status: 'initializing',
            data: '',
        });
    }


    // initialize the sampling process
    init() {
        setInterval(() => {
            // process system status
            this.processSystemStatus();
        }, this.sampleInterval);

        // run once immediately
        this.processSystemStatus();
    }


    // process system status
    processSystemStatus() {
        // wrap the system status processing in a try catch, in case there's errors with os
        try {
            if (configManager.checkLogLevel('interval')) {
                logger.info(`Processing current system status at ${ new Date().toLocaleTimeString() }`);
            }

            // emit an event that the statusTracker is running
            eventHub.emit('moduleStatus', { 
                name: 'StatusTracker', 
                status: 'operational',
                data: '',
            });

            // read CPU frequency, governor and temperature (added 2026-08 to diagnose slow devices)
            const cpuStatus = this.readCpuStatus();

            // create an object with the current system status in it
            const currentSystemStatus = {
                timestamp: new Date(),
                
                platform: os.platform(),
                architecture: os.arch(),
                hostname: os.hostname(),

                cpuCount: os.cpus().length,
                cpuUsage: os.loadavg().map(num => num.toFixed(2)),

                cpuFreqMHz: cpuStatus.cpuFreqMHz,
                cpuFreqMinMHz: cpuStatus.cpuFreqMinMHz,
                cpuFreqMaxMHz: cpuStatus.cpuFreqMaxMHz,
                cpuFreqHwMaxMHz: cpuStatus.cpuFreqHwMaxMHz,
                cpuGovernor: cpuStatus.cpuGovernor,
                cpuTempC: cpuStatus.cpuTempC,

                totalMemory: this.formatBytes(os.totalmem()),
                freeMemory: this.formatBytes(os.freemem()),
                usedMemory: this.formatBytes(os.totalmem() - os.freemem()),

                uptime: this.formatTime(os.uptime()),

                diskUsage: 'unknown',

                networkInterfaces: os.networkInterfaces(),
            };

            // TEMP log the current system status object
            // console.log('currentSystemStatus', currentSystemStatus);

            // console.log('network', currentSystemStatus.networkInterfaces);

            // emit an event that the current system status has been processed
            eventHub.emit('systemStatusUpdate', currentSystemStatus);
        } catch (error) {
            logger.error(`Error processing system status: ${error}`);

            // emit an event that we had an error
            eventHub.emit('moduleStatus', { 
                name: 'StatusTracker', 
                status: 'errored',
                data: `Error processing system status: ${error}`,
            });
        }
    }


    // helper to read a single sysfs value. returns null if the file is missing or unreadable,
    // which is the normal case on macOS during development or on a board without cpufreq exposed.
    readSysfs(path) {
        try {
            return fs.readFileSync(path, 'utf8').trim();
        } catch (error) {
            return null;
        }
    }


    // read CPU frequency, governor and temperature. all values null where unavailable.
    readCpuStatus() {
        const base = '/sys/devices/system/cpu/cpu0/cpufreq/';

        // sysfs reports frequency in kHz and temperature in millidegrees C
        const toMHz = (value) => (value === null ? null : Math.round(Number(value) / 1000));
        const rawTemp = this.readSysfs('/sys/class/thermal/thermal_zone0/temp');

        return {
            cpuFreqMHz: toMHz(this.readSysfs(base + 'scaling_cur_freq')),
            cpuFreqMinMHz: toMHz(this.readSysfs(base + 'scaling_min_freq')),
            cpuFreqMaxMHz: toMHz(this.readSysfs(base + 'scaling_max_freq')),
            cpuFreqHwMaxMHz: toMHz(this.readSysfs(base + 'cpuinfo_max_freq')),
            cpuGovernor: this.readSysfs(base + 'scaling_governor'),
            cpuTempC: (rawTemp === null ? null : Math.round(Number(rawTemp) / 1000)),
        };
    }


    // helper function to return a usable number of bytes
    formatBytes(bytes, decimals = 2) {
        if (bytes === 0) return '0 Bytes';

        const k = 1024;
        const dm = decimals < 0 ? 0 : decimals;
        const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];

        const i = Math.floor(Math.log(bytes) / Math.log(k));

        return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
    }


    // helper function to format time
    formatTime(seconds) {
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const remainingSeconds = Math.floor(seconds % 60);

        if (hours >= 24) {
            const days = Math.floor(hours / 24);
            const formattedDays = String(days).padStart(1, '0');
            const formattedHours = String(hours % 24).padStart(1, '0');
            const formattedMinutes = String(minutes).padStart(1, '0');
            const formattedSeconds = String(remainingSeconds).padStart(1, '0');
            return `${formattedDays}d ${formattedHours}h ${formattedMinutes}m ${formattedSeconds}s`;
        } else {
            const formattedHours = String(hours).padStart(1, '0');
            const formattedMinutes = String(minutes).padStart(1, '0');
            const formattedSeconds = String(remainingSeconds).padStart(1, '0');
            return `${formattedHours}h ${formattedMinutes}m ${formattedSeconds}s`;
        }
    }
}



// Create an instance of StatusTracker
const statusTracker = new StatusTracker();

// Export the statusTracker instance for use in other modules
export default statusTracker;
