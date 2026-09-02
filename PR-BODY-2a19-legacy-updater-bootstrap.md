# 2.A.19 — let a box with the old updater fix itself, in two cycles

Roughly 500 SD cards were provisioned with the pre-2026-08-08 updater. They
cannot be re-imaged. This is how they get current anyway, with no change to the
cards and one flag per box.

## What the old updater is

All 26 lines of it:

```bash
curl -L -o $ZIP_FILE "$REPO_URL/archive/refs/heads/main.zip"
unzip $ZIP_FILE -d $TMP_DIR
rsync -av --remove-source-files $UNZIPPED_DIR/ $TARGET_DIR/
rm -rf $ZIP_FILE $TMP_DIR
echo "Attitude update.sh script v071724 complete!"
```

No `set -e`. No `-f` on curl. Not one return value checked. It ends with an
unconditional `echo "...complete!"`, so a failed download, a failed unzip and a
failed rsync all report success.

`curl` without `-f` writes GitHub's error page **to disk as the zip file**. That
endpoint rate-limits unauthenticated requests and answers 403 — the current
updater carries a comment about it, observed 2026-08-08 after roughly six pulls
in twenty minutes from one IP, and noting that several devices behind one public
IP make it a fleet-scale concern rather than a lab quirk. Then `unzip` fails,
`rsync` fails on a directory that does not exist, and the script says complete.

Box 151 did exactly this on 2026-09-02: update ran at 09:21:20, logged
`complete!`, pm2 restarted at 09:21:54, and the box came back on byte-identical
code. It has been reporting successful updates while taking none.

This is the failure the fleet playbook opens with — *a false pass is worse than
no check at all* — except it is in the updater rather than the health check.

## The way out needs no change to the cards

The old updater's rsync copies the **whole repo tree**, `update.sh` included. So
it only has to succeed once, and it repairs itself when it does. What was
missing is any way to know whether that once has happened, and any way to get a
verified record afterwards.

**Cycle 1** — the old script runs on a flag and replaces itself with the current
updater, along with the rest of the app. It cannot verify any of that and does
not need to.

**Cycle 2** — the new code comes up, notices the real updater has never run
here, and runs it once.

On a box cycle 1 brought current, cycle 2 lands on `update.sh`'s
`already-current` path, which exits **before** the snapshot, the rsync and any
restart: it downloads, compares versions, writes `attitude-build.json` and
quits. Nothing is touched. On a box where cycle 1 only half-worked, it performs
a real validated, health-checked, roll-back-able update instead — which is the
correct behaviour in both cases.

Either way a device that asks for one update ends up on current code with a
build record that says so, and every device that asks again is running an
updater that cannot lie about the answer.

## The changes

**`update.sh` gains a machine-readable capability marker.**

```bash
ATT_UPDATER_API=2
```

The old script announced itself only inside an echo at the very end, which is
useless to anything that has to *decide* whether the updater on disk can be
trusted — and which it printed whether or not the four preceding commands
worked. Absence of the marker means API 1, the old script. Raise the number when
the contract changes, not when the script does.

**`MacrosModule` gains `bootstrapLegacyUpdater()`**, run once 90 seconds after
boot. It launches `./update.sh` only when all of these hold:

- `~/attitude-build.json` does not exist — the real updater has never run here.
  Once it exists, whatever the outcome, this never fires again. That is what
  stops an update loop on every boot, and a rollback loop after a rollback.
- the updater on disk reports `ATT_UPDATER_API >= 2`. Launching the old script
  would produce another unverifiable "complete!" and, because the legacy
  MacrosModule follows it with a pm2 restart, an outage for nothing.
- fewer than 3 attempts recorded, and the last was over 6 hours ago. If
  `update.sh` dies without writing a build state — killed, out of disk, no
  network — the first condition stays false forever, and without a cap we would
  relaunch it on every boot.

It is **deliberately not tied to the update flag**. A box whose flag was set once
and whose cycle 1 succeeded would otherwise need a second flag to get a verified
record, and nobody would know which boxes those were.

Two details that are load-bearing rather than defensive:

- **The attempt is recorded before the spawn, not after.** The updater restarts
  this process; anything written afterwards may never be written, and then the
  cap does not exist.
- **If the attempt cannot be recorded, nothing is launched.** A read-only home
  directory would otherwise become a reboot loop.
- **Detached**, for the same reason `handleUpdate()` is. An updater that is a
  child of the process it restarts is killed by that restart. That one froze ~93
  devices for weeks.

## Finding the affected boxes — no device change needed

`StatusTracker.readLastUpdate()` already reports `~/attitude-build.json`, and its
own comment says the right thing: *"Returns null on a device that has never run
the new updater."*

**Any box reporting no update record is on the old updater.** That is already
flowing to the server on every sync and needs only a column or a query on the
fleet view. It is a better census than update outcomes, because the old script's
outcome is always "complete" — which is precisely why 151 looked fine.

## Tests

15 new, in `test/legacy-bootstrap.test.mjs`. 83 total, all green.

They drive the real `MacrosModule` against a sandboxed HOME and cwd, and let the
**real** spawn happen against a stand-in `update.sh` that records that it ran,
what the bootstrap state looked like at the moment it started, and its own
process group.

Two things went wrong writing them, both worth recording:

**The first version intercepted `child_process.spawn` and tested nothing.**
`MacrosModule` imports `spawn` as a named binding, so reassigning the property
on the module namespace never reaches it. Every "did it launch" assertion passed
vacuously. Launching a real process is slower and is the only version that means
anything.

**The detached assertion compared the child's process group to `process.pid`.**
Those are different numbers unless the parent happens to be a group leader, so
the assertion could never fail — a `detached: false` mutant passed it cleanly. It
now compares against the parent's actual process group, read with `ps`.

Both were caught by mutation testing rather than by review. Five mutants —
ignoring the build state, launching the old updater, removing the attempt cap,
removing the retry window, and `detached: false` — and all five now fail the
suite.

## What this does not fix

**New cards still ship the old updater.** This makes them self-healing on first
flag; it does not make them correct. Whatever produces the image should take its
tree from current `main` when that becomes possible. The one-line check on any
image is `wc -l update.sh` — 26-ish lines is the old one, 690-ish is the real
one.

**Cycle 1 can still fail silently**, because it is the old script and nothing can
change that. What is different is that the box now tells you: a device that
reports no build record after a flag did not complete cycle 1, and should be
flagged again. Stagger a large rollout rather than flagging 500 boxes at once —
they share few public IPs, and the 403 is exactly what a burst produces.
