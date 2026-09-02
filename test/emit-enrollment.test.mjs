// Enrollment: how a device that has never been assigned an ID gets one.
//
// The problem 2.A.18 fixes, stated plainly: an Emit-8 out of the box announces
// itself with ID 0, because an ID is something the server hands out and nobody
// has handed it one yet. This box threw that packet away in validation, so a
// brand new device was indistinguishable from a device that was not there. It
// was found on the bench - a live control box at .52 was receiving the Emit-8's
// announce every ten seconds and rejecting all of it.
//
// These drive the real AttitudeEmitManager. ConfigManager, UDPManager and the
// e131 sockets are stubbed because they reach the disk and the network; the
// validation, keying and packet construction under test are not.
//
//   node --test test/emit-enrollment.test.mjs
//
import test from 'node:test';
import assert from 'node:assert/strict';

const { default: configManager } = await import('../ConfigManager.mjs');
const { default: udpManager }    = await import('../UDPManager.mjs');
const { default: attitudeSACN }  = await import('../AttitudeSACN2A.mjs');
const { default: eventHub }      = await import('../EventHub.mjs');
const { default: emitManager }   = await import('../AttitudeEmitManager.mjs');
const { default: Logger }        = await import('../Logger.mjs');

const DEV_A = 'F7FA56C78673486C';   // the unit actually on the bench
const DEV_B = '0123456789ABCDEF';

// An announce as the Emit-8 firmware writes it. Key order and types match
// announce_msg.c so a capture and this fixture can be read side by side.
function announce(over = {}) {
    return {
        NAME: 'Attitude Emit 8',
        TYPE: 2,
        ID: 0,
        DEVICE_ID: DEV_A,
        VERSION: '1.0.0',
        PACKET_NO: 38,
        PORTS: 8,
        UNIVERSE: 0,
        UNIVERSES: [0, 0, 0, 0, 0, 0, 0, 0],
        IDENTIFY: false,
        ERRORS: '',
        _SOURCE_IP: '192.168.68.53',
        ...over,
    };
}

// The shipping Emit-1 packet, which has no chip id at all.
function legacyAnnounce(over = {}) {
    return {
        NAME: 'Attitude Emit',
        TYPE: 2,
        ID: 4,
        VERSION: '0.9.9',
        PACKET_NO: 12,
        UNIVERSE: 3,
        IDENTIFY: false,
        _SOURCE_IP: '192.168.68.40',
        ...over,
    };
}

// Capture what handleNewEmitData reports upstream, without letting the real
// NetworkModule listeners see it.
function capture(fn) {
    const got = [];
    const listener = p => got.push(p);
    eventHub.on('attitudeEmitDataReceived', listener);
    try { fn(); } finally { eventHub.off('attitudeEmitDataReceived', listener); }
    return got;
}

// Capture what broadcastEmitAssignments puts on the wire.
function sendCapture(emits) {
    const sent = [];
    const realSend = udpManager.send;
    const realSetRoutes = attitudeSACN.setRoutes;
    configManager.getAttitudeEmits = () => emits;
    configManager.getForceSacnMulticast = () => false;
    attitudeSACN.universes = 4;
    udpManager.send = p => sent.push(p);
    attitudeSACN.setRoutes = () => {};
    try { emitManager.broadcastEmitAssignments(); }
    finally { udpManager.send = realSend; attitudeSACN.setRoutes = realSetRoutes; }
    return sent;
}

function reset() {
    emitManager.discovered.clear();
    emitManager.warned.clear();
    emitManager.warnTokens = 20;
    emitManager.warnSuppressed = 0;
    configManager.getAttitudeEmits = () => [];
    configManager.getForceSacnMulticast = () => false;
}

// ------------------------------------------------- accepting an unenrolled device
test('a factory-fresh Emit-8 announcing ID 0 is accepted, not rejected', () => {
    reset();
    assert.equal(emitManager.validateEmitDataObject(announce()), true,
        'this exact packet is what the bench unit sends, and 2.A.17 dropped it');
});

test('an unenrolled device is remembered, so it can be shown for enrollment', () => {
    reset();
    emitManager.handleNewEmitData(announce());

    const rec = emitManager.discovered.get(`dev:${DEV_A}`);
    assert.ok(rec, 'keyed on the chip id, which it has, not the ID it does not');
    assert.equal(rec.ip, '192.168.68.53');
    assert.equal(rec.id, 0);
    assert.equal(rec.ports, 8);
    assert.equal(rec.isEmit8, true);
});

test('two unenrolled devices do not overwrite each other', () => {
    // The collision this task exists to fix. Keyed on ID, both of these are
    // key 0, so a rack of new units showed up as exactly one device - and
    // which one depended on announce timing.
    reset();
    emitManager.handleNewEmitData(announce());
    emitManager.handleNewEmitData(announce({
        DEVICE_ID: DEV_B, _SOURCE_IP: '192.168.68.54',
    }));

    assert.equal(emitManager.discovered.size, 2, 'two devices, two records');
    assert.equal(emitManager.discovered.get(`dev:${DEV_A}`).ip, '192.168.68.53');
    assert.equal(emitManager.discovered.get(`dev:${DEV_B}`).ip, '192.168.68.54');
});

test('a legacy packet with ID 0 is still rejected', () => {
    // Relaxing the rule for chip-id devices must not relax it for everyone.
    // Without a chip id there is nothing to enroll and no way to address the
    // device, so ID 0 remains malformed.
    reset();
    assert.equal(emitManager.validateEmitDataObject(legacyAnnounce({ ID: 0 })), false);
    assert.equal(emitManager.validateEmitDataObject(legacyAnnounce({ UNIVERSE: 0 })), false);
});

test('a legacy device is still accepted and still keyed by ID', () => {
    reset();
    emitManager.handleNewEmitData(legacyAnnounce());

    assert.ok(emitManager.discovered.get('id:4'), 'the field fleet must not change');
    assert.equal(emitManager.discovered.get('id:4').isEmit8, false);
});

test('an unusable DEVICE_ID degrades to the old rules rather than dropping telemetry', () => {
    // A device that cannot be enrolled should still be heard. But it must not
    // be enrollable either - a 4 KB or empty chip id is not an identity.
    reset();
    assert.equal(emitManager.normalizeDeviceId('x'.repeat(4096)), '');
    assert.equal(emitManager.normalizeDeviceId(''), '');
    assert.equal(emitManager.normalizeDeviceId('not-hex-at-all'), '');

    assert.equal(emitManager.validateEmitDataObject(announce({ DEVICE_ID: 'nope' })), false,
        'ID 0 with no usable chip id is malformed, as it always was');
    assert.equal(
        emitManager.validateEmitDataObject(announce({ DEVICE_ID: 'nope', ID: 5, UNIVERSE: 1 })),
        true, 'but an enrolled device with a bad chip id is still heard');
});

test('a lower-case chip id is the same device as an upper-case one', () => {
    reset();
    emitManager.handleNewEmitData(announce({ DEVICE_ID: DEV_A.toLowerCase() }));
    assert.ok(emitManager.discovered.get(`dev:${DEV_A}`),
        'normalised on the way in, or a firmware casing change forks the record');
});

// ------------------------------------------------------------- what goes upstream
test('telemetry carries what the server needs to enroll the device', () => {
    reset();
    const [pkt] = capture(() => emitManager.handleNewEmitData(announce()));

    assert.equal(pkt.device_id, DEV_A, 'the field enrollment is keyed on');
    assert.equal(pkt.id, 0, 'reported honestly as unenrolled');
    assert.equal(pkt.reported_ports, 8);
    assert.deepEqual(pkt.reported_universes, [0, 0, 0, 0, 0, 0, 0, 0]);
});

test('a reported hole stays a hole', () => {
    // Port 3 unassigned. Compacting this to [1, 2, 5] would tell the server
    // port 3 is on universe 5 - the wrong fixtures, reported convincingly.
    reset();
    const [pkt] = capture(() => emitManager.handleNewEmitData(announce({
        UNIVERSE: 1, UNIVERSES: [1, 2, 0, 5, 0, 0, 0, 0], ID: 7,
    })));

    assert.deepEqual(pkt.reported_universes, [1, 2, 0, 5, 0, 0, 0, 0]);
    assert.deepEqual(emitManager.discovered.get(`dev:${DEV_A}`).universes, [1, 2, 5],
        'routing asks a different question and may flatten; the report may not');
});

test('a legacy device reports one port', () => {
    reset();
    const [pkt] = capture(() => emitManager.handleNewEmitData(legacyAnnounce()));
    assert.equal(pkt.device_id, null,
        'null, not empty string - every legacy device would collide on one key');
    assert.equal(pkt.reported_ports, 1);
    assert.deepEqual(pkt.reported_universes, [3]);
});

test('a device claiming an absurd port count cannot make this box allocate for it', () => {
    reset();
    const [pkt] = capture(() => emitManager.handleNewEmitData(announce({
        PORTS: 100000, UNIVERSES: new Array(5000).fill(1),
    })));
    assert.ok(pkt.reported_universes.length <= 64);
    assert.ok(pkt.reported_ports <= 64);
});

// --------------------------------------------------------- what goes on the wire
test('an eight-port assignment is sent as a position-preserving array', () => {
    reset();
    const sent = sendCapture([{
        id: 7, device_id: DEV_A, assigned_identify_mode: false,
        assigned_universes: [1, 2, 0, 4, 5, 6, 7, 8],
    }]);

    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].UNIVERSES_SET, [1, 2, 0, 4, 5, 6, 7, 8],
        'port 3 is blank and every port after it must stay where it is');
    assert.equal(sent[0].UNIVERSE_SET, 1, "port 1's universe, from the same array");
    assert.equal(sent[0].DEST_ID, 7);
    assert.equal(sent[0].DEST_DEVICE_ID, DEV_A);
});

test('DEST_ID is how an unenrolled device learns its own ID', () => {
    // There is no ID_SET field on purpose. The device matches DEST_DEVICE_ID
    // against the chip id it was born with, then adopts DEST_ID. Two fields
    // that have to agree would be one more thing to get wrong.
    reset();
    const sent = sendCapture([{
        id: 12, device_id: DEV_A, assigned_identify_mode: false,
        assigned_universes: [0, 0, 0, 0, 0, 0, 0, 0],
    }]);

    assert.equal(sent.length, 1,
        'an enrolled-but-unassigned device is still told who it is');
    assert.equal(sent[0].DEST_ID, 12);
    assert.equal(sent[0].DEST_DEVICE_ID, DEV_A);
    assert.equal(sent[0].UNIVERSE_SET, 0);
});

test('a legacy device gets exactly the packet it has always got', () => {
    // The regression guard for the whole installed fleet. An Emit-1 reads
    // UNIVERSE_SET and nothing else; an extra key it does not expect, or a
    // missing one it does, takes a working site down.
    reset();
    const sent = sendCapture([{
        id: 4, assigned_universe: 3, assigned_identify_mode: true,
    }]);

    assert.deepEqual(sent[0], {
        DEST_TYPE: 2, DEST_ID: 4, IDENTIFY: true, UNIVERSE_SET: 3,
    });
    assert.equal('UNIVERSES_SET' in sent[0], false);
    assert.equal('DEST_DEVICE_ID' in sent[0], false);
});

test('a legacy device with no valid universe is still skipped', () => {
    reset();
    assert.equal(sendCapture([{ id: 4, assigned_universe: 0, assigned_identify_mode: false }]).length, 0);
    assert.equal(sendCapture([{ id: 4, assigned_universe: 70000, assigned_identify_mode: false }]).length, 0);
    assert.equal(sendCapture([{ id: 0, assigned_universe: 3, assigned_identify_mode: false }]).length, 0);
    assert.equal(sendCapture([{ id: 4, assigned_universe: 3, assigned_identify_mode: 'yes' }]).length, 0);
});

test('a garbage entry in the assigned map becomes a blank port, not a shifted one', () => {
    reset();
    const sent = sendCapture([{
        id: 7, device_id: DEV_A, assigned_identify_mode: false,
        assigned_universes: [1, null, 'two', 4, 70000, -1, 6, 7],
    }]);
    assert.deepEqual(sent[0].UNIVERSES_SET, [1, 0, 0, 4, 0, 0, 6, 7]);
});

// ------------------------------------------------------------------- routing
test('a configured device_id matches the discovered chip id', () => {
    reset();
    configManager.getAttitudeEmits = () => [{
        id: 7, device_id: DEV_A, model: 'Emit-8', assigned_universes: [1, 2],
    }];
    emitManager.handleNewEmitData(announce({ ID: 7, UNIVERSE: 1, UNIVERSES: [1, 2, 0, 0, 0, 0, 0, 0] }));

    const { routes, keepMulticast } = emitManager.computeRoutes(2);
    assert.equal(keepMulticast, false);
    assert.deepEqual(routes[0], ['192.168.68.53']);
});

test('a named device that is not on the network does NOT fall back to the ID', () => {
    // The mix-up a chip id exists to prevent. Something else answering to ID 7
    // must not receive this location's universes because the device the server
    // actually named is unplugged.
    reset();
    configManager.getAttitudeEmits = () => [{
        id: 7, device_id: DEV_B, model: 'Emit-8', assigned_universes: [1],
    }];
    emitManager.handleNewEmitData(announce({ ID: 7, UNIVERSE: 1, UNIVERSES: [1, 0, 0, 0, 0, 0, 0, 0] }));

    const { routes, keepMulticast } = emitManager.computeRoutes(1);
    assert.equal(keepMulticast, true, 'the named device is silent, so multicast stays');
    assert.deepEqual(routes[0], [null]);
});

test('a config record with no device_id still matches by ID', () => {
    // Nothing in the field changes until the server starts sending device_id.
    reset();
    configManager.getAttitudeEmits = () => [{
        id: 7, model: 'Emit-8', assigned_universes: [1],
    }];
    emitManager.handleNewEmitData(announce({ ID: 7, UNIVERSE: 1, UNIVERSES: [1, 0, 0, 0, 0, 0, 0, 0] }));

    const { routes } = emitManager.computeRoutes(1);
    assert.deepEqual(routes[0], ['192.168.68.53']);
});

test('an unenrolled device on the segment changes no routing at all', () => {
    // It is in the discovery map so it can be shown for enrollment. It has no
    // config record and no assignment, and it must not touch a running site.
    reset();
    configManager.getAttitudeEmits = () => [{ id: 3, assigned_universe: 1, model: 'Emit-1' }];
    emitManager.discovered.set('id:3', {
        ip: '10.0.0.53', deviceId: '', id: 3, name: 'Attitude Emit',
        ports: 1, universes: [1], isEmit8: false, lastSeen: Date.now(),
    });
    emitManager.handleNewEmitData(announce());

    const { routes, keepMulticast, anyEmit8 } = emitManager.computeRoutes(1);
    assert.equal(anyEmit8, false, 'an unenrolled device is not an assignment');
    assert.equal(keepMulticast, true);
    assert.deepEqual(routes[0], [null]);
});

test('a named device_id still matches a legacy device that reports no chip id', () => {
    // The rollout hazard. If the server fills device_id in on every emit record
    // including the Emit-1s, a strict match would make the entire existing
    // fleet undiscoverable at once. A device that has never claimed a chip id
    // cannot contradict the server about which device it is.
    reset();
    configManager.getAttitudeEmits = () => [{
        id: 4, device_id: DEV_B, model: 'Emit-8', assigned_universes: [1],
    }];
    emitManager.handleNewEmitData(legacyAnnounce({ ID: 4, UNIVERSE: 1 }));

    const { routes } = emitManager.computeRoutes(1);
    assert.deepEqual(routes[0], ['192.168.68.40']);
});

test('the discovery map cannot be grown without bound by announcing', () => {
    // Keyed on a string the device chooses for itself, on a segment where
    // nothing is authenticated, in a process that runs for months.
    reset();
    for (let i = 0; i < 400; i++) {
        emitManager.handleNewEmitData(announce({
            DEVICE_ID: i.toString(16).toUpperCase().padStart(16, '0'),
            _SOURCE_IP: '10.0.0.1',
        }));
    }
    assert.ok(emitManager.discovered.size <= 256, `grew to ${emitManager.discovered.size}`);

    // and a device already known still gets its address refreshed at the cap
    const known = [...emitManager.discovered.keys()][0];
    const before = emitManager.discovered.get(known).ip;
    emitManager.handleNewEmitData(announce({
        DEVICE_ID: known.slice(4), _SOURCE_IP: '10.9.9.9',
    }));
    assert.notEqual(emitManager.discovered.get(known).ip, before,
        'a full map must not stop a known device from moving');
});

test('one malformed config entry costs one device, not the whole site', () => {
    // The broadcast shares a single try/catch, so a null in the list used to
    // throw past every device after it.
    reset();
    const sent = sendCapture([
        { id: 4, assigned_universe: 3, assigned_identify_mode: false },
        null,
        { id: 5, assigned_universe: 6, assigned_identify_mode: false },
    ]);
    assert.equal(sent.length, 2, 'the entries either side of the bad one still went');
});

test('an unknown-age record does not displace a known incumbent, either order', () => {
    // Records written before this version - or by the routing suite's helper -
    // have no firstSeen. A bare `<` compared undefined and was false in BOTH
    // directions, so the winner was whichever key the Map happened to reach
    // first: the same two devices, two different answers.
    const seed = (first, second) => {
        reset();
        configManager.getAttitudeEmits = () => [{ id: 7, model: 'Emit-8', assigned_universes: [1] }];
        for (const r of [first, second]) emitManager.discovered.set(r.key, r.rec);
        return emitManager.computeRoutes(1).routes[0];
    };
    const now = Date.now();
    const known = { key: `dev:${DEV_A}`, rec: {
        ip: '10.0.0.77', deviceId: DEV_A, id: 7, name: 'Emit-8', ports: 8,
        universes: [1], isEmit8: true, lastSeen: now, firstSeen: now - 600000 } };
    const unknownAge = { key: `dev:${DEV_B}`, rec: {
        ip: '10.0.0.199', deviceId: DEV_B, id: 7, name: 'Emit-8', ports: 8,
        universes: [1], isEmit8: true, lastSeen: now } };

    assert.deepEqual(seed(known, unknownAge), ['10.0.0.77']);
    assert.deepEqual(seed(unknownAge, known), ['10.0.0.77'],
        'insertion order must not decide which device a site feeds');

    // and when NEITHER has an age, the answer still has to be a property of the
    // two devices rather than of Map insertion order
    const bare = (key, ip) => ({ key, rec: {
        ip, deviceId: key.slice(4), id: 7, name: 'Emit-8', ports: 8,
        universes: [1], isEmit8: true, lastSeen: now } });
    const p = bare(`dev:${DEV_A}`, '10.0.0.77');
    const q = bare(`dev:${DEV_B}`, '10.0.0.199');
    assert.deepEqual(seed(p, q), seed(q, p),
        'two records with no age at all must still agree with themselves');
});
// ------------------------------------------ what a server-side change must not do
test('an empty assigned_universes does NOT override a valid assigned_universe', () => {
    // The rollout that would take the whole fleet down. The moment the Laravel
    // side adds the column, every emit row grows `assigned_universes: []` - an
    // array-cast column defaulting to [], an unfilled relation, a plucked-to-
    // nothing serializer. Treating an empty array as "the multi-port shape"
    // sends UNIVERSE_SET: 0 to every Emit-1 in the field on the next 1 Hz tick,
    // with no box update and no config edit.
    reset();
    const sent = sendCapture([{
        id: 4, assigned_universe: 3, assigned_universes: [], assigned_identify_mode: false,
    }]);
    assert.equal(sent[0].UNIVERSE_SET, 3);
    assert.equal('UNIVERSES_SET' in sent[0], false);
});

test('an empty assigned_universes does not silently stop holding multicast open', () => {
    // The same input, second consequence. universesFor() returning [] means the
    // device stops setting anyNonEmit8 - so an Emit-1 sharing a universe with an
    // Emit-8 goes unicast-only and dark.
    reset();
    configManager.getAttitudeEmits = () => [
        { id: 7, model: 'Emit-8', assigned_universes: [1] },
        { id: 3, model: 'Emit-1', assigned_universe: 1, assigned_universes: [] },
    ];
    emitManager.handleNewEmitData(announce({ ID: 7, UNIVERSE: 1, UNIVERSES: [1, 0, 0, 0, 0, 0, 0, 0] }));

    const { keepMulticast } = emitManager.computeRoutes(1);
    assert.equal(keepMulticast, true, 'the Emit-1 is still an Emit-1');
});

test('a map that is ENTIRELY the wrong type is refused, not applied as zeros', () => {
    // ['1','2',...] coerces entry-by-entry to [0,0,...], which is a valid,
    // deliberate, blank-every-port instruction. A server-side type change must
    // not be able to say that by accident to every Emit-8 at once.
    reset();
    const sent = sendCapture([{
        id: 7, device_id: DEV_A, assigned_identify_mode: false,
        assigned_universes: ['1', '2', '3', '4', '5', '6', '7', '8'],
    }]);
    assert.equal(sent.length, 0, 'refused, and with no valid scalar the device is skipped');
});

test('one bad slot among good ones is still a blank port', () => {
    reset();
    const sent = sendCapture([{
        id: 7, device_id: DEV_A, assigned_identify_mode: false,
        assigned_universes: [1, 'x', 3, null, 5, 6, 7, 8],
    }]);
    assert.deepEqual(sent[0].UNIVERSES_SET, [1, 0, 3, 0, 5, 6, 7, 8],
        'a data problem is not a deploy');
});

test('DEST_DEVICE_ID is not sent to a legacy single-universe record', () => {
    // device_id is a DB column; the server will fill it in on every emit row,
    // Emit-1s included. The shipping Emit-1 parser's tolerance for keys it does
    // not know is established nowhere, so the new field is tied to the new
    // shape rather than to the presence of the column.
    reset();
    const sent = sendCapture([{
        id: 4, device_id: DEV_A, assigned_universe: 3, assigned_identify_mode: false,
    }]);
    assert.deepEqual(sent[0], {
        DEST_TYPE: 2, DEST_ID: 4, IDENTIFY: false, UNIVERSE_SET: 3,
    }, 'byte-identical to 2.A.17 whatever the server puts in device_id');
});

test('a non-array attitudeEmits does not freeze routing and discovery', () => {
    // config.attitudeEmits is merged from the server payload with no shape
    // validation. A non-array used to throw out of for..of - and because
    // updateSACNRouting() and the only pruning of `discovered` both live inside
    // broadcastEmitAssignments' single try/catch, that one condition froze the
    // routing table, froze the discovery map, and stopped every assignment.
    reset();
    let routed = false;
    const realSetRoutes = attitudeSACN.setRoutes;
    configManager.getAttitudeEmits = () => ({ 0: { id: 1 } });
    attitudeSACN.universes = 1;
    attitudeSACN.setRoutes = () => { routed = true; };
    try { emitManager.broadcastEmitAssignments(); }
    finally { attitudeSACN.setRoutes = realSetRoutes; }

    assert.equal(routed, true, 'sACN routing still ran');
    assert.doesNotThrow(() => emitManager.computeRoutes(1));
});

test('a config record this box will not send to does not drop multicast', () => {
    // broadcastEmitAssignments skips id < 1, so a record like this describes a
    // device that will never be told which universes to listen on. Unicasting
    // to it and dropping multicast would black out the universe.
    reset();
    configManager.getAttitudeEmits = () => [{
        id: 0, device_id: DEV_A, model: 'Emit-8', assigned_universes: [1],
    }];
    emitManager.handleNewEmitData(announce({ UNIVERSE: 1, UNIVERSES: [1, 0, 0, 0, 0, 0, 0, 0] }));

    const { routes, keepMulticast } = emitManager.computeRoutes(1);
    assert.equal(keepMulticast, true);
    assert.deepEqual(routes[0], [null]);
    assert.equal(sendCapture([{ id: 0, device_id: DEV_A, assigned_universes: [1], assigned_identify_mode: false }]).length, 0);
});

test('a full discovery map still admits a real device, evicting the stalest', () => {
    // Refusing at the cap looks safer and is not: whoever filled the map first
    // keeps it, so forged chip ids could lock a real Emit-8 out of discovery -
    // and an Emit-8 that is not discovered gets no unicast, which on a device
    // fed by one socket by design means it gets nothing at all.
    reset();
    for (let i = 0; i < 256; i++) {
        emitManager.discovered.set(`dev:FORGED${i.toString(16).padStart(10, '0').toUpperCase()}`, {
            ip: '10.0.0.1', deviceId: 'x', id: 0, name: 'x', ports: 8,
            universes: [], isEmit8: true,
            lastSeen: Date.now() - (256 - i), firstSeen: Date.now() - 999,
        });
    }
    assert.equal(emitManager.discovered.size, 256);

    emitManager.handleNewEmitData(announce());
    assert.ok(emitManager.discovered.get(`dev:${DEV_A}`),
        'the real device got in');
    assert.ok(emitManager.discovered.size <= 256, 'and the cap held');
});

test('an ID claimed by two live devices goes to the incumbent', () => {
    // Nothing on this segment is authenticated. Preferring the most recently
    // heard means anything can take over a site's routing at any moment just by
    // announcing; preferring the earliest means it has to win at boot and hold.
    reset();
    configManager.getAttitudeEmits = () => [{ id: 7, model: 'Emit-8', assigned_universes: [1] }];
    const now = Date.now();
    emitManager.discovered.set(`dev:${DEV_A}`, {
        ip: '10.0.0.77', deviceId: DEV_A, id: 7, name: 'Emit-8', ports: 8,
        universes: [1], isEmit8: true, lastSeen: now - 5000, firstSeen: now - 600000,
    });
    emitManager.discovered.set(`dev:${DEV_B}`, {
        ip: '10.0.0.199', deviceId: DEV_B, id: 7, name: 'Emit-8', ports: 8,
        universes: [1], isEmit8: true, lastSeen: now, firstSeen: now,
    });

    const { routes } = emitManager.computeRoutes(1);
    assert.deepEqual(routes[0], ['10.0.0.77'],
        'the newcomer does not get to take the incumbent\'s routing');
});

// ------------------------------------------------------ the shipping ingress path
test('the whole path from datagram to discovery record works', () => {
    // Every other test in both suites hands handleNewEmitData an object with
    // _SOURCE_IP already attached. That one line in UDPManager is what the
    // entire unicast feature stands on, and nothing exercised it.
    reset();
    const listener = emitManager.handleNewEmitData;
    eventHub.on('receivedUDP', listener);
    try {
        const wire = JSON.stringify(announce({ _SOURCE_IP: undefined }));
        udpManager.handleMessage(Buffer.from(wire), { address: '192.168.68.53', port: 6455 });
    } finally { eventHub.off('receivedUDP', listener); }

    const rec = emitManager.discovered.get(`dev:${DEV_A}`);
    assert.ok(rec, 'a real datagram produced a real discovery record');
    assert.equal(rec.ip, '192.168.68.53', 'the address came from the datagram, not the JSON');
});

test('a device cannot claim its own source address', () => {
    reset();
    const listener = emitManager.handleNewEmitData;
    eventHub.on('receivedUDP', listener);
    try {
        const wire = JSON.stringify(announce({ _SOURCE_IP: '10.6.6.6' }));
        udpManager.handleMessage(Buffer.from(wire), { address: '192.168.68.53', port: 6455 });
    } finally { eventHub.off('receivedUDP', listener); }

    assert.equal(emitManager.discovered.get(`dev:${DEV_A}`).ip, '192.168.68.53',
        'the transport wins over anything the device claimed');
});

// --------------------------------------------- the fixes for the fixes
test('an all-null assigned_universes does not blank a device that has a scalar', () => {
    // `[]` is not the only way a serializer says nothing. A per-port relation
    // padded to PORTS from nullable rows arrives as [null x 8], which reaches
    // portMapFor with zero type errors - null IS how the server says "blank
    // port" - and would have sent UNIVERSE_SET: 0 to a legacy record with a
    // perfectly good universe on it.
    reset();
    for (const arr of [[null], [null, null], [undefined, undefined], [0, 0, 0, 0, 0, 0, 0, 0]]) {
        const sent = sendCapture([{
            id: 4, assigned_universe: 3, assigned_universes: arr, assigned_identify_mode: false,
        }]);
        assert.equal(sent[0].UNIVERSE_SET, 3, `${JSON.stringify(arr)} must not win over the scalar`);
        assert.equal('UNIVERSES_SET' in sent[0], false);
    }
});

test('an all-zero map with NO scalar to lose is still sent', () => {
    // The other half of the same rule. This is the deliberate "you are
    // enrolled, nothing assigned yet" instruction, and it is how a device
    // learns its own ID.
    reset();
    const sent = sendCapture([{
        id: 12, device_id: DEV_A, assigned_universes: [0, 0, 0, 0, 0, 0, 0, 0],
        assigned_identify_mode: false,
    }]);
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].UNIVERSES_SET, [0, 0, 0, 0, 0, 0, 0, 0]);
    assert.equal(sent[0].DEST_ID, 12);
});

test('a legacy assignment is byte-identical to 2.A.17, key order included', () => {
    // deepEqual is order-insensitive and JSON.stringify is not, so the same
    // document in a different key order is a different datagram. If the claim
    // is "nothing on the wire changes for the fleet", assert it literally.
    reset();
    const sent = sendCapture([{
        id: 4, device_id: DEV_A, assigned_universe: 3, assigned_identify_mode: false,
    }]);
    assert.equal(JSON.stringify(sent[0]),
        '{"DEST_TYPE":2,"DEST_ID":4,"UNIVERSE_SET":3,"IDENTIFY":false}');
});

test('port count alone does not decide that a location drops multicast', () => {
    // isEmit8 gates whether a whole LOCATION stops multicasting. Inferring it
    // from a reported port count reads as an improvement and is a change in the
    // dangerous direction: `ports` falls back to the length of the reported
    // array, so a pre-PORTS device reporting two universes would take its site
    // unicast-only without anyone changing a thing.
    reset();
    configManager.getAttitudeEmits = () => [{ id: 9, assigned_universes: [1] }];  // no model
    emitManager.handleNewEmitData({
        NAME: 'Attitude Emit 2', TYPE: 2, ID: 9, DEVICE_ID: DEV_B, VERSION: '1.0',
        PACKET_NO: 1, PORTS: 2, UNIVERSE: 1, UNIVERSES: [1, 2], IDENTIFY: false,
        _SOURCE_IP: '10.0.0.32',
    });

    assert.equal(emitManager.discovered.get(`dev:${DEV_B}`).ports, 2,
        'the port count is still recorded for the server');
    assert.equal(emitManager.computeRoutes(1).keepMulticast, true,
        'but it does not decide routing on its own');
});

test('a flood of NEW warning conditions is bounded by rate, not by key count', () => {
    // The failure the first version of warnOnce had: a Set cleared at 64
    // entries means suppression falls to ZERO at 65 distinct conditions - one
    // warning per record per tick, forever, queued to the server. Sixty-five
    // misconfigured rows is a large site, not an attack.
    reset();
    let warns = 0;
    const realWarn = emitManager.constructor.prototype.warnOnce;
    const seen = [];
    emitManager.warnOnce = function (k, m) { seen.push(k); return realWarn.call(this, k, m); };

    const realLog = Logger.prototype.warn;
    Logger.prototype.warn = function () { warns++; };
    try {
        const emits = [];
        for (let i = 1; i <= 100; i++) {
            emits.push({ id: i, assigned_universe: 900000 + i, assigned_identify_mode: false });
        }
        for (let tick = 0; tick < 50; tick++) sendCapture(emits);
    } finally {
        Logger.prototype.warn = realLog;
        delete emitManager.warnOnce;
    }

    assert.ok(seen.length > 4000, 'the conditions really did fire thousands of times');
    assert.ok(warns <= 40, `expected the budget to hold; ${warns} lines reached the log`);
});

test('one address cannot evict the Emit-8 that is feeding the building', () => {
    // Whatever ID it claims. An earlier version of this ranked eviction on
    // whether a record was "enrolled" - which is `rec.id`, a number the
    // announcing device writes into its own packet. Claiming ID 7 was enough to
    // rank as enrolled AND win the routing, so universe 1 went only to the
    // forger. The bound that holds is on how many records one ADDRESS may keep.
    for (const floodId of [0, 1, 99, 7]) {
        reset();
        configManager.getAttitudeEmits = () => [{ id: 7, model: 'Emit-8', assigned_universes: [1] }];
        emitManager.handleNewEmitData(announce({ ID: 7, UNIVERSE: 1, UNIVERSES: [1, 0, 0, 0, 0, 0, 0, 0] }));
        assert.deepEqual(emitManager.computeRoutes(1).routes[0], ['192.168.68.53']);

        for (let i = 0; i < 600; i++) {
            emitManager.handleNewEmitData(announce({
                ID: floodId,
                UNIVERSE: 1,
                DEVICE_ID: 'AA' + i.toString(16).toUpperCase().padStart(14, '0'),
                _SOURCE_IP: '10.6.6.6',
            }));
        }

        assert.ok(emitManager.discovered.size <= 256, 'the global cap held');
        assert.ok(emitManager.discovered.get(`dev:${DEV_A}`),
            `the real device survived a flood claiming ID ${floodId}`);
        assert.deepEqual(emitManager.computeRoutes(1).routes[0], ['192.168.68.53'],
            `routing survived a flood claiming ID ${floodId}`);
    }
});

test('one address holds at most a handful of records', () => {
    reset();
    for (let i = 0; i < 200; i++) {
        emitManager.handleNewEmitData(announce({
            DEVICE_ID: 'BB' + i.toString(16).toUpperCase().padStart(14, '0'),
            _SOURCE_IP: '10.6.6.6',
        }));
    }
    assert.ok(emitManager.discovered.size <= 16,
        `one host kept ${emitManager.discovered.size} slots`);
});

test('a deliberate blank-all on a multi-port record beats the stale legacy column', () => {
    // The other direction of the blank-map rule, and the one that is easy to
    // get backwards. assigned_universe is the OLD column; on a record the
    // server has called multi-port, an all-blank array is the operator clearing
    // every port in the new UI. Letting the old column win would put a universe
    // back on a device someone deliberately cleared and strip DEST_DEVICE_ID
    // off the packet, so the device could no longer be told its ID.
    reset();
    for (const evidence of [{ ports: 8 }, { model: 'Emit-8' },
                            { type: 'Emit-8' }, { device_type: 'Emit-8' }]) {
        const sent = sendCapture([{
            id: 12, device_id: DEV_A, assigned_universe: 5,
            assigned_universes: [0, 0, 0, 0, 0, 0, 0, 0],
            assigned_identify_mode: false, ...evidence,
        }]);
        assert.deepEqual(sent[0].UNIVERSES_SET, [0, 0, 0, 0, 0, 0, 0, 0],
            `${JSON.stringify(evidence)} should establish this is multi-port`);
        assert.equal(sent[0].UNIVERSE_SET, 0);
        assert.equal(sent[0].DEST_DEVICE_ID, DEV_A);
    }
});

test('a typo in the legacy column does not suppress a real multi-port map', () => {
    reset();
    const sent = sendCapture([{
        id: 12, ports: 8, device_id: DEV_A, assigned_universe: 70000,
        assigned_universes: [1, 2, 3, 4, 5, 6, 7, 8], assigned_identify_mode: false,
    }]);
    assert.deepEqual(sent[0].UNIVERSES_SET, [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('a device reporting an error is named and budgeted', () => {
    // Before this change an ID-0 packet was rejected in validation and never
    // reached the ERRORS log, so an unenrolled device could not reach it at
    // all - and an unenrolled device is the one most likely to be reporting a
    // fault, fresh out of the box on a bench. Left alone it was 8,640 lines a
    // day reading "Emit device ID 0 reported error", naming no device.
    reset();
    const lines = [];
    const realErr = Logger.prototype.error;
    Logger.prototype.error = function (m) { lines.push(m); };
    try {
        for (let i = 0; i < 500; i++) {
            emitManager.handleNewEmitData(announce({ ERRORS: 'no link on port 3' }));
        }
    } finally { Logger.prototype.error = realErr; }

    assert.equal(lines.length, 1, `${lines.length} lines for one repeating fault`);
    assert.ok(lines[0].includes(DEV_A), `the line must name the device: ${lines[0]}`);

    // and the key must not retain a device-supplied string verbatim
    reset();
    const realErr2 = Logger.prototype.error;
    Logger.prototype.error = () => {};
    try {
        for (let i = 0; i < 70; i++) {
            emitManager.handleNewEmitData(announce({ ERRORS: 'E'.repeat(20000) + i }));
        }
    } finally { Logger.prototype.error = realErr2; }
    for (const k of emitManager.warned.keys()) {
        assert.ok(k.length < 200, `a device chose a ${k.length}-character map key`);
    }
});

test('the cap holds even for records with no usable lastSeen', () => {
    reset();
    for (let i = 0; i < 300; i++) {
        emitManager.discovered.set(`dev:X${i.toString(16).padStart(15, '0').toUpperCase()}`, {
            ip: '10.0.0.1', deviceId: 'x', id: 0, name: '', ports: 1,
            universes: [], isEmit8: false, lastSeen: undefined,
        });
    }
    emitManager.handleNewEmitData(announce());
    assert.ok(emitManager.discovered.size <= 256,
        `an unsortable record must not let the cap be breached (${emitManager.discovered.size})`);
});
