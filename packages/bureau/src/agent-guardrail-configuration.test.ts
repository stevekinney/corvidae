/**
 * COR-2118 — a guardrail an agent configures. A plugin contributes a factory, an agent file lists
 * it as `plugin:name` or `{ id, configuration }`, and each agent runs the guardrail the factory
 * builds from its own configuration, with every field it leaves out at the schema's default (the
 * plugin-wide one). A repeated id or a refused configuration makes the agent invalid, naming the id
 * or the field; a stored definition with ids alone, or with a repeated id, still reads.
 *
 * | input | result |
 * | -- | -- |
 * | two agents configure one guardrail differently | they judge the same reply differently |
 * | a configuration the schema refuses | agent invalid, `invalid-guardrail-configuration`, the issue names the field |
 * | one id listed twice | agent invalid, `invalid-frontmatter`, the issue names the id |
 * | a stored definition with ids alone, or a repeated id | reads, the first entry applies |
 * | a configuration that sets one field | the other fields keep their defaults |
 */
import { afterEach, describe, expect, it } from 'bun:test';

import type { PluginGuardrailFactory } from '@lostgradient/interborough-plugin';
import {
  guardrailOf,
  type InputDetector,
  type OutputValidator,
  type ToolCallValidator,
} from '@lostgradient/operative';
import { z } from 'zod';

import {
  createAgentContributions,
  guardrailAdditionsOf,
  refusedGuardrailConfigurations,
  unresolvedContributions,
} from './agent-contributions';
import { agentFileDefinitionSchema, parseAgentFile } from './agent-file';
import { agentFileText, KNOWN_MODEL } from './testing/agent-file-fixtures.test-support';
import { type FileBureauHarness, startFileBureau } from './testing/agent-file-bureau.test-support';

/** What a `limit` validator judged: whether a reply of `length` characters passes under its settings. */
const limitFactory: PluginGuardrailFactory<
  OutputValidator,
  { readonly maximum: number; readonly category: string }
> = {
  name: 'limit',
  description: 'Flags a reply longer than its maximum.',
  // Two fields, so a configuration that sets one shows the other keeps its default.
  configuration: z.strictObject({
    maximum: z.number().int().min(1).default(20),
    category: z.string().min(1).default('too-long'),
  }),
  create: ({ maximum, category }) => ({
    name: 'ignored',
    validate: async (output) => ({ valid: output.length <= maximum, category, confidence: 1 }),
  }),
};

const keywordFactory: PluginGuardrailFactory<InputDetector, { readonly keyword: string }> = {
  name: 'keyword',
  description: 'Flags input that holds its keyword.',
  // No default: a bare id configures it with `{}`, which the schema refuses.
  configuration: z.strictObject({ keyword: z.string().min(1) }),
  create: ({ keyword }) => ({
    name: 'keyword',
    detect: async (input) => ({
      triggered: input.includes(keyword),
      category: 'keyword',
      confidence: input.includes(keyword) ? 1 : 0,
    }),
  }),
};

const capFactory: PluginGuardrailFactory<ToolCallValidator, { readonly most: number }> = {
  name: 'cap',
  description: 'Blocks a call whose amount is over its cap.',
  configuration: z.strictObject({ most: z.number().default(100) }),
  create: ({ most }) => ({
    name: 'cap',
    action: 'block',
    validate: async (call) => ({
      valid: ((call.arguments as { amount?: number }).amount ?? 0) <= most,
      category: 'cap',
      confidence: 1,
    }),
  }),
};

const plain: OutputValidator & { readonly description: string } = {
  name: 'plain',
  description: 'Takes no configuration.',
  validate: async () => ({ valid: true, category: 'plain', confidence: 0 }),
};

const contributions = createAgentContributions([
  {
    plugin: 'x',
    guardrails: {
      input: [{ guardrail: keywordFactory, action: 'warn' }],
      output: [limitFactory, plain],
      tools: [capFactory],
    },
  },
]);

/** The validator `x:limit` builds for one definition. */
function limitOf(configuration?: Record<string, unknown>): OutputValidator {
  const additions = guardrailAdditionsOf(
    { guardrails: [configuration === undefined ? 'x:limit' : { id: 'x:limit', configuration }] },
    contributions,
  );
  return guardrailOf(required(additions?.outputValidators?.[0]));
}

/** `value`, which the test needs to be there. */
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Expected a value.');
  return value;
}

async function passes(validator: OutputValidator, reply: string): Promise<boolean> {
  const result = await validator.validate(reply, { conversationText: () => '' } as never);
  return result.valid;
}

describe('a guardrail factory an agent configures', () => {
  it('builds a guardrail per configuration, so two agents judge one reply differently', async () => {
    const reply = 'x'.repeat(15);
    const lenient = limitOf({ maximum: 30 });
    const strict = limitOf({ maximum: 10 });

    expect(await passes(lenient, reply)).toBe(true);
    expect(await passes(strict, reply)).toBe(false);
  });

  it('gives a field the configuration leaves out its default, field by field', async () => {
    const validator = limitOf({ maximum: 10 });
    const result = await validator.validate('x'.repeat(11), {} as never);

    // `maximum` is the agent's, `category` the schema's default.
    expect(result).toEqual({ valid: false, category: 'too-long', confidence: 1 });
    expect(await passes(limitOf(), 'x'.repeat(20))).toBe(true);
    expect(await passes(limitOf(), 'x'.repeat(21))).toBe(false);
    const recategorized = await limitOf({ category: 'wordy' }).validate(
      'x'.repeat(21),
      {} as never,
    );
    expect(recategorized).toEqual({ valid: false, category: 'wordy', confidence: 1 });
  });

  it('names what it builds by the factory, keeps the entry’s action, and builds tool validators', async () => {
    expect(limitOf().name).toBe('limit');
    const additions = guardrailAdditionsOf(
      {
        guardrails: [
          { id: 'x:keyword', configuration: { keyword: 'SENTINEL' } },
          { id: 'x:cap', configuration: { most: 10 } },
        ],
      },
      contributions,
    );
    const entry = required(additions?.inputDetectors?.[0]);
    expect(entry).toMatchObject({ action: 'warn', guardrail: { name: 'keyword' } });
    const detected = await guardrailOf(entry).detect('a SENTINEL here', {} as never);
    expect(detected.triggered).toBe(true);
    const cap = required(additions?.toolValidators?.[0]);
    expect(cap).toMatchObject({
      name: 'cap',
      action: 'block',
      description: capFactory.description,
    });
    const call = { id: 'c', name: 'refund', arguments: { amount: 50 } };
    const judged = await cap.validate(call, {} as never);
    expect(judged.valid).toBe(false);
  });

  it('applies an id a stored definition repeats once, as its first entry says', async () => {
    const additions = guardrailAdditionsOf(
      {
        guardrails: [
          { id: 'x:limit', configuration: { maximum: 5 } },
          'x:limit',
          { id: 'x:limit', configuration: { maximum: 50 } },
        ],
      },
      contributions,
    );
    expect(additions?.outputValidators).toHaveLength(1);
    const first = guardrailOf(required(additions?.outputValidators?.[0]));
    expect(await passes(first, 'x'.repeat(6))).toBe(false);
  });

  it('refuses to build a guardrail from a configuration its schema refuses', () => {
    expect(() =>
      guardrailAdditionsOf(
        { guardrails: [{ id: 'x:limit', configuration: { maximum: 0 } }] },
        contributions,
      ),
    ).toThrow('The configuration of the guardrail "x:limit" is refused: maximum:');
  });
});

describe('refusedGuardrailConfigurations', () => {
  it('accepts an id alone, and a configuration the schema accepts', () => {
    expect(
      refusedGuardrailConfigurations(
        {
          guardrails: [
            'x:limit',
            'x:plain',
            { id: 'x:limit', configuration: { maximum: 3 } },
            { id: 'x:keyword', configuration: { keyword: 'a' } },
          ],
        },
        contributions,
      ),
    ).toEqual([]);
  });

  it('names the field a configuration gets wrong, and an unknown field', () => {
    expect(
      refusedGuardrailConfigurations(
        {
          guardrails: [
            'x:plain',
            { id: 'x:limit', configuration: { maximum: 'many', extra: true } },
          ],
        },
        contributions,
      ),
    ).toEqual([
      {
        path: 'guardrails.1.configuration.maximum',
        message: expect.stringContaining('"x:limit" refuses `maximum`'),
        reference: 'x:limit',
      },
      {
        path: 'guardrails.1.configuration',
        message: expect.stringContaining('extra'),
        reference: 'x:limit',
      },
    ]);
  });

  it('refuses an id alone for a schema that needs a field, naming the field', () => {
    expect(refusedGuardrailConfigurations({ guardrails: ['x:keyword'] }, contributions)).toEqual([
      {
        path: 'guardrails.0.configuration.keyword',
        message: expect.stringContaining('"x:keyword" refuses `keyword`'),
        reference: 'x:keyword',
      },
    ]);
  });

  it('refuses a configuration given to a guardrail that takes none', () => {
    expect(
      refusedGuardrailConfigurations(
        { guardrails: [{ id: 'x:plain', configuration: {} }] },
        contributions,
      ),
    ).toEqual([
      {
        path: 'guardrails.0.configuration',
        message: '"x:plain" takes no configuration',
        reference: 'x:plain',
      },
    ]);
  });

  it('leaves an unresolved id to unresolvedContributions, which reads either form', () => {
    const definition = { guardrails: [{ id: 'x:gone', configuration: {} }, 'y:gone'] };
    expect(refusedGuardrailConfigurations(definition, contributions)).toEqual([]);
    expect(unresolvedContributions(definition, contributions).map(({ path }) => path)).toEqual([
      'guardrails.0',
      'guardrails.1',
    ]);
  });
});

describe('guardrails in the frontmatter', () => {
  function problemOf(guardrails: string) {
    const result = parseAgentFile('helper', `---\nmodel: a/b\nguardrails: ${guardrails}\n---\n`);
    return result.ok ? undefined : result.problem;
  }

  it('parses an id and an id with its configuration', () => {
    const result = parseAgentFile(
      'helper',
      '---\nmodel: a/b\nguardrails:\n  - x:plain\n  - id: x:limit\n    configuration:\n      maximum: 3\n---\n',
    );
    expect(result.ok && result.file.definition.guardrails).toEqual([
      'x:plain',
      { id: 'x:limit', configuration: { maximum: 3 } },
    ]);
  });

  it.each([
    ['two ids', '[x:limit, x:plain, x:limit]', 2],
    ['an id and its configured form', '[x:limit, {id: x:limit, configuration: {maximum: 3}}]', 1],
  ])('refuses %s naming the same guardrail, at the repeat, naming the id', (_, list, index) => {
    const problem = problemOf(list);
    expect(problem?.code).toBe('invalid-frontmatter');
    expect(problem?.issues).toEqual([
      {
        path: `guardrails.${index}`,
        message: '"x:limit" is listed more than once; list each guardrail once',
      },
    ]);
  });

  it.each([
    ['a configuration that is not an object', '[{id: x:limit, configuration: 3}]'],
    ['an entry with a key besides id and configuration', '[{id: x:limit, action: warn}]'],
    ['an entry without an id', '[{configuration: {}}]'],
  ])('refuses %s', (_, list) => {
    expect(problemOf(list)?.code).toBe('invalid-frontmatter');
  });
});

describe('a stored definition’s guardrails', () => {
  const STORED = {
    name: 'Helper',
    description: null,
    model: KNOWN_MODEL,
    tools: [],
    card: [],
    a2a: false,
    instructions: 'Recorded.\n',
  };

  it('reads ids alone, as a snapshot written before COR-2118 holds them', () => {
    expect(
      agentFileDefinitionSchema.parse({ ...STORED, guardrails: ['x:limit', 'x:plain'] }).guardrails,
    ).toEqual(['x:limit', 'x:plain']);
  });

  it('reads an id an older snapshot repeats, and a configured entry', () => {
    const guardrails = ['x:limit', 'x:limit', { id: 'x:plain', configuration: {} }];
    expect(agentFileDefinitionSchema.parse({ ...STORED, guardrails }).guardrails).toEqual(
      guardrails,
    );
  });
});

describe('a file agent that configures a guardrail', () => {
  const harnesses: FileBureauHarness[] = [];
  afterEach(async () => {
    for (const harness of harnesses.splice(0)) await harness.dispose();
  });

  async function listingOf(guardrails: string, reply = 'unused') {
    const harness = await startFileBureau({
      scripts: { 'claude-opus-5-5': () => reply },
      overrides: { agentContributions: contributions },
    });
    harnesses.push(harness);
    await harness.put('helper.md', agentFileText({ model: KNOWN_MODEL, guardrails }));
    await harness.bureau.agents.refresh();
    return { harness, listing: harness.bureau.agents.list().find(({ id }) => id === 'helper') };
  }

  it('is invalid when the schema refuses its configuration, the issue naming the field', async () => {
    const { listing } = await listingOf('[{id: x:limit, configuration: {maximum: -1}}]');

    expect(listing?.state).toBe('invalid');
    expect(listing?.problem?.code).toBe('invalid-guardrail-configuration');
    expect(listing?.problem?.issues).toEqual([
      {
        path: 'guardrails.0.configuration.maximum',
        message: expect.stringContaining('"x:limit" refuses `maximum`'),
        reference: 'x:limit',
      },
    ]);
  });

  it('is invalid when it lists a guardrail twice, the issue naming the id', async () => {
    const { listing } = await listingOf('[x:limit, x:limit]');

    expect(listing?.state).toBe('invalid');
    expect(listing?.problem?.code).toBe('invalid-frontmatter');
    expect(listing?.problem?.issues).toEqual([
      {
        path: 'guardrails.1',
        message: expect.stringContaining('"x:limit" is listed more than once'),
      },
    ]);
  });

  it('runs the guardrail its configuration builds', async () => {
    const reply = 'x'.repeat(15);
    const strict = await listingOf('[{id: x:limit, configuration: {maximum: 10}}]', reply);
    const lenient = await listingOf('[{id: x:limit, configuration: {maximum: 30}}]', reply);
    expect(strict.listing?.state).toBe('ready');
    expect(lenient.listing?.state).toBe('ready');

    const strictTask = await strict.harness.bureau.tasks.start('helper', 'Hi');
    const lenientTask = await lenient.harness.bureau.tasks.start('helper', 'Hi');
    const strictResult = await strictTask.result();
    const lenientResult = await lenientTask.result();
    expect(strictResult.finishReason).toBe('tripwire');
    expect(lenientResult.finishReason).not.toBe('tripwire');
    expect(lenientResult.content).toBe(reply);
  });
});
