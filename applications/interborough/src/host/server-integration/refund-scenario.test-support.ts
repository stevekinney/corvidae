import { outcomeOf } from '@lostgradient/testing/module-scope-scenario';

/** Runs one real-process scenario off the test clock and releases its resources on a hang. */
export async function refundScenario(
  run: (onHang: (release: () => void | Promise<void>) => void) => Promise<void>,
): Promise<unknown> {
  const releases: Array<() => void | Promise<void>> = [];
  return outcomeOf(
    () => run((release) => releases.push(release)),
    undefined,
    async () => {
      const failures: unknown[] = [];
      for (const release of releases.toReversed()) {
        try {
          await release();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length) throw new AggregateError(failures, 'Refund scenario cleanup failed');
    },
  );
}

export function releaseRefundOnHang(
  onHang: (release: () => void | Promise<void>) => void,
  fixture: { abort(): Promise<void> },
): void {
  onHang(() => fixture.abort());
}
