/**
 * COR-1913 — the policy hook that a file agent's `toolApproval` becomes: what each value decides
 * for a read-only and a mutating tool, and that it composes with the toolbox's own approval policy
 * as the most restrictive of the two, so a per-tool `never` can never loosen a toolbox `ask`.
 */
import {
  type AnyToolbox,
  type ApprovalMode,
  type ApprovalStatus,
  combineApprovalStatuses,
  createTool,
  createToolbox,
  createToolCall,
  type ToolMetadata,
} from 'armorer';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import {
  createToolApprovalHooks,
  grantLoosensTool,
  TOOL_APPROVAL_DEFAULT_MODE,
  TOOL_APPROVAL_MODES,
  type ToolApprovalMode,
} from './tool-approval';

type Kind = 'read-only' | 'mutating';

const METADATA: Readonly<Record<Kind, ToolMetadata>> = {
  'read-only': { readOnly: true },
  mutating: { mutates: true },
};

/** What each value decides on its own, written out and not derived from the hook. */
const HOOK_ALONE: Readonly<Record<ToolApprovalMode, Readonly<Record<Kind, ApprovalStatus>>>> = {
  never: { 'read-only': 'allow', mutating: 'allow' },
  'on-changes': { 'read-only': 'allow', mutating: 'ask' },
  always: { 'read-only': 'ask', mutating: 'ask' },
  blocked: { 'read-only': 'deny', mutating: 'deny' },
};

/** The toolbox policies the matrix puts beside the hook: one that allows a call, one that asks. */
const TOOLBOX_POLICY: Readonly<
  Record<'allow' | 'ask', { readonly mode: ApprovalMode; readonly status: ApprovalStatus }>
> = {
  allow: { mode: 'never', status: 'allow' },
  ask: { mode: 'always', status: 'ask' },
};

const OUTCOME = { allow: 'success', ask: 'action_required', deny: 'error' } as const;

function subject(metadata: ToolMetadata) {
  return createTool({
    name: 'subject',
    description: 'The tool under test',
    input: z.object({}),
    metadata,
    execute: async () => ({ ran: true }),
  });
}

/** The outcome of one call to the tool named `name` in `toolbox`. */
async function outcomeOf(toolbox: AnyToolbox, name = 'subject'): Promise<string> {
  const result = await toolbox.execute(createToolCall(name, {}));
  return result.outcome;
}

describe('createToolApprovalHooks', () => {
  for (const mode of TOOL_APPROVAL_MODES) {
    for (const kind of ['read-only', 'mutating'] as const) {
      for (const policy of ['allow', 'ask'] as const) {
        it(`decides a ${kind} tool set to ${mode} under a toolbox that ${policy}s as the most restrictive of the two`, async () => {
          const toolbox = createToolbox([subject(METADATA[kind])], {
            approvalPolicy: { mode: TOOLBOX_POLICY[policy].mode },
            policy: createToolApprovalHooks({ subject: mode }),
          });
          const expected = combineApprovalStatuses(
            TOOLBOX_POLICY[policy].status,
            HOOK_ALONE[mode][kind],
          );

          const result = await toolbox.execute(createToolCall('subject', {}));

          expect(result.outcome).toBe(OUTCOME[expected]);
          if (expected === 'ask') expect(result.pendingApproval).toBeDefined();
          if (expected === 'deny') expect(result.error?.code).toBe('POLICY_DENIED');
        });
      }
    }

    for (const kind of ['read-only', 'mutating'] as const) {
      it(`decides a ${kind} tool set to ${mode} in a toolbox with no approval policy of its own`, async () => {
        const toolbox = createToolbox([subject(METADATA[kind])], {
          policy: createToolApprovalHooks({ subject: mode }),
        });

        const result = await toolbox.execute(createToolCall('subject', {}));

        expect(result.outcome).toBe(OUTCOME[HOOK_ALONE[mode][kind]]);
      });
    }
  }

  it('applies on-changes to a tool the map leaves out, and to every tool when there is no map', async () => {
    expect(TOOL_APPROVAL_DEFAULT_MODE).toBe('on-changes');
    for (const toolApproval of [undefined, {}, { other: 'never' as const }]) {
      const readOnly = createToolbox([subject(METADATA['read-only'])], {
        policy: createToolApprovalHooks(toolApproval),
      });
      const mutating = createToolbox([subject(METADATA.mutating)], {
        policy: createToolApprovalHooks(toolApproval),
      });

      expect(await outcomeOf(readOnly, 'subject')).toBe('success');
      expect(await outcomeOf(mutating, 'subject')).toBe('action_required');
    }
  });

  it('takes another default for a tool the map leaves out when it is given one', async () => {
    const toolbox = createToolbox([subject(METADATA.mutating)], {
      policy: createToolApprovalHooks({}, { defaultMode: 'blocked' }),
    });

    expect(await outcomeOf(toolbox, 'subject')).toBe('error');
  });

  it('asks about a tool that declares no capability, even when the tool is set to never', async () => {
    const toolbox = createToolbox([subject({})], {
      policy: createToolApprovalHooks({ subject: 'never' }),
    });

    expect(await outcomeOf(toolbox, 'subject')).toBe('action_required');
  });

  it('reads a tool name that is also an Object.prototype member as a name with no entry', async () => {
    const readOnly = createTool({
      name: 'constructor',
      description: 'A tool named like an inherited member',
      input: z.object({}),
      metadata: { mutates: true },
      execute: async () => 'ran',
    });
    const toolbox = createToolbox([readOnly], {
      policy: createToolApprovalHooks({ other: 'never' }),
    });

    expect(await outcomeOf(toolbox, 'constructor')).toBe('action_required');
  });

  it('leaves a tool it does not govern to whatever else decides, even one that declares nothing', async () => {
    for (const metadata of [{ mutates: true }, {}]) {
      const toolbox = createToolbox([subject(metadata)], {
        policy: createToolApprovalHooks({ subject: 'blocked' }, { tools: ['other'] }),
      });

      expect(await outcomeOf(toolbox, 'subject')).toBe('success');
    }
  });

  it('governs a tool it is told to govern', async () => {
    const toolbox = createToolbox([subject({ mutates: true })], {
      policy: createToolApprovalHooks({}, { tools: ['subject'] }),
    });

    expect(await outcomeOf(toolbox, 'subject')).toBe('action_required');
  });

  it('does not see a change the caller makes to the map after the hook is built', async () => {
    const toolApproval: Record<string, ToolApprovalMode> = { subject: 'never' };
    const toolbox = createToolbox([subject(METADATA.mutating)], {
      policy: createToolApprovalHooks(toolApproval),
    });
    toolApproval['subject'] = 'blocked';

    expect(await outcomeOf(toolbox, 'subject')).toBe('success');
  });
});

describe('a remembered tool (COR-1828)', () => {
  const REMEMBERED: Readonly<Record<ToolApprovalMode, Readonly<Record<Kind, ApprovalStatus>>>> = {
    // A grant lifts the `on-changes` ask of a changing tool and nothing else.
    never: HOOK_ALONE.never,
    'on-changes': { 'read-only': 'allow', mutating: 'allow' },
    always: HOOK_ALONE.always,
    blocked: HOOK_ALONE.blocked,
  };
  const RESTRICTIONS = {
    allow: { mode: 'never', status: 'allow' },
    ask: { mode: 'always', status: 'ask' },
    // A restriction that refuses every call, as a read-only mode refuses a call that changes things.
    deny: { mode: 'deny', status: 'deny' },
  } as const satisfies Record<string, { mode: ApprovalMode; status: ApprovalStatus }>;

  for (const mode of TOOL_APPROVAL_MODES) {
    for (const kind of ['read-only', 'mutating'] as const) {
      for (const restriction of ['allow', 'ask', 'deny'] as const) {
        it(`decides a ${kind} tool set to ${mode} that is remembered, under a toolbox that ${restriction === 'allow' ? 'allows' : restriction === 'ask' ? 'asks' : 'denies'}`, async () => {
          const toolbox = createToolbox([subject(METADATA[kind])], {
            approvalPolicy: { mode: RESTRICTIONS[restriction].mode },
            policy: createToolApprovalHooks(
              { subject: mode },
              { remembered: async (tool) => tool.name === 'subject' },
            ),
          });
          const expected = combineApprovalStatuses(
            RESTRICTIONS[restriction].status,
            REMEMBERED[mode][kind],
          );

          expect(await outcomeOf(toolbox)).toBe(OUTCOME[expected]);
        });
      }
    }
  }

  it('lifts the ask of the tool that was remembered and not of another', async () => {
    const other = createTool({
      name: 'other',
      description: 'Another tool that changes things',
      input: z.object({}),
      metadata: { mutates: true },
      execute: async () => ({ ran: true }),
    });
    const toolbox = createToolbox([subject({ mutates: true }), other], {
      policy: createToolApprovalHooks({}, { remembered: (tool) => tool.name === 'subject' }),
    });

    expect(await outcomeOf(toolbox, 'subject')).toBe('success');
    expect(await outcomeOf(toolbox, 'other')).toBe('action_required');
  });

  it('asks the grant by the namespaced name, so a grant for a:search does not authorize b:search (COR-1879)', async () => {
    const searchIn = (namespace: string) =>
      createTool({
        name: 'search',
        namespace,
        description: `Search ${namespace}`,
        input: z.object({}),
        metadata: { mutates: true },
        execute: async () => ({ ran: namespace }),
      });
    // An unsigned approval's grant is the approval's `toolName`.
    const granted = new Set(['a:search']);
    const toolbox = createToolbox([searchIn('a'), searchIn('b')], {
      policy: createToolApprovalHooks({}, { remembered: (tool) => granted.has(tool.name) }),
    });

    expect(await outcomeOf(toolbox, 'a__search')).toBe('success');
    expect(await outcomeOf(toolbox, 'b__search')).toBe('action_required');
  });

  it('asks the grant for the id of the tool called, version included (COR-1950)', async () => {
    const versioned = (version: string) =>
      createTool({
        name: 'subject',
        version,
        description: 'A tool that changes things',
        input: z.object({}),
        metadata: { mutates: true },
        execute: async () => ({ ran: true }),
      });
    const granted = new Set(['default:subject@1.0.0']);
    const hooks = () => createToolApprovalHooks({}, { remembered: (tool) => granted.has(tool.id) });

    const sameVersion = createToolbox([versioned('1.0.0')], { policy: hooks() });
    const newVersion = createToolbox([versioned('2.0.0')], { policy: hooks() });

    expect(await outcomeOf(sameVersion)).toBe('success');
    expect(await outcomeOf(newVersion)).toBe('action_required');
  });

  it('asks when the grant cannot be read', async () => {
    const toolbox = createToolbox([subject({ mutates: true })], {
      policy: createToolApprovalHooks(
        {},
        {
          remembered: () => {
            throw new Error('The session could not be read.');
          },
        },
      ),
    });

    expect(await outcomeOf(toolbox)).toBe('action_required');
  });

  it('never asks the grant about a tool whose value is not on-changes', async () => {
    const asked: string[] = [];
    for (const mode of ['never', 'always', 'blocked'] as const) {
      const toolbox = createToolbox([subject({ mutates: true })], {
        policy: createToolApprovalHooks(
          { subject: mode },
          {
            remembered: (tool) => {
              asked.push(tool.name);
              return true;
            },
          },
        ),
      });
      await outcomeOf(toolbox);
    }

    expect(asked).toEqual([]);
  });
});

describe('grantLoosensTool (COR-1990)', () => {
  const tool = (name: string, namespace: string | undefined, metadata: ToolMetadata) =>
    createTool({
      name,
      ...(namespace === undefined ? {} : { namespace }),
      version: '1.0.0',
      description: name,
      input: z.object({}),
      metadata,
      execute: async () => ({}),
    });
  const tools = { refund: tool('refund', undefined, { mutates: true }) };

  it.each([
    ['a tool with no setting, in the default mode', undefined, 'on-changes', true],
    ['a tool set to on-changes, in allow-all', { refund: 'on-changes' }, 'allow-all', true],
    ['a tool set to never', { refund: 'never' }, 'on-changes', true],
    ['a tool set to always', { refund: 'always' }, 'on-changes', false],
    ['a tool set to blocked', { refund: 'blocked' }, 'on-changes', false],
    ['a tool in a chat that asks about every call', undefined, 'always', false],
    ['a tool that changes something, in a read-only chat', undefined, 'read-only', false],
  ] as const)('answers %s', (_name, toolApproval, mode, expected) => {
    expect(
      grantLoosensTool({
        toolApproval,
        tools,
        reportedName: 'refund',
        mode,
      }),
    ).toBe(expected);
  });

  it('reads the setting of the key a namespaced tool was declared under', () => {
    const namespaced = { search: tool('search', 'docs', { mutates: true }) };

    expect(
      grantLoosensTool({
        toolApproval: { search: 'always' },
        tools: namespaced,
        reportedName: 'docs:search',
        mode: 'on-changes',
      }),
    ).toBe(false);
    expect(
      grantLoosensTool({
        toolApproval: { search: 'never' },
        tools: namespaced,
        reportedName: 'docs:search',
        mode: 'on-changes',
      }),
    ).toBe(true);
  });

  it('weighs only the chat’s mode for an agent whose tools the Bureau cannot read', () => {
    expect(
      grantLoosensTool({
        toolApproval: undefined,
        tools: undefined,
        reportedName: 'anything',
        mode: 'on-changes',
      }),
    ).toBe(true);
    expect(
      grantLoosensTool({
        toolApproval: undefined,
        tools: undefined,
        reportedName: 'anything',
        mode: 'always',
      }),
    ).toBe(false);
  });
});
