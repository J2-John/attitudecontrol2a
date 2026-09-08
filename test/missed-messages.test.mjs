// The offline backlog file: append-only, capped, and readable in both formats.
//
// This file is the device's store-and-forward queue while the server is unreachable. It used to
// read, parse, append to, re-stringify and rewrite ITSELF once per second for the entire length
// of an outage, so the bytes written grew with the SQUARE of the outage - a measured 1.76 GB for
// one hour carrying a single log line per second, on a fleet whose known failure mode is SD card
// wear. It had none of the protections config.json got: no write guard, no size cap, no rate
// limit, and it wrote even when there was nothing to write.
//
//   node --test test/missed-messages.test.mjs
//
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const { default: networkModule, _backlogCountFor } = await import('../NetworkModule.mjs');

// Point the module at a scratch file, run fn, clean up.
function withTempBacklog(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attbacklog-'));
    const file = path.join(dir, 'missedNetworkMessages.json');
    const saved = networkModule.filePath;

    networkModule.filePath = file;

    try {
        return fn(file);
    } finally {
        networkModule.filePath = saved;
        fs.rmSync(dir, { recursive: true, force: true });
    }
}


// Run one real performNetworkRequest tick with the transport stubbed, and hand back the payload
// the module actually assembled. Every backlog test below goes through this rather than setting
// state by hand: the count now travels with the payload and is not reachable from outside, which
// is deliberate - hand-built interleavings are what let three separate defects in that count go
// unnoticed through a green suite.
function realTick(ownRecords = []) {
    const sent = [];
    const savedHttp = networkModule.sendViaHttp;
    const savedConnected = networkModule.isWebSocketConnected;

    networkModule.isWebSocketConnected = () => false;
    networkModule.sendViaHttp = (requestObject, payload) => { sent.push({ requestObject, payload }); };

    try {
        networkModule.queue = ownRecords.slice();
        networkModule.requestInProgress = false;
        networkModule.loadMissedNetworkMessagesFlag = true;

        networkModule.performNetworkRequest();

        return sent[0];
    } finally {
        networkModule.sendViaHttp = savedHttp;
        networkModule.isWebSocketConnected = savedConnected;
        networkModule.requestInProgress = false;
    }
}

const MAX_ERROR_COUNT_FOR_TEST = 99;   // any value above the module's threshold

const record = (i) => ({ type: 'log', data: { message: 'record ' + i } });
const sizeOf = (f) => (fs.existsSync(f) ? fs.statSync(f).size : 0);


test('an empty payload writes nothing at all', () => {
    withTempBacklog((file) => {
        networkModule.savePayloadToFile([]);
        networkModule.savePayloadToFile(undefined);
        networkModule.savePayloadToFile(null);

        assert.equal(fs.existsSync(file), false,
            'the old code rewrote the whole file for an empty payload, and empty is the common case');
    });
});


test('each append costs only the new data, not the whole backlog', () => {
    withTempBacklog((file) => {
        networkModule.savePayloadToFile([record(0)]);
        const afterFirst = sizeOf(file);

        for (let i = 1; i < 500; i++) {
            networkModule.savePayloadToFile([record(i)]);
        }

        const afterMany = sizeOf(file);

        // 500 records of roughly equal size: the file is ~500x one record. If this were still
        // read-modify-rewrite the file would be the same size but the BYTES WRITTEN would have
        // been ~500x larger, which is the defect. Size here is the proxy the test can see.
        assert.ok(afterMany > afterFirst * 400 && afterMany < afterFirst * 600,
            `expected ~500 records worth, got ${afterMany} bytes from ${afterFirst}-byte records`);

        assert.equal(networkModule.loadMissedNetworkMessagesJSONFromFile().length, 500);
    });
});


test('records survive a round trip in order', () => {
    withTempBacklog(() => {
        networkModule.savePayloadToFile([record(1), record(2)]);
        networkModule.savePayloadToFile([record(3)]);

        const back = networkModule.loadMissedNetworkMessagesJSONFromFile();

        assert.deepEqual(back.map((r) => r.data.message), ['record 1', 'record 2', 'record 3']);
    });
});


test('a backlog written by an older build is still readable', () => {
    withTempBacklog((file) => {
        // exactly what the previous implementation wrote: one pretty-printed JSON array
        fs.writeFileSync(file, JSON.stringify([record(1), record(2), record(3)], null, 2));

        const back = networkModule.loadMissedNetworkMessagesJSONFromFile();

        assert.equal(back.length, 3, 'a device updating with a backlog in hand must not lose it');
        assert.equal(back[0].data.message, 'record 1');
    });
});


test('a partial final line costs that line, not the whole backlog', () => {
    withTempBacklog((file) => {
        networkModule.savePayloadToFile([record(1), record(2)]);

        // appendFileSync is not atomic; losing power mid-append leaves a truncated line
        fs.appendFileSync(file, '{"type":"log","data":{"mess');

        const back = networkModule.loadMissedNetworkMessagesJSONFromFile();

        assert.equal(back.length, 2,
            'the old code returned [] for the entire file on any parse error, silently '
            + 'discarding everything the device had queued');
    });
});


test('the backlog is capped, and it is the OLDEST records that go', () => {
    withTempBacklog((file) => {
        // ~2 KB per record, so a few thousand records crosses the 8 MB cap
        const fat = (i) => ({ type: 'log', seq: i, data: { blob: 'x'.repeat(2000) } });

        for (let i = 0; i < 6000; i++) {
            networkModule.savePayloadToFile([fat(i)]);
        }

        const size = sizeOf(file);
        assert.ok(size <= 8 * 1024 * 1024,
            `backlog must stay under the cap, got ${(size / 1048576).toFixed(1)} MB`);

        const back = networkModule.loadMissedNetworkMessagesJSONFromFile();
        assert.ok(back.length > 0, 'compaction must not empty the file');

        // newest kept, oldest dropped - recent telemetry is the useful telemetry
        assert.equal(back[back.length - 1].seq, 5999, 'the newest record must survive');
        assert.ok(back[0].seq > 0, 'the oldest records must be the ones dropped');
    });
});


test('an unserializable record does not cost the rest of the payload', () => {
    withTempBacklog(() => {
        const circular = { type: 'log' };
        circular.self = circular;

        networkModule.savePayloadToFile([record(1), circular, record(2)]);

        const back = networkModule.loadMissedNetworkMessagesJSONFromFile();

        assert.equal(back.length, 2, 'the two good records must still be stored');
        assert.deepEqual(back.map((r) => r.data.message), ['record 1', 'record 2']);
    });
});


test('the drain path queues a batch WITHOUT removing it from disk yet', () => {
    // The contract changed deliberately. Records used to be deleted from the file the instant
    // they were read, so they existed only in RAM until some later sync happened to succeed - and
    // a crash in that window lost them. They now stay on disk until the server confirms them.
    withTempBacklog(() => {
        const all = [];
        for (let i = 0; i < 400; i++) { all.push(record(i)); }
        networkModule.savePayloadToFile(all);

        networkModule.queue = [];
        
        // The load RETURNS the batch; performNetworkRequest is what places it and sets the
        // count. Deriving the boundary from queue length assumed nothing else touched the
        // queue in between, and a synchronous log listener can.
        const batch = networkModule.loadMissedNetworkMessages();

        assert.equal(batch.length, 250, 'MAX_MESSAGES_TO_RESEND_AT_ONCE per pass');
        assert.equal(networkModule.queue.length, 0, 'and it is NOT pushed onto the queue');

        const stillOnDisk = networkModule.loadMissedNetworkMessagesJSONFromFile();
        assert.equal(stillOnDisk.length, 400,
            'NOTHING is removed on read - a crash here must not lose the batch');
    });
});


test('the batch leaves the disk only once the server confirms it', () => {
    withTempBacklog(() => {
        const all = [];
        for (let i = 0; i < 400; i++) { all.push(record(i)); }
        networkModule.savePayloadToFile(all);

        const { payload } = realTick();
        assert.equal(payload.length, 250);

        networkModule.commitBacklogDrain(payload);

        const remaining = networkModule.loadMissedNetworkMessagesJSONFromFile();
        assert.equal(remaining.length, 150, 'the rest stays queued for the next pass');
        assert.equal(remaining[0].data.message, 'record 250', 'and it resumes where it left off');
        assert.equal(_backlogCountFor(payload), 0, 'the count is consumed with the payload');
    });
});


test('a crash before confirmation loses nothing', () => {
    // The whole point. Read the batch, then simulate the process dying: no commit ever runs.
    withTempBacklog(() => {
        const all = [];
        for (let i = 0; i < 10; i++) { all.push(record(i)); }
        networkModule.savePayloadToFile(all);

        networkModule.queue = [];
        
        // ... process dies here. Nothing confirmed, no commit.
        networkModule.queue = [];
        
        const afterRestart = networkModule.loadMissedNetworkMessagesJSONFromFile();
        assert.equal(afterRestart.length, 10, 'every record survived the crash');
        assert.equal(afterRestart[0].data.message, 'record 0');
    });
});


test('THE SUCCESS PATH commits the drain - not just a direct call to it', () => {
    // The sibling test calls commitBacklogDrain() itself, so it would still pass if the call were
    // removed from onNetworkRequestSuccess and the batch never left the disk. Mutation-verified.
    withTempBacklog(() => {
        const all = [];
        for (let i = 0; i < 20; i++) { all.push(record(i)); }
        networkModule.savePayloadToFile(all);

        networkModule.errorCounter = 0;
        const { payload } = realTick();
        assert.equal(payload.length, 20);

        networkModule.onNetworkRequestSuccess(payload, JSON.stringify({ device_id: 1 }));

        assert.equal(networkModule.loadMissedNetworkMessagesJSONFromFile().length, 0,
            'a confirmed batch must leave the disk; if this is 20 the commit never ran');
    });
});


test('THE BATCH RIDES IN THIS REQUEST, not the next one', () => {
    // The backlog used to be loaded AFTER the payload was spliced, so a batch read off the disk
    // did not go out until the next tick - while already deleted from the file.
    withTempBacklog(() => {
        const all = [];
        for (let i = 0; i < 7; i++) { all.push(record(i)); }
        networkModule.savePayloadToFile(all);

        const { payload } = realTick();

        assert.equal(payload.length, 7, 'the backlog batch is IN this request');
        assert.equal(_backlogCountFor(payload), 7, 'and it is marked unconfirmed, on THIS payload');
    });
});


test('a FAILED send does not duplicate the backlog batch', () => {
    // The hazard of not truncating on read: the failure path re-persists the payload, and the
    // backlog portion of it is still in the file. Re-appending would duplicate every record on
    // every retry, and an outage is exactly when retries fail repeatedly.
    withTempBacklog(() => {
        const all = [];
        for (let i = 0; i < 5; i++) { all.push(record(i)); }
        networkModule.savePayloadToFile(all);

        const { payload } = realTick([record(999)]);
        assert.equal(payload.length, 6, '5 replayed + 1 of the device\'s own');

        networkModule.errorCounter = MAX_ERROR_COUNT_FOR_TEST;
        networkModule.onNetworkRequestError(payload, new Error('network down'));

        const onDisk = networkModule.loadMissedNetworkMessagesJSONFromFile();
        assert.equal(onDisk.length, 6, 'the 5 originals plus the ONE new own-record - not 11');
        assert.equal(onDisk[5].data.message, 'record 999');
    });
});


test('a missing file reads as an empty backlog, not an error', () => {
    withTempBacklog(() => {
        assert.deepEqual(networkModule.loadMissedNetworkMessagesJSONFromFile(), []);
    });
});


// ---------------------------------------------------------------------------
// The defects an adversarial pass found in the FIRST version of this mechanism.
//
// Every test above sets pendingBacklogCount = 0 by hand immediately before its scenario - which
// is exactly the state these four defects require to be NON-zero. That is why a green suite said
// nothing about any of them. These drive the real methods with the count left where the previous
// request put it.
// ---------------------------------------------------------------------------


test('A STALE COUNT CANNOT REACH ANOTHER REQUEST\'S PAYLOAD', () => {
    // The count used to be one instance field, so two overlapping requests read each other's.
    // Three defects came out of that: an abandoned request's count made a later success delete
    // records that were never sent; a superseded abort consumed the count belonging to the
    // in-flight request so its confirmed batch was never truncated; and the newer count applied
    // to the older payload silently deleted the device's own records.
    //
    // Keyed on the payload, request A's count is simply unreachable from request B.
    withTempBacklog((file) => {
        const all = [];
        for (let i = 0; i < 400; i++) { all.push(record(i)); }
        networkModule.savePayloadToFile(all);

        const a = realTick();
        assert.equal(_backlogCountFor(a.payload), 250);

        // a second tick, with a DIFFERENT backlog state, while A is still notionally in flight
        const b = realTick();

        assert.equal(_backlogCountFor(a.payload), 250, "A's count is untouched by B");
        assert.notEqual(a.payload, b.payload, 'and they are different payloads');

        // B succeeding must not consume A's count, nor vice versa
        networkModule.commitBacklogDrain(b.payload);
        assert.equal(_backlogCountFor(b.payload), 0);
        assert.equal(_backlogCountFor(a.payload), 250, "and B's commit did not touch A");
    });
});


test('the REPLAYED records go FIRST, because the server applies the payload in order', () => {
    // Backlog records are older than this tick's. The server iterates the payload applying as it
    // goes, so whichever copy comes LAST wins. With the backlog at the end the OLDER value won -
    // and on the one failure that matters, a device that had rolled back to a blocked firmware
    // version replayed the safe version it used to run, the gateway remembered THAT, and handed
    // it the update flag: feeding the exact rollback loop the guard exists to stop.
    withTempBacklog(() => {
        const old = { type: 'systemStatus', data: { firmwareVersion: '2.A.19' } };
        networkModule.savePayloadToFile([old]);

        const sent = [];
        const savedHttp = networkModule.sendViaHttp;
        const savedConnected = networkModule.isWebSocketConnected;

        networkModule.isWebSocketConnected = () => false;
        networkModule.sendViaHttp = (requestObject) => { sent.push(requestObject); };

        try {
            networkModule.queue = [{ type: 'systemStatus', data: { firmwareVersion: '2.A.10' } }];
                        networkModule.requestInProgress = false;
            networkModule.loadMissedNetworkMessagesFlag = true;

            networkModule.performNetworkRequest();

            const versions = sent[0].payload.map((r) => r.data.firmwareVersion);
            assert.deepEqual(versions, ['2.A.19', '2.A.10'],
                'oldest first, so last-write-wins resolves to what the device is running NOW');
        } finally {
            networkModule.sendViaHttp = savedHttp;
            networkModule.isWebSocketConnected = savedConnected;
            networkModule.requestInProgress = false;
        }
    });
});


test("a SUPERSEDED request re-queues the device's OWN records, and only those", () => {
    // The newer request owns the BACKLOG portion - still on disk, and it will be re-read. It does
    // not own the device's own records: those were spliced out of the queue and exist nowhere
    // else.
    withTempBacklog(() => {
        networkModule.savePayloadToFile([record(1), record(2)]);

        const own = { type: 'macrosStatus', data: { updateQueuedFromServer: true } };
        const { payload } = realTick([own]);
        assert.equal(payload.length, 3);

        const orphaned = networkModule.stripBacklogPortion(payload);

        assert.deepEqual(orphaned, [own], 'only the records that exist nowhere else');
        assert.equal(_backlogCountFor(payload), 0, 'the count is consumed');
    });
});


test('a payload with NO recorded count is returned whole', () => {
    // A payload that never carried a backlog batch has no entry at all. It must come back
    // untouched rather than having an assumed count applied to it.
    const payload = [record(1), record(2)];

    assert.deepEqual(networkModule.stripBacklogPortion(payload), payload);
    assert.equal(_backlogCountFor(payload), 0);
});


test('a WEBSOCKET request supersedes an in-flight HTTP one', () => {
    // The generation counter used to be bumped only by sendViaHttp, so a WebSocket request could
    // not supersede a hung HTTP one - and the reconnect path makes that the common case: HTTP
    // hangs during a gateway blip, the socket comes back, the next tick goes over WebSocket.
    const before = networkModule.requestGeneration;

    const savedWs = networkModule.ws;
    networkModule.ws = { send() {}, readyState: 1 };

    try {
        networkModule.sendViaWebSocket({ device_id: 1, payload: [] }, []);

        assert.ok(networkModule.requestGeneration > before,
            'a WebSocket request must move the generation, or a stale HTTP reply stays current');
    } finally {
        networkModule.clearWebSocketResponseTimer();
        networkModule.pendingPayload = null;
        networkModule.ws = savedWs;
    }
});


test('a FAILED TRUNCATION does not report the drain as finished', () => {
    // A read-only remount is this fleet's established failure mode. The write fails, the file
    // still holds every record - and the commit used to clear loadMissedNetworkMessagesFlag
    // anyway, stopping the drain outright on the device that most needed it.
    //
    // THIS TEST WAS VACUOUS. It called commitBacklogDrain() with NO argument; the WeakMap lookup
    // on `undefined` returns undefined, so the method returned at its first line and never
    // reached the code under test. Proven by mutation: restoring the original defect - the save
    // helper returning true from its catch - left all 179 tests green. It now drives a real tick
    // so the payload carries a real count.
    withTempBacklog(() => {
        networkModule.savePayloadToFile([record(1), record(2), record(3)]);

        const { payload } = realTick();
        assert.equal(payload.length, 3);

        const savedWrite = fs.writeFileSync;
        fs.writeFileSync = () => { throw new Error('EROFS: read-only file system'); };

        try {
            networkModule.commitBacklogDrain(payload);
        } finally {
            fs.writeFileSync = savedWrite;
        }

        assert.equal(networkModule.loadMissedNetworkMessagesFlag, true,
            'the drain must keep trying; the records are still on disk');
        assert.equal(networkModule.loadMissedNetworkMessagesJSONFromFile().length, 3,
            'and nothing was lost');
    });
});


test('THE COMMIT TRUNCATES THE BATCH THAT WAS CONFIRMED, not a fixed number', () => {
    // The file GROWS between the load and the commit - which is the normal case during an
    // outage, because every failing tick appends to it. So the commit cannot assume the batch
    // is the whole file, or a remembered size: it has to use the count belonging to the payload
    // the server actually acknowledged.
    withTempBacklog(() => {
        const all = [];
        for (let i = 0; i < 12; i++) { all.push(record(i)); }
        networkModule.savePayloadToFile(all);

        const { payload } = realTick();
        assert.equal(payload.length, 12, 'the batch is 12');

        // the outage continues while that request is in flight
        networkModule.savePayloadToFile([record(100), record(101), record(102), record(103), record(104)]);
        assert.equal(networkModule.loadMissedNetworkMessagesJSONFromFile().length, 17);

        networkModule.commitBacklogDrain(payload);

        const remaining = networkModule.loadMissedNetworkMessagesJSONFromFile();
        assert.equal(remaining.length, 5,
            'exactly the 12 that were confirmed come off; the 5 that arrived since must survive');
        assert.equal(remaining[0].data.message, 'record 100');
    });
});


test('A TRUNCATED FINAL LINE COSTS ONLY ITSELF, not the next record too', () => {
    // appendFileSync is not atomic, so a power cut mid-append leaves a line with no newline.
    // Appending straight onto it fused the stub with the NEXT record into one unparseable line,
    // so the power cut cost two records instead of one - and if the second carried the
    // macrosStatus ack, the device stays on old firmware.
    withTempBacklog((file) => {
        networkModule.savePayloadToFile([record(1), record(2)]);

        // simulate the power cut: a partial record with no trailing newline
        fs.appendFileSync(file, '{"type":"log","data":{"mess');

        networkModule.savePayloadToFile([record(3), record(4)]);

        const back = networkModule.loadMissedNetworkMessagesJSONFromFile();
        const messages = back.map((r) => r.data.message);

        assert.ok(messages.includes('record 3'),
            'record 3 must survive; fused onto the stub it is destroyed along with it');
        assert.ok(messages.includes('record 4'));
        assert.equal(back.length, 4, 'all four good records, only the stub lost');
    });
});


test('APPENDING TO A LEGACY-FORMAT BACKLOG DOES NOT DESTROY IT', () => {
    // The reader picks its format from the first character: '[' means the old single-JSON-array
    // format and it parses the WHOLE file at once. Appending a newline-delimited record produced
    // `[...]\n{...}`, which that parse rejects - so the reader returned [] for the ENTIRE file,
    // loadMissedNetworkMessages set the drain flag to false, and the device stopped queueing to
    // disk for the life of that boot.
    //
    // Reproduced before the fix: 301 records in, one append, 0 readable, macrosStatus ack gone.
    // The ~500 cards provisioned with the pre-2026-08-08 build hold exactly this format, and the
    // trigger is any of them being offline for six seconds - long enough for errorCounter to
    // cross MAX_ERROR_COUNT and reach savePayloadToFile.
    //
    // This is a regression from making the file append-only; the old read-modify-rewrite happened
    // to keep the file in one format.
    withTempBacklog((file) => {
        const legacy = [];
        for (let i = 0; i < 20; i++) { legacy.push(record(i)); }
        legacy.push({ type: 'macrosStatus', data: { updateQueuedFromServer: true, updateCommandSuccess: true } });

        // written the way the old build wrote it
        fs.writeFileSync(file, JSON.stringify(legacy));
        assert.equal(networkModule.loadMissedNetworkMessagesJSONFromFile().length, 21);

        networkModule.savePayloadToFile([record(999)]);

        const back = networkModule.loadMissedNetworkMessagesJSONFromFile();
        assert.equal(back.length, 22, 'the 21 legacy records survive and the new one is added');
        assert.ok(back.some((r) => r.type === 'macrosStatus'),
            'the update acknowledgement must still be recoverable - losing it strands the device');
        assert.equal(back[21].data.message, 'record 999');
    });
});


test('a legacy file is converted ONCE, then appended to normally', () => {
    withTempBacklog((file) => {
        fs.writeFileSync(file, JSON.stringify([record(1), record(2)]));

        networkModule.savePayloadToFile([record(3)]);
        assert.equal(fs.readFileSync(file, 'utf8').trimStart()[0], '{',
            'the file is newline-delimited after the first append');

        networkModule.savePayloadToFile([record(4)]);
        assert.equal(networkModule.loadMissedNetworkMessagesJSONFromFile().length, 4);
    });
});
