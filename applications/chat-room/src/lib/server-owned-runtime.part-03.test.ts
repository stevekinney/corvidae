import { describe, expect, it } from 'bun:test';
import { existsSync, join, mkdtempSync, rmSync, tmpdir } from './server-owned-runtime-test-helpers';

/** Spawns the fixture and waits until it reports its handlers registered. */
async function readyFixture(environment: Record<string, string>) {
  const child = Bun.spawn(['bun', join(import.meta.dir, 'server-owned-signal-fixture.ts')], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...environment },
  });

  // Signalled only once the fixture says so, so this cannot race module
  // evaluation.
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let announced = '';
  while (!announced.includes('ready')) {
    const { value, done } = await reader.read();
    if (done) break;
    announced += decoder.decode(value, { stream: true });
  }
  expect(announced).toContain('ready');
  return { child, reader };
}

describe('process signals', () => {
  it('a repeated signal forces the exit instead of being ignored', async () => {
    // `process.once` removed the listener after the first delivery, so a
    // second SIGINT took Node's default path and killed the process
    // mid-disposal. Same outcome as a forced exit, but arrived at by the
    // handler no longer being installed — untestable, and impossible to
    // change without noticing it first.
    //
    // A slow teardown widens the window so the second signal genuinely
    // lands during disposal rather than after it.
    const directory = mkdtempSync(join(tmpdir(), 'server-owned-signal-'));
    const marker = join(directory, 'disposed');

    try {
      // WITH a host listener, which is what makes this test able to tell
      // the two implementations apart. Without one they are
      // indistinguishable by outcome: under `process.once` the second
      // delivery finds no listener and Node's default terminates, which
      // looks exactly like a deliberate forced exit.
      //
      // Add a host listener and they diverge. `once`: our handler is gone,
      // the host's no-op absorbs the second signal, the default is
      // suppressed, and the process waits out the whole teardown. `on`:
      // our handler is still installed and forces the exit. Verified both
      // ways — this fails against `once`.
      const { child, reader } = await readyFixture({
        TEARDOWN_MARKER: marker,
        BLOCK_TEARDOWN: '1',
        HOST_LISTENER: '1',
      });

      child.kill('SIGTERM');

      // The second signal is sent once the fixture ANNOUNCES that disposal
      // has started, not after a guessed delay — signals delivered in the
      // same tick can be coalesced, and the first attempt at this test
      // sent both back to back and saw only one handled.
      let announced = '';
      const decoder = new TextDecoder();
      while (!announced.includes('disposing')) {
        const { value, done } = await reader.read();
        if (done) break;
        announced += decoder.decode(value, { stream: true });
      }
      expect(announced).toContain('disposing');

      child.kill('SIGTERM');

      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
      await child.exited;

      // TERMINATED while the teardown was still BLOCKED. The barrier never
      // opens — the parent holds it closed — so the only way this process
      // can exit is the second signal forcing it. No delay is involved,
      // and no amount of waiting could satisfy this by accident.
      const terminated = child.signalCode === 'SIGTERM' || child.exitCode === 143;
      expect(terminated).toBe(true);

      // And the teardown did NOT complete, which is what "forced" means
      // here — the marker is written at the end of it, past the barrier.
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  // Both cases, because the second is the one the first cannot speak for.
  for (const [label, environment] of [
    ['as the only signal listener', {}],
    ["alongside a host's own persistent listener", { HOST_LISTENER: '1' }],
  ] as const) {
    it(`disposes and then terminates the process ${label}`, async () => {
      // The marker is what makes this two claims rather than one. Asserting
      // termination alone would stay green if the handler's cleanup were
      // replaced by a bare `process.exit(143)` — and cutting off the disposal
      // is the regression these handlers exist to prevent.
      const directory = mkdtempSync(join(tmpdir(), 'server-owned-signal-'));
      const marker = join(directory, 'disposed');

      try {
        const { child, reader } = await readyFixture({ ...environment, TEARDOWN_MARKER: marker });

        expect(existsSync(marker)).toBe(false);

        child.kill('SIGTERM');

        // Drained to EOF rather than polled: the stream closes when the
        // process does, so this waits on the exit without a timer.
        for (;;) {
          const { done } = await reader.read();
          if (done) break;
        }
        await child.exited;

        // DISPOSED: a teardown registered on the runtime actually ran.
        expect(existsSync(marker)).toBe(true);

        // AND TERMINATED, the way a signal terminates: either the runtime
        // reports the signal directly, or it surfaces as the conventional
        // 128 + 15 status. Never a clean 0, which would mean something
        // invented a success it had no basis for.
        const terminated = child.signalCode === 'SIGTERM' || child.exitCode === 143;
        expect(terminated).toBe(true);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }

  it('replaces listeners left by an older dispatch protocol', async () => {
    // `SIGNALS_SLOT` makes registration idempotent, which is right — and it
    // also means listeners from an OLDER evaluation survive forever. When this
    // module changed which slot the listener reads, those old listeners went on
    // reading a slot nothing writes any more, leaving the new implementation
    // unreachable until a full dev-server restart. That is the staleness the
    // indirection exists to prevent, reappearing at the upgrade boundary.
    //
    // The sibling fixture starts cold and therefore cannot show this: its
    // listeners are always the ones this evaluation installed. This one puts
    // protocol-1 listeners in place BEFORE importing the module.
    //
    // What this proves, precisely: the migration works when the previous
    // evaluation RECORDED its listeners. It does not model the one upgrade
    // that cannot be migrated — a version predating the registry, which set
    // `SIGNALS_SLOT` and recorded nothing, leaving no references to remove
    // by. The fixture seeds the registry deliberately, so this is coverage
    // for every protocol change from here on rather than for the one that
    // introduced it. That boundary is documented at the migration itself and
    // needs a dev-server restart.
    const directory = mkdtempSync(join(tmpdir(), 'server-owned-protocol-'));
    const stale = join(directory, 'stale');
    const marker = join(directory, 'disposed');

    try {
      const child = Bun.spawn(
        ['bun', join(import.meta.dir, 'server-owned-stale-listener-fixture.ts')],
        {
          stdout: 'pipe',
          stderr: 'pipe',
          env: { ...process.env, STALE_MARKER: stale, TEARDOWN_MARKER: marker },
        },
      );

      const reader = child.stdout.getReader();
      const decoder = new TextDecoder();
      let announced = '';
      while (!announced.includes('ready')) {
        const { value, done } = await reader.read();
        if (done) break;
        announced += decoder.decode(value, { stream: true });
      }
      expect(announced).toContain('ready');

      child.kill('SIGTERM');
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
      await child.exited;

      // The NEW handler ran: it disposed the runtime.
      expect(existsSync(marker)).toBe(true);

      // And the stale listener did NOT. Without the protocol check this is
      // the one that fires, exiting 0 without disposing anything.
      expect(existsSync(stale)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("runs the reloaded module's signal handler rather than the one it registered with", async () => {
    // Vite re-evaluates server modules on edit while `globalThis` survives, so
    // the registration guard correctly declines to add a second pair of
    // listeners — and the pair already on `process` belongs to the FIRST
    // evaluation. Closing over `disposeServerOwnedRuntime` directly would make
    // those listeners permanent: every later edit to draining, teardown
    // ordering, or failure reporting would load and appear active while Ctrl-C
    // still ran the shutdown path from before the edit. The symptom only shows
    // at exit, which is the worst place to discover you have been measuring
    // code that is no longer on disk.
    const directory = mkdtempSync(join(tmpdir(), 'server-owned-reload-'));
    const reloaded = join(directory, 'reloaded');
    const marker = join(directory, 'disposed');

    try {
      const { child, reader } = await readyFixture({
        RELOAD_MARKER: reloaded,
        TEARDOWN_MARKER: marker,
      });

      child.kill('SIGTERM');

      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
      await child.exited;

      // The handler reached the CURRENT implementation, not the one that was
      // in scope when it was registered.
      expect(existsSync(reloaded)).toBe(true);

      // And it still disposed: the indirection replaced how the handler finds
      // the disposer, not what the disposer does.
      expect(existsSync(marker)).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
