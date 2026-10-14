import { describe, expect, it } from 'bun:test';

import { type ContainerMode, recipeExitStatus, runContainerModes } from './run-linux-lifecycle.ts';

describe('Linux lifecycle recipe', () => {
  it('runs every mode when nothing interrupts it', async () => {
    const ran: ContainerMode[] = [];
    const results = await runContainerModes(
      ['init', 'no-init'],
      async (mode) => {
        ran.push(mode);
        return 0;
      },
      () => undefined,
    );

    expect(ran).toEqual(['init', 'no-init']);
    expect(recipeExitStatus(results, undefined, 2)).toBe(0);
  });

  it('stops after a signal during the first mode and exits 128 + signal', async () => {
    let received: NodeJS.Signals | undefined;
    const ran: ContainerMode[] = [];
    const results = await runContainerModes(
      ['init', 'no-init'],
      async (mode) => {
        ran.push(mode);
        received = 'SIGINT';
        return 130;
      },
      () => received,
    );

    expect(ran).toEqual(['init']);
    expect(recipeExitStatus(results, received, 2)).toBe(130);
    expect(recipeExitStatus(results, 'SIGTERM', 2)).toBe(143);
  });

  it('fails when a mode failed or did not run', () => {
    expect(
      recipeExitStatus(
        [
          ['init', 0],
          ['no-init', 1],
        ],
        undefined,
        2,
      ),
    ).toBe(1);
    expect(recipeExitStatus([['init', 0]], undefined, 2)).toBe(1);
  });
});
