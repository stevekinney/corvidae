import { afterAll, afterEach } from 'bun:test';
import 'fake-indexeddb/auto';
import { restoreRealTimers } from '../src/testing/fake-timers.test-support.ts';
import {
  createRealTimerTracker,
  ENGINE_CLEANUP_INTERVAL_EXEMPTION,
} from '../src/testing/real-timer-leak-guard.test-support.ts';

// Fail the run when a real timer outlives the tests that armed it: a leaked
// timer keeps firing into every later file in this process (COR-1339).
const realTimers = createRealTimerTracker();
realTimers.install();

// TEMPORARY, removed by COR-1342 together with ENGINE_CLEANUP_INTERVAL_EXEMPTION:
// `WEFT_STRICT_TIMER_LEAK_GUARD=1` disables the exemption, to check a file for
// engine leaks too.
const exemptions =
  process.env['WEFT_STRICT_TIMER_LEAK_GUARD'] === '1' ? [] : [ENGINE_CLEANUP_INTERVAL_EXEMPTION];

// Each test starts with native timers, even after a failed fake-clock assertion.
afterEach(restoreRealTimers);

afterAll(() => realTimers.assertNoLeaks(exemptions));
