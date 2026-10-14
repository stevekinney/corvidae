import { describe, expect, it } from 'bun:test';

import { startMainThreadCpuClock } from './main-thread-cpu.ts';

describe('startMainThreadCpuClock', () => {
  it('does not count time the thread spends waiting, the way a wall clock would', async () => {
    const readCpuMilliseconds = startMainThreadCpuClock();
    const wallStarted = performance.now();

    await Bun.sleep(100);

    expect(performance.now() - wallStarted).toBeGreaterThanOrEqual(95);
    expect(readCpuMilliseconds()).toBeLessThan(50);
  });

  it('counts time the thread spends computing', () => {
    const readCpuMilliseconds = startMainThreadCpuClock();
    let accumulator = 0;
    while (readCpuMilliseconds() < 20) accumulator += Math.sqrt(accumulator + 1);

    expect(readCpuMilliseconds()).toBeGreaterThanOrEqual(20);
    expect(accumulator).toBeGreaterThan(0);
  });
});
