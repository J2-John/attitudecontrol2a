// Regression tests for the schedule, config and sense defects found on 2026-09-02.
//
// Every case here is a bug that shipped to the fleet and that npm test could not have caught,
// because until now the suite covered the emit subsystem only - nothing exercised the
// scheduler, the config manager or the sense manager at all. Four of the six defects below are
// pure-function bugs that any one of these tests would have caught years ago.
//
// These run the REAL modules. ConfigManager's disk access and the Logger are the only things
// stubbed, because they reach the filesystem; the logic under test is not restated here.
//
//   node --test test/schedule-and-config.test.mjs
//
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const { default: scheduler }    = await import('../AttitudeScheduler.mjs');
const { default: configManager } = await import('../ConfigManager.mjs');
const { default: senseManager }  = await import('../AttitudeSenseManager.mjs');


// ============================================================================================
// layerAnOverride - an override with FEWER groups than the base used to delete the extras
// ============================================================================================
//
// The result was `layer[z].map(...)`, so each zone took the LAYER's group count. Downstream,
// AttitudeFixtureManager resolves a missing group with `?? 0`, and show id 0 renders BLACK.
// Reached whenever an override was authored against a zone that later gained a group - an
// ordinary sequence of events in the web app. The override did not even have to intend a
// change: [0, 0] means "change nothing" and still blacked out half the zone.

test('layerAnOverride keeps base groups the override does not mention', () => {
    const base  = [[11, 12, 13, 14], 5];
    const layer = [[0, 0], 0];

    assert.deepEqual(scheduler.layerAnOverride(base, layer), [[11, 12, 13, 14], 5],
        'groups 3 and 4 must survive an override that only covers groups 1 and 2');
});

test('layerAnOverride still applies the groups the override DOES set', () => {
    const base  = [[11, 12, 13, 14]];
    const layer = [[99, 0]];

    assert.deepEqual(scheduler.layerAnOverride(base, layer), [[99, 12, 13, 14]]);
});

test('layerAnOverride still EXPANDS when the override is wider than the base', () => {
    // the opposite direction is load-bearing and already worked - do not regress it
    assert.deepEqual(scheduler.layerAnOverride([[11, 12]], [[0, 0, 0, 0]]), [[11, 12, 11, 11]]);
    assert.deepEqual(scheduler.layerAnOverride([7], [[0, 0, 0]]), [[7, 7, 7]]);
});

test('layerAnOverride leaves scalar zones alone', () => {
    assert.deepEqual(scheduler.layerAnOverride([4, 5, 6], [0, 9, 0]), [4, 9, 6]);
});


// ============================================================================================
// this.degraded - set in four catch blocks, cleared nowhere
// ============================================================================================
//
// One transient error pinned the scheduler's reported status at 'degraded' for the life of the
// process. A device that recovered an hour ago looked identical on /admin/fleet to one still
// broken, and every genuinely new fault at that site was invisible behind it.

test('degraded clears on a subsequent clean pass', () => {
    scheduler.degraded = true;

    // stub out everything processSchedule calls so we exercise only the flag lifecycle
    const saved = {};
    for (const fn of ['updateScheduleConfigration', 'updateCurrentTime', 'processWeeklySchedule',
                      'processCustomScheduleBlocks', 'processOverrides', 'processWebOverrides',
                      'layerScheduleToCreateFinal']) {
        saved[fn] = scheduler[fn];
        scheduler[fn] = () => {};
    }

    try {
        scheduler.processSchedule();
        assert.equal(scheduler.degraded, false,
            'a clean pass must clear a degraded flag left by an earlier one');
    } finally {
        for (const fn of Object.keys(saved)) { scheduler[fn] = saved[fn]; }
    }
});


// ============================================================================================
// processWebOverrides - one unresolvable override_id used to disable ALL web overrides
// ============================================================================================
//
// The throw escaped the forEach into the function-level catch, which zeroes the entire layer -
// so deleting an override block that a still-active web override referenced silently disabled
// every web override at that location, including the manual-control buttons staff use during a
// service call.

test('one bad web override does not take the good ones with it', () => {
    scheduler.degraded = false;
    scheduler.overrides = [
        { id: 44, showsdata: JSON.stringify([44, 0, 0, 0, 0, 0, 0, 0, 0, 0]) },
    ];
    scheduler.webOverrides = [
        { name: 'good', active: true, override_id: 44 },
        { name: 'points at a deleted block', active: true, override_id: 9999 },
    ];

    scheduler.processWebOverrides();

    assert.equal(scheduler.processedShowIds.webOverrides[0], 44,
        'the resolvable web override must still apply');
    assert.equal(scheduler.degraded, true,
        'the unresolvable row must still be reported, not silently swallowed');
});

test('a web override with no block selected is skipped without failing the pass', () => {
    scheduler.degraded = false;
    scheduler.overrides = [];
    scheduler.webOverrides = [{ name: 'unassigned', active: true, override_id: 0 }];

    scheduler.processWebOverrides();

    assert.deepEqual(scheduler.processedShowIds.webOverrides, new Array(10).fill(0));
    assert.equal(scheduler.degraded, false, 'an unassigned web override is not an error');
});


// ============================================================================================
// ConfigManager - show tables must never reach the SD card
// ============================================================================================
//
// ShowTableStore's header states the rule: "Tables live in memory only. They are never written
// to the SD card. Continuous writing of config.json is the established cause of this fleet's
// card failures." The store honoured it. NetworkModule merged the whole sync reply into the
// config and update() persisted whatever it merged, so the base64 blobs landed on the card and
// - because mergeObjects has no delete path - stayed there for the life of the card.

test('a persisted showTables blob is purged on load', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attcfg-'));
    const file = path.join(dir, 'config.json');

    // simulate a card written by a pre-fix build
    fs.writeFileSync(file, JSON.stringify({
        logLevel: 'minimal',
        shows: [{ id: 1 }],
        showTables: [{ showId: 1, b64: 'AAAA'.repeat(4096) }],
    }, null, 2));

    const savedPath = configManager.filePath;
    configManager.filePath = file;

    try {
        configManager.loadFromFile();

        assert.equal(configManager.config.showTables, undefined,
            'showTables must not survive into the in-memory config');
        assert.deepEqual(configManager.config.shows, [{ id: 1 }],
            'real configuration must be preserved');

        const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
        assert.equal(onDisk.showTables, undefined,
            'the blob must actually leave the card, not just the in-memory copy');
    } finally {
        configManager.filePath = savedPath;
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('getFixtures reports a loaded-but-fixtureless config instead of failing silently', () => {
    // the guard was `!Object.keys(this.config).length === 0`, which is (boolean) === 0 and
    // therefore ALWAYS false - so every fixture at the site froze on its last DMX value with
    // nothing logged anywhere.
    const savedConfig = configManager.config;

    try {
        configManager.config = {};
        assert.deepEqual(configManager.getFixtures(), [],
            'an empty config is "no data yet", not an error');

        configManager.config = { shows: [] };
        assert.deepEqual(configManager.getFixtures(), [],
            'a loaded config with no fixtures still returns an empty list');
    } finally {
        configManager.config = savedConfig;
    }
});


// ============================================================================================
// AttitudeSenseManager - a unit that goes quiet used to latch its ports on forever
// ============================================================================================
//
// mostRecentPacketFromEachSense had no expiry: set, has, get, nothing else. A sense powered
// down or unplugged while a port was asserted kept that port reading active indefinitely, so a
// toggle-mode override stayed layered for days with no way to dislodge it.

test('a stale sense reads as no ports active', () => {
    const id = 4242;
    senseManager.mostRecentPacketFromEachSense.clear();

    senseManager.mostRecentPacketFromEachSense.set(id, {
        ID: id,
        DATA: '1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0',
        receivedAt: Date.now(),
    });

    assert.equal(senseManager.getSensePortDataById(id)[0], 1,
        'a fresh packet must still be served');

    // age it well past the TTL
    senseManager.mostRecentPacketFromEachSense.get(id).receivedAt = Date.now() - (10 * 60 * 1000);

    assert.deepEqual(senseManager.getSensePortDataById(id), Array(16).fill(0),
        'a sense that has gone quiet must read as all ports inactive');
    assert.equal(senseManager.mostRecentPacketFromEachSense.has(id), false,
        'the stale entry is dropped so a returning unit starts clean');
});

test('an unknown sense id still returns sixteen zeroes', () => {
    senseManager.mostRecentPacketFromEachSense.clear();
    assert.deepEqual(senseManager.getSensePortDataById(99999), Array(16).fill(0));
});
