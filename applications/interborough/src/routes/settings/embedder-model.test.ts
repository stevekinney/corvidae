/**
 * What the Embedder row derives from the embedding status and the host's plugins (design board
 * COR-2189, rows EM6-02 to EM6-05, EM6-08, EM6-13 to EM6-15 and EM6-22): the option of each
 * embedder in words, the cause of a problem with the embedder in use, the switch's line, and which
 * embedder a provider's key serves. The status carries identifiers and codes; none of them is shown.
 */
import { describe, expect, test } from 'bun:test';

import type { EmbeddingStatus } from '../../lib/bureau-embedding.ts';
import type { PluginStanding } from '../../lib/host-plugins.ts';
import {
  embedderName,
  embedderOptions,
  embedderOwner,
  failureCause,
  problemCause,
  providerEmbedder,
  switchLine,
} from './embedder-model.ts';

function plugin(
  name: string,
  title: string,
  embedders: readonly { id: string; title?: string }[],
  overrides: { missing?: readonly string[] } = {},
): PluginStanding {
  return {
    descriptor: {
      name,
      title,
      version: '1.0.0',
      description: '',
      required: false,
      enabledByDefault: true,
    },
    source: 'package',
    location: '',
    status: (overrides.missing ?? []).length > 0 ? 'needs-setup' : 'running',
    problems: [],
    contributions: embedders.map((embedder) => ({
      kind: 'embedder',
      id: embedder.id,
      ...(embedder.title === undefined ? {} : { title: embedder.title }),
      references: { agents: 0, schedules: 0, waitingRuns: 0 },
    })),
    enabled: true,
    configuration: {},
    configurationSchema: null,
    running: { enabled: true, configuration: {} },
    secrets: (overrides.missing ?? []).map((key) => ({
      key,
      generated: false,
      set: false,
      location: '',
    })),
    restartRequired: false,
  };
}

function status(overrides: Partial<EmbeddingStatus> = {}): EmbeddingStatus {
  return {
    active: { embedder: 'hashing', dimension: 256, model: 'hashing' },
    problem: null,
    job: null,
    embedders: [
      { id: 'hashing', dimension: 256, availability: 'available' },
      { id: 'gemini:embedder', dimension: 768, availability: 'available' },
    ],
    ...overrides,
  };
}

const GEMINI = plugin('gemini', 'Gemini', [{ id: 'gemini:embedder' }]);
const OPENAI = plugin('openai', 'OpenAI', [{ id: 'openai:embedder' }]);
const TWO = plugin('multi', 'Multi', [
  { id: 'multi:small', title: 'Small model' },
  { id: 'multi:large-vectors' },
]);

describe('embedderName', () => {
  test('names the built-in embedder in words and a plugin embedder by its plugin title', () => {
    expect(embedderName('hashing', [])).toBe('Text hashing');
    expect(embedderName('gemini:embedder', [GEMINI])).toBe('Gemini');
  });

  test('follows the title with the embedder’s own name in words when the plugin adds more than one', () => {
    expect(embedderName('multi:small', [TWO])).toBe('Multi, Small model');
    expect(embedderName('multi:large-vectors', [TWO])).toBe('Multi, Large vectors');
  });

  test('words a plugin the host does not list from its identifier, never as the identifier', () => {
    expect(embedderName('ollama:embed', [])).toBe('Ollama');
    expect(embedderName('some-thing:embed', [])).toBe('Some thing');
    expect(embedderName('custom', [])).toBe('Custom');
  });
});

describe('embedderOptions (EM6-02, EM6-03, EM6-05)', () => {
  test('lists every registered embedder once, built-in first, with the built-in one suffixed and no identifier shown', () => {
    const options = embedderOptions(status(), [GEMINI]);
    expect(options.map((option) => option.value)).toEqual(['hashing', 'gemini:embedder']);
    expect(options.map((option) => option.label)).toEqual(['Text hashing', 'Gemini']);
    expect(options[0]?.suffix).toBe('built in');
    expect(options[1]?.suffix).toBeUndefined();
    for (const option of options) expect(option.label).not.toMatch(/[:]|embedder/u);
  });

  test('lists an embedder that needs setup but cannot be chosen, with its note and description', () => {
    const options = embedderOptions(
      status({
        embedders: [
          { id: 'hashing', dimension: 256, availability: 'available' },
          { id: 'gemini:embedder', dimension: 768, availability: 'needs-setup' },
        ],
      }),
      [GEMINI],
    );
    expect(options[1]).toMatchObject({
      value: 'gemini:embedder',
      label: 'Gemini',
      disabled: true,
      note: 'Needs setup',
      description: 'Save its key in Settings › Plugins first.',
    });
    expect(options[0]?.disabled).toBeUndefined();
  });

  test('adds the embedder in use as the current value, noted Not loaded, when no plugin has loaded it', () => {
    const options = embedderOptions(
      status({ active: { embedder: 'ollama:embed', dimension: 4, model: 'm' } }),
      [],
    );
    expect(options.at(-1)).toMatchObject({
      value: 'ollama:embed',
      label: 'Ollama',
      note: 'Not loaded',
    });
    expect(options).toHaveLength(3);
  });
});

describe('problemCause (EM6-15)', () => {
  const unavailable = 'embedder-unavailable';

  test('is nothing while the status reports no problem', () => {
    expect(problemCause(status())).toBeUndefined();
  });

  test('is not loaded when the embedder in use is not registered', () => {
    expect(
      problemCause(
        status({
          problem: unavailable,
          active: { embedder: 'ollama:embed', dimension: 4, model: 'm' },
        }),
      ),
    ).toBe('not-loaded');
  });

  test('is needs setup when the embedder in use is registered as needing setup', () => {
    expect(
      problemCause(
        status({
          problem: unavailable,
          active: { embedder: 'gemini:embedder', dimension: 768, model: 'm' },
          embedders: [{ id: 'gemini:embedder', dimension: 768, availability: 'needs-setup' }],
        }),
      ),
    ).toBe('needs-setup');
  });

  test('is a changed dimension when the embedder in use now makes vectors of another size', () => {
    expect(
      problemCause(
        status({
          problem: unavailable,
          active: { embedder: 'gemini:embedder', dimension: 768, model: 'm' },
          embedders: [{ id: 'gemini:embedder', dimension: 1536, availability: 'available' }],
        }),
      ),
    ).toBe('dimension-changed');
  });

  test('is a changed model when it is available at the same size', () => {
    expect(
      problemCause(
        status({
          problem: unavailable,
          active: { embedder: 'gemini:embedder', dimension: 768, model: 'm' },
        }),
      ),
    ).toBe('model-changed');
  });
});

describe('switchLine (EM6-08, EM6-13, EM6-14)', () => {
  const job = { target: 'gemini:embedder', done: 3, total: 10, error: null } as const;

  test('is nothing while there is no switch to report', () => {
    expect(switchLine(status(), [GEMINI])).toBeUndefined();
  });

  test('names the target and the count while a switch runs', () => {
    expect(switchLine(status({ job: { ...job, state: 'running' } }), [GEMINI])).toEqual({
      state: 'running',
      target: 'Gemini',
      current: 'Text hashing',
      done: 3,
      total: 10,
    });
  });

  test('words the wire’s cancelled as Canceled, with the embedder search still uses', () => {
    expect(switchLine(status({ job: { ...job, state: 'cancelled' } }), [GEMINI])).toMatchObject({
      state: 'canceled',
      target: 'Gemini',
      current: 'Text hashing',
    });
  });

  test('carries the cause of a failure in words', () => {
    expect(
      switchLine(status({ job: { ...job, state: 'failed', error: 'embedder-timeout' } }), [GEMINI]),
    ).toEqual({
      state: 'failed',
      target: 'Gemini',
      current: 'Text hashing',
      cause: 'Gemini took too long to answer',
      code: undefined,
    });
  });
});

describe('failureCause (EM6-14)', () => {
  test('words each code the Bureau names', () => {
    expect(failureCause('target-unavailable', 'Gemini')).toEqual({
      words: 'Gemini wasn’t loaded after a restart',
    });
    expect(failureCause('target-missing', 'Gemini')).toEqual({
      words: 'Gemini isn’t installed any more',
    });
    expect(failureCause('embedder-failed', 'Gemini')).toEqual({
      words: 'Gemini couldn’t embed one of the memories',
    });
    expect(failureCause('embedder-timeout', 'Gemini')).toEqual({
      words: 'Gemini took too long to answer',
    });
  });

  test('says an unknown code stopped the switch and hands the code back to show in monospace', () => {
    expect(failureCause('quota-exceeded', 'Gemini')).toEqual({
      words: 'Gemini stopped the switch',
      code: 'quota-exceeded',
    });
  });

  test('does not read a code off the prototype chain', () => {
    expect(failureCause('constructor', 'Gemini')).toEqual({
      words: 'Gemini stopped the switch',
      code: 'constructor',
    });
    expect(failureCause(null, 'Gemini')).toEqual({ words: 'Gemini stopped the switch' });
  });
});

describe('embedderOwner', () => {
  test('finds the plugin that adds an embedder by the plugin part of its identifier', () => {
    expect(embedderOwner('gemini:embedder', [OPENAI, GEMINI])?.descriptor.name).toBe('gemini');
    expect(embedderOwner('hashing', [OPENAI, GEMINI])).toBeUndefined();
    expect(embedderOwner('ollama:embed', [OPENAI, GEMINI])).toBeUndefined();
  });
});

describe('providerEmbedder (EM6-22)', () => {
  test('is the embedder memory uses when it is one the provider’s plugin contributes', () => {
    const current = status({
      active: { embedder: 'gemini:embedder', dimension: 768, model: 'm' },
    });
    expect(providerEmbedder(GEMINI, current)).toBe('gemini:embedder');
    expect(providerEmbedder(OPENAI, current)).toBeUndefined();
  });

  test('is the embedder a running switch moves to', () => {
    const switching = status({
      job: { target: 'openai:embedder', state: 'running', done: 1, total: 4, error: null },
    });
    expect(providerEmbedder(OPENAI, switching)).toBe('openai:embedder');
    expect(providerEmbedder(GEMINI, switching)).toBeUndefined();
  });

  test('is not the embedder of a switch that failed or was canceled, which memory is not moving to', () => {
    const failed = status({
      job: { target: 'openai:embedder', state: 'failed', done: 1, total: 4, error: null },
    });
    expect(providerEmbedder(OPENAI, failed)).toBeUndefined();
  });

  test('is nothing for a provider whose plugin is not known or contributes no embedder', () => {
    const current = status({
      active: { embedder: 'gemini:embedder', dimension: 768, model: 'm' },
    });
    expect(providerEmbedder(undefined, current)).toBeUndefined();
    expect(providerEmbedder(plugin('anthropic', 'Anthropic', []), current)).toBeUndefined();
  });
});
