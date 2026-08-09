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

            // read CPU frequency/governor/temperature and thermal configuration.
            // added 2026-08: field devices were found clamped to 100MHz of 1512MHz capability
            // by thermal throttling at a surprisingly low trip point, which is why they render
            // at 5-20fps instead of 40. These fields identify affected sites from the dashboard.
            const cpuStatus = this.readCpuStatus();
            const thermal = this.readThermalDetail();

            // which build is actually running, and how the last update attempt ended.
            // added 2026-08: with ~200 devices across several build generations there was no
            // way to answer 'what is deployed where', and a silent rollback looked identical
            // to a successful update.
            const firmwareVersion = this.readTextFile('./VERSION');
            const lastUpdate = this.readLastUpdate();

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
                cpuThrottled: (Number.isFinite(cpuStatus.cpuFreqMaxMHz) && Number.isFinite(cpuStatus.cpuFreqHwMaxMHz))
                    ? (cpuStatus.cpuFreqMaxMHz < cpuStatus.cpuFreqHwMaxMHz) : null,

                thermalZone: thermal.zone,
                thermalPolicy: thermal.policy,
                thermalTripPoints: thermal.tripPoints,
                thermalCoolingDevices: thermal.coolingDevices,

                totalMemory: this.formatBytes(os.totalmem()),
                freeMemory: this.formatBytes(os.freemem()),
                usedMemory: this.formatBytes(os.totalmem() - os.freemem()),

                uptime: this.formatTime(os.uptime()),

                diskUsage: 'unknown',

                networkInterfaces: os.networkInterfaces(),

                firmwareVersion: firmwareVersion,
                lastUpdate: lastUpdate,
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
        return this.readTextFile(path);
    }


    // read any small text file, returning a trimmed string or null. Never throws.
    readTextFile(path) {
        try {
            return fs.readFileSync(path, 'utf8').trim();
        } catch (error) {
            return null;
        }
    }


    // read the record update.sh leaves behind. Lives outside the app directory so a
    // rollback's rsync --delete cannot erase the evidence that a rollback happened.
    // Returns null on a device that has never run the new updater.
    readLastUpdate() {
        const raw = this.readTextFile(os.homedir() + '/attitude-build.json');
        if (raw === null) { return null; }

        try {
            return JSON.parse(raw);
        } catch (error) {
            // a truncated or malformed file should not cost us the whole status cycle
            return { outcome: 'unreadable' };
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


    // read the thermal configuration: trip points and cooling device states.
    // this is read-only. we do not attempt to override thermal management - a device
    // throttling at 60C needs cooling, not software arguing with the kernel about it.
    readThermalDetail() {
        const result = { zone: null, policy: null, tripPoints: [], coolingDevices: [] };

        try {
            result.zone = this.readSysfs('/sys/class/thermal/thermal_zone0/type');
            result.policy = this.readSysfs('/sys/class/thermal/thermal_zone0/policy');

            // enumerate trip points until one is missing
            for (let i = 0; i < 8; i++) {
                const rawTemp = this.readSysfs('/sys/class/thermal/thermal_zone0/trip_point_' + i + '_temp');
                if (rawTemp === null) { break; }

                result.tripPoints.push({
                    type: this.readSysfs('/sys/class/thermal/thermal_zone0/trip_point_' + i + '_type'),
                    tempC: Math.round(Number(rawTemp) / 1000),
                });
            }

            // enumerate cooling devices. cur_state above 0 means throttling is actively engaged.
            const entries = fs.readdirSync('/sys/class/thermal');
            entries.filter(name => name.indexOf('cooling_device') === 0).slice(0, 10).forEach(name => {
                const base = '/sys/class/thermal/' + name + '/';

                result.coolingDevices.push({
                    name: name,
                    type: this.readSysfs(base + 'type'),
                    curState: this.readSysfs(base + 'cur_state'),
                    maxState: this.readSysfs(base + 'max_state'),
                });
            });
        } catch (error) {
            // leave whatever was gathered. never let telemetry reading break the status cycle.
        }

        return result;
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
