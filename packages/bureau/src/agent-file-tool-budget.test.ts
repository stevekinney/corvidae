/**
 * COR-1915 — an agent file's `limits.tools` (`calls`, `seconds`) and the `chat`
 * half of `limits.cost` in the file: what the format accepts, how a write keeps, changes and removes
 * them, how seconds become Armorer's milliseconds, and that a run over its tool budget finishes
 * `budget-exceeded` with a reason that names the limit.
 */
import { afterEach, describe, expect, it } from 'bun:test';

import { parseAgentFile, serializeUpdatedAgentFile, type ParsedAgentFile } from './agent-file';
import { toolboxBudgetOf } from './file-agent-cost-budget';
import { waitForTaskState } from './test';
import { agentFileText, KNOWN_MODEL } from './testing/agent-file-fixtures.test-support';
import { type FileBureauHarness, startFileBureau } from './testing/agent-file-bureau.test-support';

const decoder = new TextDecoder();

function parsed(text: string): ParsedAgentFile {
  const result = parseAgentFile('helper', text);
  if (!result.ok) throw new Error(`Expected the file to parse: ${result.problem.message}`);
  return result.file;
}

function issuePaths(frontmatter: string): string[] | undefined {
  const result = parseAgentFile('helper', `---\nmodel: a/b\n${frontmatter}\n---\n`);
  if (result.ok) return undefined;
  expect(result.problem.code).toBe('invalid-frontmatter');
  return result.problem.issues?.map((issue) => issue.path);
}

describe('limits.tools in the frontmatter', () => {
  it('parses either limit or both, and a file without the key has none', () => {
    expect(
      parsed('---\nmodel: a/b\nlimits: { tools: { calls: 5 } }\n---\n').definition.limits?.tools,
    ).toEqual({ calls: 5 });
    expect(
      parsed('---\nmodel: a/b\nlimits: { tools: { seconds: 90.5 } }\n---\n').definition.limits
        ?.tools,
    ).toEqual({ seconds: 90.5 });
    expect(
      parsed('---\nmodel: a/b\nlimits: { tools: { calls: 5, seconds: 60 } }\n---\n').definition
        .limits?.tools,
    ).toEqual({ calls: 5, seconds: 60 });
    expect(parsed('---\nmodel: a/b\n---\n').definition).not.toHaveProperty('limits');
  });

  it('refuses a limit that is not a positive amount, an unknown key, and a budget with no limit', () => {
    expect(issuePaths('limits: { tools: { calls: 0 } }')).toEqual(['limits.tools.calls']);
    expect(issuePaths('limits: { tools: { calls: 1.5 } }')).toEqual(['limits.tools.calls']);
    expect(issuePaths('limits: { tools: { calls: 1000000 } }')).toEqual(['limits.tools.calls']);
    expect(issuePaths('limits: { tools: { seconds: 0 } }')).toEqual(['limits.tools.seconds']);
    expect(issuePaths('limits: { tools: { seconds: 100000 } }')).toEqual(['limits.tools.seconds']);
    expect(issuePaths('limits: { tools: { calls: 1, maxDuration: 2 } }')).toEqual(['limits.tools']);
    expect(issuePaths('limits: { tools: {} }')).toEqual(['limits.tools']);
  });

  it('maps seconds to Armorer’s milliseconds and leaves out a limit the file does not set', () => {
    expect(toolboxBudgetOf({ calls: 3 })).toEqual({ maxCalls: 3 });
    expect(toolboxBudgetOf({ seconds: 1.5 })).toEqual({ maxDurationMs: 1500 });
    expect(toolboxBudgetOf({ calls: 3, seconds: 60 })).toEqual({
      maxCalls: 3,
      maxDurationMs: 60_000,
    });
  });
});

describe('writing limits.tools and limits.cost.chat', () => {
  const file = () =>
    parsed(
      '---\nmodel: a/b\nlimits: { cost: { run: 1, chat: 4 }, tools: { calls: 5 } }\ncolor: blue\n---\nBody.\n',
    );

  it('keeps both when an update leaves them out, and changes them when it states them', () => {
    const kept = decoder.decode(
      serializeUpdatedAgentFile('helper', file(), {
        model: 'a/b',
        name: 'Named',
        instructions: 'Body.\n',
      }),
    );
    expect(parsed(kept).definition).toMatchObject({
      limits: { cost: { run: 1, chat: 4 }, tools: { calls: 5 } },
    });
    expect(kept).toContain('color: blue');

    const changed = parsed(
      decoder.decode(
        serializeUpdatedAgentFile('helper', file(), {
          model: 'a/b',
          limits: { cost: { run: 1, chat: 9 }, tools: { calls: 2, seconds: 30 } },
          instructions: 'Body.\n',
        }),
      ),
    );
    expect(changed.definition.limits?.cost).toEqual({ run: 1, chat: 9 });
    expect(changed.definition.limits?.tools).toEqual({ calls: 2, seconds: 30 });
  });

  it('removes limits.tools the update sets to null, and a limits.cost.chat an update drops', () => {
    const removed = decoder.decode(
      serializeUpdatedAgentFile('helper', file(), {
        model: 'a/b',
        limits: { cost: { run: 1 }, tools: null },
        instructions: 'Body.\n',
      }),
    );
    expect(removed).not.toContain('tools');
    expect(removed).not.toContain('chat');
    expect(parsed(removed).definition.limits).toEqual({ cost: { run: 1 } });
  });

  it('rewrites nothing when the update states what the file has', () => {
    expect(
      serializeUpdatedAgentFile('helper', file(), {
        model: 'a/b',
        limits: { cost: { run: 1, chat: 4 }, tools: { calls: 5 } },
        instructions: 'Body.\n',
      }),
    ).toBeUndefined();
  });
});

describe.each(['non-durable', 'durable'] as const)(
  'a file agent’s limits.tools, %s dispatch',
  (dispatch) => {
    const harnesses: FileBureauHarness[] = [];
    afterEach(async () => {
      for (const harness of harnesses.splice(0)) await harness.dispose();
    });

    /** Runs a file agent that asks for its tool on every step, `steps` times, then answers. */
    async function run(frontmatter: Record<string, string>, steps: number) {
      let call = 0;
      const harness = await startFileBureau({
        scripts: {
          'claude-opus-5-5': () => {
            call += 1;
            return call >= steps
              ? 'All done.'
              : { content: '', toolCalls: [{ name: 'lookup-order', arguments: {} }] };
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
      return { result, generations: call };
    }

    it('ends a run that has used its calls as budget-exceeded, naming the limit, and asks the model for nothing more', async () => {
      const { result, generations } = await run({ limits: '{ tools: { calls: 2 } }' }, 10);
      expect(result.finishReason).toBe('budget-exceeded');
      expect(result.error instanceof Error ? result.error.message : '').toContain('max calls 2');
      // Two calls ran; the third was refused and the run stopped there.
      expect(generations).toBe(3);
    });

    it('lets a run that stays within its calls finish', async () => {
      const { result, generations } = await run({ limits: '{ tools: { calls: 5 } }' }, 3);
      expect(result.finishReason).toBe('stop-condition');
      expect(generations).toBe(3);
    });

    it('puts no limit on an agent whose file sets none', async () => {
      const { result, generations } = await run({}, 8);
      expect(result.finishReason).toBe('stop-condition');
      expect(generations).toBe(8);
    });
  },
);
