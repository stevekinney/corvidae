import { describe, expect, it } from 'bun:test';
import { AttemptControllerTable } from './attempt-controllers.ts';

// Regression (COR-1343): RemoteWorker and LongPollWorker both arm a
// per-attempt heartbeat `setInterval` right after registering the attempt's
// AbortController, and both relied on the attempt's own `finally` block to
// `clearInterval` it. An activity that never settles (ignores its abort
// signal, e.g. `await new Promise(() => {})`) never reaches that `finally`,
// so aborting or deleting the attempt out from under it — the drain-timeout
// path, `stop()`, or `[Symbol.dispose]()` — left the heartbeat interval
// running forever, firing real timers the timer-leak guard reports as a
// leak. `setHeartbeatTimer` lets `delete`/`abortAll` clear it too.
describe('AttemptControllerTable heartbeat timer tracking', () => {
  it('abortAll clears every tracked heartbeat timer, not just the AbortController', async () => {
    const table = new AttemptControllerTable();
    const controller = new AbortController();
    table.set('op-1', 'attempt-1', controller);

    let heartbeats = 0;
    const timer = setInterval(() => {
      heartbeats++;
    }, 5);
    table.setHeartbeatTimer('op-1', 'attempt-1', timer);

    table.abortAll();

    expect(controller.signal.aborted).toBe(true);
    // If the interval were still armed it would have fired multiple times in
    // this window; a cleared interval fires zero.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(heartbeats).toBe(0);
  });

  it("delete clears exactly that attempt's tracked heartbeat timer", async () => {
    const table = new AttemptControllerTable();
    const controller = new AbortController();
    table.set('op-2', 'attempt-2', controller);

    let heartbeats = 0;
    const timer = setInterval(() => {
      heartbeats++;
    }, 5);
    table.setHeartbeatTimer('op-2', 'attempt-2', timer);

    table.delete('op-2', 'attempt-2');

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(heartbeats).toBe(0);
  });
});
