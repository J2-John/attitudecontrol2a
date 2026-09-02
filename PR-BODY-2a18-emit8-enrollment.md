# 2.A.18 — let the box see an Emit-8 that has not been enrolled yet

An Emit-8 out of the box has no ID. An ID is something the server hands out, and
nothing has handed it one, so it announces itself with `ID: 0` and a `DEVICE_ID`
— the 16 hex characters of its RP2350 chip id, which it has from the first
second it is powered.

`validateEmitDataObject` required `ID >= 1`. So the box heard the announce,
threw it away, and a brand-new device was indistinguishable from a device that
was not there.

This was found on the bench, not reasoned about: while testing the Emit-8's DHCP
and announce, the live control box at `192.168.68.52` was receiving the Emit-8's
announce every ten seconds and rejecting all of it. That bench is now a complete
enrollment station.

Four changes, then a set of hardening fixes that came out of reviewing them.

---

## 1. Accept a device that carries a chip id but no ID

`ID: 0` and `UNIVERSE: 0` are allowed **when the packet carries a usable
`DEVICE_ID`**. Without one there is nothing to enroll and no way to address the
device, so the old rules stand exactly as they were — a legacy packet with
`ID: 0` is still malformed and still rejected.

A `DEVICE_ID` that is present but unusable (wrong length, not hex, 4 KB of
nonsense) degrades the device to the old rules rather than dropping its
telemetry: it is still heard, it just cannot be enrolled, and that is said once
rather than every ten seconds.

## 2. Key discovery on the chip id, not on the ID

`discovered` was `Map<ID, record>`. Every unenrolled device is ID 0, so a rack of
new units collided on one key — the second to announce overwrote the first, and
which one you could see depended on announce timing.

Keys are now `dev:<DEVICE_ID>` for anything reporting a chip id and `id:<ID>` for
the older firmware that does not. Config records are matched by `device_id` when
the server sends one, and by ID otherwise, so **nothing in the field changes
until the server starts sending `device_id`**.

One deliberate asymmetry: when the server names a `device_id`, that is the only
thing matched — with one exception, a device that reports **no** chip id at all,
because an Emit-1 has never claimed one and so cannot contradict the server about
which device it is. A device reporting a *different* chip id is a different
device, and matching it would be the exact mix-up the field exists to prevent.

## 3. Send the universe array, and address by chip id

`broadcastEmitAssignments` sent a single `UNIVERSE_SET` integer. It now also
sends `UNIVERSES_SET`, a **position-preserving** array — entry *i* is port
*i+1*, and 0 means that port has no universe — plus `DEST_DEVICE_ID`.

That is how an unenrolled device learns its own ID: it matches `DEST_DEVICE_ID`
against the chip id it was born with, then adopts `DEST_ID`. There is
deliberately no separate `ID_SET` field; `DEST_ID` already carries the number,
and two fields that have to agree is one more thing to get wrong.

**Position is load-bearing.** `[1, 0, 5]` compacted to `[1, 5]` puts universe 5
on port 2 — the wrong fixtures, lit convincingly, with nothing reporting a
fault. This is the same defect that was found and fixed in the server-side map
last week; both ends of the protocol now keep the slot.

**Nothing on the wire changes for the existing fleet.** A legacy record produces
a byte-identical datagram to 2.A.17, key order included — there is a test that
asserts the literal string, because `deepEqual` is order-insensitive and
`JSON.stringify` is not.

## 4. Report what the server needs to enroll from

Telemetry gains `device_id`, `reported_ports` and `reported_universes`. An
unenrolled device reports `id: 0`, so `id` alone cannot identify it and the
server has nothing to create a record against. `device_id` is the field that
makes an enrollment page possible at all.

---

## What review turned up

Three review passes — two adversarial, one verification — found 24 findings
across the first draft and the fixes for it. The ones that would have taken a
site down:

**An empty `assigned_universes` overrode a valid `assigned_universe`.** The
moment Laravel adds the column, every emit row grows `assigned_universes: []` —
an array-cast column defaulting to `[]`, an unfilled relation, a serializer that
plucks to nothing. Treating that as "the multi-port shape" would have sent
`UNIVERSE_SET: 0` to every Emit-1 in the fleet on the next one-second tick, with
no box update and no config edit. Same input, second consequence: the device
stopped counting as a non-Emit-8, so an Emit-1 sharing a universe with an Emit-8
would have gone unicast-only and dark.

**`[]` was not the only shape that did it.** A per-port relation padded to
`PORTS` from nullable rows arrives as `[null, null, …]`, which has *zero* type
errors in it — `null` is how the server says "this port is blank" — and would
have blanked the same records. The rule now is: an all-blank map loses to a valid
single-universe scalar **unless** the server has said this is a multi-port device
(`ports > 1`, or a model name), because on a multi-port record an all-blank map
is the operator clearing every port in the new UI and the old scalar column is
the stale value.

**A map that is entirely the wrong type is refused, not applied.**
`['1','2',…]` coerces entry-by-entry to `[0,0,…]`, which is a valid, deliberate,
blank-every-port instruction. A server-side type change must not be able to say
that by accident to every Emit-8 at once. One bad slot among good ones is still
just a blank port — that is a data problem, not a deploy.

**A non-array `attitudeEmits` froze the whole module silently.**
`config.attitudeEmits` is merged from the server payload with no shape
validation, and a non-array threw out of `for..of`. Because `updateSACNRouting()`
and the *only* pruning of `discovered` both live inside
`broadcastEmitAssignments`' single `try/catch`, that one condition froze the
routing table, froze the discovery map, and stopped every assignment — silently,
for as long as the config stayed that way.

**A flood of forged announces could evict the Emit-8 feeding the building.**
The discovery map is now keyed on a string the device chooses for itself, on a
segment where nothing is authenticated, in a process that runs for months. The
cap is 256 records, and 16 per source address — that second bound is the one that
holds, because the first attempt ranked eviction on whether a record was
"enrolled", and `rec.id` is a number the announcing device writes into its own
packet. Claiming ID 7 was enough to rank as enrolled *and* win the routing, so
universe 1 went only to the forger.

**Every warning in the module fires from a path that repeats** — the announce is
every ten seconds, the assignment broadcast every second — and these lines are
queued to the server. A per-key dedupe alone was not enough: 65 misconfigured
rows produce a *new* key every tick, so suppression fell to zero at exactly the
scale it was written for. There is now a token bucket underneath it.

**The reported-`ERRORS` log needed the same treatment, and this change is why.**
Before 2.A.18 an ID-0 packet was rejected in validation and never reached that
line, so an unenrolled device could not reach it at all — and an unenrolled
device is the one most likely to be reporting a fault, fresh out of the box on a
bench. It was 8,640 lines a day reading `Emit device ID 0 reported error: …`,
which names no device. It is now budgeted and names the chip id.

---

## The test suite was silently not running some of its tests

Worth reading separately, because it undermines everything above.

`npm test` uses `--test-force-exit`, which calls `process.exit()` before the TAP
stream has drained. Five consecutive runs on unmodified `main` reported **64, 55,
64, 61, 64** tests — every one exit 0, every one `# fail 0`. The dropped tests
were always a *suffix* of the file, so the newest tests in a file were the least
likely to be enforced. Tests that never run cannot fail.

The flag was there because `Logger`'s cleanup interval and `AttitudeSACN2A`'s FPS
interval hold the process open at import time. Both are now `.unref()`'d and the
flag is gone: 68 tests, ten runs, 68 every time, exits on its own in 0.6 s.

The unrefs are safe in the app. Once `AttitudeControl2A.js` is running there are
at least eleven ref'd handles — the UDP socket on 6455, the DMX interval, the
emit broadcast, the fixture and schedule loops, macros, module status, the
network poll and WebSocket, the status tracker, the LED serial port, and the
e131 sockets. A process whose only remaining handle is a log-cleanup timer has
nothing left to log about. Verified empirically: importing only those two modules
now leaves zero active resources; adding `attitudeEmitManager.init()` holds the
process open on its own.

---

## Tests

68, all green, stable across ten runs. 22 in `emit-routing.test.mjs` (existing,
updated for the new key format) and 46 in the new `emit-enrollment.test.mjs`.

They drive the real `AttitudeEmitManager` — `ConfigManager`, `UDPManager` and the
e131 sockets are stubbed because they reach the disk and the network; the
validation, keying and packet construction under test are not. Two of them go
through `UDPManager.handleMessage` with a real datagram, because every other test
hands `handleNewEmitData` an object with `_SOURCE_IP` already attached, and that
one line in `UDPManager` is what the entire unicast feature stands on.

---

## Known and deliberate

**This protocol has no authentication.** A chip id is an identifier, not a
credential. A device that claims another device's `DEVICE_ID` takes over its
record in one packet — no flood needed — and a flood from *many* source addresses
still defeats the per-source cap. Both become fail-safe the moment the server
sends `device_id` in the config: `seenFor` then pins on it, and the same flood
produces `keepMulticast: true` and multicast rather than a hijacked unicast.
That is a deployment requirement, not an optimisation.

**`MAX_PER_SOURCE = 16` is a hard devices-per-address limit.** Sixteen genuine
devices behind one address would degrade safely — the dropped ones stay on
multicast — but it is a functional constraint worth knowing about.

**The all-blank-map rule needs the server to send `ports` or `model`.** Without
either, a record with only `device_id` and an all-blank array falls back to the
legacy scalar. Fail-safe direction, but it means the new UI cannot blank a device
until the server sends port or model evidence alongside the map.

**The firmware and this box disagree about how to say "unassigned".** A
factory-fresh Emit-8 announces `UNIVERSE: 1` / `UNIVERSES: [1..8]` — the bench
default — because the firmware decided that saying "not configured" with a 0 was
worse than reporting what it is doing. This box now treats 0 as a blank port, so
a brand-new unit will show up on the enrollment page already owning universes
1–8. The firmware is the side that should move; it belongs with the receive half.

**The firmware has no receive half yet.** `announce_set_id()`,
`announce_set_universes()` and `announce_set_identify()` are called by nothing,
and the control socket is opened but only ever written to. Everything this
release sends outbound lands in a socket buffer that is never drained. That is
the next task, and the contract it has to implement is now pinned down by these
tests.
