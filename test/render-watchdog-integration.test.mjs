// The watchdog, driven through the REAL AttitudeFixtureManager.
//
// The unit tests in render-watchdog.test.mjs exercise the watchdog's logic by calling its
// accounting methods directly. Every one of them would still pass if the watchdog were never
// wired into the fixture manager at all - which is exactly the failure mode the batch-4 review
// found in the gateway suite, where a test file restated the handler and stayed green after the
// fix it protected was deleted.
//
// So this file does not call the watchdog. It calls fixtureManager.processFixtures() against
// stubbed config and a stubbed sACN, breaks the render path in each of the three known ways, and
// asks the watchdog what it saw.
//
//   node --test test/render-watchdog-integration.test.mjs
//
import test from 'node:test';
import assert from 'node:assert/strict';

const { default: fixtureManager } = await import('../AttitudeFixtureManager.mjs');
const { default: configManager }  = await import('../ConfigManager.mjs');
const { default: scheduler }      = await import('../AttitudeScheduler.mjs');
const { default: attitudeSACN }   = await import('../AttitudeSACN2A.mjs');
const { default: renderWatchdog, FROZEN_AFTER_MS } = await import('../RenderWatchdog.mjs');


// ---- a minimal but real patch: one zone, one group, four RGB fixtures ----
//
// These shapes are the ones the real code reads, not invented ones: fixtures are matched on
// zoneNumber/groupNumber, the fixture TYPE carries the colour mode and channel count, zone.groups
// is an array, and a show is only configured natively when engineVersion is '2A'. Getting any of
// them wrong makes processFixtures emit 'degraded' and write nothing - which is how the first
// version of this file "passed" its route tests for the wrong reason.

const FIXTURE_TYPES = [
    { id: 1, channels: 3, segments: 1, color: 'RGB', multicountonefixture: false },
];

const FIXTURES = [
    { id: 1, zoneNumber: 1, groupNumber: 1, type: 1, universe: 1, startAddress: 1,  quantity: 1 },
    { id: 2, zoneNumber: 1, groupNumber: 1, type: 1, universe: 1, startAddress: 4,  quantity: 1 },
    { id: 3, zoneNumber: 1, groupNumber: 1, type: 1, universe: 1, startAddress: 7,  quantity: 1 },
    { id: 4, zoneNumber: 1, groupNumber: 1, type: 1, universe: 1, startAddress: 10, quantity: 1 },
];

const SHOWS = [{
    id: 1, name: 'Test Static', engineVersion: '2A',
    showType: 'Static', direction: 'Left to Right',
    speed: 50, size: 50, splits: 1,
    transition: 'Both Edges', transitionWidth: 1, bounce: false,
    colors: [{ red: 255, green: 0, blue: 0 }],
}];

let assigned = true;
let dmxWrites = 0;
const saved = {};

function install() {
    saved.getZones      = configManager.getZones;
    saved.getFixtures   = configManager.getFixtures;
    saved.getShows      = configManager.getShows;
    saved.getTypes      = configManager.getFixtureTypes;
    saved.getAssigned   = configManager.getAssignedToLocation;
    saved.getFinal      = scheduler.getFinalSchedule;
    saved.set           = attitudeSACN.set;
    saved.universes     = attitudeSACN.universes;

    configManager.getZones              = () => [{ id: 1, groups: [{ id: 1 }] }];
    configManager.getFixtures           = () => FIXTURES;
    configManager.getShows              = () => SHOWS;
    configManager.getFixtureTypes       = () => FIXTURE_TYPES;
    configManager.getAssignedToLocation = () => assigned;
    scheduler.getFinalSchedule          = () => [[1]];

    attitudeSACN.universes = 1;
    attitudeSACN.set = () => { dmxWrites++; };
}

function restore() {
    configManager.getZones              = saved.getZones;
    configManager.getFixtures           = saved.getFixtures;
    configManager.getShows              = saved.getShows;
    configManager.getFixtureTypes       = saved.getTypes;
    configManager.getAssignedToLocation = saved.getAssigned;
    scheduler.getFinalSchedule          = saved.getFinal;
    attitudeSACN.set                    = saved.set;
    attitudeSACN.universes              = saved.universes;
}

function resetWatchdog() {
    renderWatchdog.lastLiveFrameAt = null;
    renderWatchdog.frozen = false;
    renderWatchdog.freezeEvents = 0;
    renderWatchdog.segmentsExpected = 0;
    renderWatchdog.segmentsCovered = 0;
    renderWatchdog.faultedShows.clear();
    renderWatchdog.zoneFaults = 0;
    renderWatchdog.frameOpen = false;
}

test.beforeEach(() => {
    assigned = true;
    dmxWrites = 0;

    // The fixture manager is a singleton and its engines outlive a test. Without this, a test
    // that breaks an engine to simulate a fault leaves it broken for every test after it - which
    // is how the route-1 test started failing for a reason that had nothing to do with route 1.
    fixtureManager.engineInstances = [];

    resetWatchdog();
    install();
});
test.afterEach(restore);


test('a healthy device rendering a real show records live frames', () => {
    for (let i = 0; i < 20; i++) { fixtureManager.processFixtures(); }

    assert.ok(dmxWrites > 0, 'the stub really was driven - DMX writes happened');
    assert.notEqual(renderWatchdog.lastLiveFrameAt, null,
        'processFixtures must record a live frame; if this is null the watchdog is not wired in');
    assert.equal(renderWatchdog.check(Date.now()).frozen, false);
    assert.ok(renderWatchdog.segmentsExpected > 0, 'segments were accounted for');
    assert.equal(renderWatchdog.segmentsCovered, renderWatchdog.segmentsExpected,
        'and every one of them reached a DMX write');
});


test('an UNASSIGNED device records live frames', () => {
    assigned = false;
    for (let i = 0; i < 5; i++) { fixtureManager.processFixtures(); }

    assert.notEqual(renderWatchdog.lastLiveFrameAt, null,
        'an unassigned device outputs white deliberately and must not read as frozen');
    assert.equal(renderWatchdog.check(Date.now()).frozen, false);
});


test('COMMISSIONING, END TO END: assigned with no fixtures yet is live, not frozen', () => {
    // The false positive a review found and no test covered. A box that has just been assigned
    // to a location, before its fixtures are entered, expects zero segments - and an earlier
    // version of endFrame() called that not-live, so it read as frozen five seconds later and
    // stayed that way. Reached again by any site mid-re-patch.
    configManager.getFixtures = () => [];

    for (let i = 0; i < 20; i++) { fixtureManager.processFixtures(); }

    assert.notEqual(renderWatchdog.lastLiveFrameAt, null,
        'a device with nothing patched has no output to freeze');
    assert.equal(renderWatchdog.check(Date.now()).frozen, false);
});


test('COMMISSIONING, END TO END: the unassigned -> assigned transition stays live throughout', () => {
    // The full sequence, in order: an unassigned box goes live via coverWholeFrame(), is then
    // assigned to a location whose fixtures have not been entered, and must remain live across
    // the transition rather than being reported frozen the moment it is commissioned.
    assigned = false;
    for (let i = 0; i < 5; i++) { fixtureManager.processFixtures(); }
    const whileUnassigned = renderWatchdog.lastLiveFrameAt;
    assert.notEqual(whileUnassigned, null, 'unassigned is live');

    assigned = true;
    configManager.getFixtures = () => [];
    for (let i = 0; i < 20; i++) { fixtureManager.processFixtures(); }

    assert.notEqual(renderWatchdog.lastLiveFrameAt, whileUnassigned,
        'frames kept being counted live across the transition');
    assert.equal(renderWatchdog.check(Date.now()).frozen, false);
});


test('a device whose CONFIG HANDLING throws every frame is frozen, not live', () => {
    // The outer catch. Nothing is ever registered, so this frame reaches endFrame with zero
    // expected segments - identical, on that number alone, to a device with nothing patched.
    // Without the zone-fault counter the two are indistinguishable and this device would report
    // healthy forever while rendering nothing.
    configManager.getZones = () => { throw new Error('config is malformed'); };

    for (let i = 0; i < 20; i++) { fixtureManager.processFixtures(); }

    assert.equal(renderWatchdog.lastLiveFrameAt, null, 'not one live frame');
    assert.ok(renderWatchdog.zoneFaults > 0, 'the fault was recorded');
});


test('a config with NO FIXTURES KEY at all is frozen, not live', () => {
    // ConfigManager documents this as a real occurrence. `this.fixtures` is undefined, so the
    // per-group filter throws before applyShowToFixtures is reached - which means it throws
    // before any segment is registered, and again lands on zero expected.
    configManager.getFixtures = () => undefined;

    for (let i = 0; i < 20; i++) { fixtureManager.processFixtures(); }

    assert.equal(renderWatchdog.lastLiveFrameAt, null,
        'a device that cannot read its own patch is not rendering');
    assert.ok(renderWatchdog.zoneFaults > 0);
});


test('ROUTE 3, END TO END: a swallowed engine fault is seen through processFixtures', () => {
    // The hardest of the three, because every segment still gets written - from last frame's
    // pixels. Corrupt the show type so the real engine's run() throws and swallows it.
    fixtureManager.processFixtures();
    const liveAt = renderWatchdog.lastLiveFrameAt;
    assert.notEqual(liveAt, null, 'a healthy frame first');

    // Make the REAL run() throw and catch its own throw, by breaking the effect function it
    // dispatches to. Corrupting engine.config directly does not work - processEngineInstances
    // reconfigures every engine from the show on every frame, so the corruption is undone before
    // the next run(). That mistake made this test pass for the wrong reason on its first draft.
    for (const inst of fixtureManager.engineInstances) {
        inst.engine.calculateStaticEffect = () => { throw new Error('engine blew up'); };
    }

    const writesBefore = dmxWrites;
    for (let i = 0; i < 20; i++) { fixtureManager.processFixtures(); }

    // The device is NOT silent - this is the whole point of the defect.
    assert.ok(dmxWrites > writesBefore,
        'the device keeps writing DMX at full rate while frozen, which is why it looks healthy');

    assert.equal(renderWatchdog.lastLiveFrameAt, liveAt,
        'but not one of those frames counted as live');
    assert.ok(renderWatchdog.faultedShows.size > 0, 'and the engine fault was recorded');
});


test('ROUTE 2, END TO END: a zone that throws leaves the frame uncovered', () => {
    fixtureManager.processFixtures();
    const liveAt = renderWatchdog.lastLiveFrameAt;

    // Fail part-way through the segment loop, exactly as a bad colorMode or a NaN address does.
    let n = 0;
    attitudeSACN.set = () => { n++; if (n > 4) { throw new Error('sACN write failed'); } };

    for (let i = 0; i < 20; i++) { fixtureManager.processFixtures(); }

    assert.equal(renderWatchdog.lastLiveFrameAt, liveAt,
        'a frame that abandoned half its patch is not a live frame');
});


test('ROUTE 1, END TO END: no frames at all is frozen after the threshold', () => {
    fixtureManager.processFixtures();
    const liveAt = renderWatchdog.lastLiveFrameAt;
    assert.notEqual(liveAt, null);

    // processFixtures is simply never called again.
    assert.equal(renderWatchdog.check(liveAt + FROZEN_AFTER_MS + 1).frozen, true);
});


test('recovery: the device is live again on the first good frame', () => {
    for (const inst of fixtureManager.engineInstances) {
        inst.engine.calculateStaticEffect = () => { throw new Error('engine blew up'); };
    }
    for (let i = 0; i < 5; i++) { fixtureManager.processFixtures(); }

    // Force a rebuild of the engines from the real show config.
    fixtureManager.engineInstances = [];
    fixtureManager.processFixtures();

    assert.notEqual(renderWatchdog.lastLiveFrameAt, null, 'rendering resumed');
    assert.equal(renderWatchdog.check(Date.now()).frozen, false);
});
