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

17 new, in `test/legacy-bootstrap.test.mjs`. 85 total, all green, 0.6 s.

**Split by platform, deliberately.** `bootstrapDecision()` is pure filesystem
reasoning and is tested everywhere — including on the Windows laptop where
`npm test` actually gets run before a push. The launch spawns a bash script and
reads process groups, so those three tests `skip` loudly on Windows rather than
passing quietly.

That split is the whole reason the decision was extracted from the launch in the
first place. Three things went wrong writing these, and all three are the same
failure wearing different clothes — **a test that cannot fail**:

**The first version intercepted `child_process.spawn` and tested nothing.**
`MacrosModule` imports `spawn` as a named binding, so reassigning the property on
the module namespace never reaches it. Every "did it launch" assertion passed
vacuously.

**The detached assertion compared the child's process group to `process.pid`.**
Those are different numbers unless the parent happens to be a group leader, so it
could never fail — a `detached: false` mutant passed cleanly. It now compares
against the parent's real process group, read with `ps`.

**And on Windows, seven "it must NOT launch" tests passed because nothing on
Windows can launch a bash script.** The suite reported green while covering none
of the logic it existed for. Splitting the decision out fixed it: those seven now
assert on `bootstrapDecision()` and run everywhere.

All caught by mutation testing rather than by review. Six mutants — ignoring the
build state, accepting the old updater, removing the attempt cap, removing the
retry window, unanchoring the marker regex, and `detached: false` — and every one
now fails the suite, including on the Windows path.

## One bug the Windows run exposed in the production code

`spawn` reports a failure to LAUNCH — not executable, not found — as an
asynchronous `'error'` event, and a `ChildProcess` with no listener for it throws
that error globally. The `try/catch` around the call cannot catch it, because by
then we have returned. On a device whose `update.sh` lost its executable bit that
would take the whole app down, which is a far worse outcome than not updating.
There is now a listener that logs it.

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
