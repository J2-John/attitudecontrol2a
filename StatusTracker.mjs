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

// Kernel-exposed CPU frequency and thermal state. All of these are virtual files - reading
// them costs nothing and touches no storage.
//
// Why this matters: field devices showing 6-9fps were found pinned at 100MHz of a possible
// 1512MHz because the SoC sits above its 60C passive trip point and the kernel clamps
// scaling_max_freq to hold it there. The device looks healthy by every other measure. The
// diagnostic is scaling_max_freq < cpuinfo_max_freq - a software restore is reverted by the
// kernel within seconds, so the fix is physical cooling.
const CPUFREQ_DIR = '/sys/devices/system/cpu/cpu0/cpufreq';
const THERMAL_ZONE = '/sys/class/thermal/thermal_zone0';
const COOLING_DEVICE = '/sys/class/thermal/cooling_device0';



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

            // create an object with the current system status in it
            const currentSystemStatus = {
                timestamp: new Date(),
                
                platform: os.platform(),
                architecture: os.arch(),
                hostname: os.hostname(),

                cpuCount: os.cpus().length,
                cpuUsage: os.loadavg().map(num => num.toFixed(2)),

                totalMemory: this.formatBytes(os.totalmem()),
                freeMemory: this.formatBytes(os.freemem()),
                usedMemory: this.formatBytes(os.totalmem() - os.freemem()),

                uptime: this.formatTime(os.uptime()),

                diskUsage: 'unknown',

                networkInterfaces: os.networkInterfaces(),

                ...this.getCpuStatus(),
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


    // read a sysfs file, returning a trimmed string or null. Never throws: these paths differ
    // between kernels and boards, and a missing file must not take down status reporting.
    readSysfs(path) {
        try {
            return fs.readFileSync(path, 'utf8').trim();
        } catch (error) {
            return null;
        }
    }


    // same, parsed as an integer, or null
    readSysfsInt(path) {
        const raw = this.readSysfs(path);
        if (raw === null) { return null; }

        const value = parseInt(raw, 10);
        return Number.isNaN(value) ? null : value;
    }


    // collect CPU frequency and thermal state. Returns an object of nulls on a board that
    // does not expose these, rather than failing.
    getCpuStatus() {
        try {
            // cpufreq reports kHz
            const curKHz = this.readSysfsInt(`${CPUFREQ_DIR}/scaling_cur_freq`);
            const minKHz = this.readSysfsInt(`${CPUFREQ_DIR}/scaling_min_freq`);
            const maxKHz = this.readSysfsInt(`${CPUFREQ_DIR}/scaling_max_freq`);
            const hwMaxKHz = this.readSysfsInt(`${CPUFREQ_DIR}/cpuinfo_max_freq`);

            // thermal zone reports millidegrees C
            const tempMilliC = this.readSysfsInt(`${THERMAL_ZONE}/temp`);

            const toMHz = (kHz) => (kHz === null ? null : Math.round(kHz / 1000));

            const cpuFreqMaxMHz = toMHz(maxKHz);
            const cpuFreqHwMaxMHz = toMHz(hwMaxKHz);

            return {
                cpuFreqMHz: toMHz(curKHz),
                cpuFreqMinMHz: toMHz(minKHz),
                cpuFreqMaxMHz: cpuFreqMaxMHz,
                cpuFreqHwMaxMHz: cpuFreqHwMaxMHz,
                cpuGovernor: this.readSysfs(`${CPUFREQ_DIR}/scaling_governor`),

                cpuTempC: tempMilliC === null ? null : Math.round(tempMilliC / 100) / 10,

                // the single most useful field: true means the kernel has capped this CPU
                // below what the hardware can do, which on this board means thermal throttling
                cpuThrottled: (cpuFreqMaxMHz !== null && cpuFreqHwMaxMHz !== null)
                    ? (cpuFreqMaxMHz < cpuFreqHwMaxMHz)
                    : null,

                // how hard the cooling policy is currently pushing. curState at maxState means
                // the kernel has run out of room and is holding the clock at its floor.
                coolingType: this.readSysfs(`${COOLING_DEVICE}/type`),
                coolingState: this.readSysfsInt(`${COOLING_DEVICE}/cur_state`),
                coolingMaxState: this.readSysfsInt(`${COOLING_DEVICE}/max_state`),
            };
        } catch (error) {
            // status reporting is more important than these extras
            return {};
        }
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
