// A gateway error reply must be treated as a FAILED sync, not a successful one.
//
// The gateway answers a rejected sync with {"error": "..."} - a bad serial, an unknown device id,
// an internal fault. The WebSocket message handler used to hand that to onNetworkRequestSuccess,
// which:
//
//   1. reset errorCounter to 0, so a device whose every sync was being REFUSED reported itself
//      online and never entered the missed-message path - its queued logs and statuses were
//      spliced off and discarded on each tick, so the failure was invisible from both ends;
//   2. passed the error to configManager.update(), which merges every top-level key into the
//      config and persists it - writing `"error": "Invalid device id"` into config.json on the
//      SD card;
//   3. left it there for the life of the card, because mergeObjects has no delete path.
//
// The HTTP transport never had this: fetch throws on a non-2xx before reaching the success path.
// It was specific to the WebSocket path, which is the one the fleet actually uses.
//
//   node --test test/gateway-error-replies.test.mjs
//
import test from 'node:test';
import assert from 'node:assert/strict';

const { default: networkModule } = await import('../NetworkModule.mjs');

// Drive the module's own handlers and record which one ran, without a socket or a server.
function harness() {
    const calls = { success: [], error: [], configUpdates: [] };

    const savedSuccess = networkModule.onNetworkRequestSuccess;
    const savedError = networkModule.onNetworkRequestError;

    networkModule.onNetworkRequestSuccess = (payload, body) => { calls.success.push(body); };
    networkModule.onNetworkRequestError = (payload, err) => { calls.error.push(err.message); };

    return {
        calls,
        restore() {
            networkModule.onNetworkRequestSuccess = savedSuccess;
            networkModule.onNetworkRequestError = savedError;
        },
    };
}

// The exact dispatch the socket 'message' listener performs, driven directly. Extracted here
// rather than restated: it calls the module's real methods, so the branch under test is the
// shipped one.
function deliver(h, body) {
    networkModule.pendingPayload = [{ type: 'log', data: { message: 'x' } }];
    networkModule.handleWebSocketMessage(Buffer.from(body));
}


test('an error reply routes to the FAILURE path, not the success path', () => {
    const h = harness();
    try {
        deliver(h, JSON.stringify({ error: 'Invalid device id' }));

        assert.equal(h.calls.success.length, 0,
            'a refused sync must never be counted as a success');
        assert.equal(h.calls.error.length, 1,
            'it goes to the error handler, which re-queues the payload');
        assert.match(h.calls.error[0], /Invalid device id/,
            'and the gateway message is preserved for the log');
    } finally {
        h.restore();
    }
});


test('the internal-error reply is caught too', () => {
    const h = harness();
    try {
        deliver(h, JSON.stringify({ error: 'Internal gateway error' }));
        assert.equal(h.calls.error.length, 1);
        assert.equal(h.calls.success.length, 0);
    } finally {
        h.restore();
    }
});


test('a REAL sync reply still goes to the success path', () => {
    // The guard must key on the absence of device_id, not on the presence of the word "error".
    // Every reply handleSync produces carries device_id - both the 'config' and the 'nochange'
    // shapes are the same object - so this is the discriminator, and it is the one that cannot
    // be spoofed into refusing a healthy device.
    const h = harness();
    try {
        for (const reply of [
            { device_id: 42, serialnumber: 'AC-0020135', type: 'nochange', update: false },
            { device_id: 42, serialnumber: 'AC-0020135', type: 'config', zones: [], shows: [] },
            { device_id: 42, type: 'config', update: true },
        ]) {
            const before = h.calls.success.length;
            deliver(h, JSON.stringify(reply));
            assert.equal(h.calls.success.length, before + 1,
                `a real reply must be handled normally: ${JSON.stringify(reply)}`);
        }
        assert.equal(h.calls.error.length, 0, 'and none of them was treated as a failure');
    } finally {
        h.restore();
    }
});


test('a reply carrying BOTH device_id and an error field is still a success', () => {
    // Deliberately permissive in the safe direction. If a future gateway reply ever carries an
    // advisory `error` field alongside a real config, refusing it would strand the device -
    // and the update flag rides on exactly that reply. Only a reply with no device_id at all,
    // which is the gateway's error shape, is refused.
    const h = harness();
    try {
        deliver(h, JSON.stringify({ device_id: 42, error: 'something advisory', update: true }));
        assert.equal(h.calls.success.length, 1);
        assert.equal(h.calls.error.length, 0);
    } finally {
        h.restore();
    }
});


test('an unparseable body is left to handleResponse, exactly as before', () => {
    // Not a behaviour change: handleResponse already swallows a malformed body inside its own
    // try/catch. Routing it to the error path here would be a new behaviour on a path that has
    // been working, so the guard deliberately does not claim it.
    const h = harness();
    try {
        deliver(h, 'not json at all');
        assert.equal(h.calls.success.length, 1, 'unchanged: it goes to the success path');
        assert.equal(h.calls.error.length, 0);
    } finally {
        h.restore();
    }
});


test('A REPLY THAT IS NOT A SYNC REPLY IS TREATED AS A FAILURE', () => {
    // This test used to assert the OPPOSITE - that '{"error":42}', '"error"', '[]', 'null' and
    // '123' were all successes - and in doing so it locked in the defect the file exists to
    // prevent. Detection was a blacklist of one shape, `{"error": "<string>"}`, so every other
    // rejection the gateway or a proxy can emit reset errorCounter (device reports itself online,
    // never queues) AND was merged into config.json by configManager.update(), where mergeObjects
    // has no delete path so it survives every boot. Verified: `{"error":{"code":422}}`,
    // `{"message":"Unauthenticated."}` and `{"errors":{...}}` all landed on the card.
    //
    // It is a whitelist now: a real sync reply always carries device_id - there is exactly one
    // response object in the gateway's handleSync, it sets device_id unconditionally, and both of
    // its return statements return that object. Anything else is re-queued and retried, which
    // loses nothing.
    const h = harness();
    try {
        for (const body of ['"error"', '[]', 'null', '123', '{"error":42}',
                            '{"error":{"code":422,"message":"Invalid device id"}}',
                            '{"message":"Unauthenticated."}',
                            '{"errors":{"serialnumber":["invalid"]}}']) {
            const before = h.calls.error.length;
            deliver(h, body);
            assert.equal(h.calls.error.length, before + 1, `must not be a success: ${body}`);
        }
        assert.equal(h.calls.success.length, 0, 'none of these may reach configManager.update()');
    } finally {
        h.restore();
    }
});


test('a REAL sync reply is still a success', () => {
    // The other half. A whitelist that refuses everything would be just as broken, and the cost
    // would be every device on the fleet re-queueing forever.
    const h = harness();
    try {
        deliver(h, JSON.stringify({ device_id: 1, serialnumber: 'AC-0020104', nochange: true }));
        deliver(h, JSON.stringify({ device_id: 1, serialnumber: 'AC-0020104', timezone: 'UTC' }));

        assert.equal(h.calls.success.length, 2);
        assert.equal(h.calls.error.length, 0);
    } finally {
        h.restore();
    }
});


test('an unsolicited message is still ignored outright', () => {
    // The pre-existing guard. A stray or duplicate frame with nothing pending must not reset the
    // error counter or be applied as configuration.
    const h = harness();
    try {
        networkModule.pendingPayload = null;
        networkModule.handleWebSocketMessage(Buffer.from(JSON.stringify({ device_id: 42 })));

        assert.equal(h.calls.success.length, 0);
        assert.equal(h.calls.error.length, 0);
    } finally {
        h.restore();
    }
});
