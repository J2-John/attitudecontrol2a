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
# Canonical firmware repo. Override with the ATT_REPO_URL environment variable to
# install from a fork - useful for canary testing a branch before it reaches main:
#   ATT_REPO_URL=https://github.com/J2-John/attitudecontrol2a ./update.sh my-branch
REPO_URL="${ATT_REPO_URL:-https://github.com/DrewJSquared/attitudecontrol2a}"
BRANCH="${1:-main}"

STAMP="$(date +%Y%m%d-%H%M%S)"
SNAPSHOT="$PARENT_DIR/${APP_BASENAME}.rollback-$STAMP"
WORK="/tmp/attitude-update-$$"
LOG="/home/attitude/attitude-update.log"

# Written on every terminal path - success, abort, and rollback - and read back by
# StatusTracker, which reports it to the server on the normal status cycle. Deliberately
# OUTSIDE the app directory: rsync --delete during a rollback would otherwise wipe the very
# record that says a rollback happened.
BUILD_STATE="${HOME:-/home/attitude}/attitude-build.json"

# Populated as we go. Declared up front because 'set -u' is on and the abort path can fire
# before any of them are known.
CUR_VERSION=""
NEW_VERSION=""
SRC_SHA=""

# Do not hold the app directory as our working directory - it gets rewritten below.
cd / || exit 1

# A fixed watch window was biased against exactly the devices that most need updating.
# AC-0020047 runs at 100MHz of 1512 - roughly a fifteenth of a healthy device - so Node
# takes far longer there to boot, load config, start eight modules and open a socket. A flat
# 90s window timed it out mid-startup and rolled back a perfectly good build, which would
# have left every throttled device in the fleet permanently on old firmware.
#
# So: pass as soon as the build has proved itself, but wait a lot longer before giving up.
# A real crash loop still fails in seconds, because that is detected by the pid changing
# rather than by the clock running out.
MIN_STABLE_SECONDS=60    # must be up at least this long, and seen talking to the server
MAX_WATCH_SECONDS=240    # ...but wait up to this long for a slow device to get there
KEEP_SNAPSHOTS=2      # older rollback snapshots are pruned to save SD space

log() {
	echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" | tee -a "$LOG"
}

# Watch the app across the whole settle window and decide whether it is working.
#
# Deliberately does NOT ask pm2 whether it is happy. pm2 reports a process as
# "online" the moment it forks, before knowing whether it survived - observed on
# 2026-08-08 reporting "online" with a single restart for a build that could not
# load at all. Its status field and restart counter are both unreliable here.
#
# Two things are checked, and both are sampled continuously rather than once at
# the end, because a single sample cannot tell a stable process from a respawned
# one and cannot see a short-lived HTTP request that closed a moment earlier:
#
#   1. the PID never changes  - a crash-respawn gives a different pid
#   2. we see the app talking to the server at least once on :443
#
# (2) is the property that actually matters. A device that can reach the server
# can still be updated, so a bad build stays recoverable remotely. One that
# cannot is a site visit. Both transports are covered: the WebSocket build holds
# one connection open continuously, the HTTP build opens a short one every
# second, and sampling across 90s catches either.
app_pid() {
	pm2 pid "$PM2_APP_NAME" 2>/dev/null | tr -d '[:space:]'
}

watch_and_check() {
	local start_pid pid seen=0 samples=0 elapsed=0

	start_pid="$(app_pid)"
	case "$start_pid" in
		''|*[!0-9]*)
			log "health: pm2 gave no usable pid after restart ('$start_pid')"
			return 1
			;;
	esac

	while [ "$elapsed" -lt "$MAX_WATCH_SECONDS" ]; do
		sleep 3
		elapsed=$((elapsed + 3))
		samples=$((samples + 1))

		pid="$(app_pid)"
		case "$pid" in
			''|*[!0-9]*)
				log "health: no running process at t=${elapsed}s"
				return 1
				;;
		esac

		if [ "$pid" != "$start_pid" ]; then
			log "health: pid changed $start_pid -> $pid at t=${elapsed}s (the app restarted)"
			return 1
		fi

		if ! kill -0 "$pid" 2>/dev/null; then
			log "health: pid $pid died at t=${elapsed}s"
			return 1
		fi

		if ss -tanp 2>/dev/null | grep "pid=${pid}," | grep -q ':443'; then
			seen=$((seen + 1))
		fi

		# Early exit. Once the process has held together for MIN_STABLE_SECONDS and we have
		# actually watched it reach the server, there is nothing further to learn by waiting -
		# and on a healthy device this finishes sooner than the old fixed window did.
		if [ "$elapsed" -ge "$MIN_STABLE_SECONDS" ] && [ "$seen" -gt 0 ]; then
			log "health: pid $pid stable ${elapsed}s, server contact on $seen of $samples samples"
			return 0
		fi
	done

	log "health: pid $pid stayed up ${MAX_WATCH_SECONDS}s but never reached the server on :443"
	log "health: cpu $(cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_max_freq 2>/dev/null || echo '?') of $(cat /sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq 2>/dev/null || echo '?') kHz"
	ss -tanp 2>/dev/null | grep "pid=${start_pid}," | head -5 | while read -r l; do log "health:   $l"; done
	return 1
}


abort() {
	log "ABORTED: $* (live install untouched)"
	write_build_state "aborted" "$*"
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
	write_build_state "rolled-back" "$*"
	rm -rf "$WORK"
	exit 2
}

# Only one updater at a time. The macro handshake re-arms the update flag on failure with
# no cap, so a second run can start while the first is still installing - two processes
# snapshotting and rsyncing the same directory produces silent, unreproducible corruption.
LOCK_FILE="${HOME:-/home/attitude}/.attitude-update.lock"
exec 9>"$LOCK_FILE" 2>/dev/null || true
if ! flock -n 9 2>/dev/null; then
	log "another update is already running - exiting without changes"
	exit 3
fi

log "=== update start (branch=$BRANCH) ==="

# ---------------------------------------------------------------------------
# 1. Fetch and validate. Nothing live is touched in this section.
# ---------------------------------------------------------------------------
# ss is used by the health check below. If it is unavailable we cannot tell a
# working install from a dead one, so stop before changing anything.
command -v ss >/dev/null 2>&1 || abort "ss (iproute2) not found - cannot verify device health"

mkdir -p "$WORK" || abort "cannot create work dir $WORK"

# GitHub's archive endpoint rate-limits unauthenticated requests and answers with
# 404 when it does - indistinguishable from a branch that does not exist. Observed
# 2026-08-08 after roughly six pulls in twenty minutes from one IP. Several devices
# at one site share a public IP, so this is a fleet-scale concern, not a lab quirk.
# Retry with backoff rather than abandoning the update on a transient refusal.
ZIP_URL="$REPO_URL/archive/refs/heads/$BRANCH.zip"
log "fetching $ZIP_URL"

# The unzip is inside this loop deliberately. A truncated or corrupt archive is exactly
# the kind of transient failure retrying fixes, and treating it as fatal - as the first
# version of this did - turns a blip into a device that never updates. Observed in the
# field 2026-08-09: "zip is corrupt or incomplete" after curl reported success.
CUR_VERSION="$(tr -d '\r\n' < "$APP_DIR/VERSION" 2>/dev/null)"

fetch_max=4
fetch_delay=10
fetch_ok=0
ZIP_BYTES=0

for fetch_attempt in $(seq 1 "$fetch_max"); do
	# start each attempt from nothing, so a partial unpack cannot be mistaken for a good one
	rm -rf "$WORK/unz" "$WORK/src.zip"

	if ! curl -fsSL --max-time 300 -o "$WORK/src.zip" "$ZIP_URL"; then
		log "attempt $fetch_attempt/$fetch_max: download failed"
	else
		# recorded before validation, so an abort can say what actually arrived
		ZIP_BYTES="$(stat -c %s "$WORK/src.zip" 2>/dev/null || echo 0)"
		SRC_SHA="$(sha256sum "$WORK/src.zip" 2>/dev/null | cut -c1-12)"

		if unzip -q "$WORK/src.zip" -d "$WORK/unz"; then
			fetch_ok=1
			break
		fi

		log "attempt $fetch_attempt/$fetch_max: archive did not unpack (bytes=$ZIP_BYTES sha=$SRC_SHA)"
	fi

	if [ "$fetch_attempt" -lt "$fetch_max" ]; then
		sleep "$fetch_delay"
		fetch_delay=$((fetch_delay * 2))
	fi
done

if [ "$fetch_ok" -ne 1 ]; then
	# include free space: a full /tmp produces a corrupt-archive symptom, and with no SSH
	# into field devices this line may be the only way anyone ever finds that out
	abort "no usable archive after $fetch_max attempts (bytes=$ZIP_BYTES sha=${SRC_SHA:-none} tmpfreeMB=$(df -Pm /tmp 2>/dev/null | awk 'NR==2{print $4}') rootfreeMB=$(df -Pm / 2>/dev/null | awk 'NR==2{print $4}'))"
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

NEW_VERSION="$(tr -d '\r\n' < "$SRC/VERSION" 2>/dev/null)"

log "download validated (${ZIP_BYTES} bytes, sha ${SRC_SHA:-unknown}) version ${CUR_VERSION:-unknown} -> ${NEW_VERSION:-unknown}"

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
log "restarted - watching (pass at ${MIN_STABLE_SECONDS}s, give up at ${MAX_WATCH_SECONDS}s)"

if ! watch_and_check; then
	rollback "new build failed the health check"
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
write_build_state "updated" "installed ${NEW_VERSION:-unknown} from $BRANCH"

log "=== update complete (branch=$BRANCH, version=${NEW_VERSION:-unknown}) ==="
exit 0
