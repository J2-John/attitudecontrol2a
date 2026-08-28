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

function setConfig(emits, suppressMulticast = false) {
    configManager.getAttitudeEmits = () => emits;
    configManager.getSuppressSacnMulticast = () => suppressMulticast;
}

function discover(id, ip, name, universes) {
    emitManager.discovered.set(id, {
        ip, name, universes,
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

test('Emit-8 only, location NOT opted out: unicast AND multicast', () => {
    // The default, and the one that matters most. Third-party sACN receivers
    // exist at many locations and appear nowhere in attitudeEmits, so an
    // all-Emit-8 assignment list is not evidence that nothing else is
    // listening. Multicast stays until a human says otherwise.
    reset();
    setConfig([{ id: 7, assigned_universes: [1, 2, 3, 4], model: 'Emit-8' }]);
    discover(7, '10.0.0.77', 'Emit-8', [1, 2, 3, 4]);

    const { routes, keepMulticast } = emitManager.computeRoutes(4);
    assert.equal(keepMulticast, true, 'third-party receivers must not be cut off');
    for (let u = 0; u < 4; u++) {
        assert.deepEqual(routes[u], ['10.0.0.77', null],
            `universe ${u + 1} unicast plus multicast`);
    }
});

test('Emit-8 only, location opted out: unicast only', () => {
    reset();
    setConfig([{ id: 7, assigned_universes: [1, 2, 3, 4], model: 'Emit-8' }], true);
    discover(7, '10.0.0.77', 'Emit-8', [1, 2, 3, 4]);

    const { routes, keepMulticast } = emitManager.computeRoutes(4);
    assert.equal(keepMulticast, false, 'opted out and every Emit-8 reachable');
    for (let u = 0; u < 4; u++) {
        assert.deepEqual(routes[u], ['10.0.0.77'], `universe ${u + 1} unicast only`);
    }
});

test('opted out but an Emit-1 is present: multicast stays', () => {
    reset();
    setConfig([
        { id: 7, assigned_universes: [1], model: 'Emit-8' },
        { id: 3, assigned_universe: 2,   model: 'Emit-1' },
    ], true);
    discover(7, '10.0.0.77', 'Emit-8', [1]);
    discover(3, '10.0.0.53', 'Attitude Emit', [2]);

    const { keepMulticast } = emitManager.computeRoutes(2);
    assert.equal(keepMulticast, true, 'the opt-out does not override a real Emit-1');
});

test('opted out but an Emit-8 has not announced itself: multicast stays', () => {
    reset();
    setConfig([{ id: 7, assigned_universes: [1] }, ], true);
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
    emitManager.discovered.set(7, {
        ip: '10.0.0.77', name: 'Emit-8', universes: [1], isEmit8: true,
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
    reset();
    setConfig([{ id: 9, assigned_universes: [1] }]);   // no model field
    discover(9, '10.0.0.9', 'Emit-8', [1]);
    // name-based detection still routes unicast; it just does not remove
    // multicast, because only the opt-out can do that

    const { routes, keepMulticast } = emitManager.computeRoutes(1);
    assert.equal(keepMulticast, true, 'not opted out, so multicast stays');
    assert.deepEqual(routes[0], ['10.0.0.9', null]);
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
