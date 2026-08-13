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
# v3, 2026-08-11: the health check now requires proof that the app is RENDERING, not just
# that it is running. 2.A.9 passed v2's check with the lights frozen - see the render health
# section below. This is the failure v2 could not see and v3 exists to catch.
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
# Both windows can be overridden from the environment. That exists for testing: with a 900s
# timeout, exercising a failure path on the bench means waiting a quarter of an hour, and a
# check nobody is willing to test is a check nobody tests. Not for production use.
#   ATT_MIN_STABLE=10 ATT_MAX_WATCH=45 ./update.sh some-branch
MIN_STABLE_SECONDS="${ATT_MIN_STABLE:-60}"    # must be up at least this long, and seen talking to the server
MAX_WATCH_SECONDS="${ATT_MAX_WATCH:-900}"     # ...but wait up to this long for a slow device to get there
KEEP_SNAPSHOTS=2      # older rollback snapshots are pruned to save SD space

# Why 900 and not 240.
#
# 240 never meant 240 seconds. The old loop added 3 to a counter each pass and called it
# seconds, while each pass also spent a measured 1.368s starting pm2 (bench device, 2026-08-11,
# `time pm2 pid`) - so a nominal 240 was really ~360s here, and on AC-0020047 at 100MHz of
# 1512, where starting Node costs far more, plausibly twenty minutes or more. That accidental
# padding is the most likely reason this timeout has never fired on a throttled device.
#
# Now that the clock is honest, keeping 240 would QUIETLY CUT the budget on exactly the
# devices the long window exists for, and a timeout there means rolling back a good build and
# stranding the slowest units on old firmware forever. That is the failure this number was
# introduced to prevent.
#
# So it goes up, and the asymmetry says to err long: a too-short timeout strands a device
# permanently, a too-long one only delays a rollback that is coming anyway. It is also rarely
# reached now - a genuinely broken render loop fails in about 9s on the errored path, so this
# only governs the ambiguous states (no status file yet, not rendering yet), where patience is
# what we actually want.

# With the render check running we are no longer INFERRING health from how long the process
# has survived - we are watching it do its job. That is a stronger signal than duration, so
# the stability window can be shorter. It is not zero: the pid check still only covers the
# window we watch, and a build that dies at 40s should not have passed at 20s.
#
# Without the render check, duration is all we have, so it stays at 60.
MIN_STABLE_WITH_RENDER="${ATT_MIN_STABLE:-30}"

# Asking pm2 for the pid costs a Node process start - measured at 1.368s on the bench device
# and far more on one throttled to 100MHz. Doing that every 3s took CPU from the app we were
# trying to measure, and inflated a 60s window to 92s of wall clock. So the loop uses kill -0,
# which is free, and reconciles against pm2 occasionally and once more before passing.
PM2_RECHECK_EVERY=10

# --- render health -----------------------------------------------------------
# ADDED 2026-08-11, after a build passed this health check with the lights frozen.
#
# 2.A.9 shipped a fixture manager that called a method the engine it shipped alongside did
# not have. AttitudeFixtureManager threw on every frame, sACN went on transmitting the last
# frame it had, and the device sat there with a stable pid and an open socket to the server.
# The health check reported "pid stable 60s, server contact 20 of 20" and passed the build.
#
# Neither of the two things checked here can see that, and neither can be made to:
#   - the pid is stable, because the throw is caught inside the render loop
#   - the socket is open, because the network module is fine, and on the WebSocket build
#     the connection is held open continuously whether or not anything else still runs
#
# There is also no log to grep. Logger has console output disabled on field units
# (DEV_MODE=false) so that a fault cannot fill the SD card with log lines - which is
# correct, and means stderr is empty on a device that is failing 40 times a second.
#
# So the app writes what it knows to a small file on a memory-backed filesystem every few
# seconds - see writeLocalStatusFile() in ModuleStatusTracker.mjs - and we read it here.
# That gives POSITIVE proof of work done rather than absence of evidence of failure, and it
# catches a wedged event loop as well, which nothing above does.
#
# Set ATT_RENDER_CHECK=observe to log the render state without acting on it.
RENDER_CHECK_MODE="${ATT_RENDER_CHECK:-require}"
RENDER_STATUS_MARKER="ATTITUDE_STATUS_FILE_V1"
RENDER_STATUS_FILES="/dev/shm/attitude-status /run/shm/attitude-status /tmp/attitude-status"
RENDER_STALE_SECONDS=30   # the app rewrites it every 3s; 30 allows for a badly throttled device
RENDER_FAIL_SAMPLES=3     # consecutive errored samples before we roll back, so one blip does not

RESTART_EPOCH=0           # set just before the restart; the status file must be newer than this
RENDER_CHECK_APPLIES=0    # set once we know whether the installed build writes the file at all
render_errored_streak=0
render_state="unknown"

log() {
	echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" | tee -a "$LOG"
}

# Read a VERSION file.
#
# Keeps only the characters a version string is made of, which throws away line endings, NUL
# bytes and - the reason this exists - a byte order mark. A VERSION file saved from PowerShell
# or Notepad carries one, it is invisible in every editor, and it would make
# "$CUR_VERSION" = "$NEW_VERSION" compare false forever. Every flagged device would reinstall
# the same build, on a loop, for as long as the flag kept re-arming.
#
# Caught 2026-08-11 on a canary branch whose VERSION was written by 'echo' in PowerShell:
# the log line read 'version <BOM>2.A.10-canary'. On the fleet it would not have been a bad
# version string, it would have been an update loop across every device.
read_version() {
	tr -cd '[:alnum:]._+-' < "$1" 2>/dev/null
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


# Read one key out of the local status file. It is key=value lines rather than JSON
# precisely so that this needs nothing but sed - field devices have no jq.
status_value() {
	sed -n "s/^$2=//p" "$1" 2>/dev/null | head -1
}

# Classify what the app is telling us about rendering. Echoes one word:
#
#   ok        fixtures are being processed (or the device is unassigned, which is
#             legitimately not rendering anything - it outputs white and reports operational)
#   waiting   alive but has not proved itself yet. Normal for the first second or two,
#             and normal for a long time on a device throttled to 100MHz.
#   errored   the fixture manager is catching an exception. THIS is the 2.A.9 failure.
#   missing   no status file at all
#   preboot   a file left over from the process we just replaced
#   stale     the file stopped being updated - a wedged event loop looks like this
render_state_now() {
	local f found="" epoch now age fixtures fps assigned marker

	for f in $RENDER_STATUS_FILES; do
		if [ -f "$f" ]; then found="$f"; break; fi
	done

	if [ -z "$found" ]; then echo "missing"; return; fi

	marker="$(status_value "$found" marker)"
	if [ "$marker" != "$RENDER_STATUS_MARKER" ]; then echo "missing"; return; fi

	epoch="$(status_value "$found" epoch)"
	case "$epoch" in ''|*[!0-9]*) echo "missing"; return ;; esac

	# Written by the previous process, before we restarted. Not evidence of anything.
	if [ "$epoch" -lt "$RESTART_EPOCH" ]; then echo "preboot"; return; fi

	now="$(date +%s)"
	age=$((now - epoch))
	if [ "$age" -gt "$RENDER_STALE_SECONDS" ]; then echo "stale"; return; fi

	fixtures="$(status_value "$found" mod.AttitudeFixtureManager)"
	if [ "$fixtures" = "errored" ]; then echo "errored"; return; fi
	if [ "$fixtures" != "operational" ]; then echo "waiting"; return; fi

	assigned="$(status_value "$found" assigned)"
	if [ "$assigned" = "0" ]; then echo "ok"; return; fi

	fps="$(status_value "$found" renderfps)"
	case "$fps" in ''|*[!0-9]*) echo "waiting"; return ;; esac
	if [ "$fps" -gt 0 ]; then echo "ok"; return; fi

	echo "waiting"
}

watch_and_check() {
	local start_pid pid seen=0 samples=0 elapsed=0 t_start min_stable

	start_pid="$(app_pid)"
	case "$start_pid" in
		''|*[!0-9]*)
			log "health: pm2 gave no usable pid after restart ('$start_pid')"
			return 1
			;;
	esac
	pid="$start_pid"

	# The render check is the stronger of the two gates, so it buys a shorter one of these.
	min_stable="$MIN_STABLE_SECONDS"
	if [ "$RENDER_CHECK_APPLIES" -eq 1 ]; then
		min_stable="$MIN_STABLE_WITH_RENDER"
	fi

	# Real elapsed time, not a count of loop iterations. The old version added 3 per pass and
	# called it seconds, which was wrong by however long the work in the loop took - measured
	# at 92s of wall clock for a nominal 60s window on the bench device, and unknown but much
	# worse on a throttled one. A window whose real length nobody knows cannot be tuned.
	t_start="$(date +%s)"

	while [ "$elapsed" -lt "$MAX_WATCH_SECONDS" ]; do
		sleep 3
		elapsed=$(( $(date +%s) - t_start ))
		samples=$((samples + 1))

		# Free liveness check. A crash-respawn gives pm2 a new pid, so the original one
		# stops existing and this catches it on the next sample.
		if ! kill -0 "$start_pid" 2>/dev/null; then
			log "health: pid $start_pid is gone at t=${elapsed}s (the app crashed and was respawned)"
			return 1
		fi

		# ...and reconcile with pm2 now and then, in case the process is lingering as a
		# zombie or pm2 has moved on to a different one. Occasionally, because it is not free.
		if [ $((samples % PM2_RECHECK_EVERY)) -eq 0 ]; then
			pid="$(app_pid)"
			if [ "$pid" != "$start_pid" ]; then
				log "health: pid changed $start_pid -> ${pid:-none} at t=${elapsed}s (the app restarted)"
				return 1
			fi
		fi

		if ss -tanp 2>/dev/null | grep "pid=${start_pid}," | grep -q ':443'; then
			seen=$((seen + 1))
		fi

		if [ "$RENDER_CHECK_APPLIES" -eq 1 ]; then
			render_state="$(render_state_now)"

			if [ "$render_state" = "errored" ]; then
				render_errored_streak=$((render_errored_streak + 1))
			else
				render_errored_streak=0
			fi

			# Fail fast on a genuinely broken render loop rather than waiting out the whole
			# window. Several consecutive samples, so that one caught exception during
			# startup - a config that arrives a moment late, say - is not a rollback.
			if [ "$render_errored_streak" -ge "$RENDER_FAIL_SAMPLES" ]; then
				if [ "$RENDER_CHECK_MODE" = "observe" ]; then
					log "health: OBSERVE ONLY - fixture manager errored on $render_errored_streak consecutive samples at t=${elapsed}s"
				else
					log "health: fixture manager errored on $render_errored_streak consecutive samples at t=${elapsed}s - the app is up but not rendering"
					log "health: $(grep . /dev/shm/attitude-status /run/shm/attitude-status /tmp/attitude-status 2>/dev/null | grep -E 'renderfps|overall|Fixture|SACN' | tr '\n' ' ')"
					return 1
				fi
			fi
		fi

		# Early exit. Once the process has held together for the stability window, we have
		# actually watched it reach the server, and it is doing the work it exists to do,
		# there is nothing further to learn by waiting.
		if [ "$elapsed" -ge "$min_stable" ] && [ "$seen" -gt 0 ] \
			&& { [ "$RENDER_CHECK_APPLIES" -eq 0 ] || [ "$render_state" = "ok" ] || [ "$RENDER_CHECK_MODE" = "observe" ]; }; then

			# One authoritative pm2 check before accepting, whatever the sample count is.
			# Everything above this point was deliberately cheap; this is the one place it
			# is worth paying for certainty.
			pid="$(app_pid)"
			if [ "$pid" != "$start_pid" ]; then
				log "health: pid changed $start_pid -> ${pid:-none} at t=${elapsed}s (the app restarted)"
				return 1
			fi

			log "health: pid $pid stable ${elapsed}s, server contact on $seen of $samples samples, render=$render_state"
			return 0
		fi
	done

	if [ "$RENDER_CHECK_APPLIES" -eq 1 ] && [ "$render_state" != "ok" ]; then
		log "health: pid $pid stayed up ${MAX_WATCH_SECONDS}s but never proved it was rendering (render=$render_state, server contact on $seen of $samples samples)"
		case "$render_state" in
			missing) log "health: no local status file - the app never got as far as writing one" ;;
			preboot) log "health: the only status file is older than the restart - the new process never wrote one" ;;
			stale)   log "health: the status file stopped being updated - the event loop is wedged" ;;
			waiting) log "health: fixtures never reported operational with a non-zero frame rate" ;;
		esac
		return 1
	fi

	log "health: pid $pid stayed up ${MAX_WATCH_SECONDS}s but never reached the server on :443"
	log "health: cpu $(cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_max_freq 2>/dev/null || echo '?') of $(cat /sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq 2>/dev/null || echo '?') kHz"
	ss -tanp 2>/dev/null | grep "pid=${start_pid}," | head -5 | while read -r l; do log "health:   $l"; done
	return 1
}


# Strip anything that would break the JSON below. These strings are ours, not user input,
# but a stray quote in a failure message should not produce a file the device cannot parse.
json_escape() {
	printf '%s' "$1" | tr -d '"\\' | tr '\n' ' '
}


# Record what happened, so the fleet operator can see it without SSH into the device.
# A silent rollback is indistinguishable from a successful update, which is exactly the
# ambiguity this removes.
write_build_state() {
	local outcome="$1"
	local detail="$2"
	local installed
	local tail_lines

	installed="$(read_version "$APP_DIR/VERSION")"

	# Last few log lines travel with the state. With no SSH into field devices this is often
	# the only way anyone will ever see why something failed.
	tail_lines="$(tail -n 4 "$LOG" 2>/dev/null | tr '\n' '|')"

	cat > "$BUILD_STATE" 2>/dev/null <<EOF || true
{
  "outcome": "$(json_escape "$outcome")",
  "detail": "$(json_escape "$detail")",
  "branch": "$(json_escape "$BRANCH")",
  "at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "fromVersion": "$(json_escape "$CUR_VERSION")",
  "toVersion": "$(json_escape "$NEW_VERSION")",
  "installedVersion": "$(json_escape "$installed")",
  "sourceSha256": "$(json_escape "$SRC_SHA")",
  "log": "$(json_escape "$tail_lines")"
}
EOF
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

	pm2 stop "$PM2_APP_NAME" >/dev/null 2>&1 9>&-

	# Restore with rsync --delete rather than removing and recreating the directory.
	# This script lives inside APP_DIR and is still executing; deleting the directory
	# out from under a running bash script - and out from under our own cwd - is not
	# something to rely on, even where the kernel tolerates it.
	if ! rsync -a --delete "$SNAPSHOT/" "$APP_DIR/"; then
		log "CRITICAL: could not restore snapshot $SNAPSHOT - manual recovery needed"
		pm2 restart "$PM2_APP_NAME" >/dev/null 2>&1 9>&-
		exit 2
	fi
	cp -p "$WORK/config.json.keep" "$APP_DIR/config.json" 2>/dev/null

	pm2 restart "$PM2_APP_NAME" >/dev/null 2>&1 9>&-
	log "rollback complete - restored from $SNAPSHOT"
	write_build_state "rolled-back" "$*"
	rm -rf "$WORK"
	exit 2
}

# Only one updater at a time. The macro handshake re-arms the update flag on failure with
# no cap, so a second run can start while the first is still installing - two processes
# snapshotting and rsyncing the same directory produces silent, unreproducible corruption.
# NOTE ON FD 9. Every command run from here on must close it explicitly with 9>&-, and the
# pm2 calls below do. fd 9 is inherited by children, so a child that outlives this script goes
# on holding the lock after we are gone.
#
# Observed 2026-08-13: the updater was killed during its own pm2 restart, but the orphaned
# `pm2 restart` process kept fd 9 open, and the next update 26 seconds later was refused with
# "another update is already running" - blocked by a lock whose owner no longer existed.
LOCK_FILE="${HOME:-/home/attitude}/.attitude-update.lock"
exec 9>"$LOCK_FILE" 2>/dev/null || true
if ! flock -n 9 2>/dev/null; then
	# Exit 0, not an error. The macro handshake treats a non-zero exit as failure and re-arms
	# the update flag, so exiting non-zero here made a harmless collision look like a failed
	# update and started a retry loop on devices that were already current.
	log "another update is already running - nothing to do"
	exit 0
fi

log "=== update start (branch=$BRANCH) ==="

# ---------------------------------------------------------------------------
# 1. Fetch and validate. Nothing live is touched in this section.
# ---------------------------------------------------------------------------
# ss is used by the health check below. If it is unavailable we cannot tell a
# working install from a dead one, so stop before changing anything.
command -v ss >/dev/null 2>&1 || abort "ss (iproute2) not found - cannot verify device health"

mkdir -p "$WORK" || abort "cannot create work dir $WORK"

# Nothing live has been touched yet, so an interruption here is free - just clean up.
trap 'log "interrupted before any change was made"; rm -rf "$WORK"; exit 1' INT TERM HUP

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
CUR_VERSION="$(read_version "$APP_DIR/VERSION")"

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

NEW_VERSION="$(read_version "$SRC/VERSION")"

# Nothing to do if we already have this version. Without this the updater downloads,
# snapshots, rsyncs and restarts in order to arrive exactly where it started - and combined
# with a re-armed flag that became a permanent loop on already-current devices. Set
# ATT_FORCE=1 to reinstall the same version deliberately.
if [ -n "$CUR_VERSION" ] && [ "$CUR_VERSION" = "$NEW_VERSION" ] && [ "${ATT_FORCE:-0}" != "1" ]; then
	log "already on ${CUR_VERSION} - nothing to do"
	write_build_state "already-current" "already on ${CUR_VERSION}"
	rm -rf "$WORK"
	exit 0
fi

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

# From here on the live directory is going to be rewritten, so an interruption is NOT free.
#
# Observed on the bench 2026-08-11: a Ctrl-C during the watch loop left new files installed
# and pm2 restarted, with no health check, no rollback and no build-state record - an
# unverified build running and nothing anywhere saying so. That is the one state this script
# exists to make impossible.
#
# So an interrupt from here on lands where every other failure lands: back on the build that
# was known to work. The trap is cleared first so that a second Ctrl-C during the rollback
# does not re-enter it.
trap 'trap - INT TERM HUP; log "interrupted after files were installed"; rollback "update was interrupted before the health check finished"' INT TERM HUP

# ---------------------------------------------------------------------------
# 3. Install and restart.
# ---------------------------------------------------------------------------
if ! rsync -a "$SRC/" "$APP_DIR/"; then
	rollback "rsync failed partway through install"
fi
log "files installed"

# Does the build we just installed write a local status file? Asked of the code that is now
# running, not of a version number, so that installing an older build or a branch that
# predates this simply skips the render check instead of rolling itself back.
if grep -q "$RENDER_STATUS_MARKER" "$APP_DIR/ModuleStatusTracker.mjs" 2>/dev/null; then
	RENDER_CHECK_APPLIES=1
	log "render check: enabled (mode=$RENDER_CHECK_MODE)"
else
	log "render check: not available in this build - falling back to pid and server contact only"
fi

# Everything the status file says about the run before this moment is history. Recorded
# before the restart so there is no window in which a leftover file could look current.
RESTART_EPOCH="$(date +%s)"

# STOP LISTENING FOR INTERRUPTS FROM HERE ON.
#
# This script is normally launched by MacrosModule with exec('./update.sh'), which makes it a
# CHILD OF THE APP. The next thing it does is restart that app. pm2's default kill signal is
# SIGINT and it kills the whole process tree, so the restart below delivers a signal to this
# script every single time - not as a failure, but as the ordinary consequence of doing its job.
#
# The rollback trap armed at snapshot time therefore fired on every macro-triggered update:
# install, get signalled, start rolling back, get killed mid-rollback, flag re-arms, repeat.
# Observed on the bench 2026-08-12, three cycles in four minutes.
#
# So the trap is cleared before the restart rather than after it. It protected the window it
# was written for - between the snapshot and the end of rsync, where an interrupt really does
# leave a half-installed directory - and that window has now closed.
#
# HUP is included because a dying parent can deliver it too - the app is about to be that parent.
#
# NOTE: this means Ctrl-C no longer stops a manual run once the restart begins. That is the
# correct trade: an interrupt here is far more likely to be pm2 doing its job than a person
# changing their mind.
trap '' INT TERM HUP

# pm2 is itself a Node CLI. On a device throttled to 100MHz of 1512 it can take many seconds
# to start, and a single non-zero return rolled back a perfectly good build on AC-0020001.
restart_ok=0
for restart_attempt in 1 2 3; do
	if pm2 restart "$PM2_APP_NAME" >/dev/null 2>&1 9>&-; then
		restart_ok=1
		break
	fi

	log "pm2 restart attempt $restart_attempt of 3 failed"
	sleep 5
done

if [ "$restart_ok" -ne 1 ]; then
	rollback "pm2 restart failed after 3 attempts"
fi

# ---------------------------------------------------------------------------
# 4. Health check. A crash loop is the failure mode that matters most, because
#    it is the one that costs a site visit.
# ---------------------------------------------------------------------------
log "restarted - watching (pass at $([ "$RENDER_CHECK_APPLIES" -eq 1 ] && echo "$MIN_STABLE_WITH_RENDER" || echo "$MIN_STABLE_SECONDS")s, give up at ${MAX_WATCH_SECONDS}s)"

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
