import { afterAll, afterEach } from 'bun:test';
import 'fake-indexeddb/auto';
import { restoreRealTimers } from '../src/testing/fake-timers.test-support.ts';
import { createRealTimerTracker } from '../src/testing/real-timer-leak-guard.test-support.ts';

// Fail the run when a real timer outlives the tests that armed it: a leaked
// timer keeps firing into every later file in this process (COR-1339,
// COR-1343). No timer is exempt (COR-1342).
const realTimers = createRealTimerTracker();
realTimers.install();

// Each test starts with native timers, even after a failed fake-clock assertion.
afterEach(restoreRealTimers);

afterAll(() => realTimers.assertNoLeaks());
