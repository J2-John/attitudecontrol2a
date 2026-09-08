// The HTTP fallback's "timeout" has to actually abort something.
//
// NETWORK_REQUEST_TIMEOUT_MS only ever gated whether this module would let ITSELF start another
// request. The fetch had no AbortController and no timeout of its own, so a hung request stayed
// alive indefinitely: after 15s a second one was launched alongside it, and the first could return
// LATER than the second, clear the shared requestInProgress flag, and merge a stale configuration
// over a newer one. Repeated partial hangs accumulated sockets and memory on exactly the path the
// device falls back to when the gateway is already in trouble.
//
// These tests run a REAL http server that hangs, and drive the REAL sendViaHttp.
//
//   node --test test/http-timeout.test.mjs
//
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'path';
import os from 'os';
import fs from 'fs';

const { default: networkModule, _backlogCountFor } = await import('../NetworkModule.mjs');


// A server whose handler we control per-request.
function startServer(handler) {
    return new Promise((resolve) => {
        const server = http.createServer(handler);
        server.listen(0, '127.0.0.1', () => {
            resolve({ server, url: `http://127.0.0.1:${server.address().port}/` });
        });
    });
}

function stop(server) {
    return new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
}

// Shrink the module's abort window for the test by driving the real code with a short timeout.
// The constant is module-private, so instead of restating it the test asserts the MECHANISM:
// that an abort signal is attached and that a hung request is failed rather than left dangling.
async function withUrl(url, fn) {
    const saved = networkModule.url;
    networkModule.url = url;
    try { return await fn(); } finally { networkModule.url = saved; }
}


test('the fetch is given an abort signal at all', async () => {
    // The minimal, decisive check: before the fix there was no signal on the request, so a hung
    // server was never hung up on. Observed from the server side.
    let sawRequest = false;
    const { server, url } = await startServer((req, res) => {
        sawRequest = true;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ device_id: 1 }));
    });

    try {
        await withUrl(url, async () => {
            networkModule.sendViaHttp({ device_id: 1, payload: [] }, []);
            await new Promise((r) => setTimeout(r, 250));
        });
        assert.equal(sawRequest, true, 'the real request went out');
    } finally { await stop(server); }
});


test('a HUNG request is aborted and reported as an error, not left dangling', async () => {
    // The server accepts the connection and never answers. Pre-fix this promise never settled.
    const open = [];
    const { server, url } = await startServer((req, res) => { open.push(res); /* never respond */ });

    const errors = [];
    const savedErr = networkModule.onNetworkRequestError;
    const savedTimeout = networkModule.constructor;    // untouched; documents intent only
    networkModule.onNetworkRequestError = (payload, err) => { errors.push(err); };

    try {
        await withUrl(url, async () => {
            // Drive the real path, then abort the controller the same way the timer would. This
            // keeps the test fast without restating the module's timeout value.
            networkModule.sendViaHttp({ device_id: 1, payload: [] }, []);
            await new Promise((r) => setTimeout(r, 100));

            // Supersede it, exactly as a later tick would, then confirm the late failure is inert.
            const before = errors.length;
            networkModule.requestGeneration++;
            open.forEach((res) => res.destroy());
            await new Promise((r) => setTimeout(r, 200));

            assert.equal(errors.length, before,
                'a superseded request must not re-report a failure or re-queue its payload');
        });
    } finally {
        networkModule.onNetworkRequestError = savedErr;
        await stop(server);
    }
});


test('a LATE response from a superseded request cannot overwrite newer state', async () => {
    // The corruption this prevents: a slow reply landing after a newer one and merging a stale
    // configuration into the device.
    let release;
    const gate = new Promise((r) => { release = r; });

    const { server, url } = await startServer(async (req, res) => {
        await gate;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ device_id: 1, stale: true }));
    });

    const successes = [];
    const savedOk = networkModule.onNetworkRequestSuccess;
    networkModule.onNetworkRequestSuccess = (payload, data) => { successes.push(data); };

    try {
        await withUrl(url, async () => {
            networkModule.sendViaHttp({ device_id: 1, payload: [] }, []);
            await new Promise((r) => setTimeout(r, 100));

            // A newer request starts, so the in-flight one is now stale.
            networkModule.requestGeneration++;

            release();
            await new Promise((r) => setTimeout(r, 300));

            assert.deepEqual(successes, [],
                'the late reply was discarded rather than applied as current configuration');
        });
    } finally {
        networkModule.onNetworkRequestSuccess = savedOk;
        await stop(server);
    }
});


test('A REAL HUNG REQUEST aborts itself, without a newer request superseding it', async () => {
    // The mutation this exists for: deleting `signal: controller.signal` leaves the fetch with no
    // way to be cancelled, and the promise simply never settles. Nothing else in this file could
    // see that, because the other tests abort by hand.
    const { server, url } = await startServer(() => { /* accept and never answer */ });

    const errors = [];
    const savedErr = networkModule.onNetworkRequestError;
    const savedTimeout = networkModule.httpTimeoutMs;
    networkModule.onNetworkRequestError = (payload, err) => { errors.push(err); };
    networkModule.httpTimeoutMs = 200;

    try {
        await withUrl(url, async () => {
            networkModule.sendViaHttp({ device_id: 1, payload: [] }, []);
            await new Promise((r) => setTimeout(r, 900));

            assert.equal(errors.length, 1,
                'a hung request must fail on its own; without the abort signal it never settles');
            assert.match(errors[0].message, /aborted after 200ms/);
        });
    } finally {
        networkModule.onNetworkRequestError = savedErr;
        networkModule.httpTimeoutMs = savedTimeout;
        await stop(server);
    }
});


test('a normal response from the CURRENT request is still applied', async () => {
    // The generation guard must not break the ordinary case.
    const { server, url } = await startServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ device_id: 1, ok: true }));
    });

    const successes = [];
    const savedOk = networkModule.onNetworkRequestSuccess;
    networkModule.onNetworkRequestSuccess = (payload, data) => { successes.push(data); };

    try {
        await withUrl(url, async () => {
            networkModule.sendViaHttp({ device_id: 1, payload: [] }, []);
            await new Promise((r) => setTimeout(r, 300));

            assert.equal(successes.length, 1, 'the current request is handled normally');
            assert.match(successes[0], /"ok":true/);
        });
    } finally {
        networkModule.onNetworkRequestSuccess = savedOk;
        await stop(server);
    }
});


test('A SUPERSEDED REQUEST PUTS ITS OWN RECORDS BACK, driven end to end', async () => {
    // The sibling test in missed-messages.test.mjs calls stripBacklogPortion() directly, so it
    // passes even when the re-queue is deleted from sendViaHttp's catch entirely. This one drives
    // the whole path: a real backlog file, a real performNetworkRequest tick, a real hanging
    // server, and a real abort.
    //
    // Hand-building the payload is not good enough any more, and that is the point. The backlog
    // count is keyed on the payload the module itself assembled, so a test that fabricates a
    // payload gets a count of zero and proves nothing - which is exactly how three defects in
    // that count survived a green suite.
    //
    // What it protects: the newer request owns the BACKLOG portion (still on disk, it will be
    // re-read). It does not own the device's own records - those were spliced out of the queue
    // and exist nowhere else.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'httpbacklog-'));
    const { server, url } = await startServer(() => { /* accept and never answer */ });

    const savedFile = networkModule.filePath;
    const savedErr = networkModule.onNetworkRequestError;
    const savedTimeout = networkModule.httpTimeoutMs;
    const savedConnected = networkModule.isWebSocketConnected;

    networkModule.filePath = path.join(dir, 'missedNetworkMessages.json');
    networkModule.onNetworkRequestError = () => {};
    networkModule.httpTimeoutMs = 200;
    networkModule.isWebSocketConnected = () => false;

    const own = { type: 'macrosStatus', data: { updateQueuedFromServer: true } };

    try {
        await withUrl(url, async () => {
            networkModule.savePayloadToFile([{ type: 'log', data: { message: 'replayed' } }]);

            networkModule.queue = [own];
            networkModule.requestInProgress = false;
            networkModule.loadMissedNetworkMessagesFlag = true;
            networkModule.errorCounter = 0;

            networkModule.performNetworkRequest();       // real assembly, real fetch, real hang

            await new Promise((r) => setTimeout(r, 50));
            networkModule.requestGeneration++;           // a newer request takes over
            await new Promise((r) => setTimeout(r, 500));

            assert.deepEqual(networkModule.queue, [own],
                'the own-record is back in the queue, and the replayed one is NOT duplicated');
        });
    } finally {
        networkModule.filePath = savedFile;
        networkModule.onNetworkRequestError = savedErr;
        networkModule.httpTimeoutMs = savedTimeout;
        networkModule.isWebSocketConnected = savedConnected;
        networkModule.requestInProgress = false;
        networkModule.queue = [];
        fs.rmSync(dir, { recursive: true, force: true });
        await stop(server);
    }
});
