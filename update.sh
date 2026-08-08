#!/bin/bash
# update.sh — rollback-capable updater for AttitudeControl2A
# v2, 2026-08-08. Replaces the original fire-and-forget updater.
#
# What changed from v1, and why:
#   1. Validates the download BEFORE touching the live directory. A failed or
#      truncated fetch now leaves the running install completely untouched.
#      v1 unzipped straight over the top and could half-install a broken build.
#   2. Snapshots with hardlinks (cp -al). Near-instant, and writes almost nothing
#      to the SD card - it creates directory entries, not copies of file data.
#   3. Health-checks after restart and AUTOMATICALLY ROLLS BACK if the app does
#      not come up clean. This is the whole point: with no SSH into field units,
#      a bad push otherwise means a truck roll.
#   4. Returns real exit codes and logs to a file. v1 always exited 0 and
#      reported success unconditionally, so failures were invisible.
#
# Usage:
#   ./update.sh              install main
#   ./update.sh some-branch  install a branch (canary testing)
#
# Exit codes: 0 = updated OK, 1 = aborted before any change, 2 = rolled back.

# Deliberately NOT 'set -e'. We want to handle failures ourselves so we can roll
# back, rather than dying halfway with the live directory in an unknown state.
set -uo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PARENT_DIR="$(dirname "$APP_DIR")"
APP_BASENAME="$(basename "$APP_DIR")"

PM2_APP_NAME="AttitudeControl2A"
REPO_URL="https://github.com/DrewJSquared/attitudecontrol2a"
BRANCH="${1:-main}"

STAMP="$(date +%Y%m%d-%H%M%S)"
SNAPSHOT="$PARENT_DIR/${APP_BASENAME}.rollback-$STAMP"
WORK="/tmp/attitude-update-$$"
LOG="/home/attitude/attitude-update.log"

# Do not hold the app directory as our working directory - it gets rewritten below.
cd / || exit 1

SETTLE_SECONDS=90     # how long the new build must stay up before we trust it
KEEP_SNAPSHOTS=2      # older rollback snapshots are pruned to save SD space

log() {
	echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" | tee -a "$LOG"
}

# Read one process's state out of pm2. Prints: "<status> <restart_count>"
pm2_state() {
	pm2 jlist 2>/dev/null | node -e '
		let s = "";
		process.stdin.on("data", d => s += d).on("end", () => {
			try {
				const list = JSON.parse(s);
				const p = list.find(x => x.name === process.argv[1]);
				if (!p) { console.log("missing 0"); return; }
				console.log(p.pm2_env.status, p.pm2_env.restart_time);
			} catch (e) { console.log("unreadable 0"); }
		});
	' "$PM2_APP_NAME"
}

abort() {
	log "ABORTED: $* (live install untouched)"
	rm -rf "$WORK"
	exit 1
}

rollback() {
	log "ROLLING BACK: $*"
	# Keep whatever config the device is holding now - it came from the server
	# and is newer than the snapshot's copy.
	cp -p "$APP_DIR/config.json" "$WORK/config.json.keep" 2>/dev/null

	pm2 stop "$PM2_APP_NAME" >/dev/null 2>&1

	# Restore with rsync --delete rather than removing and recreating the directory.
	# This script lives inside APP_DIR and is still executing; deleting the directory
	# out from under a running bash script - and out from under our own cwd - is not
	# something to rely on, even where the kernel tolerates it.
	if ! rsync -a --delete "$SNAPSHOT/" "$APP_DIR/"; then
		log "CRITICAL: could not restore snapshot $SNAPSHOT - manual recovery needed"
		pm2 restart "$PM2_APP_NAME" >/dev/null 2>&1
		exit 2
	fi
	cp -p "$WORK/config.json.keep" "$APP_DIR/config.json" 2>/dev/null

	pm2 restart "$PM2_APP_NAME" >/dev/null 2>&1
	log "rollback complete - restored from $SNAPSHOT"
	rm -rf "$WORK"
	exit 2
}

log "=== update start (branch=$BRANCH) ==="

# ---------------------------------------------------------------------------
# 1. Fetch and validate. Nothing live is touched in this section.
# ---------------------------------------------------------------------------
mkdir -p "$WORK" || abort "cannot create work dir $WORK"

if ! curl -fSL --max-time 300 -o "$WORK/src.zip" "$REPO_URL/archive/refs/heads/$BRANCH.zip"; then
	abort "download failed"
fi

if ! unzip -q "$WORK/src.zip" -d "$WORK/unz"; then
	abort "zip is corrupt or incomplete"
fi

SRC="$(find "$WORK/unz" -mindepth 1 -maxdepth 1 -type d | head -1)"
[ -n "$SRC" ]                        || abort "no directory found inside zip"
[ -f "$SRC/AttitudeControl2A.js" ]   || abort "entrypoint missing from download"
[ -d "$SRC/node_modules" ]           || abort "node_modules missing (there is no npm install step)"

# Syntax-check the entrypoint. Catches a mangled download before it can take
# the device offline. Not a full test, but it is free.
if ! node --check "$SRC/AttitudeControl2A.js" 2>/dev/null; then
	abort "downloaded entrypoint does not parse"
fi

log "download validated ($(du -sh "$SRC" | cut -f1))"

# ---------------------------------------------------------------------------
# 2. Snapshot the current install. Hardlinks, so this is fast and cheap.
#    rsync replaces files by writing a temp file and renaming, which creates a
#    new inode - so the snapshot's hardlinks keep pointing at the OLD contents.
# ---------------------------------------------------------------------------
rm -rf "$SNAPSHOT"
if ! cp -al "$APP_DIR" "$SNAPSHOT"; then
	abort "could not snapshot current install"
fi

# config.json is written by the app itself, possibly in place, so give the
# snapshot its own real copy rather than a hardlink that could be mutated.
rm -f "$SNAPSHOT/config.json"
cp -p "$APP_DIR/config.json" "$SNAPSHOT/config.json" 2>/dev/null

log "snapshot created: $SNAPSHOT"

BEFORE_RESTARTS="$(pm2_state | awk '{print $2}')"

# ---------------------------------------------------------------------------
# 3. Install and restart.
# ---------------------------------------------------------------------------
if ! rsync -a "$SRC/" "$APP_DIR/"; then
	rollback "rsync failed partway through install"
fi
log "files installed"

if ! pm2 restart "$PM2_APP_NAME" >/dev/null 2>&1; then
	rollback "pm2 restart failed"
fi

# ---------------------------------------------------------------------------
# 4. Health check. A crash loop is the failure mode that matters most, because
#    it is the one that costs a site visit.
# ---------------------------------------------------------------------------
log "restarted - watching for ${SETTLE_SECONDS}s"
sleep "$SETTLE_SECONDS"

read -r STATUS AFTER_RESTARTS <<< "$(pm2_state)"

if [ "$STATUS" != "online" ]; then
	rollback "process is '$STATUS' after ${SETTLE_SECONDS}s"
fi

# One restart is the one we asked for. More than that means it is crash looping.
if [ "$((AFTER_RESTARTS - BEFORE_RESTARTS))" -gt 1 ]; then
	rollback "process restarted $((AFTER_RESTARTS - BEFORE_RESTARTS)) times in ${SETTLE_SECONDS}s"
fi

# config.json must survive the update. It is gitignored so rsync never ships one,
# but a missing file here would mean the device lost its configuration and has to
# refetch everything - worth flagging even though it is not fatal.
#
# Note: mtime is NOT a sync signal. Since the ConfigManager write guard landed,
# config.json is only written when the content actually changes, so a stale mtime
# on a healthy device is normal and expected.
if [ ! -s "$APP_DIR/config.json" ]; then
	log "WARNING: config.json missing or empty after update"
fi

# ---------------------------------------------------------------------------
# 5. Success. Prune old snapshots so they do not fill the card.
# ---------------------------------------------------------------------------
ls -1dt "$PARENT_DIR/${APP_BASENAME}.rollback-"* 2>/dev/null \
	| tail -n +$((KEEP_SNAPSHOTS + 1)) \
	| xargs -r rm -rf

rm -rf "$WORK"
log "=== update complete (branch=$BRANCH) ==="
exit 0
