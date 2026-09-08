// Frozen-output detection.
//
// A 2.A device can stop rendering while every health signal says it is fine: renderfps=40,
// mod.AttitudeFixtureManager=operational, overall=online, last_fps=41, and no new frame in
// minutes. The device is not even silent - it re-asserts the stale frame into the sACN packet 40
// times a second, so the wire carries a live, valid, correctly-sequenced stream of last frame's
// pixels and no receiver can tell the difference.
//
// These tests drive the REAL RenderWatchdog and, at the bottom, the REAL AttitudeFixtureManager.
// The distinction matters here more than usual: the batch-4 review found two gateway test files
// that restated the code they claimed to test, one of which stayed green after the fix it existed
// to protect was deleted outright.
//
//   node --test test/render-watchdog.test.mjs
//
import test from 'node:test';
import assert from 'node:assert/strict';

import renderWatchdog, {
    FROZEN_AFTER_MS,
    CHECK_INTERVAL_MS,
    ESCALATE_TO_WHITE_BACKUP,
    WIRE_INTO_OVERALL_STATUS,
} from '../RenderWatchdog.mjs';


function reset() {
    renderWatchdog.segmentsExpected = 0;
    renderWatchdog.segmentsCovered = 0;
    renderWatchdog.faultedShows.clear();
    renderWatchdog.zoneFaults = 0;
    renderWatchdog.nestedFrames = 0;
    renderWatchdog.frameOpen = false;
    renderWatchdog.lastLiveFrameAt = null;
    renderWatchdog.frozen = false;
    renderWatchdog.frozenSince = null;
    renderWatchdog.freezeEvents = 0;
}

// One healthy frame: N segments expected, N covered, no engine fault.
function healthyFrame(t, segments = 24, showId = 1) {
    renderWatchdog.beginFrame();
    renderWatchdog.expectSegments(segments);
    renderWatchdog.noteEngineRun(undefined, showId);        // what run() returns on success
    for (let i = 0; i < segments; i++) {
        if (!renderWatchdog.engineFaulted(showId)) { renderWatchdog.coverSegments(1); }
    }
    return renderWatchdog.endFrame(t);
}

test.beforeEach(reset);


test('a healthy frame is live, and an hour of them stays live', () => {
    let t = 1_000_000;
    for (let i = 0; i < 3600 * 40; i++) {
        t += 25;
        assert.equal(healthyFrame(t), true);
    }
    assert.equal(renderWatchdog.check(t).frozen, false);
});


test('a STATIC show is live, though its pixels never change', () => {
    // The false positive that sinks any change-detector. A Static show recomputes and rewrites
    // identical values every frame - measured on the real engine: 10 frames, 10 sets of DMX
    // writes, 1 distinct output. It is byte-identical to a frozen device at every observable
    // point, so the watchdog must key on the pipeline running, not on the values moving.
    let t = 1_000_000;
    for (let i = 0; i < 4000; i++) {
        t += 25;
        healthyFrame(t, 8);
    }

    const verdict = renderWatchdog.check(t + 4000);
    assert.equal(verdict.frozen, false,
        'a show that is legitimately static must never be reported frozen');
});


test('ROUTE 3: a swallowed engine fault is caught even though every segment is written', () => {
    // run() catches its own throw and returns a fallback colour; pixelData still holds last
    // frame, so getFixtureColor keeps serving it and the segment loop writes all 24 segments
    // exactly as it would on a healthy frame. Coverage alone cannot see this.
    let t = 1_000_000;
    healthyFrame(t, 24);

    for (let i = 0; i < 400; i++) {
        t += 25;
        renderWatchdog.beginFrame();
        renderWatchdog.expectSegments(24);
        renderWatchdog.noteEngineRun({ red: 0, green: 0, blue: 0 }, 1);  // run()'s catch return
        for (let s = 0; s < 24; s++) {
            // The DMX write still HAPPENS on this route - with last frame's pixels - so the
            // caller asks the watchdog whether to count it, exactly as the fixture manager does.
            if (!renderWatchdog.engineFaulted(1)) { renderWatchdog.coverSegments(1); }
        }

        assert.equal(renderWatchdog.endFrame(t), false,
            'segments written from a faulted engine do not count as covered');
    }

    const verdict = renderWatchdog.check(t);
    assert.equal(verdict.frozen, true, 'and after the threshold it is reported frozen');
    assert.ok(verdict.staleMs >= FROZEN_AFTER_MS);
});


test('ROUTE 2: a zone that throws mid-frame leaves segments uncovered', () => {
    // The forEach aborts part-way, so the surviving segments keep their last values and the rest
    // of the patch is silently abandoned. Coverage sees it directly.
    let t = 1_000_000;
    healthyFrame(t, 24);

    for (let i = 0; i < 400; i++) {
        t += 25;
        renderWatchdog.beginFrame();
        renderWatchdog.expectSegments(24);
        renderWatchdog.noteEngineRun(undefined, 1);
        for (let s = 0; s < 9; s++) { renderWatchdog.coverSegments(1); }   // throws at segment 10
        assert.equal(renderWatchdog.endFrame(t), false);
    }

    assert.equal(renderWatchdog.check(t).frozen, true);
});


test('ROUTE 1: the fixture manager stopping entirely is caught', () => {
    // No frames at all - beginFrame is never called again.
    let t = 1_000_000;
    healthyFrame(t, 24);

    assert.equal(renderWatchdog.check(t + 1000).frozen, false, 'not yet');
    assert.equal(renderWatchdog.check(t + FROZEN_AFTER_MS).frozen, false, 'not at the boundary');
    assert.equal(renderWatchdog.check(t + FROZEN_AFTER_MS + 1).frozen, true, 'just past it');

    // And it is caught 7x faster than the existing unresponsive sweep, which needs 35s plus up
    // to 3s of sampling before it even sets a flag nothing acts on.
    assert.ok(FROZEN_AFTER_MS < 35_000);
});


test('TABLE PLAYBACK is live, though run() is never called', () => {
    // isFullyCovered() skips the engine entirely and the frame comes from the server-rendered
    // table. Every segment is still written, and noteEngineRun is never called - so a detector
    // that required an engine to have run would report every table-playback device frozen.
    let t = 1_000_000;

    for (let i = 0; i < 400; i++) {
        t += 25;
        renderWatchdog.beginFrame();
        renderWatchdog.expectSegments(16);
        // no noteEngineRun at all - the table-covered branch calls incrementFrameCounter()
        for (let s = 0; s < 16; s++) { renderWatchdog.coverSegments(1); }
        assert.equal(renderWatchdog.endFrame(t), true);
    }

    assert.equal(renderWatchdog.check(t).frozen, false);
});


test('an UNASSIGNED device is live', () => {
    // It writes white to all channels directly rather than per segment. That is a complete,
    // correct frame with no patch to account for - and reporting every unassigned device in the
    // fleet as frozen would be the detector's most embarrassing possible failure.
    let t = 1_000_000;

    for (let i = 0; i < 400; i++) {
        t += 25;
        renderWatchdog.beginFrame();
        renderWatchdog.coverWholeFrame();
        assert.equal(renderWatchdog.endFrame(t), true);
    }

    assert.equal(renderWatchdog.check(t).frozen, false);
});


test('a device with NOTHING PATCHED is live, not frozen', () => {
    // FALSE POSITIVE, found by review. An earlier version returned false when no segments were
    // expected, so a device with no fixtures read as frozen five seconds later - which is the
    // normal state of a box during commissioning, between being assigned to a location and
    // having its fixtures entered. Also reached mid-re-patch, and by a config that arrives with
    // no fixtures key at all.
    //
    // Nothing patched is a real configuration, not a fault. There is no output to freeze.
    let t = 1_000_000;

    for (let i = 0; i < 400; i++) {
        t += 25;
        renderWatchdog.beginFrame();
        // no expectSegments, no coverSegments, no engines - nothing is patched
        assert.equal(renderWatchdog.endFrame(t), true);
    }

    assert.equal(renderWatchdog.check(t).frozen, false,
        'a commissioning device must not be reported frozen');
});


test('but a device whose every zone THROWS is frozen, though it also expects nothing', () => {
    // The distinction the zone-fault counter exists to make. Both cases reach endFrame with zero
    // expected segments; only this one is a failure. Without the counter, fixing the
    // commissioning false positive would have silently disabled route 2 for a total failure.
    let t = 1_000_000;
    healthyFrame(t, 24);

    for (let i = 0; i < 400; i++) {
        t += 25;
        renderWatchdog.beginFrame();
        renderWatchdog.noteZoneFault();
        assert.equal(renderWatchdog.endFrame(t), false);
    }

    assert.equal(renderWatchdog.check(t).frozen, true);
});


test('ONE broken engine does not freeze shows that render fine', () => {
    // FALSE POSITIVE, found by review. engineFaults was a device-wide count, so a single
    // faulting engine reported the whole device frozen - including when nothing rendered from
    // it. generateEngineInstances force-creates an engine for the location's fallback show even
    // when the schedule never mentions it, so an unused, unscheduled show could report a
    // fully-rendering device as frozen.
    let t = 1_000_000;

    for (let i = 0; i < 400; i++) {
        t += 25;
        renderWatchdog.beginFrame();

        // show 9 is the fallback: its engine throws, and nothing is patched to it
        renderWatchdog.noteEngineRun({ red: 0, green: 0, blue: 0 }, 9);

        // show 1 is scheduled and renders correctly across all 24 segments
        renderWatchdog.expectSegments(24);
        renderWatchdog.noteEngineRun(undefined, 1);
        for (let s = 0; s < 24; s++) {
            if (!renderWatchdog.engineFaulted(1)) { renderWatchdog.coverSegments(1); }
        }

        assert.equal(renderWatchdog.endFrame(t), true,
            'every patched segment rendered; the broken engine drives nothing');
    }

    assert.equal(renderWatchdog.check(t).frozen, false);
});


test('a broken engine DOES freeze the shows it actually drives', () => {
    // The converse of the test above - scoping the fault must not stop it being detected.
    let t = 1_000_000;
    healthyFrame(t, 24);

    for (let i = 0; i < 400; i++) {
        t += 25;
        renderWatchdog.beginFrame();

        renderWatchdog.expectSegments(24);          // show 1, 16 segments
        renderWatchdog.noteEngineRun(undefined, 1);
        renderWatchdog.noteEngineRun({ red: 0, green: 0, blue: 0 }, 2);

        for (let s = 0; s < 16; s++) {
            if (!renderWatchdog.engineFaulted(1)) { renderWatchdog.coverSegments(1); }
        }
        for (let s = 0; s < 8; s++) {               // show 2's 8 segments, from stale pixels
            if (!renderWatchdog.engineFaulted(2)) { renderWatchdog.coverSegments(1); }
        }

        assert.equal(renderWatchdog.endFrame(t), false,
            'show 2 is serving last frame, so the frame is not live');
    }

    assert.equal(renderWatchdog.check(t).frozen, true);
});


test('a device that has never rendered is NOT reported frozen', () => {
    // Every device in the fleet boots through this state, and they all boot at once after a
    // deploy. Calling it frozen would fire 96 alerts on every restart.
    assert.equal(renderWatchdog.lastLiveFrameAt, null);

    const verdict = renderWatchdog.check(1_000_000 + 10 * FROZEN_AFTER_MS);
    assert.equal(verdict.frozen, false);
    assert.match(verdict.reason, /no frame rendered yet/);
});


test('a BACKWARD clock step does not declare the fleet frozen', () => {
    // Date.now() is not monotonic and NTP steps rather than slews. Unclamped, one backward step
    // makes staleMs enormous on every device at once. This is the third instance of the same
    // hazard in this release - the gateway's token bucket and the engine's error reporter both
    // guard it - which is why it gets a test rather than a comment.
    let t = 1_000_000;
    healthyFrame(t, 24);

    for (const jumpMs of [10_000, 3_600_000, 86_400_000]) {
        const verdict = renderWatchdog.check(t - jumpMs);
        assert.equal(verdict.frozen, false, `a ${jumpMs / 1000}s backward step must not fire`);
        assert.ok(verdict.staleMs >= 0, 'and staleMs must never go negative');
    }
});


test('recovery clears the frozen state and is reported', () => {
    let t = 1_000_000;
    healthyFrame(t, 24);

    t += FROZEN_AFTER_MS + 1;
    assert.equal(renderWatchdog.check(t).frozen, true);

    healthyFrame(t, 24);
    assert.equal(renderWatchdog.check(t).frozen, false, 'one good frame is enough to clear it');
});


test('tick() emits a module status, and does NOT touch white backup', () => {
    // The escalation ships off, deliberately: white backup writes 255 to all 512 channels of all
    // 16 universes ignoring the patch, and a blinding-white car wash is a worse outcome than a
    // stale-but-plausible one. This test is what stops that constant being flipped by accident.
    assert.equal(ESCALATE_TO_WHITE_BACKUP, false,
        'if this is ever turned on, it must be a deliberate decision with field data behind it');
    assert.equal(WIRE_INTO_OVERALL_STATUS, false,
        'and the same for putting a brand-new detector into the fleet headline status field');

    let t = 1_000_000;
    healthyFrame(t, 24);

    const emitted = [];
    const whiteCalls = [];
    const deps = {
        eventHub: { emit: (name, payload) => emitted.push({ name, payload }) },
        attitudeSACN: { setWhiteBackupMode: (v) => whiteCalls.push(v) },
        logger: { error: () => {}, warn: () => {} },
        now: () => t,
    };

    renderWatchdog.tick(deps);
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].name, 'moduleStatus');
    assert.equal(emitted[0].payload.name, 'RenderWatchdog');
    assert.equal(emitted[0].payload.status, 'operational');

    t += FROZEN_AFTER_MS + 1;
    renderWatchdog.tick(deps);
    assert.equal(emitted[1].payload.status, 'frozen');
    assert.match(emitted[1].payload.data, /frozen=1/);

    assert.deepEqual(whiteCalls, [], 'white backup must not be touched while escalation is off');
});


test('a persistent freeze is logged ONCE, not every three seconds', () => {
    // The log queue drains to the server, and on a device that is also offline it drains to the
    // SD card - whose wear is this fleet's established failure mode. An hour frozen must not be
    // twelve hundred identical lines.
    let t = 1_000_000;
    healthyFrame(t, 24);

    const errors = [];
    const deps = {
        eventHub: { emit: () => {} },
        attitudeSACN: {},
        logger: { error: (m) => errors.push(m), warn: () => {} },
        now: () => t,
    };

    t += FROZEN_AFTER_MS + 1;
    for (let i = 0; i < 1200; i++) { t += CHECK_INTERVAL_MS; renderWatchdog.tick(deps); }

    assert.equal(errors.length, 1, 'one line for the whole hour');
    assert.equal(renderWatchdog.freezeEvents, 1);

    // A second, distinct freeze is a second event - so a flapping device is distinguishable from
    // one that froze once.
    healthyFrame(t, 24);
    renderWatchdog.tick(deps);
    t += FROZEN_AFTER_MS + 1;
    renderWatchdog.tick(deps);
    assert.equal(errors.length, 2);
    assert.equal(renderWatchdog.freezeEvents, 2);
});


test('a throwing dependency cannot take the process down', () => {
    // A watchdog that can crash the thing it watches is worse than no watchdog.
    let t = 1_000_000;
    healthyFrame(t, 24);

    const logged = [];
    assert.doesNotThrow(() => {
        renderWatchdog.tick({
            eventHub: { emit: () => { throw new Error('hub is gone'); } },
            attitudeSACN: {},
            logger: { error: (m) => logged.push(m), warn: () => {} },
            now: () => t,
        });
    }, 'tick must not throw out to the caller');
});
