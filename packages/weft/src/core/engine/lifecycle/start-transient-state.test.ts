/**
 * The one place a start installs the per-run state it holds in memory (COR-1408), and the rollback
 * that takes back exactly what the launch that adopted the id installed.
 */
import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../../../storage/memory.ts';
import type { Checkpoint } from '../../types.ts';
import { Engine } from '../index.ts';
import { getInternals, type EngineInternals } from '../internals.ts';
import {
  createLaunchAdoption,
  installRunTransientState,
  type RunTransientStateSources,
} from './start-transient-state.ts';

const ID = 'transient-state-unit';

function createCheckpoint(): Checkpoint {
  return { workflowExecutionToken: 'the-generation' } as Checkpoint;
}

async function withEngine(run: (internals: EngineInternals) => void | Promise<void>) {
  await using engine = new Engine({ storage: new MemoryStorage() });
  await run(getInternals(engine));
}

describe('installing the per-run state of a start', () => {
  const installations: readonly {
    label: string;
    sources: RunTransientStateSources;
    services: { value: unknown } | undefined;
    joinsCleanup: boolean;
  }[] = [
    {
      label: 'installs services and joins terminal cleanup for a start that asked for services',
      sources: { options: { services: { owner: 'the start' } }, limitsConcurrency: false },
      services: { value: { owner: 'the start' } },
      joinsCleanup: true,
    },
    {
      label: 'installs services a caller handed over, and joins terminal cleanup with them',
      sources: {
        options: undefined,
        limitsConcurrency: false,
        transientState: { services: { value: { owner: 'the occurrence' } } },
      },
      services: { value: { owner: 'the occurrence' } },
      joinsCleanup: true,
    },
    {
      label: 'installs a handed-over services value that is itself undefined',
      sources: {
        options: undefined,
        limitsConcurrency: false,
        transientState: { services: { value: undefined } },
      },
      services: { value: undefined },
      joinsCleanup: true,
    },
    {
      label: 'joins terminal cleanup without services when the caller asks to',
      sources: {
        options: undefined,
        limitsConcurrency: false,
        transientState: { joinTerminalCleanup: true },
      },
      services: undefined,
      joinsCleanup: true,
    },
    {
      label: 'joins terminal cleanup for a type that limits concurrency',
      sources: { options: undefined, limitsConcurrency: true },
      services: undefined,
      joinsCleanup: true,
    },
    {
      label: 'installs nothing for a start that asked for neither',
      sources: { options: {}, limitsConcurrency: false },
      services: undefined,
      joinsCleanup: false,
    },
    {
      label: 'installs nothing for a caller state that asks for neither',
      sources: { options: undefined, limitsConcurrency: false, transientState: {} },
      services: undefined,
      joinsCleanup: false,
    },
    {
      label: 'prefers the start options over the state a caller handed over',
      sources: {
        options: { services: { owner: 'the start' } },
        limitsConcurrency: false,
        transientState: { services: { value: { owner: 'the occurrence' } } },
      },
      services: { value: { owner: 'the start' } },
      joinsCleanup: true,
    },
  ];

  for (const { label, sources, services, joinsCleanup } of installations) {
    it(label, async () => {
      await withEngine((internals) => {
        installRunTransientState(internals, ID, sources);

        expect(internals.workflowServices.has(ID)).toBe(services !== undefined);
        if (services !== undefined) {
          expect(internals.workflowServices.get(ID)).toEqual(services.value);
        }
        expect(internals.workflowsNeedingTerminalCleanup.has(ID)).toBe(joinsCleanup);
      });
    });
  }

  it('holds the services a caller handed over by identity', async () => {
    await withEngine((internals) => {
      const value = { owner: 'the occurrence' };

      installRunTransientState(internals, ID, {
        options: undefined,
        limitsConcurrency: false,
        transientState: { services: { value } },
      });

      expect(internals.workflowServices.get(ID)).toBe(value);
    });
  });
});

describe('rolling back a launch', () => {
  it('removes the services and cleanup membership the launch installed after it adopted a checkpoint', async () => {
    await withEngine((internals) => {
      const launch = createLaunchAdoption(internals, ID);
      launch.adopt(createCheckpoint(), new Uint8Array());
      installRunTransientState(internals, ID, {
        options: undefined,
        limitsConcurrency: false,
        transientState: { joinTerminalCleanup: true, services: { value: { owner: 'launch' } } },
      });

      launch.rollback();

      expect(internals.workflowServices.has(ID)).toBe(false);
      expect(internals.workflowsNeedingTerminalCleanup.has(ID)).toBe(false);
      expect(internals.checkpoints.has(ID)).toBe(false);
    });
  });

  it('leaves a live run its services and cleanup membership when the launch never adopted a checkpoint', async () => {
    await withEngine((internals) => {
      const live = { owner: 'the live run' };
      const liveLaunch = createLaunchAdoption(internals, ID);
      liveLaunch.adopt(createCheckpoint(), new Uint8Array());
      installRunTransientState(internals, ID, {
        options: { services: live },
        limitsConcurrency: false,
      });

      createLaunchAdoption(internals, ID).rollback();

      expect(internals.workflowServices.get(ID)).toBe(live);
      expect(internals.workflowsNeedingTerminalCleanup.has(ID)).toBe(true);
      expect(internals.checkpoints.has(ID)).toBe(true);
    });
  });
});
