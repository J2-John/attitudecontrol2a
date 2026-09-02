// Cycle 2: the legacy-updater bootstrap.
//
// This code runs unattended, once, on roughly 500 boxes provisioned with an
// updater that cannot report failure. Every branch has a wrong answer with a
// fleet-scale consequence:
//
//   launching the OLD updater     another cheerful lie, plus a pointless restart
//   launching when already done   an update loop on every boot
//   not launching when it should  the box stays unverifiable forever
//   not capping attempts          a device that cannot write a build state
//                                 relaunches the updater on every single boot
//
// SPLIT BY PLATFORM, deliberately. The DECISION - bootstrapDecision() - is pure
// filesystem reasoning and is tested everywhere, including on the Windows
// laptop where `npm test` actually gets run before a push. The LAUNCH spawns a
// bash script and can only be tested on a POSIX host, so those three tests skip
// loudly rather than passing quietly.
//
// That distinction is the whole reason this file is shaped like this. The first
// version tested the launch only, so on Windows every "it must NOT launch"
// assertion passed because nothing there can launch - seven vacuous passes
// reported as green. A test that cannot fail is worse than a missing one.
//
//   node --test test/legacy-bootstrap.test.mjs
//
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

const { default: macros } = await import('../MacrosModule.mjs');

const POSIX = process.platform !== 'win32';
const NEEDS_POSIX = POSIX ? false : 'needs a POSIX host: spawns a bash script and reads process groups';

const OLD_UPDATER = '#!/bin/bash\ncurl -L -o f.zip url\nunzip f.zip\necho "Attitude update.sh script v071724 complete!"\n';

let sandbox, home, appDir, realHomedir, realCwd;

// This process's own process GROUP - not its pid. They are different numbers
// unless this process happens to be a group leader, and an earlier version of
// the detached test compared against process.pid, so the assertion could never
// fail: a `detached: false` mutant passed it cleanly.
function ownPgid() {
    try { return Number(execSync(`ps -o pgid= -p ${process.pid}`).toString().trim()); }
    catch (error) { return null; }
}

// A stand-in updater that does no updating. Records that it ran, what the
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

// Ask only "should this device bootstrap, and why". No spawning; runs anywhere.
function decide(opts) {
    setup(opts);
    try { return macros.bootstrapDecision(); }
    finally { teardown(); }
}

// ===================================================== the decision (everywhere)
test('a box cycle 1 has just fixed should run the real updater', () => {
    const d = decide({});
    assert.equal(d.go, true, `refused with: ${d.reason}`);
});

test('a box that has already run the real updater is left alone', () => {
    // Otherwise every boot launches an update, forever.
    const d = decide({ buildState: { outcome: 'updated', installedVersion: '2.A.19' } });
    assert.equal(d.go, false, 'an update loop on every boot');
});

test('a rolled-back box is left alone too', () => {
    // A build state exists whatever the outcome was. Re-running the updater
    // because we did not like the answer is how you get a rollback loop.
    const d = decide({ buildState: { outcome: 'rolled-back', detail: 'render check failed' } });
    assert.equal(d.go, false);
});

test('the OLD updater is never launched', () => {
    // Launching it produces another unverifiable "complete!" and, because the
    // legacy MacrosModule follows it with a pm2 restart, an outage for nothing.
    const d = decide({ updater: OLD_UPDATER });
    assert.equal(d.go, false, 'would launch the script that cannot report failure');
    assert.equal(d.warn, true, 'and a person should be told why this box is stuck');
});

test('a missing updater is a warning, not a crash', () => {
    const d = decide({ updater: null });
    assert.equal(d.go, false);
    assert.equal(d.warn, true);
});

test('attempts are capped, so a device that cannot write a build state stops trying', () => {
    const d = decide({ bootstrapState: { attempts: 3, lastAttempt: 1 } });
    assert.equal(d.go, false, 'relaunching the updater on every boot forever');
});

test('a recent failed attempt is not retried immediately', () => {
    const d = decide({ bootstrapState: { attempts: 1, lastAttempt: Date.now() } });
    assert.equal(d.go, false, 'a fast retry loop is the same fault as no cap');
});

test('but it IS retried once the window has passed', () => {
    const sevenHoursAgo = Date.now() - 7 * 60 * 60 * 1000;
    const d = decide({ bootstrapState: { attempts: 1, lastAttempt: sevenHoursAgo } });
    assert.equal(d.go, true, 'a transient network failure must not be permanent');
    assert.equal(d.attempts, 1);
});

test('a corrupt bootstrap state does not strand the device', () => {
    const d = decide({ bootstrapState: '{not json' });
    assert.equal(d.go, true, 'a truncated file must not be a permanent refusal');
});

// ------------------------------------------------------------ the marker itself
test('the marker is read from the line, not from prose that mentions it', () => {
    // MacrosModule.mjs itself contains ATT_UPDATER_API in a comment. An
    // unanchored match would call any file that discusses the marker a
    // compliant updater.
    const prose = '#!/bin/bash\n# see ATT_UPDATER_API=2 in the docs\nexit 0\n';
    assert.equal(decide({ updater: prose }).go, false,
        'a comment about the marker is not the marker');
});

test('an updater with a LOWER api than we require is refused', () => {
    assert.equal(decide({ updater: '#!/bin/bash\nATT_UPDATER_API=1\nexit 0\n' }).go, false);
});

test('a FUTURE api is accepted', () => {
    // The check is a floor. A device that has somehow got ahead of us is not a
    // device to refuse to run.
    assert.equal(decide({ api: 7 }).go, true);
});

// =================================================== recording (everywhere)
test('the attempt is recorded, and only when it is going to launch', () => {
    // The record happens before the spawn, so it exists on every platform even
    // where the spawn itself cannot succeed.
    const statePath = () => path.join(home, '.attitude-bootstrap.json');

    setup({});
    try {
        macros.bootstrapLegacyUpdater();
        const state = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
        assert.equal(state.attempts, 1);
        assert.ok(state.lastAttempt > 0);
    } finally { teardown(); }

    setup({ buildState: { outcome: 'updated' } });
    try {
        macros.bootstrapLegacyUpdater();
        assert.equal(fs.existsSync(statePath()), false,
            'a device that is not bootstrapping must not burn an attempt');
    } finally { teardown(); }
});

test('an unwritable home means no launch at all', () => {
    // Better to do nothing than to launch an updater whose attempt we cannot
    // count - that is a reboot loop on a read-only filesystem.
    setup({});
    const realWrite = fs.writeFileSync;
    let spawned = false;
    fs.writeFileSync = () => { throw new Error('EROFS'); };
    try {
        macros.bootstrapLegacyUpdater();
        spawned = fs.existsSync(path.join(appDir, 'ran'));
        assert.equal(spawned, false);
    } finally { fs.writeFileSync = realWrite; teardown(); }
});

// ======================================================= the launch (POSIX only)
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function ranWithin(ms) {
    const marker = path.join(appDir, 'ran');
    for (let waited = 0; waited < ms; waited += 20) {
        if (fs.existsSync(marker)) return true;
        await sleep(20);
    }
    return false;
}

test('the updater is actually launched', { skip: NEEDS_POSIX }, async () => {
    setup({});
    try {
        macros.bootstrapLegacyUpdater();
        assert.equal(await ranWithin(2000), true,
            'the verified build record is the whole point of cycle 2');
    } finally { teardown(); }
});

test('the updater is launched DETACHED', { skip: NEEDS_POSIX }, async () => {
    // Not a style point. An updater that is a child of the process it restarts
    // is killed by that restart - it froze ~93 devices for weeks. A detached
    // child is in its own process group, so a tree kill aimed at this app
    // cannot reach it.
    const parent = ownPgid();
    assert.ok(parent, 'cannot read this process group - the assertion below would be vacuous');

    setup({});
    try {
        macros.bootstrapLegacyUpdater();
        assert.equal(await ranWithin(2000), true);
        const pgid = Number(fs.readFileSync(path.join(appDir, 'pgid'), 'utf8').trim());
        assert.notEqual(pgid, parent,
            `the updater is in this app's process group (${parent}) and a tree kill `
            + `aimed at the app would take it down mid-update`);
    } finally { teardown(); }
});

test('the attempt is recorded BEFORE the spawn', { skip: NEEDS_POSIX }, async () => {
    // The updater restarts this process. Anything written after the spawn may
    // never be written at all, and then the cap does not exist.
    setup({});
    try {
        macros.bootstrapLegacyUpdater();
        assert.equal(await ranWithin(2000), true);
        const seen = fs.readFileSync(path.join(appDir, 'state-at-spawn'), 'utf8');
        assert.equal(JSON.parse(seen).attempts, 1,
            'the updater started before the attempt was recorded - a restart in that '
            + 'window would uncap the retry');
    } finally { teardown(); }
});
