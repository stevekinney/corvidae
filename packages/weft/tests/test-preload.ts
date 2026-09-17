import { afterEach } from 'bun:test';
import 'fake-indexeddb/auto';
import { restoreRealTimers } from '../src/testing/fake-timers.test-support.ts';

// Each test starts with native timers, even after a failed fake-clock assertion.
afterEach(restoreRealTimers);
