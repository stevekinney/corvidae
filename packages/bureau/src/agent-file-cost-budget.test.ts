/**
 * COR-1914 — an agent file's `costBudget`: what it accepts, how a write keeps it, that a file whose
 * model has no price is not usable, that it is enforced on a real run (ending it with
 * `budget-exceeded` and a reason that names `perRunUsd`), and that a crossed `warnAt` fraction
 * shows once in the run's activity (the `operative.runs.events` feed and the audit trail).
 */
import {
  createModelCatalog,
  getModelPricing,
  type BackendDescriptor,
} from '@lostgradient/operative';
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { afterEach, describe, expect, it } from 'bun:test';

import {
  AgentFileError,
  agentFileDefinitionSchema,
  parseAgentFile,
  serializeNewAgentFile,
  serializeUpdatedAgentFile,
  type ParsedAgentFile,
} from './agent-file';
import { costBudgetOptions, unpricedSwitchReason, usdPricingOfRow } from './file-agent-cost-budget';
import { waitForTaskState } from './test';
import {
  type AgentFileFixture,
  agentFileText,
  createAgentFileFixture,
  KNOWN_MODEL,
} from './testing/agent-file-fixtures.test-support';
import { type FileBureauHarness, startFileBureau } from './testing/agent-file-bureau.test-support';

const decoder = new TextDecoder();

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parsed(text: string): ParsedAgentFile {
  const result = parseAgentFile('helper', text);
  if (!result.ok) throw new Error(`Expected the file to parse: ${result.problem.message}`);
  return result.file;
}

/** The field paths a file's `invalid-frontmatter` problem names, or `undefined` if it parses. */
function issuePaths(frontmatter: string): string[] | undefined {
  const result = parseAgentFile('helper', `---\nmodel: a/b\n${frontmatter}\n---\n`);
  if (result.ok) return undefined;
  expect(result.problem.code).toBe('invalid-frontmatter');
  return result.problem.issues?.map((issue) => issue.path);
}

describe('costBudget in the frontmatter', () => {
  it('parses perRunUsd with and without warnAt, and a file without the key has none', () => {
    expect(
      parsed('---\nmodel: a/b\ncostBudget:\n  perRunUsd: 0.5\n---\n').definition.costBudget,
    ).toEqual({ perRunUsd: 0.5 });
    expect(
      parsed('---\nmodel: a/b\ncostBudget: { perRunUsd: 2, warnAt: [0.5, 0.9] }\n---\n').definition
        .costBudget,
    ).toEqual({ perRunUsd: 2, warnAt: [0.5, 0.9] });
    expect(Object.hasOwn(parsed('---\nmodel: a/b\n---\n').definition, 'costBudget')).toBe(false);
    expect(
      Object.hasOwn(parsed('---\nmodel: a/b\ncostBudget:\n---\n').definition, 'costBudget'),
    ).toBe(false);
  });

  it('holds warnAt sorted and without repeats, and drops an empty list', () => {
    const unsorted = parsed(
      '---\nmodel: a/b\ncostBudget: { perRunUsd: 1, warnAt: [0.9, 0.5, 0.9, 0.25] }\n---\n',
    );
    expect(unsorted.definition.costBudget).toEqual({ perRunUsd: 1, warnAt: [0.25, 0.5, 0.9] });
    const empty = parsed('---\nmodel: a/b\ncostBudget: { perRunUsd: 1, warnAt: [] }\n---\n');
    expect(empty.definition.costBudget).toEqual({ perRunUsd: 1 });
  });

  it('names the field of a value it refuses', () => {
    expect(issuePaths('costBudget: { perRunUsd: 0 }')).toEqual(['costBudget.perRunUsd']);
    expect(issuePaths('costBudget: { perRunUsd: -1 }')).toEqual(['costBudget.perRunUsd']);
    expect(issuePaths('costBudget: { perRunUsd: cheap }')).toEqual(['costBudget.perRunUsd']);
    expect(issuePaths('costBudget: { perRunUsd: 2000000 }')).toEqual(['costBudget.perRunUsd']);
    expect(issuePaths('costBudget: { warnAt: [0.5] }')).toEqual(['costBudget.perRunUsd']);
    expect(issuePaths('costBudget: { perRunUsd: 1, warnAt: [0] }')).toEqual([
      'costBudget.warnAt.0',
    ]);
    expect(issuePaths('costBudget: { perRunUsd: 1, warnAt: [0.5, 1] }')).toEqual([
      'costBudget.warnAt.1',
    ]);
    expect(issuePaths('costBudget: { perRunUsd: 1, warnAt: [1.5] }')).toEqual([
      'costBudget.warnAt.0',
    ]);
    expect(issuePaths('costBudget: 5')).toEqual(['costBudget']);
    expect(issuePaths('costBudget: [1]')).toEqual(['costBudget']);
    const eleven = Array.from({ length: 11 }, (_, index) => (index + 1) / 20).join(', ');
    expect(issuePaths(`costBudget: { perRunUsd: 1, warnAt: [${eleven}] }`)).toEqual([
      'costBudget.warnAt',
    ]);
  });

  it('parses perChatUsd beside perRunUsd, and refuses one that is not a positive dollar amount', () => {
    expect(
      parsed('---\nmodel: a/b\ncostBudget: { perRunUsd: 1, perChatUsd: 5 }\n---\n').definition
        .costBudget,
    ).toEqual({ perRunUsd: 1, perChatUsd: 5 });
    expect(issuePaths('costBudget: { perRunUsd: 1, perChatUsd: 0 }')).toEqual([
      'costBudget.perChatUsd',
    ]);
    expect(issuePaths('costBudget: { perRunUsd: 1, perChatUsd: cheap }')).toEqual([
      'costBudget.perChatUsd',
    ]);
    expect(issuePaths('costBudget: { perRunUsd: 1, perChatUsd: 2000000 }')).toEqual([
      'costBudget.perChatUsd',
    ]);
  });
});

describe('writing costBudget', () => {
  it('writes a new file that parses back to the same budget', () => {
    const text = decoder.decode(
      serializeNewAgentFile({
        model: 'a/b',
        costBudget: { perRunUsd: 0.75, warnAt: [0.5, 0.9] },
        instructions: 'Body.\n',
      }),
    );
    expect(text).toContain('costBudget:');
    expect(parsed(text).definition.costBudget).toEqual({ perRunUsd: 0.75, warnAt: [0.5, 0.9] });
  });

  it('writes warnAt sorted and without repeats however the caller gave it', () => {
    const text = decoder.decode(
      serializeNewAgentFile({
        model: 'a/b',
        costBudget: { perRunUsd: 1, warnAt: [0.9, 0.5, 0.9] },
        instructions: 'Body.\n',
      }),
    );
    expect(parsed(text).definition.costBudget?.warnAt).toEqual([0.5, 0.9]);
    expect(text.indexOf('0.5')).toBeLessThan(text.indexOf('0.9'));
  });

  it('writes no key when the definition sets none', () => {
    const text = decoder.decode(serializeNewAgentFile({ model: 'a/b', instructions: 'Body.\n' }));
    expect(text).not.toContain('costBudget');
  });

  it('keeps the budget when an update leaves it out, and adds none to a file without one', () => {
    const file = parsed(
      '---\nmodel: a/b\ncostBudget: { perRunUsd: 1, warnAt: [0.5] }\ncolor: blue\n---\nBody.\n',
    );
    const kept = decoder.decode(
      serializeUpdatedAgentFile('helper', file, {
        model: 'a/b',
        name: 'Named',
        instructions: 'Body.\n',
      }),
    );
    expect(parsed(kept).definition).toMatchObject({
      name: 'Named',
      costBudget: { perRunUsd: 1, warnAt: [0.5] },
    });
    expect(kept).toContain('color: blue');

    const bare = parsed('---\nmodel: a/b\n---\nBody.\n');
    const renamed = decoder.decode(
      serializeUpdatedAgentFile('helper', bare, {
        model: 'a/b',
        name: 'Named',
        instructions: 'Body.\n',
      }),
    );
    expect(renamed).not.toContain('costBudget');
  });

  it('changes a budget the update states, and removes one the update sets to null', () => {
    const file = parsed('---\nmodel: a/b\ncostBudget: { perRunUsd: 1 }\n---\nBody.\n');
    const changed = parsed(
      decoder.decode(
        serializeUpdatedAgentFile('helper', file, {
          model: 'a/b',
          costBudget: { perRunUsd: 3, warnAt: [0.8] },
          instructions: 'Body.\n',
        }),
      ),
    );
    expect(changed.definition.costBudget).toEqual({ perRunUsd: 3, warnAt: [0.8] });

    const removed = decoder.decode(
      serializeUpdatedAgentFile('helper', changed, {
        model: 'a/b',
        costBudget: null,
        instructions: 'Body.\n',
      }),
    );
    expect(removed).not.toContain('costBudget');
    expect(parsed(removed).definition).not.toHaveProperty('costBudget');
  });

  it('rewrites nothing when the update states the budget the file has, in any order', () => {
    const file = parsed(
      '---\nmodel: a/b\ncostBudget: { perRunUsd: 1, warnAt: [0.5, 0.9] }\n---\nBody.\n',
    );
    for (const warnAt of [
      [0.5, 0.9],
      [0.9, 0.5],
      [0.9, 0.5, 0.9],
    ]) {
      expect(
        serializeUpdatedAgentFile('helper', file, {
          model: 'a/b',
          costBudget: { perRunUsd: 1, warnAt },
          instructions: 'Body.\n',
        }),
      ).toBeUndefined();
    }
    const unsorted = parsed(
      '---\nmodel: a/b\ncostBudget: { perRunUsd: 1, warnAt: [0.9, 0.5] }\n---\nBody.\n',
    );
    expect(
      serializeUpdatedAgentFile('helper', unsorted, {
        model: 'a/b',
        costBudget: { perRunUsd: 1, warnAt: [0.5, 0.9] },
        instructions: 'Body.\n',
      }),
    ).toBeUndefined();
  });
});

describe('a stored definition', () => {
  const OLD_SNAPSHOT = {
    name: 'Helper',
    description: null,
    model: KNOWN_MODEL,
    tools: [],
    skillDescriptors: [],
    a2a: false,
    instructions: 'Recorded.\n',
  };

  it('loads when it was written before the field existed', () => {
    expect(agentFileDefinitionSchema.parse(OLD_SNAPSHOT).costBudget).toBeUndefined();
  });

  it('keeps a budget when it has one, and refuses one that is not a budget', () => {
    expect(
      agentFileDefinitionSchema.parse({ ...OLD_SNAPSHOT, costBudget: { perRunUsd: 2 } }),
    ).toMatchObject({ costBudget: { perRunUsd: 2 } });
    expect(
      agentFileDefinitionSchema.safeParse({ ...OLD_SNAPSHOT, costBudget: { perRunUsd: 0 } })
        .success,
    ).toBe(false);
  });
});

describe('prices from the catalog', () => {
  const opus = createModelCatalog().descriptors.find((row) => row.model === 'claude-opus-5-5')!;

  it('turns a catalog row into the prices a run counts at, keeping the cache rates it knows', () => {
    const pricing = usdPricingOfRow(opus);
    expect(pricing).toMatchObject({
      promptCostPerMillionTokens: 4,
      completionCostPerMillionTokens: 20,
    });
    // The catalog row says nothing of caching; Operative's table does, and a cache read is not free.
    expect(pricing?.cacheReadCostPerMillionTokens).toBeGreaterThan(0);
  });

  it('prices nothing for a row with no price or a price in another currency', () => {
    expect(usdPricingOfRow({ ...opus, pricing: undefined })).toBeUndefined();
    expect(
      usdPricingOfRow({ ...opus, pricing: { ...opus.pricing!, currency: 'EUR' } }),
    ).toBeUndefined();
  });

  it('enters a switched model with no price as unpriced, even one Operative’s table knows (COR-1921)', () => {
    const catalog = createModelCatalog().descriptors;
    const known = catalog.find((row) => row.model === 'claude-opus-5')!;
    const { costEstimation } = costBudgetOptions({ perRunUsd: 1 }, opus, [
      { ...known, pricing: undefined },
    ]);
    const pricing = costEstimation?.pricing;
    // Left out, the built-in table would count it at its own rate, which is not the catalog's.
    expect(Object.hasOwn(pricing?.customPricing ?? {}, 'claude-opus-5')).toBe(true);
    expect(getModelPricing('claude-opus-5', pricing)).toBeUndefined();
    expect(getModelPricing('claude-opus-5-5', pricing)).toMatchObject({
      promptCostPerMillionTokens: 4,
    });
  });

  it('prices a model from a second row when the first has no price', () => {
    const other = createModelCatalog().descriptors.find((row) => row.model === 'claude-opus-5')!;
    const { costEstimation } = costBudgetOptions({ perRunUsd: 1 }, opus, [
      { ...other, provider: 'twin', pricing: undefined },
      other,
    ]);
    expect(getModelPricing('claude-opus-5', costEstimation?.pricing)).toMatchObject({
      promptCostPerMillionTokens: 5,
    });
  });

  it('counts the default model first, and a switched model at its own price', () => {
    const other = createModelCatalog().descriptors.find((row) => row.model === 'claude-opus-5')!;
    const { costEstimation, costBudget } = costBudgetOptions(
      { perRunUsd: 1, warnAt: [0.5] },
      opus,
      [other, opus],
    );
    expect(costEstimation?.model).toBe('claude-opus-5-5');
    expect(costEstimation?.pricing?.customPricing?.['claude-opus-5-5']).toMatchObject({
      promptCostPerMillionTokens: 4,
    });
    expect(costEstimation?.pricing?.customPricing?.['claude-opus-5']).toMatchObject({
      promptCostPerMillionTokens: 5,
    });
    expect(costBudget).toEqual({ perRunUsd: 1, warnAt: [0.5] });
  });
});

describe('unpricedSwitchReason', () => {
  const rows = createModelCatalog().descriptors;
  const unpriced = rows.map((row) =>
    row.model === 'gpt-4.1' ? { ...row, pricing: undefined } : row,
  );

  it('names the model for a budgeted agent switched to a model with no price', () => {
    expect(unpricedSwitchReason({ perRunUsd: 1 }, unpriced, { model: 'gpt-4.1' })).toContain(
      'gpt-4.1',
    );
    expect(
      unpricedSwitchReason({ perRunUsd: 1 }, unpriced, { model: 'gpt-4.1', provider: 'openai' }),
    ).toContain('costBudget');
  });

  it('has no objection to a priced model, an agent with no budget, or a model no row serves', () => {
    expect(
      unpricedSwitchReason({ perRunUsd: 1 }, unpriced, { model: 'claude-opus-5' }),
    ).toBeUndefined();
    expect(unpricedSwitchReason(undefined, unpriced, { model: 'gpt-4.1' })).toBeUndefined();
    expect(unpricedSwitchReason({ perRunUsd: 1 }, unpriced, { model: 'nope' })).toBeUndefined();
    // Another provider's row of the same name is not the one asked for.
    expect(
      unpricedSwitchReason({ perRunUsd: 1 }, unpriced, { model: 'gpt-4.1', provider: 'other' }),
    ).toBeUndefined();
  });
});

describe('a file whose model has no price', () => {
  const fixtures: AgentFileFixture[] = [];
  afterEach(async () => {
    for (const fixture of fixtures.splice(0)) await fixture.dispose();
  });

  function withoutPrice(change: (row: BackendDescriptor) => BackendDescriptor) {
    return createModelCatalog().descriptors.map((row) =>
      row.model === 'claude-opus-5-5' ? change(row) : row,
    );
  }

  async function start(descriptors: readonly BackendDescriptor[]) {
    const fixture = await createAgentFileFixture({ watch: false, descriptors });
    fixtures.push(fixture);
    return fixture;
  }

  const budgeted = agentFileText({ model: KNOWN_MODEL, costBudget: '{ perRunUsd: 1 }' });

  it('is usable when the model has a price in US dollars', async () => {
    const fixture = await start(createModelCatalog().descriptors);
    await fixture.put('helper.md', budgeted);
    await fixture.catalog.refresh();
    expect(fixture.catalog.list().find((listing) => listing.id === 'helper')?.state).toBe('ready');
  });

  it.each([
    ['has no price', (row: BackendDescriptor) => ({ ...row, pricing: undefined })],
    [
      'is priced in another currency',
      (row: BackendDescriptor) => ({ ...row, pricing: { ...row.pricing!, currency: 'EUR' } }),
    ],
  ])('is not usable, and says why, when the model %s', async (_name, change) => {
    const fixture = await start(withoutPrice(change));
    await fixture.put('helper.md', budgeted);
    await fixture.catalog.refresh();

    const listing = fixture.catalog.list().find((entry) => entry.id === 'helper');
    expect(listing?.state).toBe('invalid');
    expect(listing?.problem?.code).toBe('invalid-frontmatter');
    expect(listing?.problem?.message).toContain('costBudget');
    expect(listing?.problem?.issues?.map((issue) => issue.path)).toEqual(['costBudget']);
  });

  it('is fine without a budget: the file never needed a price', async () => {
    const fixture = await start(withoutPrice((row) => ({ ...row, pricing: undefined })));
    await fixture.put('helper.md', agentFileText({ model: KNOWN_MODEL }));
    await fixture.catalog.refresh();
    expect(fixture.catalog.list().find((listing) => listing.id === 'helper')?.state).toBe('ready');
  });

  it('refuses a write of a budget the model could not honor, and writes nothing', async () => {
    const fixture = await start(withoutPrice((row) => ({ ...row, pricing: undefined })));
    const error = await rejectionOf(
      fixture.catalog.create('helper', {
        model: KNOWN_MODEL,
        costBudget: { perRunUsd: 1 },
        instructions: 'Hi.\n',
      }),
    );
    expect(error).toBeInstanceOf(AgentFileError);
    expect((error as AgentFileError).code).toBe('invalid-frontmatter');
    expect(fixture.catalog.list().find((listing) => listing.id === 'helper')).toBeUndefined();
  });
});

describe('restoring a version', () => {
  const fixtures: AgentFileFixture[] = [];
  afterEach(async () => {
    for (const fixture of fixtures.splice(0)) await fixture.dispose();
  });

  it('removes the budget and the guardrails a version that never had them lacks', async () => {
    const fixture = await createAgentFileFixture({ watch: false });
    fixtures.push(fixture);
    await fixture.put('helper.md', agentFileText({ name: 'Helper', model: KNOWN_MODEL }));
    await fixture.catalog.refresh();
    const hash = () =>
      fixture.catalog.list().find((listing) => listing.id === 'helper')?.definitionHash ?? '';
    await fixture.catalog.update(
      'helper',
      {
        name: 'Helper',
        model: KNOWN_MODEL,
        guardrails: 'off',
        costBudget: { perRunUsd: 1, warnAt: [0.5] },
        instructions: 'You are helpful.\n',
      },
      { expectedHash: hash() },
    );
    const updated = await fixture.catalog.detail('helper');
    expect(updated?.definition).toMatchObject({
      guardrails: 'off',
      costBudget: { perRunUsd: 1, warnAt: [0.5] },
    });

    await fixture.catalog.versions.restore('helper', 1, { expectedHash: hash() });

    const restoredDetail = await fixture.catalog.detail('helper');
    const restored = restoredDetail?.definition;
    expect(restored).not.toHaveProperty('costBudget');
    expect(restored).not.toHaveProperty('guardrails');
  });

  it('lists the keys a save changed, guardrails and costBudget among them', async () => {
    const fixture = await createAgentFileFixture({ watch: false });
    fixtures.push(fixture);
    await fixture.put('helper.md', agentFileText({ name: 'Helper', model: KNOWN_MODEL }));
    await fixture.catalog.refresh();
    const hash =
      fixture.catalog.list().find((listing) => listing.id === 'helper')?.definitionHash ?? '';
    await fixture.catalog.update(
      'helper',
      {
        name: 'Helper',
        model: KNOWN_MODEL,
        guardrails: 'default',
        costBudget: { perRunUsd: 1 },
        instructions: 'You are helpful.\n',
      },
      { expectedHash: hash },
    );

    const [latest] = await fixture.catalog.versions.list('helper');
    expect(latest?.changedKeys).toEqual(['guardrails', 'costBudget']);
  });
});

/** Opus 5.5 is $4 per million tokens in: 50,000 prompt tokens cost $0.20. */
const TWENTY_CENTS = { prompt: 50_000, completion: 0, total: 50_000 };

describe.each(['non-durable', 'durable'] as const)(
  'a file agent’s costBudget, %s dispatch',
  (dispatch) => {
    const harnesses: FileBureauHarness[] = [];
    afterEach(async () => {
      for (const harness of harnesses.splice(0)) await harness.dispose();
    });

    /** Runs a file agent that spends $0.20 a step for `steps` steps, then answers. */
    async function run(frontmatter: Record<string, string>, steps: number) {
      let call = 0;
      const harness = await startFileBureau({
        scripts: {
          'claude-opus-5-5': () => {
            call += 1;
            return call >= steps
              ? { content: 'All done.', usage: TWENTY_CENTS }
              : {
                  content: '',
                  usage: TWENTY_CENTS,
                  toolCalls: [{ name: 'lookup-order', arguments: {} }],
                };
          },
        },
        overrides: { durable: dispatch === 'durable' },
      });
      harnesses.push(harness);
      await harness.put(
        'helper.md',
        agentFileText({ model: KNOWN_MODEL, tools: '[lookup-order]', ...frontmatter }),
      );
      await harness.bureau.agents.refresh();

      const task = await harness.bureau.tasks.start('helper', 'Go.');
      const result = await task.result();
      await waitForTaskState(harness.bureau, task.id);

      const feed: Array<{ kind: string; payload: Record<string, unknown> }> = [];
      const runFeed = harness.bureau.internals.runEventFeeds.get(task.id);
      if (runFeed === undefined) throw new Error('Expected the run to have a feed.');
      for await (const envelope of runFeed.feed.replay()) {
        feed.push({ kind: envelope.kind, payload: { ...envelope.payload } });
      }
      const audit = (await harness.bureau.internals.auditTrail?.query({ runId: task.id })) ?? [];
      return { result, feed, audit, generations: call };
    }

    const BUDGET = { costBudget: '{ perRunUsd: 0.5, warnAt: [0.9, 0.5] }' };

    it('ends a run that has spent its budget as budget-exceeded, with a reason that names perRunUsd', async () => {
      const { result, generations } = await run(BUDGET, 10);

      expect(result.finishReason).toBe('budget-exceeded');
      // $0.20 a step against $0.50: the third step takes the run to $0.60, and no fourth is asked for.
      expect(generations).toBe(3);
      expect(messageOf(result.error)).toContain('perRunUsd');
      expect(messageOf(result.error)).toContain('0.5');
    });

    it('shows each warnAt fraction once, in the run’s activity and the audit trail, before the run ends', async () => {
      const { feed, audit } = await run(BUDGET, 10);

      const warnings = feed.filter((event) => event.kind === 'budget.threshold');
      // 0.5 of $0.50 is $0.25, passed by the second step ($0.40); 0.9 is $0.45, by the third ($0.60).
      expect(warnings.map((event) => [event.payload['step'], event.payload['threshold']])).toEqual([
        [1, 0.5],
        [2, 0.9],
      ]);
      expect(warnings[0]?.payload).toMatchObject({
        budget: 0.5,
        model: 'claude-opus-5-5',
      });
      expect(warnings[1]?.payload['currentCost']).toBeCloseTo(0.6, 10);
      const order = feed.map((event) => event.kind);
      expect(order.lastIndexOf('budget.threshold')).toBeLessThan(order.indexOf('run.error'));
      expect(audit.filter((record) => record.type === 'budget.threshold')).toHaveLength(2);
    });

    it('lets a run that stays under its budget finish, warning at the fractions it passed', async () => {
      const { result, feed, generations } = await run(BUDGET, 2);

      expect(result.finishReason).toBe('stop-condition');
      expect(generations).toBe(2);
      expect(feed.filter((event) => event.kind === 'budget.threshold')).toHaveLength(1);
      expect(feed.map((event) => event.kind)).not.toContain('run.error');
    });

    it('puts no limit on an agent whose file sets none', async () => {
      const { result, feed, generations } = await run({}, 6);

      expect(result.finishReason).toBe('stop-condition');
      expect(generations).toBe(6);
      expect(feed.map((event) => event.kind)).not.toContain('budget.threshold');
    });
  },
);
