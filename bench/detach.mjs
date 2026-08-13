// bench/detach.mjs
// Proves the property 2.A.13 depends on: a detached child survives a tree kill aimed at its
// parent, and a non-detached one does not.
//
// This is the whole reason the update health check has never run in the field. MacrosModule
// launched update.sh with exec(), making it a child of the app; update.sh then restarts that
// app; pm2 kills the tree; the updater dies seconds after installing the files and before it
// can check anything. Nothing in the logs said so, because the updater was killed before it
// could write a log line.
//
// Run: node bench/detach.mjs

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'attdetach-'));

// stands in for update.sh: writes a line, sleeps past the kill, writes a second line.
// The second line is the health check it has never been alive long enough to run.
const script = path.join(DIR, 'fake-update.sh');
fs.writeFileSync(script, `#!/bin/bash
echo "installed" >> "${DIR}/log"
sleep 3
echo "health check ran" >> "${DIR}/log"
`);
fs.chmodSync(script, 0o755);

// stands in for the app: launches the updater the way MacrosModule does, then waits to be killed
const parent = path.join(DIR, 'fake-app.mjs');
fs.writeFileSync(parent, `
import { spawn } from 'child_process';
const detached = process.argv[2] === 'detached';
const child = spawn('${script}', [], {
	detached: detached,
	stdio: 'ignore',
});
if (detached) child.unref();
setTimeout(() => {}, 60000);
`);

function run(mode) {
	return new Promise((resolve) => {
		fs.writeFileSync(path.join(DIR, 'log'), '');

		// detached so we can signal the whole group, which is what pm2 does to the app
		const app = spawn(process.execPath, [parent, mode], { detached: true, stdio: 'ignore' });

		setTimeout(() => {
			try {
				// negative pid = the whole process group, i.e. a tree kill
				process.kill(-app.pid, 'SIGINT');
			} catch (error) { /* already gone */ }

			setTimeout(() => {
				try { process.kill(-app.pid, 'SIGKILL'); } catch (error) { /* already gone */ }
				const log = fs.readFileSync(path.join(DIR, 'log'), 'utf8');
				resolve(log.indexOf('health check ran') !== -1);
			}, 4000);
		}, 700);
	});
}

const attached = await run('attached');
const detached = await run('detached');

console.log(`  exec-style (child of the app)  survived the tree kill: ${attached}`);
console.log(`  detached + unref               survived the tree kill: ${detached}`);

fs.rmSync(DIR, { recursive: true, force: true });

const ok = attached === false && detached === true;
console.log(ok
	? '\nconfirmed: only a detached updater lives long enough to health check'
	: '\nUNEXPECTED - the premise of 2.A.13 does not hold here');
process.exit(ok ? 0 : 1);
