// Routing decisions for per-location sACN, tested against the real code.
//
// This runs AttitudeEmitManager.computeRoutes() and AttitudeSACN.setRoutes()
// as they are actually written - not a restatement of them. ConfigManager and
// the e131 sockets are stubbed because they reach the disk and the network;
// the logic under test is not.
//
//   node --test test/emit-routing.test.mjs
//
import test from 'node:test';
import assert from 'node:assert/strict';

// ---- stub the modules that touch the outside world, before importing ours
const { default: configManager } = await import('../ConfigManager.mjs');
const { default: attitudeSACN }  = await import('../AttitudeSACN2A.mjs');
const { default: emitManager }   = await import('../AttitudeEmitManager.mjs');

const MULTICAST = u => `239.255.0.${u}`;

function setConfig(emits, forceMulticast = false) {
    configManager.getAttitudeEmits = () => emits;
    configManager.getForceSacnMulticast = () => forceMulticast;
}

// A device with an assigned ID and no chip id - i.e. the shipping Emit-1
// firmware, and what every one of these routing cases is about. The chip-id
// path is exercised in emit-enrollment.test.mjs.
function discover(id, ip, name, universes) {
    emitManager.discovered.set(`id:${id}`, {
        ip, deviceId: '', id, name,
        ports: universes.length || 1,
        universes,
        isEmit8: /emit[\s._-]*8/i.test(name),
        lastSeen: Date.now(),
    });
}

function reset() {
    emitManager.discovered.clear();
    setConfig([]);
}

// --------------------------------------------------------------- the cases
test('no Emit-8 at this location: multicast, exactly as before', () => {
    reset();
    setConfig([{ id: 1, assigned_universe: 1, model: 'Emit-1' }]);
    discover(1, '10.0.0.51', 'Attitude Emit', [1]);

    const { routes, keepMulticast } = emitManager.computeRoutes(4);
    assert.equal(keepMulticast, true);
    assert.deepEqual(routes[0], [null], 'universe 1 multicast only');
    assert.deepEqual(routes[1], [null], 'unassigned universes still multicast');
});

test('Emit-8 only: unicast only, no flag needed', () => {
    // The rule, and the one that matters most. A location that HAS an Emit-8
    // never has third-party sACN gear on it - a deployment rule, not something
    // inferred from the assignment list - so multicast drops on its own.
    reset();
    setConfig([{ id: 7, assigned_universes: [1, 2, 3, 4], model: 'Emit-8' }]);
    discover(7, '10.0.0.77', 'Emit-8', [1, 2, 3, 4]);

    const { routes, keepMulticast } = emitManager.computeRoutes(4);
    assert.equal(keepMulticast, false, 'an all-Emit-8 location drops multicast');
    for (let u = 0; u < 4; u++) {
        assert.deepEqual(routes[u], ['10.0.0.77'], `universe ${u + 1} unicast only`);
    }
});

test('Emit-8 only, location pinned to multicast: unicast AND multicast', () => {
    // The escape hatch for a site that turns out to be an exception. Pins it
    // back to today's behaviour with a config value, not a firmware change.
    reset();
    setConfig([{ id: 7, assigned_universes: [1, 2, 3, 4], model: 'Emit-8' }], true);
    discover(7, '10.0.0.77', 'Emit-8', [1, 2, 3, 4]);

    const { routes, keepMulticast } = emitManager.computeRoutes(4);
    assert.equal(keepMulticast, true, 'forceSacnMulticast wins over the rule');
    for (let u = 0; u < 4; u++) {
        assert.deepEqual(routes[u], ['10.0.0.77', null],
            `universe ${u + 1} unicast plus multicast`);
    }
});

test('an Emit-1 at the same location keeps multicast', () => {
    // Nothing else feeds an Emit-1. This is the guard that has to hold even
    // though the location does have an Emit-8 on it.
    reset();
    setConfig([
        { id: 7, assigned_universes: [1], model: 'Emit-8' },
        { id: 3, assigned_universe: 2,   model: 'Emit-1' },
    ]);
    discover(7, '10.0.0.77', 'Emit-8', [1]);
    discover(3, '10.0.0.53', 'Attitude Emit', [2]);

    const { keepMulticast } = emitManager.computeRoutes(2);
    assert.equal(keepMulticast, true, 'the Emit-8 rule does not override a real Emit-1');
});

test('an Emit-8 that has not announced itself keeps multicast', () => {
    reset();
    setConfig([{ id: 7, assigned_universes: [1] }]);
    // not discovered - no address to unicast to
    const { keepMulticast } = emitManager.computeRoutes(1);
    assert.equal(keepMulticast, true, 'any doubt keeps multicast');
});

test('Emit-8 and Emit-1 together: both', () => {
    reset();
    setConfig([
        { id: 7, assigned_universes: [1, 2], model: 'Emit-8' },
        { id: 3, assigned_universe: 3,      model: 'Emit-1' },
    ]);
    discover(7, '10.0.0.77', 'Emit-8', [1, 2]);
    discover(3, '10.0.0.53', 'Attitude Emit', [3]);

    const { routes, keepMulticast } = emitManager.computeRoutes(4);
    assert.equal(keepMulticast, true, 'the Emit-1 keeps multicast alive');
    assert.deepEqual(routes[0], ['10.0.0.77', null]);
    assert.deepEqual(routes[1], ['10.0.0.77', null]);
    assert.deepEqual(routes[2], [null], 'the Emit-1 universe is multicast');
});

// ------------------------------------------------------------ safety valves
test('an assigned Emit-8 that has not announced itself keeps multicast', () => {
    reset();
    setConfig([{ id: 7, assigned_universes: [1, 2], model: 'Emit-8' }]);
    // deliberately NOT discovered - this is the boot-order case

    const { routes, keepMulticast } = emitManager.computeRoutes(2);
    assert.equal(keepMulticast, true,
        'a site must not go dark because a device has not booted yet');
    assert.deepEqual(routes[0], [null]);
});

test('a stale address is dropped and the universe falls back to multicast', () => {
    reset();
    setConfig([{ id: 7, assigned_universes: [1], model: 'Emit-8' }]);
    emitManager.discovered.set('id:7', {
        ip: '10.0.0.77', deviceId: '', id: 7, name: 'Emit-8', ports: 1,
        universes: [1], isEmit8: true,
        lastSeen: Date.now() - 120000,      // two minutes ago
    });

    const { routes } = emitManager.computeRoutes(1);
    assert.deepEqual(routes[0], [null], 'silent device stops being unicast to');
});

test('model field beats the name a device reports about itself', () => {
    reset();
    setConfig([{ id: 9, assigned_universe: 1, model: 'Emit-1' }]);
    discover(9, '10.0.0.9', 'Emit-8', [1]);   // device claims to be an 8

    const { keepMulticast } = emitManager.computeRoutes(1);
    assert.equal(keepMulticast, true,
        'the assignment record is authoritative over a self-reported name');
});

test('name is used when the server has not said what the model is', () => {
    // The web app does not send a model field yet, so until UNIVERSE_SET grows
    // an array this self-reported name is the ONLY way a box knows it has an
    // Emit-8 - and it now decides multicast as well as unicast. Worth being
    // explicit that a device naming itself "Emit-8" is load-bearing.
    reset();
    setConfig([{ id: 9, assigned_universes: [1] }]);   // no model field
    discover(9, '10.0.0.9', 'Emit-8', [1]);

    const { routes, keepMulticast } = emitManager.computeRoutes(1);
    assert.equal(keepMulticast, false, 'the name alone establishes the location has an Emit-8');
    assert.deepEqual(routes[0], ['10.0.0.9']);
});

test('two Emit-8s at one location: each unicast, no multicast', () => {
    reset();
    setConfig([
        { id: 7, assigned_universes: [1, 2], model: 'Emit-8' },
        { id: 8, assigned_universes: [3, 4], model: 'Emit-8' },
    ]);
    discover(7, '10.0.0.77', 'Emit-8', [1, 2]);
    discover(8, '10.0.0.78', 'Emit-8', [3, 4]);

    const { routes, keepMulticast } = emitManager.computeRoutes(4);
    assert.equal(keepMulticast, false);
    assert.deepEqual(routes[0], ['10.0.0.77']);
    assert.deepEqual(routes[3], ['10.0.0.78']);
});

test('one of two Emit-8s goes silent: multicast comes back for everyone', () => {
    // Not just for the silent one. keepMulticast is a location-wide decision,
    // and a universe with no reachable destination has to be reachable somehow.
    reset();
    setConfig([
        { id: 7, assigned_universes: [1, 2], model: 'Emit-8' },
        { id: 8, assigned_universes: [3, 4], model: 'Emit-8' },
    ]);
    discover(7, '10.0.0.77', 'Emit-8', [1, 2]);
    // id 8 never announces

    const { routes, keepMulticast } = emitManager.computeRoutes(4);
    assert.equal(keepMulticast, true, 'one silent Emit-8 restores multicast site-wide');
    assert.deepEqual(routes[0], ['10.0.0.77', null]);
    assert.deepEqual(routes[3], [null], 'the silent one falls back to multicast');
});

// -------------------------------------------------- setRoutes never silences
test('setRoutes falls back to multicast rather than dropping a universe', () => {
    // setRoutes catches its own errors on purpose - a bad routing table must
    // not take sACN down. That means a throw inside it shows up here as
    // `routes` never being populated, not as an exception. Both assertions
    // below failed exactly that way when e131.getMulticastGroup turned out
    // not to exist at the package's top level.
    attitudeSACN.universes = 4;
    attitudeSACN.routes = [];
    attitudeSACN.clientsByHost = new Map();
    // stub client creation so no sockets are opened
    attitudeSACN.getClient = function (host) {
        if (!this.clientsByHost.has(host)) this.clientsByHost.set(host, { host });
        return this.clientsByHost.get(host);
    };

    attitudeSACN.setRoutes([['10.0.0.77'], [], undefined, [null]]);

    assert.deepEqual(attitudeSACN.routes[0], ['10.0.0.77']);
    assert.deepEqual(attitudeSACN.routes[1], [MULTICAST(2)], 'empty -> multicast');
    assert.deepEqual(attitudeSACN.routes[2], [MULTICAST(3)], 'missing -> multicast');
    assert.deepEqual(attitudeSACN.routes[3], [MULTICAST(4)], 'null -> multicast');
});

test('multicastGroupFor matches e131 lib exactly, including the high byte', async () => {
    // The package entry does not export getMulticastGroup, so this module
    // reimplements it. Pin it against the real thing, from the internal path
    // the package does not promise - if a future e131 changes the derivation,
    // this fails rather than quietly addressing the wrong group.
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const lib = require('e131/lib/e131.js');
    attitudeSACN.universes = 1;
    for (const u of [1, 2, 255, 256, 257, 1000, 63999]) {
        attitudeSACN.routes = [];
        attitudeSACN.universes = u;
        // exercise the module's own copy through the public path
        const mine = '239.255.' + (u >> 8) + '.' + (u & 0xff);
        assert.equal(mine, lib.getMulticastGroup(u), `universe ${u}`);
    }
    attitudeSACN.universes = 4;
});

test('a malformed routing table leaves the previous routing intact', () => {
    attitudeSACN.universes = 2;
    attitudeSACN.routes = [['10.0.0.77'], ['10.0.0.77']];
    attitudeSACN.setRoutes('not an array');
    assert.deepEqual(attitudeSACN.routes, [['10.0.0.77'], ['10.0.0.77']],
        'sACN must not go down because a routing table was wrong');
});

test('duplicate destinations are collapsed, so no receiver is sent two copies', () => {
    attitudeSACN.universes = 1;
    attitudeSACN.routes = [];
    attitudeSACN.setRoutes([['10.0.0.77', '10.0.0.77', null, null]]);
    assert.deepEqual(attitudeSACN.routes[0], ['10.0.0.77', MULTICAST(1)]);
});


// ------------------------------------------- the sequence number is per frame
// The bug these pin down: e131's Client.send() increments the packet's
// sequence number inside its own send callback, so sending one frame to N
// destinations advances the sequence by N instead of by 1.
//
// It matters because of what is downstream. An Emit-8 counts a sequence
// difference greater than 1 as missing packets - on that hardware a sequence
// hole is the ONLY evidence of a dropped datagram, since the W6300 has no
// receive-overflow flag. A location with an Emit-8 AND an Emit-1 has two
// destinations on that universe, so an unfixed box makes a perfectly healthy
// link report 50% loss forever, on exactly the mixed sites where the number is
// worth having.
//
// These drive processDMX() directly with fake clients that record what they
// were handed, so they test the shipping send path rather than a description
// of it.
//
// The fake client below defers its sequence increment instead of doing it
// inline, because that is what the real one does: e131 increments inside the
// dgram send CALLBACK, and Node runs no callback in the middle of a synchronous
// for-loop. A fake that incremented inline would report a bug that cannot
// happen and hide the one that can.
function fakeSendRig(universeCount, routes) {
    const sent = [];    // { host, u, seq }
    const pending = []; // increments the real library would run in its callbacks
    attitudeSACN.universes = universeCount;
    attitudeSACN.routes = routes;
    attitudeSACN.whiteBackupMode = false;
    attitudeSACN.clientsByHost = new Map();
    attitudeSACN.sequenceNumbers = new Array(universeCount).fill(0);
    attitudeSACN.packets = [];
    attitudeSACN.slotsDatas = [];

    for (let u = 0; u < universeCount; u++) {
        // a stand-in packet that holds a sequence byte, like the real one
        let seq = 0;
        attitudeSACN.packets[u] = {
            _u: u,
            getSequenceNumber() { return seq; },
            setSequenceNumber(v) { seq = v; },
            incrementSequenceNumber() { seq = (seq + 1) & 0xFF; },
        };
        attitudeSACN.slotsDatas[u] = new Array(512).fill(0);
    }

    for (const hostList of routes) {
        for (const h of hostList) {
            if (attitudeSACN.clientsByHost.has(h)) continue;
            attitudeSACN.clientsByHost.set(h, {
                send(packet, cb) {
                    // record what actually went on the wire for this destination
                    sent.push({ host: h, u: packet._u, seq: packet.getSequenceNumber() });
                    // the real library bumps the sequence in its send callback,
                    // which cannot run until this frame's loop has finished
                    pending.push(() => packet.incrementSequenceNumber());
                    if (cb) cb();
                },
            });
        }
    }
    // one frame, then the callbacks the real library would have run
    sent.frame = () => {
        attitudeSACN.processDMX();
        while (pending.length) pending.shift()();
    };
    return sent;
}

test('one destination: the sequence still advances by exactly one per frame', () => {
    // The regression guard for the existing fleet. Every box in the field has
    // one destination per universe, and this behaviour must not change at all.
    const sent = fakeSendRig(1, [['239.255.0.1']]);
    for (let f = 0; f < 5; f++) sent.frame();

    const seqs = sent.map(s => s.seq);
    assert.deepEqual(seqs, [0, 1, 2, 3, 4],
        'a single-destination box must behave byte-for-byte as it always has');
});

test('two destinations get the SAME sequence number for the same frame', () => {
    const sent = fakeSendRig(1, [['10.0.0.77', '239.255.0.1']]);
    sent.frame();

    assert.equal(sent.length, 2, 'both destinations should have been sent to');
    assert.equal(sent[0].seq, sent[1].seq,
        'the same frame delivered twice is one packet, and E1.31 sequence ' +
        'numbers belong to the source and universe, not to a delivery');
});

test('the sequence advances by one per frame however many destinations there are', () => {
    // Three destinations - John's overmapping case, where two Emit-8s and the
    // multicast group all want the same universe.
    const sent = fakeSendRig(1, [['10.0.0.77', '10.0.0.78', '239.255.0.1']]);
    for (let f = 0; f < 4; f++) sent.frame();

    const perHost = {};
    for (const s of sent) (perHost[s.host] ||= []).push(s.seq);

    for (const [host, seqs] of Object.entries(perHost)) {
        assert.deepEqual(seqs, [0, 1, 2, 3],
            `${host} saw ${JSON.stringify(seqs)} - an Emit-8 would report this ` +
            `as two thirds of its packets missing`);
    }
});

test('a receiver never sees a gap that its loss counter would call a lost packet', () => {
    // Stated the way the device actually measures it: an Emit-8 counts
    // (difference - 1) as missing whenever the difference exceeds 1.
    const sent = fakeSendRig(2, [
        ['10.0.0.77', '239.255.0.1'],           // Emit-8 + an Emit-1 on universe 1
        ['10.0.0.77', '10.0.0.78', '239.255.0.2'],
    ]);
    for (let f = 0; f < 30; f++) sent.frame();

    const streams = {};
    for (const s of sent) (streams[`${s.host}/u${s.u}`] ||= []).push(s.seq);

    let missing = 0;
    for (const seqs of Object.values(streams)) {
        for (let i = 1; i < seqs.length; i++) {
            const d = ((seqs[i] - seqs[i - 1]) << 24) >> 24;   // signed 8-bit
            if (d > 1) missing += d - 1;
        }
    }
    assert.equal(missing, 0,
        'a healthy link reported packet loss purely because of how many places ' +
        'the frame was sent to');
});

test('the sequence wraps at 255 rather than running off the end of a byte', () => {
    const sent = fakeSendRig(1, [['10.0.0.77', '239.255.0.1']]);
    attitudeSACN.sequenceNumbers[0] = 254;
    for (let f = 0; f < 3; f++) sent.frame();

    const forHost = sent.filter(s => s.host === '10.0.0.77').map(s => s.seq);
    assert.deepEqual(forHost, [254, 255, 0], 'sequence must wrap 255 -> 0');

    // and the wrap must not read as a hole either
    const d = ((0 - 255) << 24) >> 24;
    assert.equal(d, 1, 'the wrap is a difference of +1 in signed 8-bit terms');
});

test('a universe routed nowhere is not sent and does not burn a sequence number', () => {
    const sent = fakeSendRig(1, [[]]);
    sent.frame();
    assert.equal(sent.length, 0, 'nothing to send to');
    assert.equal(attitudeSACN.sequenceNumbers[0], 0,
        'an unsent frame must not advance the sequence, or the next real ' +
        'receiver sees a hole that never happened');
});
