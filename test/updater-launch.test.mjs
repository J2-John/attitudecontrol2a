// The update flag is the only channel to a field device. Spending it without updating is a site
// visit, times however many devices hit the case.
//
// spawn() does NOT throw for a missing or non-executable update.sh. It returns a ChildProcess and
// delivers the ENOENT asynchronously, as an 'error' event on a later tick. The try/catch in
// handleUpdate() could not see it, so:
//
//   1. updateCommandSuccess was set TRUE and macrosStatus told the server the update had
//      succeeded, so the server CLEARED THE UPDATE FLAG - with no updater having run. The device
//      stays on old firmware, the server believes it updated, and the only channel to that device
//      has been spent.
//   2. A ChildProcess 'error' with no listener is an uncaught exception, so the app went down as
//      well - on exactly the device that most needed to stay up to receive its next flag.
//
// The bootstrap path in the same file already guarded both, with a comment describing this exact
// hazard. It was added in 2.A.19 and never carried across to the flag-driven path twenty lines
// away.
//
// These tests drive the REAL macrosModule.handleUpdate() against a real temp directory.
//
//   node --test test/updater-launch.test.mjs
//
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const { default: macrosModule } = await import('../MacrosModule.mjs');
const { default: eventHub }     = await import('../EventHub.mjs');
const { default: configManager } = await import('../ConfigManager.mjs');

// processMacros() calls getUpdatedConfig(), which re-reads the three flags from configManager -
// so a test that only sets the instance fields has them overwritten before handleUpdate runs.
function withQueuedUpdate(fn) {
    const saved = {
        u: configManager.getUpdate, r: configManager.getReboot, s: configManager.getRestart,
    };
    configManager.getUpdate  = () => true;
    configManager.getReboot  = () => false;
    configManager.getRestart = () => false;
    try { return fn(); } finally {
        configManager.getUpdate = saved.u;
        configManager.getReboot = saved.r;
        configManager.getRestart = saved.s;
    }
}

// What actually reaches the server. macrosStatus is the payload the server reads to decide
// whether to clear the update flag, so it - not the in-memory field - is what the assertions
// below have to look at. An earlier version of this file checked only the field, and would have
// passed against code that reported success to the server forever.
function captureMacrosPayloads() {
    const seen = [];
    const listener = (d) => seen.push(d);
    eventHub.on('macrosStatus', listener);
    return { seen, stop: () => eventHub.off('macrosStatus', listener) };
}


// handleUpdate resolves as soon as it has launched (or refused to launch), and emitMacrosEvent
// runs on the next microtask. Give the async 'error' event a real tick to land as well.
const settle = () => new Promise((r) => setTimeout(r, 60));

function inTempCwd(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attupd-'));
    const cwd = process.cwd();
    process.chdir(dir);
    try { return fn(dir); } finally { process.chdir(cwd); fs.rmSync(dir, { recursive: true, force: true }); }
}

function captureStatuses() {
    const seen = [];
    const listener = (m) => { if (m.name === 'MacrosModule') { seen.push(m); } };
    eventHub.on('moduleStatus', listener);
    return { seen, stop: () => eventHub.off('moduleStatus', listener) };
}

// A stand-in updater that does nothing. The real one restarts the app.
function writeFakeUpdater(dir, mode = 0o755) {
    const p = path.join(dir, 'update.sh');
    fs.writeFileSync(p, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(p, mode);
    return p;
}


// POSIX-ONLY TESTS.
//
// Several of these write a `#!/bin/sh` updater, chmod it, and let the module try to exec it.
// Windows has no shebang and no executable bit, so on Windows they do not test what they claim -
// and this file's own history is the reason that matters: the assertion "a failed launch cannot
// take the process down" was ONCE PROVEN VACUOUS because nothing on that host could launch a
// script at all, so the test passed without the guard it exists to protect ever running.
//
// A skip states that. A pass would be a lie. Same convention as legacy-bootstrap.test.mjs.
const NEEDS_POSIX = process.platform === 'win32'
    ? 'needs a POSIX host: writes and execs a #!/bin/sh updater'
    : false;


test('A MISSING update.sh does not report success, so the server keeps the flag', async () => {
    const cap = captureStatuses();
    try {
        await inTempCwd(async () => {
            macrosModule.updateQueuedFromServer = true;
            macrosModule.updateCommandSuccess = true;   // the stale value it must overwrite

            await macrosModule.handleUpdate();
            await settle();

            assert.equal(macrosModule.updateCommandSuccess, false,
                'reporting success here spends the update flag with no update performed');
            assert.match(macrosModule.updateCommandResults, /missing or not executable/);
        });
    } finally { cap.stop(); }

    assert.ok(cap.seen.some((m) => m.status === 'errored'),
        'and the failure is reported, not swallowed');
});


test('a NON-EXECUTABLE update.sh does not report success either', { skip: NEEDS_POSIX }, async () => {
    // The case the bootstrap path's chmod was written for. handleUpdate now chmods too, so this
    // asserts the recovery: a lost executable bit is repaired rather than being fatal.
    const cap = captureStatuses();
    try {
        await inTempCwd(async (dir) => {
            writeFakeUpdater(dir, 0o644);

            macrosModule.updateQueuedFromServer = true;
            macrosModule.updateCommandSuccess = false;

            await macrosModule.handleUpdate();
            await settle();

            assert.equal(macrosModule.updateCommandSuccess, true,
                'the defensive chmod restores the executable bit rather than stranding the device');
        });
    } finally { cap.stop(); }
});


test('a non-executable update.sh that CANNOT be chmodded is refused, not reported as success', { skip: NEEDS_POSIX }, async () => {
    // A read-only filesystem is the realistic version of this - SD card wear is this fleet's
    // established failure mode, and a worn card remounts read-only. The chmod fails, the access
    // check fails, and the flag must survive.
    const cap = captureStatuses();
    try {
        await inTempCwd(async (dir) => {
            const p = writeFakeUpdater(dir, 0o644);

            // Make the chmod itself fail, without needing root or a real read-only mount.
            const realChmod = fs.chmodSync;
            fs.chmodSync = () => { throw new Error('EROFS: read-only file system'); };

            try {
                macrosModule.updateQueuedFromServer = true;
                macrosModule.updateCommandSuccess = true;

                await macrosModule.handleUpdate();
                await settle();

                assert.equal(macrosModule.updateCommandSuccess, false,
                    'a device that cannot run its updater must keep its flag');
                assert.match(macrosModule.updateCommandResults, /NOT acknowledged/,
                    'and the message must say so, because an operator will read it');
            } finally {
                fs.chmodSync = realChmod;
            }
        });
    } finally { cap.stop(); }
});


test('a WORKING updater is launched and reported', { skip: NEEDS_POSIX }, async () => {
    const cap = captureStatuses();
    try {
        await inTempCwd(async (dir) => {
            writeFakeUpdater(dir);

            macrosModule.updateQueuedFromServer = true;
            macrosModule.updateCommandSuccess = false;

            await macrosModule.handleUpdate();
            await settle();

            assert.equal(macrosModule.updateCommandSuccess, true);
            assert.match(macrosModule.updateCommandResults, /Update launched/);
        });
    } finally { cap.stop(); }

    assert.ok(cap.seen.some((m) => m.status === 'operational'));
});


test('no update queued means nothing is launched and nothing is claimed', async () => {
    await inTempCwd(async () => {
        macrosModule.updateQueuedFromServer = false;
        macrosModule.updateCommandSuccess = true;

        const result = await macrosModule.handleUpdate();

        assert.equal(macrosModule.updateCommandSuccess, false);
        assert.match(result, /No update queued/);
    });
});


test('THE SERVER IS TOLD THE TRUTH: a corrupt updater does not report success', { skip: NEEDS_POSIX }, async () => {
    // THE DEFECT THIS WHOLE FILE EXISTS FOR, and the one a review caught in the first version of
    // the fix.
    //
    // spawn() returning a ChildProcess says nothing about whether the updater launched. The
    // first fix set updateCommandSuccess = true immediately and corrected it from an 'error'
    // listener - but handleUpdate() resolves at once, emitMacrosEvent() runs on the next
    // microtask, and the 'error' event lands after it. So macrosStatus reported SUCCESS, the
    // server cleared the update flag, and the correction was never sent: emitMacrosEvent() only
    // emits while a macro is queued, and by then the flag was gone. The device is stranded on
    // old firmware with its only recovery channel spent.
    //
    // This drives the REAL processMacros(), which is what emits macrosStatus, and asserts on the
    // payload rather than the instance field.
    const cap = captureMacrosPayloads();
    try {
        await inTempCwd(async (dir) => {
            const p = path.join(dir, 'update.sh');
            fs.writeFileSync(p, '#!/nonexistent/interpreter\nexit 0\n');
            fs.chmodSync(p, 0o755);

            withQueuedUpdate(() => macrosModule.processMacros());
            await new Promise((r) => setTimeout(r, 300));
        });
    } finally { cap.stop(); }

    assert.ok(cap.seen.length >= 1, 'a macrosStatus payload was sent');
    for (const payload of cap.seen) {
        assert.equal(payload.updateCommandSuccess, false,
            'reporting success here clears the flag and strands the device');
    }
});


test('THE SERVER IS TOLD THE TRUTH: a working updater does report success', { skip: NEEDS_POSIX }, async () => {
    // The converse. Reporting failure for a launch that worked leaves the flag set, and the
    // device relaunches the updater on its next sync while the first is mid-install.
    const cap = captureMacrosPayloads();
    try {
        await inTempCwd(async (dir) => {
            writeFakeUpdater(dir);

            withQueuedUpdate(() => macrosModule.processMacros());
            await new Promise((r) => setTimeout(r, 300));
        });
    } finally { cap.stop(); }

    assert.ok(cap.seen.length >= 1);
    assert.ok(cap.seen.every((p) => p.updateCommandSuccess === true),
        'a launched updater must be acknowledged, or the device relaunches it every second');
});


test('a SUCCESS followed by a FAILURE reports the failure, not the stale success', { skip: NEEDS_POSIX }, async () => {
    // macrosModule is a singleton and updateCommandSuccess persists between cycles, so the
    // failure path has to actively clear it - not merely decline to set it. The realistic
    // sequence: a device updates cleanly, its card later corrupts update.sh, and the next
    // flagged update must not be acknowledged on the strength of the previous one.
    //
    // Every other test in this file starts from false, so none of them can see this.
    const cap = captureMacrosPayloads();
    try {
        await inTempCwd(async (dir) => {
            writeFakeUpdater(dir);
            withQueuedUpdate(() => macrosModule.processMacros());
            await new Promise((r) => setTimeout(r, 300));
        });

        assert.equal(macrosModule.updateCommandSuccess, true, 'the good cycle succeeded');

        await inTempCwd(async (dir) => {
            const p = path.join(dir, 'update.sh');
            fs.writeFileSync(p, '#!/nonexistent/interpreter\nexit 0\n');
            fs.chmodSync(p, 0o755);
            withQueuedUpdate(() => macrosModule.processMacros());
            await new Promise((r) => setTimeout(r, 300));
        });
    } finally { cap.stop(); }

    assert.equal(cap.seen.length, 2, 'two cycles, two payloads');
    assert.equal(cap.seen[0].updateCommandSuccess, true);
    assert.equal(cap.seen[1].updateCommandSuccess, false,
        'the stale true from the previous cycle must not be reported again');
});


test('a CORRUPT updater passes the check, fails to exec, and still does not crash', { skip: NEEDS_POSIX }, async () => {
    // The gap the pre-flight check cannot close, and the reason the 'error' listener is not
    // redundant. access(X_OK) tests the file's permission bits; the kernel resolves the shebang
    // only at exec. A truncated or corrupted update.sh - an interrupted write on a failing card,
    // which is this fleet's established failure mode - is executable AND unlaunchable.
    //
    // Without the listener this is an uncaught exception and the app goes down.
    const cap = captureStatuses();
    try {
        await inTempCwd(async (dir) => {
            const p = path.join(dir, 'update.sh');
            fs.writeFileSync(p, '#!/nonexistent/interpreter\nexit 0\n');
            fs.chmodSync(p, 0o755);

            macrosModule.updateQueuedFromServer = true;
            macrosModule.updateCommandSuccess = false;

            await macrosModule.handleUpdate();
            await settle();

            assert.equal(macrosModule.updateCommandSuccess, false,
                'the late error must still correct the record, so the next cycle keeps the flag');
            assert.match(macrosModule.updateCommandResults, /failed to launch/);
        });
    } finally { cap.stop(); }

    assert.ok(cap.seen.some((m) => m.status === 'errored'));
});


test('a failed launch cannot take the process down', { skip: NEEDS_POSIX }, async () => {
    // A ChildProcess 'error' with no listener is an uncaught exception.
    //
    // This test used to run in a directory with NO update.sh, which meant the pre-flight
    // returned before spawn was ever reached - so it asserted nothing about the listener, and a
    // review proved it by deleting the listener and watching this test still pass. It needs an
    // updater that PASSES the pre-flight and then fails to exec.
    const seen = [];
    const onUncaught = (err) => seen.push(err);
    process.on('uncaughtException', onUncaught);

    try {
        await inTempCwd(async (dir) => {
            const p = path.join(dir, 'update.sh');
            fs.writeFileSync(p, '#!/nonexistent/interpreter\nexit 0\n');
            fs.chmodSync(p, 0o755);

            macrosModule.updateQueuedFromServer = true;
            await macrosModule.handleUpdate();
            await settle();
        });
    } finally {
        process.off('uncaughtException', onUncaught);
    }

    assert.deepEqual(seen, [], 'no uncaught exception from a failed updater launch');
});
