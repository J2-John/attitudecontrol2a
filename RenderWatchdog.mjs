// RenderWatchdog.mjs
// Detects frozen DMX output on a device that still reports itself healthy.
// copyright 2026 Drew Shipps, J Squared Systems


// THE PROBLEM THIS EXISTS FOR
//
// A 2.A device can stop rendering while every health signal says it is fine. Three routes are
// known, and none of them is visible today:
//
//   1. AttitudeFixtureManager stops emitting entirely -> ModuleStatusTracker marks it
//      'unresponsive' after 35s, which matches neither the errored branch nor the degraded branch
//      of the white-backup decision, so it falls through to the network checks and the device
//      reports 'online' with a rainbow LED.
//   2. Every zone throws -> 'degraded'. The white backup is not merely skipped, it is actively
//      DISABLED by the else branch, and output stays frozen on the last good frame.
//   3. engine.run() throws -> swallowed inside the engine. this.pixelData still holds the
//      previous frame, getFixtureColor keeps serving those pixels, and the status stays
//      'operational' forever.
//
// Measured, on the real modules: in route 3 the device reports renderfps=40, mod.
// AttitudeFixtureManager=operational, overall=online, last_fps=41 - and has not rendered a new
// frame in minutes.
//
//
// WHY THE OUTPUT ITSELF CANNOT BE WATCHED
//
// Two facts settle the design, and both were established by running the real code rather than
// reading it.
//
// FIRST: a frozen device is not silent. AttitudeSACN's transmit loop is a separate 24ms interval
// with no handshake to the 25ms render loop and no freshness check - the only guard on the send
// is whether the universe has a route. slotsDatas is a live view into the outgoing packet, so the
// last values written stay in it forever. In route 3 the fixture manager actively RE-ASSERTS the
// stale frame 40 times a second, because getFixtureColor keeps handing it the same pixels. The
// result is a live, valid, correctly-sequenced sACN stream carrying a stale frame. No receiver -
// fixture, Emit-8 or third-party node - can tell it from a healthy show. Detection has to happen
// on the device, upstream of attitudeSACN.set().
//
// SECOND: "the pixels changed" is NOT a liveness signal. A Static show recomputes and rewrites
// the same values every frame - measured over 10 frames: 10 renders, 10 sets of DMX writes, 1
// distinct output. A healthy Static show and a route-3 frozen show are byte-identical at every
// observable point. Any change-detector would fire on every Static show, every paused show, every
// solid-colour scene and every show sitting at the top of a slow fade. That is a false alarm on
// the reliability signal itself, which is worse than no signal: "a false pass is worse than a
// failure" cuts both ways.
//
//
// WHAT IS ACTUALLY WATCHED
//
//   Did the render pipeline reach a DMX write for EVERY patched segment this frame?
//
// Not whether the values changed - whether the decision was made. That predicate is true in every
// healthy mode and false in every failure mode:
//
//   Static show            -> every segment written, identical values.        LIVE
//   Table playback         -> engine.run() deliberately skipped, but every
//                             segment is still written from the table.        LIVE
//   Unassigned device      -> white re-asserted to all channels.              LIVE
//   Show id 0 (black)      -> black written to every segment.                 LIVE
//   Server-only, no table  -> white written to every segment.                 LIVE
//   engine.run() throws    -> stale pixels still written...                   see below
//   a zone throws          -> forEach aborts mid-way, segments left unwritten. FROZEN
//   fixture manager stops  -> no frame at all.                                 FROZEN
//
// Route 3 needs a second signal, and it is worth stating why rather than glossing: when run()
// throws with pixelData intact, the segment loop still runs and still writes - with last frame's
// pixels - so segment coverage alone does NOT catch it.
//
// The obvious second signal is the engine's frame counter, and it is WRONG. run() calls
// incrementFrameCounter() on its very first line, BEFORE the try, so the counter advances
// identically whether the frame rendered or threw. Measured: counter 2 -> 3 across a run() that
// threw and served stale pixels. A watchdog built on it would have reported healthy through
// exactly the failure it was written to catch.
//
// The signal that does work is the one already sitting there unused: run() returns undefined on
// every success path (the four calculate*Effect functions return nothing) and returns
// {red:0, green:0, blue:0} from its catch. Measured, both. AttitudeFixtureManager currently
// DISCARDS that return value - the comment claiming "run() falls back to black on this path"
// describes an intent the caller never honoured - so reading it costs nothing and changes no
// behaviour.
//
// That this needs no change to AttitudeEngine3.mjs is not a small detail. The engine is vendored
// byte-identically into the gateway and the browser, and its content fingerprint gates whether a
// device will accept a server-rendered table. Touching it would roll the fingerprint a second
// time in one release and drag the deploy-order dance along with it. The watchdog stays entirely
// on the fixture-manager side of that line.


// How long output must be stale before it is called frozen.
//
// The render loop is 25ms, so this is 200 frames. Deliberately far above any single-frame glitch -
// there is a known one-frame stale artefact when a group's segment count changes, because
// isFullyCovered() is checked before the patch phase registers that frame's needs - and far below
// the 35s it currently takes a silent module to be noticed at all.
export const FROZEN_AFTER_MS = 5000;

// How often the watchdog evaluates itself and emits.
//
// WHAT THIS CANNOT SEE: it runs on the same event loop it is watching. A render loop that HANGS -
// rather than misrendering - stops this timer too, so nothing is emitted at all. That case is
// covered instead by the local status file going stale, which update.sh already classifies. This
// watchdog is for the loop that keeps running and produces nothing useful.
//
// Its own timer, NOT a call from inside processFixtures. The fixture manager emits 'degraded'
// then 'operational' within the same frame on a fault, and ModuleStatusTracker's hold window is
// what stops the second erasing the first - anything emitted from inside that function is subject
// to the same ordering.
export const CHECK_INTERVAL_MS = 3000;

// WHETHER A FROZEN DEVICE SHOULD GO WHITE. IT SHOULD NOT, AND THIS IS DELIBERATE.
//
// It looks like the obvious escalation and it is the wrong one. White backup writes 255 to all
// 512 channels of all 16 universes, ignoring the patch entirely - a car wash lit blinding white.
// A frozen device, by contrast, is showing a stale but valid frame, which is usually a plausible
// scene and occasionally the correct one. Trading "wrong show" for "every fixture at full" is a
// bad trade, and it would widen what turns a site white on the strength of a detector that has
// never run in the field.
//
// So this ships OFF. The watchdog's job in this release is to make the failure VISIBLE so a real
// frozen device can be observed before anything is wired to act on it automatically. Turn this on
// only after the fleet has produced real frozen-output events and the false-positive rate is known
// to be zero.
//
// EXACTLY WHERE IT IS VISIBLE, and where it is not:
//
//   VISIBLE  device_module_statuses.data - the whole moduleStatus payload is stored as JSON, so
//            a RenderWatchdog row lands there with no schema or gateway change.
//   VISIBLE  the local status file, as mod.RenderWatchdog=frozen. ModuleStatusTracker writes
//            every module it holds, so this needs no change there either.
//   NOT      overallStatus, and therefore NOT the LED. processModuleStatuses inspects a fixed
//            list of module names and RenderWatchdog is not on it, so a frozen device still
//            reports 'online' with a rainbow LED. That is deliberate for this release: wiring a
//            brand-new detector into the fleet's headline status field would make a
//            false positive look like a fleet-wide degradation, and the whole point of shipping
//            it quiet first is to find out whether it has any. See WIRE_INTO_OVERALL_STATUS.
//   NOT      update.sh's rollback gate, which reads mod.AttitudeFixtureManager and renderfps.
//            renderfps counts loop iterations and stays at 40 through every frozen route, so
//            this is the signal that would close that hole - but gating a ROLLBACK on a detector
//            that has never run in the field is how a fleet-wide rollback loop starts.

// Whether a frozen verdict should reach overallStatus and the LED. Same discipline as the white
// backup constant above, one step milder: this changes what the device REPORTS, not what it
// outputs. Turn it on once the detector has field data, before considering the escalation.
export const WIRE_INTO_OVERALL_STATUS = false;
export const ESCALATE_TO_WHITE_BACKUP = false;


class RenderWatchdog {

	constructor() {
		// Per-frame accounting, reset by beginFrame().
		this.segmentsExpected = 0;
		this.segmentsCovered = 0;
		this.frameOpen = false;

		// Set by the first endFrame() that sees a live frame. Null until then, which is the
		// "never rendered since boot" state and is deliberately NOT reported as frozen - see
		// check().
		this.lastLiveFrameAt = null;

		// Show ids whose run() reported a fault this frame. POSITIONAL, not a device-wide count:
		// the segments rendered from a faulted engine were written from last frame's pixels, and
		// no others were affected.
		//
		// A device-wide flag was the first version and it was wrong in both directions. One
		// broken engine froze the whole device even when nothing rendered from it - and
		// generateEngineInstances force-creates an engine for the location's fallback show even
		// when the schedule never mentions it, so an unused, unscheduled show could report a
		// fully-rendering device as frozen. It also meant one healthy show could never rescue
		// the verdict.
		this.faultedShows = new Set();

		// Zones that threw before writing anything. Distinguishes "nothing is patched", which is
		// a real configuration, from "every zone bailed out", which is the failure.
		this.zoneFaults = 0;

		this.frozen = false;
		this.frozenSince = null;
		this.lastReason = '';

		// Frames that began while another was still open. Always zero today; a non-zero value
		// means processFixtures gained an await and the accounting can no longer be trusted.
		this.nestedFrames = 0;

		// Counted for the status payload, so an operator can tell a device that froze once from
		// one that is flapping.
		this.freezeEvents = 0;

		this.checkInterval = null;
	}


	// ---- per-frame accounting, called from AttitudeFixtureManager.processFixtures ----

	beginFrame() {
		// Defensive, not decorative. processFixtures has one caller and no await today, so
		// frames cannot interleave - but adding any await inside it would move endFrame() past
		// the suspension point and silently corrupt the counters. This makes that a visible
		// warning rather than a wrong verdict.
		if (this.frameOpen) {
			this.nestedFrames++;
		}

		this.segmentsExpected = 0;
		this.segmentsCovered = 0;
		this.faultedShows.clear();
		this.zoneFaults = 0;
		this.frameOpen = true;
	}

	// Every patched segment the frame is responsible for writing.
	expectSegments(count) {
		if (Number.isFinite(count) && count > 0) { this.segmentsExpected += count; }
	}

	// Segments that actually reached a DMX write, by whatever path - rendered, played back from a
	// table, blacked out, or whited out. All of those are the pipeline doing its job.
	coverSegments(count) {
		if (Number.isFinite(count) && count > 0) { this.segmentsCovered += count; }
	}

	// The unassigned path writes white to all channels directly rather than per segment. That is
	// a complete, correct frame with no patch to account for.
	coverWholeFrame() {
		this.segmentsExpected += 1;
		this.segmentsCovered += 1;
	}

	// Called once per engine per frame with whatever run() returned.
	//
	// undefined means the frame rendered. Anything else is the fallback colour run() returns from
	// its catch, which means the engine threw and this.pixelData still holds the previous frame.
	// A table-covered show never calls run() at all, so it never calls this either - which is
	// correct, since its segments come from the table and are accounted for by coverage.
	noteEngineRun(runResult, showId) {
		if (runResult !== undefined) { this.faultedShows.add(showId); }
	}

	// True if this frame's render of `showId` reported a fault, so its segments must not be
	// counted as covered - they carry last frame's pixels.
	engineFaulted(showId) {
		return this.faultedShows.has(showId);
	}

	// A zone or group that threw before writing anything. Without this, a device with nothing
	// patched and a device whose every zone bailed out are indistinguishable - both reach
	// endFrame with expected === 0.
	noteZoneFault() {
		this.zoneFaults++;
	}

	// Returns true if this frame was live: every patched segment reached a DMX write, and none
	// of them was written from an engine that reported a fault.
	endFrame(now = Date.now()) {
		this.frameOpen = false;

		// NOTHING PATCHED IS NOT A FAULT, and an earlier version got this backwards.
		//
		// It returned false here, so a device with no fixtures read as frozen five seconds
		// later - which is the normal state of a box during commissioning, between being
		// assigned to a location and having its fixtures entered. Also reached by a site
		// mid-re-patch, and by a config that arrives without a fixtures key.
		//
		// The distinction that matters is between "nothing is configured" and "every zone
		// bailed out". Both reach here with expected === 0; only the second is a failure.
		if (this.segmentsExpected === 0) {
			if (this.zoneFaults > 0) { return false; }

			this.lastLiveFrameAt = now;
			return true;
		}

		if (this.segmentsCovered < this.segmentsExpected) { return false; }

		this.lastLiveFrameAt = now;
		return true;
	}


	// ---- evaluation, called from its own timer ----

	// Returns { frozen, staleMs, reason } without emitting. Separated from the emit so it can be
	// tested without an event hub.
	check(now = Date.now()) {
		// Never rendered since boot. Not frozen - the device may still be starting up, and
		// calling a booting device frozen would fire on every restart of every device in the
		// fleet at once. A device that never renders at all is caught by the existing
		// 'unresponsive' sweep.
		if (this.lastLiveFrameAt === null) {
			return { frozen: false, staleMs: 0, reason: 'no frame rendered yet' };
		}

		// Clamped. Date.now() is not monotonic and the device's clock is stepped by NTP, so a
		// backward step would otherwise make staleMs enormous and declare the whole fleet frozen
		// at once - the identical hazard the gateway's token bucket and the engine's error
		// reporter both guard, and the third instance of it in this release.
		const staleMs = Math.max(0, now - this.lastLiveFrameAt);

		if (staleMs > FROZEN_AFTER_MS) {
			return {
				frozen: true,
				staleMs,
				reason: `no complete frame for ${Math.round(staleMs / 1000)}s`,
			};
		}

		return { frozen: false, staleMs, reason: 'rendering' };
	}

	// Start the watchdog's own timer. Dependencies are injected rather than imported so the
	// tests drive the real tick() with a fake clock and a fake event hub - the alternative is a
	// test that restates this logic, which is how a suite ends up passing against the bug it was
	// written to catch.
	init(deps) {
		if (this.checkInterval) { return; }

		this.checkInterval = setInterval(() => {
			try {
				this.tick(deps);
			} catch (error) {
				// A watchdog that can crash the process it watches is worse than no watchdog.
				deps.logger?.error?.(`RenderWatchdog tick failed: ${error.message}`);
			}
		}, CHECK_INTERVAL_MS);

		// Never hold the process open on our account.
		if (typeof this.checkInterval.unref === 'function') { this.checkInterval.unref(); }
	}

	tick(deps) {
		const { eventHub, attitudeSACN, logger, now = Date.now } = deps;

		const verdict = this.check(now());

		// Transitions are logged once, not every three seconds. A device that has been frozen
		// for an hour should not have written twelve hundred identical lines into the network
		// queue - the log queue drains to the server, and on a device that is ALSO offline it
		// drains to the SD card, whose wear is this fleet's established failure mode.
		if (verdict.frozen && !this.frozen) {
			this.frozen = true;
			this.frozenSince = now();
			this.freezeEvents++;
			logger?.error?.(
				`DMX output appears FROZEN: ${verdict.reason}. `
				+ `The device is still transmitting sACN, so fixtures are holding their last frame.`
			);
		} else if (!verdict.frozen && this.frozen) {
			this.frozen = false;
			this.frozenSince = null;
			logger?.warn?.('DMX output is rendering again.');
		}

		// OFF by default - see ESCALATE_TO_WHITE_BACKUP.
		if (ESCALATE_TO_WHITE_BACKUP && attitudeSACN?.setWhiteBackupMode) {
			attitudeSACN.setWhiteBackupMode(verdict.frozen);
		}

		// Guarded here as well as in init()'s interval wrapper, and not redundantly: the wrapper
		// only protects the production caller, so a future caller elsewhere would be unprotected.
		// A watchdog that can crash the thing it watches is worse than no watchdog, and this is
		// the one line in it that calls out to code it does not own.
		try {
			eventHub?.emit?.('moduleStatus', {
				name: 'RenderWatchdog',
				status: verdict.frozen ? 'frozen' : 'operational',
				data: this.statusData(verdict),
			});
		} catch (error) {
			logger?.error?.(`RenderWatchdog could not emit its status: ${error.message}`);
		}

		return verdict;
	}

	// The status payload. Kept as a single free-text string because that is what
	// device_module_statuses stores and what update.sh scrapes - no schema change anywhere.
	statusData(verdict) {
		return `frozen=${verdict.frozen ? 1 : 0}`
			+ ` staleMs=${verdict.staleMs}`
			+ ` events=${this.freezeEvents}`
			+ ` expected=${this.segmentsExpected}`
			+ ` covered=${this.segmentsCovered}`
			+ ` faultedShows=${this.faultedShows.size}`
			+ ` zoneFaults=${this.zoneFaults}`
			+ ` nested=${this.nestedFrames}`
			+ ` ${verdict.reason}`;
	}
}


const renderWatchdog = new RenderWatchdog();
export default renderWatchdog;
