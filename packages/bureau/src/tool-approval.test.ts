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
