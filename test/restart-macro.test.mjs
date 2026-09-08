// The delete-config-and-restart macro, and what it is entitled to claim.
//
// `restartPm2Async` used to be `sleep 30; pm2 restart all`, fired once, with a callback that
// only logged. Three problems, and the third is the one that matters:
//
//   1. ONE ATTEMPT, on a call INCIDENT-update-flag-lost-between-syncs documents as failing on
//      its first try, two devices out of two. update.sh retries three times and recovers; this
//      path did not retry at all, so the same failure meant the device simply never restarted.
//   2. The outcome went only to the device's own log.
//   3. A failure was STRUCTURALLY UNREPORTABLE. handleRestart() reports success the moment
//      config.json is deleted, so the server clears `deleteconfig`, so `restartQueuedFromServer`
//      is false by the time the callback fires ~30 s later - and emitMacrosEvent() only emits
//      while a macro is queued. Same trap as the batch-5 updater-launch defect: a late
//      correction with no channel to travel on.
//
//   node --test test/restart-macro.test.mjs
//
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { exec, spawnSync } from 'child_process';

const { default: macrosModule } = await import('../MacrosModule.mjs');
const { default: eventHub }     = await import('../EventHub.mjs');
const { default: configManager } = await import('../ConfigManager.mjs');

// These drive a REAL shell with a REAL fake pm2 on PATH - '#!/bin/sh', chmod +x, and a
// colon-separated PATH. None of that exists on Windows, and the device is Linux, so running them
// there is meaningless.
//
// They SKIP rather than fail, and they must never quietly pass: this project has already been
// bitten by "seven tests passing on Windows because nothing there can launch a bash script",
// which is a vacuous pass reported as coverage. A skip says so out loud.
const SHELL_TESTS = process.platform === 'win32'
    ? { skip: 'needs a POSIX shell; the device is Linux and this host is not' }
    : {};


function captureModuleStatus() {
    const seen = [];
    const listener = (d) => seen.push(d);
    eventHub.on('moduleStatus', listener);
    return { seen, stop: () => eventHub.off('moduleStatus', listener) };
}

// Swap the shell runner for one that reports a given outcome, run fn, restore.
async function withExec(impl, fn) {
    const saved = macrosModule.execCommand;
    macrosModule.execCommand = impl;
    try { return await fn(); } finally { macrosModule.execCommand = saved; }
}


test('A FAILED RESTART IS REPORTED, on the channel that is still open', async () => {
    // The whole point. macrosStatus is gone by the time this fires; moduleStatus is emitted
    // every cycle regardless of any macro flag, so that is where the failure has to go.
    const cap = captureModuleStatus();

    try {
        await withExec((cmd, cb) => cb(new Error('pm2: command not found')), async () => {
            const ok = await macrosModule.restartPm2Async();
            assert.equal(ok, false);
        });

        const errored = cap.seen.filter((e) => e.name === 'MacrosModule' && e.status === 'errored');
        assert.equal(errored.length, 1, 'exactly one errored moduleStatus');
        assert.match(errored[0].data, /pm2 restart failed after up to 3 attempts/);
        assert.match(errored[0].data, /config\.json was deleted/,
            'and it says what DID happen, so the reader knows the device has no config file');
    } finally { cap.stop(); }
});


test('a SUCCESSFUL restart does not emit an error', async () => {
    const cap = captureModuleStatus();

    try {
        await withExec((cmd, cb) => cb(null, '', ''), async () => {
            assert.equal(await macrosModule.restartPm2Async(), true);
        });

        assert.equal(cap.seen.filter((e) => e.status === 'errored').length, 0);
    } finally { cap.stop(); }
});


test('THE COMMAND ACTUALLY RETRIES - driven through a real shell', SHELL_TESTS, async () => {
    // The decisive one. The other tests stub the runner, so they would pass even if the command
    // string had no retry in it at all. This runs the REAL command that ships, against a fake
    // pm2 on PATH, with only the two sleep durations shortened - the loop, the attempt count
    // and the exit codes are exactly what a device runs.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm2fake-'));
    const counter = path.join(dir, 'count');

    fs.writeFileSync(path.join(dir, 'pm2'),
        '#!/bin/sh\n'
        + `n=$(cat ${counter} 2>/dev/null || echo 0); n=$((n+1)); echo $n > ${counter}\n`
        + 'exit 1\n');
    fs.chmodSync(path.join(dir, 'pm2'), 0o755);

    const fast = macrosModule.pm2RestartCommand
        .replace(/^sleep \d+;/, 'sleep 0;')
        .replace(/sleep \d+; done/, 'sleep 0; done');

    assert.match(fast, /for i in 1 2 3/,
        'a LITERAL list. $(seq 1 3) on a /bin/sh without seq expands to nothing, the body runs '
        + 'zero times, and the script exits 1 - indistinguishable from three real pm2 failures. '
        + 'update.sh uses a literal list for exactly this reason.');
    assert.doesNotMatch(fast, /seq/, 'and it does not depend on seq being installed');

    const code = await new Promise((resolve) => {
        exec(fast, { env: { ...process.env, PATH: dir + ':' + process.env.PATH } },
            (error) => resolve(error ? error.code : 0));
    });

    assert.equal(fs.readFileSync(counter, 'utf8').trim(), '3',
        'pm2 was called three times; with the retry removed this is 1');
    assert.equal(code, 1, 'and the exhausted loop reports failure');

    fs.rmSync(dir, { recursive: true, force: true });
});


test('a FIRST-ATTEMPT failure still restarts the device', SHELL_TESTS, async () => {
    // AC-0020151 and AC-0020140 both failed on attempt 1 and succeeded on a retry. That is the
    // documented case this fix exists for, so it gets its own test rather than being implied.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm2flaky-'));
    const counter = path.join(dir, 'count');

    fs.writeFileSync(path.join(dir, 'pm2'),
        '#!/bin/sh\n'
        + `n=$(cat ${counter} 2>/dev/null || echo 0); n=$((n+1)); echo $n > ${counter}\n`
        + '[ $n -ge 2 ] && exit 0\n'
        + 'exit 1\n');
    fs.chmodSync(path.join(dir, 'pm2'), 0o755);

    const fast = macrosModule.pm2RestartCommand
        .replace(/^sleep \d+;/, 'sleep 0;')
        .replace(/sleep \d+; done/, 'sleep 0; done');

    const code = await new Promise((resolve) => {
        exec(fast, { env: { ...process.env, PATH: dir + ':' + process.env.PATH } },
            (error) => resolve(error ? error.code : 0));
    });

    assert.equal(code, 0, 'the retry recovered it - pre-fix this device never restarted');
    assert.equal(fs.readFileSync(counter, 'utf8').trim(), '2', 'and it stopped as soon as it worked');

    fs.rmSync(dir, { recursive: true, force: true });
});


test('the restart is NOT attempted more than once after it succeeds', SHELL_TESTS, async () => {
    // A loop that kept going after a success would restart the app repeatedly.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm2ok-'));
    const counter = path.join(dir, 'count');

    fs.writeFileSync(path.join(dir, 'pm2'),
        '#!/bin/sh\n'
        + `n=$(cat ${counter} 2>/dev/null || echo 0); n=$((n+1)); echo $n > ${counter}\n`
        + 'exit 0\n');
    fs.chmodSync(path.join(dir, 'pm2'), 0o755);

    const fast = macrosModule.pm2RestartCommand
        .replace(/^sleep \d+;/, 'sleep 0;')
        .replace(/sleep \d+; done/, 'sleep 0; done');

    await new Promise((resolve) => {
        exec(fast, { env: { ...process.env, PATH: dir + ':' + process.env.PATH } }, () => resolve());
    });

    assert.equal(fs.readFileSync(counter, 'utf8').trim(), '1');
    fs.rmSync(dir, { recursive: true, force: true });
});


test('handleRestart reports success for the DELETE, and says only that', async () => {
    // Reporting success here is the safe direction and is deliberate - see the comment in
    // handleRestart. The alternative, reporting failure while the restart actually succeeds,
    // leaves the flag set and the device deletes its config and restarts again next cycle: a
    // restart loop on the fleet's only remote-restart path.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
    const cfg = path.join(dir, 'config.json');
    fs.writeFileSync(cfg, '{}');

    const savedPath = configManager.getConfigFilePath;
    configManager.getConfigFilePath = () => cfg;
    macrosModule.restartQueuedFromServer = true;

    try {
        await withExec((cmd, cb) => { /* never settles; the device would be gone */ }, async () => {
            await macrosModule.handleRestart();
        });

        assert.equal(macrosModule.restartCommandSuccess, true);
        assert.equal(fs.existsSync(cfg), false, 'and the delete really happened');
        assert.match(macrosModule.restartCommandResults, /queued for 30 seconds/);
        assert.doesNotMatch(macrosModule.restartCommandResults, /restarted/,
            'it must not claim the restart has happened - it has not been attempted yet');
    } finally {
        configManager.getConfigFilePath = savedPath;
        macrosModule.restartQueuedFromServer = false;
        fs.rmSync(dir, { recursive: true, force: true });
    }
});


test('a failed DELETE reports failure, and says so on moduleStatus too', async () => {
    // The moduleStatus half was unasserted until a mutation run pointed at it: flipping this
    // emit to 'operational' left the suite green. A device that cannot delete its own config
    // has something wrong with its card, which is the fleet's known failure mode - it needs to
    // show up as errored, not just set a boolean.
    const savedPath = configManager.getConfigFilePath;
    configManager.getConfigFilePath = () => '/nonexistent/dir/config.json';
    macrosModule.restartQueuedFromServer = true;
    const cap = captureModuleStatus();

    try {
        await macrosModule.handleRestart();

        assert.equal(macrosModule.restartCommandSuccess, false);
        assert.match(macrosModule.restartCommandResults, /File not found/);

        const errored = cap.seen.filter((e) => e.name === 'MacrosModule' && e.status === 'errored');
        assert.equal(errored.length, 1, 'and it is visible in the status stream');
        assert.match(errored[0].data, /File not found/);
    } finally {
        cap.stop();
        configManager.getConfigFilePath = savedPath;
        macrosModule.restartQueuedFromServer = false;
    }
});


test('nothing happens when no restart is queued', async () => {
    macrosModule.restartQueuedFromServer = false;
    let called = false;

    await withExec(() => { called = true; }, async () => {
        const result = await macrosModule.handleRestart();
        assert.match(result, /No restart queued/);
    });

    assert.equal(called, false, 'no shell command on the idle path');
    assert.equal(macrosModule.restartCommandSuccess, false);
});


test('THE LOOP STILL RUNS ON A SHELL WITH NO seq', SHELL_TESTS, () => {
    // The defect this replaces: `for i in $(seq 1 3)` on a shell without seq iterates ZERO times
    // and falls through to `exit 1` - byte-identical to three genuine pm2 failures, with the only
    // evidence on stderr, which the callback used to discard. The fleet's only remote-restart
    // path would silently do nothing.
    //
    // PATH is the scratch dir and NOTHING else, so seq is genuinely unavailable. The fake pm2
    // uses only shell builtins for the same reason.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noseq-'));
    const counter = path.join(dir, 'count');

    fs.writeFileSync(path.join(dir, 'pm2'), '#!/bin/sh\necho x >> ' + counter + '\nexit 1\n');
    fs.chmodSync(path.join(dir, 'pm2'), 0o755);

    const body = macrosModule.pm2RestartCommand
        .replace(/^sleep \d+;\s*/, '')
        .replace(/sleep \d+;\s*done/, 'done');

    const res = spawnSync('/bin/sh', ['-c', body], { env: { PATH: dir } });
    const attempts = fs.existsSync(counter)
        ? fs.readFileSync(counter, 'utf8').trim().split('\n').length
        : 0;

    assert.equal(attempts, 3,
        'pm2 was invoked three times with no seq on PATH; with $(seq ...) this is 0');
    assert.equal(res.status, 1, 'and the exhausted loop still reports failure');

    fs.rmSync(dir, { recursive: true, force: true });
});


test('A RESTART FAILURE SURVIVES THE NEXT MACRO CYCLE', async () => {
    // ModuleStatusTracker keeps ONE status per module name, and processMacros emits
    // 'operational' on completion every 15 s. The restart fails ~40 s after the delete, so the
    // errored status was overwritten before a network send could carry it - roughly half the
    // time, a device that deleted its config.json and never restarted reported nothing at all,
    // having already told the server the macro succeeded.
    const saved = macrosModule.restartFailure;
    macrosModule.restartFailure = null;
    const cap = captureModuleStatus();

    try {
        await withExec((cmd, cb) => cb(new Error('pm2: command not found')), async () => {
            await macrosModule.restartPm2Async();
        });

        assert.ok(macrosModule.restartFailure, 'the failure is retained, not just emitted once');

        // DRIVE THE REAL CYCLE. Re-emitting the event by hand here would pass even if
        // processMacros still hard-coded 'operational' - the exact "test restates the code"
        // failure this project keeps finding, and it escaped a mutation run in this very file.
        cap.seen.length = 0;
        macrosModule.rebootQueuedFromServer = false;
        macrosModule.restartQueuedFromServer = false;
        macrosModule.updateQueuedFromServer = false;

        await macrosModule.processMacros();

        const completion = cap.seen.filter((e) => e.name === 'MacrosModule');
        assert.ok(completion.length > 0, 'the cycle reported something');
        assert.equal(completion[completion.length - 1].status, 'errored',
            'a device that never restarted must not read as healthy on the next cycle');
    } finally {
        cap.stop();
        macrosModule.restartFailure = saved;
    }
});


test('A SHELL-LEVEL FAILURE IS DISTINGUISHABLE FROM THREE PM2 FAILURES', async () => {
    // Both exit 1. stderr is the only thing that separates them, and it was captured in the
    // callback signature and never used - so "the shell could not run the loop" was reported as
    // "pm2 was tried three times and failed".
    const saved = macrosModule.restartFailure;
    macrosModule.restartFailure = null;

    try {
        await withExec((cmd, cb) => cb(new Error('Command failed'), '', 'sh: 1: seq: not found'),
            async () => { await macrosModule.restartPm2Async(); });

        assert.match(macrosModule.restartCommandResults, /seq: not found/,
            'the stderr that identifies the real cause must reach the report');
    } finally {
        macrosModule.restartFailure = saved;
    }
});
