import { describe, expect, test } from 'bun:test';

import { createDeferred } from './fixtures/deferred.ts';
import { createScriptedStream } from './fixtures/scripted-sources.ts';
import type { AttachmentListener } from './session-types.ts';
import {
  createHarness,
  expectAttached,
  flush,
  startAndAttach,
  utf8,
  type Harness,
} from './session.test-support.ts';

describe('a backend that exits while it is still starting', () => {
  test('starts the sources and drains the tail before closing', async () => {
    const stream = createScriptedStream('pty');
    stream.push(utf8('tail'));
    stream.end();
    const holder: { harness?: Harness } = {};
    const gate = createDeferred<void>();
    const harness = createHarness({
      sources: [stream.source],
      backend: {
        start: () => {
          holder.harness?.session.reportProcessExit(0, null);
          return gate.promise;
        },
      },
    });
    holder.harness = harness;
    const attachment = expectAttached(
      harness.session.attach({
        requestedMode: 'interactive',
        grant: 'interactive',
        listener: harness.recorder.listener,
      }),
    );
    void harness.session.start();
    await flush();
    gate.resolve();
    await flush();
    expect(harness.recorder.ofType('output').map((event) => event.bytes)).toEqual([utf8('tail')]);
    expect(harness.session.snapshot.closed).toBe(false);
    attachment.outputParsedThrough(4);
    const summary = await harness.session.closed;
    expect(summary).toMatchObject({
      cause: 'process-exit',
      drain: { state: 'drained', unavailableBytes: 0 },
      cleanup: 'complete',
    });
    expect(harness.recorder.types).toEqual([
      'processExit',
      'output',
      'sourceComplete',
      'attachmentRevoked',
      'sessionClosed',
    ]);
  });

  test('an exit before the start promise settles does not leave the drain waiting forever', async () => {
    const stream = createScriptedStream('pty');
    const gate = createDeferred<void>();
    const holder: { harness?: Harness } = {};
    const harness = createHarness({
      sources: [stream.source],
      backend: {
        start: () => {
          holder.harness?.session.reportProcessExit(0, null);
          return gate.promise;
        },
      },
    });
    holder.harness = harness;
    harness.session.attach({
      requestedMode: 'interactive',
      grant: 'interactive',
      listener: harness.recorder.listener,
    });
    void harness.session.start();
    await flush();
    // The start promise never settles and the stream never ends: the cleanup deadline bounds the wait.
    harness.clock.advance(5_000);
    await flush();
    // Cleanup then waits for the start that never settled, bounded by its own deadline.
    harness.clock.advance(5_000);
    await flush();
    expect(await harness.session.closed).toMatchObject({ cause: 'process-exit' });
  });
});

describe('the operation FIFO', () => {
  test('bounds unsettled operations at the depth plus the one in flight', async () => {
    const barrier = createDeferred<void>();
    const harness = createHarness({ backend: { write: () => barrier.promise } });
    const attachment = await startAndAttach(harness);
    expect(attachment.write(Uint8Array.of(1))).toMatchObject({ disposition: 'accepted' });
    await flush();
    // The first write is in flight and blocked; the FIFO behind it holds the full depth of 256.
    // That is depth + 1 unsettled operations, the window the endpoint keeps failable after COR-1510.
    for (let index = 0; index < 256; index += 1) {
      expect(attachment.write(Uint8Array.of(1))).toMatchObject({ disposition: 'accepted' });
    }
    expect(attachment.write(Uint8Array.of(1))).toMatchObject({
      disposition: 'failed',
      reason: 'fifo-full',
    });
    barrier.resolve();
    await flush();
    expect(attachment.write(Uint8Array.of(1))).toMatchObject({ disposition: 'accepted' });
  });

  test('a burst before the first microtask still holds at the same bound', async () => {
    const barrier = createDeferred<void>();
    const harness = createHarness({ backend: { write: () => barrier.promise } });
    const attachment = await startAndAttach(harness);
    let accepted = 0;
    for (let index = 0; index < 400; index += 1) {
      if (attachment.write(Uint8Array.of(1)).disposition === 'accepted') accepted += 1;
    }
    // Nothing has been taken yet, so only the queue depth is available.
    expect(accepted).toBe(256);
    barrier.resolve();
    await flush();
  });
});

describe('acknowledging acceptance', () => {
  test('the backend is not invoked until the accepted receipt has been returned', async () => {
    const harness = createHarness();
    const attachment = await startAndAttach(harness);
    const receipt = attachment.write(utf8('x'));
    expect(receipt).toMatchObject({ disposition: 'accepted' });
    expect(harness.backend?.calls.filter((call) => call.call === 'write')).toEqual([]);
    await flush();
    expect(harness.backend?.calls.filter((call) => call.call === 'write')).toEqual([
      { call: 'write', bytes: utf8('x') },
    ]);
  });

  test('a resize is deferred the same way', async () => {
    const harness = createHarness();
    const attachment = await startAndAttach(harness);
    attachment.resize(100, 40);
    expect(harness.backend?.calls.filter((call) => call.call === 'resize')).toEqual([]);
    await flush();
    expect(harness.backend?.calls.filter((call) => call.call === 'resize')).toHaveLength(1);
  });
});

describe('a listener that rejects late', () => {
  function lateListener(gate: { promise: Promise<void> }): AttachmentListener {
    return (event) => (event.type === 'processExit' ? gate.promise : undefined);
  }

  test('still sets the callback-failed cause before the summary is final', async () => {
    const gate = createDeferred<void>();
    const harness = createHarness({ sources: [] });
    harness.session.attach({
      requestedMode: 'interactive',
      grant: 'interactive',
      listener: lateListener(gate),
    });
    void harness.session.start();
    await flush();
    harness.session.reportProcessExit(0, null);
    await flush();
    expect(harness.session.snapshot.closed).toBe(false);
    gate.reject(new Error('listener failed late'));
    expect(await harness.session.closed).toMatchObject({ cause: 'callback-failed' });
  });

  test('a listener whose promise resolves leaves the cause alone', async () => {
    const harness = createHarness({ sources: [] });
    harness.session.attach({
      requestedMode: 'interactive',
      grant: 'interactive',
      listener: () => Promise.resolve(),
    });
    void harness.session.start();
    await flush();
    harness.session.reportProcessExit(0, null);
    expect(await harness.session.closed).toMatchObject({ cause: 'process-exit' });
  });

  test('a delivery that never settles is bounded by the cleanup deadline', async () => {
    const harness = createHarness({ sources: [] });
    harness.session.attach({
      requestedMode: 'interactive',
      grant: 'interactive',
      listener: lateListener({ promise: new Promise(() => undefined) }),
    });
    void harness.session.start();
    await flush();
    harness.session.reportProcessExit(0, null);
    await flush();
    harness.clock.advance(5_000);
    await flush();
    expect(await harness.session.closed).toMatchObject({ cause: 'process-exit' });
  });
});
