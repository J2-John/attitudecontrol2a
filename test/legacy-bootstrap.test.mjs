// Cycle 2: the legacy-updater bootstrap.
//
// This code runs unattended, once, on roughly 500 boxes that were provisioned
// with an updater that cannot report failure. Every branch here has a wrong
// answer with a fleet-scale consequence:
//
//   spawning the OLD updater      another cheerful lie, plus a pointless restart
//   spawning when already done    an update loop on every boot
//   not spawning when it should   the box stays unverifiable forever
//   not capping attempts          a device that cannot write a build state
//                                 relaunches the updater on every single boot
//
// It drives the REAL MacrosModule against a sandboxed HOME and cwd, and it lets
// the REAL spawn happen against a stand-in update.sh that records what it saw.
// An earlier version of this file intercepted child_process.spawn instead; that
// silently tested nothing, because MacrosModule imports `spawn` as a named
// binding and reassigning the property on the module namespace does not reach
// it. Every "did it launch" assertion passed vacuously. Launching a real
// process is slower and is the only version that means anything.
//
//   node --test test/legacy-bootstrap.test.mjs
//
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

// This process's own process GROUP - not its pid. They are different numbers
// unless this process happens to be a group leader, and an earlier version of
// the detached test compared against process.pid, which meant the assertion
// could never fail. A `detached: false` mutant passed it cleanly.
function ownPgid() {
    try {
        return Number(execSync(`ps -o pgid= -p ${process.pid}`).toString().trim());
    } catch (error) {
        return null;
    }
}

const { default: macros } = await import('../MacrosModule.mjs');

const OLD_UPDATER = '#!/bin/bash\ncurl -L -o f.zip url\nunzip f.zip\necho "Attitude update.sh script v071724 complete!"\n';

let sandbox, home, appDir, realHomedir, realCwd;

// A stand-in updater that does no updating. It records that it ran, what the
// bootstrap state looked like AT THE MOMENT IT STARTED, and its own process
// group - which is how `detached` is checked without inspecting the call.
function standIn(api = 2) {
    return `#!/bin/bash
ATT_UPDATER_API=${api}
cp "${home}/.attitude-bootstrap.json" "${appDir}/state-at-spawn" 2>/dev/null || true
ps -o pgid= -p $$ | tr -d ' ' > "${appDir}/pgid" 2>/dev/null || true
touch "${appDir}/ran"
exit 0
`;
}

function setup({ updater, buildState = null, bootstrapState = null, api = 2 } = {}) {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-'));
    home = path.join(sandbox, 'home');
    appDir = path.join(sandbox, 'app');
    fs.mkdirSync(home);
    fs.mkdirSync(appDir);

    const body = updater === undefined ? standIn(api) : updater;
    if (body !== null) fs.writeFileSync(path.join(appDir, 'update.sh'), body, { mode: 0o755 });
    if (buildState !== null) {
        fs.writeFileSync(path.join(home, 'attitude-build.json'), JSON.stringify(buildState));
    }
    if (bootstrapState !== null) {
        // a raw string lets a test supply deliberately corrupt JSON
        fs.writeFileSync(path.join(home, '.attitude-bootstrap.json'),
            typeof bootstrapState === 'string' ? bootstrapState : JSON.stringify(bootstrapState));
    }

    realHomedir = os.homedir;
    realCwd = process.cwd;
    os.homedir = () => home;
    process.cwd = () => appDir;
}

function teardown() {
    os.homedir = realHomedir;
    process.cwd = realCwd;
    fs.rmSync(sandbox, { recursive: true, force: true });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Wait for the stand-in to run. Poll rather than sleep a fixed time, so the
// "should not spawn" cases still cost the full window and cannot pass by being
// checked too early.
async function ranWithin(ms) {
    const marker = path.join(appDir, 'ran');
    for (let waited = 0; waited < ms; waited += 20) {
        if (fs.existsSync(marker)) return true;
        await sleep(20);
    }
    return false;
}

async function run(opts) {
    setup(opts);
    try {
        macros.bootstrapLegacyUpdater();
        const ran = await ranWithin(3000);
        const read = f => {
            try { return fs.readFileSync(path.join(appDir, f), 'utf8').trim(); }
            catch { return null; }
        };
        const statePath = path.join(home, '.attitude-bootstrap.json');
        return {
            ran,
            pgid: read('pgid'),
            stateAtSpawn: read('state-at-spawn'),
            state: fs.existsSync(statePath)
                ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : null,
        };
    } finally { teardown(); }
}

// A negative result has to cost the same wall time as a positive one, or it is
// just a race the test happens to win.
async function didNotRun(opts) {
    const r = await run(opts);
    return r;
}

// ------------------------------------------------------------ the happy path
test('a box cycle 1 has just fixed runs the real updater once', async () => {
    const r = await run({});
    assert.equal(r.ran, true, 'the verified build record is the whole point of cycle 2');
    assert.equal(r.state.attempts, 1);
});

test('the updater is launched DETACHED', async () => {
    // Not a style point. An updater that is a child of the process it restarts
    // is killed by that restart - it froze ~93 devices for weeks. A detached
    // child is in its own process group, so a tree kill aimed at this app
    // cannot reach it.
    const parent = ownPgid();
    assert.ok(parent, 'cannot read this process group - the assertion below would be vacuous');

    const r = await run({});
    assert.equal(r.ran, true);
    assert.ok(r.pgid, 'the stand-in did not report a process group');
    assert.notEqual(Number(r.pgid), parent,
        `the updater is in this app's process group (${parent}) and a tree kill `
        + `aimed at the app would take it down mid-update`);
});

// ------------------------------------------------------- the four wrong answers
test('a box that has already run the real updater is left alone', async () => {
    const r = await didNotRun({ buildState: { outcome: 'updated', installedVersion: '2.A.19' } });
    assert.equal(r.ran, false, 'an update loop on every boot');
    assert.equal(r.state, null, 'and it should not even record an attempt');
});

test('a rolled-back box is left alone too', async () => {
    // A build state exists whatever the outcome was. Re-running the updater
    // because we did not like the answer is how you get a rollback loop.
    const r = await didNotRun({ buildState: { outcome: 'rolled-back', detail: 'render check failed' } });
    assert.equal(r.ran, false);
});

test('the OLD updater is never launched', async () => {
    // Launching it produces another unverifiable "complete!" and, because the
    // legacy MacrosModule follows it with a pm2 restart, an outage for nothing.
    const r = await didNotRun({ updater: OLD_UPDATER });
    assert.equal(r.ran, false, 'spawned the script that cannot report failure');
    assert.equal(r.state, null);
});

test('a missing updater is a warning, not a crash', async () => {
    const r = await didNotRun({ updater: null });
    assert.equal(r.ran, false);
});

test('attempts are capped, so a device that cannot write a build state stops trying', async () => {
    const r = await didNotRun({ bootstrapState: { attempts: 3, lastAttempt: 1 } });
    assert.equal(r.ran, false, 'relaunching the updater on every boot forever');
});

test('a recent failed attempt is not retried immediately', async () => {
    const r = await didNotRun({ bootstrapState: { attempts: 1, lastAttempt: Date.now() } });
    assert.equal(r.ran, false, 'a fast retry loop is the same fault as no cap');
});

test('but it IS retried once the window has passed', async () => {
    const sevenHoursAgo = Date.now() - 7 * 60 * 60 * 1000;
    const r = await run({ bootstrapState: { attempts: 1, lastAttempt: sevenHoursAgo } });
    assert.equal(r.ran, true, 'a transient network failure must not be permanent');
    assert.equal(r.state.attempts, 2);
});

// ------------------------------------------------------------ the marker itself
test('the marker is read from the line, not from prose that mentions it', async () => {
    // MacrosModule.mjs itself contains the string ATT_UPDATER_API in a comment.
    // An unanchored match would call any file that discusses the marker a
    // compliant updater.
    const prose = '#!/bin/bash\n# see ATT_UPDATER_API=2 in the docs\nexit 0\n';
    const r = await didNotRun({ updater: prose });
    assert.equal(r.ran, false, 'a comment about the marker is not the marker');
});

test('an updater with a LOWER api than we require is refused', async () => {
    const r = await didNotRun({ updater: '#!/bin/bash\nATT_UPDATER_API=1\nexit 0\n' });
    assert.equal(r.ran, false);
});

test('a FUTURE api is accepted', async () => {
    // The check is a floor. A device that has somehow got ahead of us is not a
    // device to refuse to run.
    const r = await run({ api: 7 });
    assert.equal(r.ran, true);
});

// ------------------------------------------------------------------- durability
test('the attempt is recorded BEFORE the spawn', async () => {
    // The updater restarts this process. Anything written after the spawn may
    // never be written at all, and then the cap does not exist.
    const r = await run({});
    assert.equal(r.ran, true);
    assert.ok(r.stateAtSpawn,
        'the updater started before the attempt was recorded - a restart in that '
        + 'window would uncap the retry');
    assert.equal(JSON.parse(r.stateAtSpawn).attempts, 1);
});

test('an unwritable home means no launch at all', async () => {
    // Better to do nothing than to launch an updater whose attempt we cannot
    // count - that is a reboot loop on a read-only filesystem.
    setup({});
    const realWrite = fs.writeFileSync;
    fs.writeFileSync = () => { throw new Error('EROFS'); };
    try {
        macros.bootstrapLegacyUpdater();
        assert.equal(await ranWithin(1500), false);
    } finally { fs.writeFileSync = realWrite; teardown(); }
});

test('a corrupt bootstrap state does not block the bootstrap', async () => {
    const r = await run({ bootstrapState: '{not json' });
    assert.equal(r.ran, true, 'a truncated file must not strand the device');
});
