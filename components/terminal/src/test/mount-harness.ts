import { flushSync, mount, unmount, type Component } from 'svelte';

/** A component mounted into its own container by {@link mountHarness}. */
export type MountedHarness = {
  /** The container the component rendered into. It is attached to `document.body` until destroyed. */
  readonly target: HTMLElement;
  /** Whether {@link MountedHarness.destroy} has already run. */
  readonly destroyed: boolean;
  /** Apply pending reactive updates to the DOM. */
  flush(): void;
  /** Unmount the component, run its teardown, and detach the container. Safe to call twice. */
  destroy(): void;
};

const liveHarnesses = new Set<MountedHarness>();
const unmountFailures: unknown[] = [];
const pendingUnmounts = new Set<Promise<void>>();

function recordUnmount(instance: Parameters<typeof unmount>[0]): void {
  const pending = unmount(instance).catch((error: unknown) => {
    unmountFailures.push(error);
  });
  pendingUnmounts.add(pending);
  void pending.finally(() => pendingUnmounts.delete(pending));
}

/**
 * Mount a Svelte component into a fresh container on `document.body`, for tests that need to prove
 * a component mounts, reacts, and tears down without leaving DOM or effects behind. The caller
 * owns the returned harness and destroys it, or lets {@link destroyAllHarnesses} do so between
 * tests.
 */
export function mountHarness<Props extends Record<string, unknown>>(
  component: Component<Props>,
  props: Props,
): MountedHarness {
  const target = document.createElement('div');
  document.body.append(target);
  let instance: ReturnType<typeof mount> | undefined;
  try {
    instance = mount(component, { target, props });
    flushSync();
  } catch (error) {
    // Unwind whatever mounted before the failure; a teardown error must not mask the original one.
    if (instance !== undefined) {
      unmount(instance).catch(() => {
        // The mount error below is the one worth reporting.
      });
    }
    target.remove();
    throw error;
  }

  let destroyed = false;
  const harness: MountedHarness = {
    target,
    get destroyed() {
      return destroyed;
    },
    flush() {
      flushSync();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      liveHarnesses.delete(harness);
      try {
        recordUnmount(instance);
        flushSync();
      } finally {
        target.remove();
      }
    },
  };
  liveHarnesses.add(harness);
  return harness;
}

/**
 * Teardown errors from components the harness unmounted. Svelte's `unmount` returns a promise that
 * rejects when a teardown throws; the harness records the error here instead of letting it escape
 * as an unhandled rejection. Returns the recorded errors and clears the list.
 */
export function takeUnmountFailures(): unknown[] {
  return unmountFailures.splice(0);
}

/** The harnesses that have been mounted and not yet destroyed. */
export function liveHarnessCount(): number {
  return liveHarnesses.size;
}

/**
 * Destroy every live harness, so one test never leaks a mounted component into the next. Waits for
 * every pending unmount and fails with any teardown error, so a test whose component teardown
 * rejects does not pass silently.
 */
export async function destroyAllHarnesses(): Promise<void> {
  const failures: unknown[] = [];
  for (const harness of liveHarnesses) {
    try {
      harness.destroy();
    } catch (error) {
      failures.push(error);
    }
  }
  await Promise.all(pendingUnmounts);
  failures.push(...takeUnmountFailures());
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, `${failures.length} harnesses failed to destroy`);
  }
}
