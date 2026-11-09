/**
 * COR-1865 — an agent file's `limits.steps` and `retry`: what they accept, how a write keeps them,
 * that a definition without them still loads, and that they reach the run.
 */
import { type GenerateFunction, ProviderError } from '@lostgradient/operative';
import { afterEach, describe, expect, it } from 'bun:test';

import {
  agentFileDefinitionSchema,
  parseAgentFile,
  serializeNewAgentFile,
  serializeUpdatedAgentFile,
  type ParsedAgentFile,
} from './agent-file';
import {
  type AgentFileFixture,
  agentFileText,
  createAgentFileFixture,
  KNOWN_MODEL,
} from './testing/agent-file-fixtures.test-support';

const decoder = new TextDecoder();

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

describe('limits.steps and retry in the frontmatter', () => {
  it('parses both, and a file without them has neither', () => {
    const { definition } = parsed(
      '---\nmodel: a/b\nlimits: { steps: 40 }\nretry:\n  attempts: 3\n  delayMilliseconds: 250\n  jitter: true\n---\n',
    );
    expect(definition.limits?.steps).toBe(40);
    expect(definition.retry).toEqual({ attempts: 3, delayMilliseconds: 250, jitter: true });

    const bare = parsed('---\nmodel: a/b\n---\n').definition;
    expect(Object.hasOwn(bare, 'limits')).toBe(false);
    expect(Object.hasOwn(bare, 'retry')).toBe(false);
    expect(parsed('---\nmodel: a/b\nretry: {attempts: 2}\n---\n').definition.retry).toEqual({
      attempts: 2,
    });
  });

  it('names the field of every out-of-range or malformed value', () => {
    expect(issuePaths('limits: { steps: 0 }')).toEqual(['limits.steps']);
    expect(issuePaths('limits: { steps: 1001 }')).toEqual(['limits.steps']);
    expect(issuePaths('limits: { steps: 2.5 }')).toEqual(['limits.steps']);
    expect(issuePaths('limits: { steps: "25" }')).toEqual(['limits.steps']);
    expect(issuePaths('retry: {attempts: 0}')).toEqual(['retry.attempts']);
    expect(issuePaths('retry: {attempts: 11}')).toEqual(['retry.attempts']);
    expect(issuePaths('retry: {attempts: 1.5}')).toEqual(['retry.attempts']);
    expect(issuePaths('retry: {}')).toEqual(['retry.attempts']);
    expect(issuePaths('retry: {attempts: 2, delayMilliseconds: -1}')).toEqual([
      'retry.delayMilliseconds',
    ]);
    expect(issuePaths('retry: {attempts: 2, delayMilliseconds: 60001}')).toEqual([
      'retry.delayMilliseconds',
    ]);
    expect(issuePaths('retry: {attempts: 2, jitter: "yes"}')).toEqual(['retry.jitter']);
    expect(issuePaths('retry: 3')?.[0]).toBe('retry');
    // A key Operative's retry has but a file may not set is an unknown key, not silently ignored.
    expect(issuePaths('retry: {attempts: 2, backoff: 2}')).toEqual(['retry']);
  });

  it('accepts the bounds', () => {
    expect(issuePaths('limits: { steps: 1 }')).toBeUndefined();
    expect(issuePaths('limits: { steps: 1000 }')).toBeUndefined();
    expect(
      issuePaths('retry: {attempts: 10, delayMilliseconds: 60000, jitter: false}'),
    ).toBeUndefined();
    expect(issuePaths('retry: {attempts: 1, delayMilliseconds: 0}')).toBeUndefined();
  });
});

describe('writing limits.steps and retry', () => {
  it('writes a new file that parses back to the same values', () => {
    const bytes = serializeNewAgentFile({
      model: 'a/b',
      limits: { steps: 12 },
      retry: { attempts: 4, delayMilliseconds: 500, jitter: true },
      instructions: 'Body.\n',
    });
    const text = decoder.decode(bytes);
    expect(text).toContain('steps: 12');
    const { definition } = parsed(text);
    expect(definition.limits?.steps).toBe(12);
    expect(definition.retry).toEqual({ attempts: 4, delayMilliseconds: 500, jitter: true });
  });

  it('writes neither key when the definition sets neither', () => {
    const text = decoder.decode(serializeNewAgentFile({ model: 'a/b', instructions: 'Body.\n' }));
    expect(text).not.toContain('limits');
    expect(text).not.toContain('retry');
  });

  it('keeps both when an update leaves them out, and adds neither to a file without them', () => {
    const file = parsed(
      '---\nmodel: a/b\nlimits: { steps: 7 }\nretry: {attempts: 2, jitter: true}\ncolor: blue\n---\nBody.\n',
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
      limits: { steps: 7 },
      retry: { attempts: 2, jitter: true },
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
    expect(renamed).not.toContain('limits');
    expect(renamed).not.toContain('retry');
  });

  it('changes a value the update states, and removes one the update sets to null', () => {
    const file = parsed(
      '---\nmodel: a/b\nlimits: { steps: 7 }\nretry: {attempts: 2}\n---\nBody.\n',
    );
    const changed = parsed(
      decoder.decode(
        serializeUpdatedAgentFile('helper', file, {
          model: 'a/b',
          limits: { steps: 9 },
          retry: { attempts: 5, delayMilliseconds: 100 },
          instructions: 'Body.\n',
        }),
      ),
    );
    expect(changed.definition.limits?.steps).toBe(9);
    expect(changed.definition.retry).toEqual({ attempts: 5, delayMilliseconds: 100 });

    const removed = decoder.decode(
      serializeUpdatedAgentFile('helper', changed, {
        model: 'a/b',
        limits: { steps: null },
        retry: null,
        instructions: 'Body.\n',
      }),
    );
    expect(removed).not.toContain('limits');
    expect(removed).not.toContain('retry');
    expect(parsed(removed).definition).not.toHaveProperty('limits');
  });

  it('rewrites nothing when the update states the values the file has', () => {
    const file = parsed(
      '---\nmodel: a/b\nlimits: { steps: 7 }\nretry: {attempts: 2}\n---\nBody.\n',
    );
    expect(
      serializeUpdatedAgentFile('helper', file, {
        model: 'a/b',
        limits: { steps: 7 },
        retry: { attempts: 2 },
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
    card: [],
    a2a: false,
    instructions: 'Recorded.\n',
  };

  it('loads when it was written before the fields existed', () => {
    const loaded = agentFileDefinitionSchema.parse(OLD_SNAPSHOT);
    expect(loaded.limits?.steps).toBeUndefined();
    expect(loaded.retry).toBeUndefined();
  });

  it('keeps both when it has them, and refuses an out-of-range value', () => {
    const loaded = agentFileDefinitionSchema.parse({
      ...OLD_SNAPSHOT,
      limits: { steps: 3 },
      retry: { attempts: 2, delayMilliseconds: 10 },
    });
    expect(loaded).toMatchObject({
      limits: { steps: 3 },
      retry: { attempts: 2, delayMilliseconds: 10 },
    });
    expect(
      agentFileDefinitionSchema.safeParse({ ...OLD_SNAPSHOT, limits: { steps: 0 } }).success,
    ).toBe(false);
    expect(
      agentFileDefinitionSchema.safeParse({ ...OLD_SNAPSHOT, retry: { attempts: 99 } }).success,
    ).toBe(false);
  });
});

describe('a file agent’s run', () => {
  const fixtures: AgentFileFixture[] = [];
  afterEach(async () => {
    for (const fixture of fixtures.splice(0)) await fixture.dispose();
  });

  async function agentOf(frontmatter: Record<string, string>, generate: GenerateFunction) {
    const fixture = await createAgentFileFixture({ watch: false, resolveGenerate: () => generate });
    fixtures.push(fixture);
    await fixture.put('helper.md', agentFileText({ model: KNOWN_MODEL, ...frontmatter }));
    await fixture.catalog.refresh();
    const agent = fixture.catalog.find('helper');
    if (agent === undefined) throw new Error('Expected the file to load as an agent.');
    return { fixture, agent };
  }

  /** A generate that asks for a tool on every step, so only the step limit ends the run. */
  function looping(): { generate: GenerateFunction; calls: () => number } {
    let calls = 0;
    return {
      calls: () => calls,
      generate: async () => {
        calls += 1;
        return {
          content: '',
          toolCalls: [{ id: `call-${calls}`, name: 'lookup-order', arguments: {} }],
        };
      },
    };
  }

  it('stops at the file’s limits.steps', async () => {
    const { generate, calls } = looping();
    const { agent } = await agentOf({ limits: '{ steps: 2 }', tools: '[lookup-order]' }, generate);

    const result = await agent.run('go').result();

    expect(result.finishReason).toBe('maximum-steps');
    expect(calls()).toBe(2);
  });

  it('runs to Operative’s default when the file sets no limits.steps', async () => {
    const { generate, calls } = looping();
    const { agent } = await agentOf({ tools: '[lookup-order]' }, generate);

    const result = await agent.run('go').result();

    expect(result.finishReason).toBe('maximum-steps');
    expect(calls()).toBe(25);
  });

  /** A generate that fails its first `failures` calls with a transient provider error, then answers. */
  function flaky(failures: number): { generate: GenerateFunction; calls: () => number } {
    let calls = 0;
    return {
      calls: () => calls,
      generate: async () => {
        calls += 1;
        if (calls <= failures) {
          throw new ProviderError({
            provider: 'anthropic',
            cause: new Error('busy'),
            statusCode: 503,
          });
        }
        return { content: 'done', toolCalls: [] };
      },
    };
  }

  it('retries a failed generate call as the file’s retry says', async () => {
    const { generate, calls } = flaky(1);
    const { agent } = await agentOf({ retry: '{attempts: 2, delayMilliseconds: 0}' }, generate);

    const result = await agent.run('go').result();

    expect(result.finishReason).toBe('stop-condition');
    expect(calls()).toBe(2);
  });

  it('does not retry when the file has no retry', async () => {
    const { generate, calls } = flaky(1);
    const { agent } = await agentOf({}, generate);

    const result = await agent.run('go').result();

    expect(result.finishReason).toBe('error');
    expect(calls()).toBe(1);
  });

  it('calls a non-transient provider error once, however many attempts the file allows', async () => {
    let calls = 0;
    const generate: GenerateFunction = async () => {
      calls += 1;
      throw new ProviderError({
        provider: 'anthropic',
        cause: new Error('bad request'),
        statusCode: 400,
      });
    };
    const { agent } = await agentOf({ retry: '{attempts: 3, delayMilliseconds: 0}' }, generate);

    const result = await agent.run('go').result();

    expect(result.finishReason).toBe('error');
    expect(calls).toBe(1);
  });
});
