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
    try {
      if (instance !== undefined) void unmount(instance);
    } catch {
      // The mount error below is the one worth reporting.
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
      void unmount(instance);
      flushSync();
      target.remove();
    },
  };
  liveHarnesses.add(harness);
  return harness;
}

/** The harnesses that have been mounted and not yet destroyed. */
export function liveHarnessCount(): number {
  return liveHarnesses.size;
}

/** Destroy every live harness, so one test never leaks a mounted component into the next. */
export function destroyAllHarnesses(): void {
  for (const harness of liveHarnesses) harness.destroy();
}
