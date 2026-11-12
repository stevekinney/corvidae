import { describe, expect, test } from 'bun:test';

import { withMemoryAdmission } from './host-slots.ts';
import {
  forgetParentSnapshot,
  memoryAdmittedVariable,
  memoryRefusalExitCode,
  parentSnapshotTaken,
  type MemoryReading,
} from './run-exclusively.ts';

const gibibyte = 1024 ** 3;
const short: MemoryReading = { totalBytes: 16 * gibibyte, availableBytes: 0, pressure: 'normal' };
const plenty: MemoryReading = {
  totalBytes: 16 * gibibyte,
  availableBytes: 12 * gibibyte,
  pressure: 'normal',
};

describe('withMemoryAdmission', () => {
  test('takes the parent snapshot before it waits for memory', async () => {
    forgetParentSnapshot(() => new Map());
    const takenAtRead: boolean[] = [];
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const run = withMemoryAdmission(async () => 0, {
      environment: { PATH: '/bin' },
      readMemory: () => {
        takenAtRead.push(parentSnapshotTaken());
        return takenAtRead.length === 1 ? short : plenty;
      },
      sleep: () => held,
      report: () => {},
    });
    expect(parentSnapshotTaken()).toBe(true);
    release();
    expect(await run).toBe(0);
    expect(takenAtRead[0]).toBe(true);
    forgetParentSnapshot();
  });

  test('a refusing reader gives exit 75 with no phase started', async () => {
    const lines: string[] = [];
    let phases = 0;
    const environment: Record<string, string | undefined> = { PATH: '/bin' };
    const code = await withMemoryAdmission(
      async () => {
        phases += 1;
        return 0;
      },
      {
        environment,
        readMemory: () => short,
        sleep: async () => {},
        maximumWaitMs: 0,
        report: (line) => lines.push(line),
      },
    );
    expect(code).toBe(memoryRefusalExitCode);
    expect(code).toBe(75);
    expect(phases).toBe(0);
    expect(lines.join('\n')).toContain('refused to start');
    expect(environment[memoryAdmittedVariable]).toBeUndefined();
  });

  test('an admitting reader is read once across several phases', async () => {
    let reads = 0;
    const environment: Record<string, string | undefined> = { PATH: '/bin' };
    const code = await withMemoryAdmission(
      async (admitted) => {
        // Each phase asks the same question a `withHostSlots` phase does, and is admitted unread.
        for (let phase = 0; phase < 3; phase += 1) {
          expect(admitted[memoryAdmittedVariable]).toBe('1');
        }
        return 7;
      },
      {
        environment,
        readMemory: () => {
          reads += 1;
          return plenty;
        },
        report: () => {},
      },
    );
    expect(code).toBe(7);
    expect(reads).toBe(1);
    // The caller's own environment is left as it was; the phases got a marked copy.
    expect(environment[memoryAdmittedVariable]).toBeUndefined();
  });

  test('phases that use the marked environment never read the host again', async () => {
    const { withHostSlots } = await import('./host-slots.ts');
    let reads = 0;
    const readMemory = (): MemoryReading => {
      reads += 1;
      return plenty;
    };
    const code = await withMemoryAdmission(
      async (environment) => {
        for (let phase = 0; phase < 3; phase += 1) {
          await withHostSlots(1, async () => 0, {
            environment,
            poolDirectory: Promise.reject(new Error('no pool in this test')),
            readMemory,
            report: () => {},
          });
        }
        return 0;
      },
      { environment: {}, readMemory, report: () => {} },
    );
    expect(code).toBe(0);
    expect(reads).toBe(1);
  });
});
