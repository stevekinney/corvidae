/**
 * COR-1936 — the approval precedence table. A chat's permission mode, a tool's own `toolApproval`
 * value, a remembered grant, and the tool's capability tier decide whether a call runs, asks, or is
 * denied. Every combination is written out below as data, read top to bottom as a person reviews
 * the rule, and not derived from the code under test. The same table is asserted twice: on the
 * pure decision, and on the outcome of a real toolbox call through the hook.
 */
import { createTool, createToolbox, createToolCall, type ToolMetadata } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { PERMISSION_MODES, type PermissionMode } from '@lostgradient/operative';

import {
  createToolApprovalHooks,
  decideToolApproval,
  TOOL_APPROVAL_MODES,
  type ToolApprovalMode,
} from './tool-approval';

type Verdict = 'allow' | 'ask' | 'deny';
/** The tiers a column of the table covers, in order. */
const TIERS = ['read-only', 'mutating', 'dangerous', 'unclassified'] as const;
type Tier = (typeof TIERS)[number];
/** One verdict for each of {@link TIERS}. */
type Row = readonly [Verdict, Verdict, Verdict, Verdict];
/** `none` is a tool the agent's `toolApproval` says nothing about. */
type Setting = ToolApprovalMode | 'none';
/** What a row decides without a remembered grant, and with one. */
type Cell = { readonly ungranted: Row; readonly granted: Row };

const METADATA: Readonly<Record<Tier, ToolMetadata | undefined>> = {
  'read-only': { readOnly: true },
  mutating: { mutates: true },
  dangerous: { dangerous: true },
  unclassified: undefined,
};

const SETTINGS: readonly Setting[] = ['none', ...TOOL_APPROVAL_MODES];

/** A cell a grant does not change. */
const same = (row: Row): Cell => ({ ungranted: row, granted: row });

/**
 * The expected verdict for every mode x setting x grant x tier: 4 x 5 x 2 x 4 = 160 cells.
 *
 * Reading the rules in `tool-approval.ts`, strongest first: `blocked` denies; `read-only` mode
 * denies what is not read-only; a tool set to `always` and the `always` mode ask; a grant lifts an
 * `on-changes` ask; `allow-all` lifts that ask for a tool that declares its tier; `never` runs
 * unless a stronger rule applies, and a tool that declares nothing still asks.
 */
const TABLE: Readonly<Record<PermissionMode, Readonly<Record<Setting, Cell>>>> = {
  // The default: the tool's own setting alone decides.
  'on-changes': {
    none: {
      ungranted: ['allow', 'ask', 'ask', 'ask'],
      granted: ['allow', 'allow', 'allow', 'allow'],
    },
    'on-changes': {
      ungranted: ['allow', 'ask', 'ask', 'ask'],
      granted: ['allow', 'allow', 'allow', 'allow'],
    },
    always: same(['ask', 'ask', 'ask', 'ask']),
    never: same(['allow', 'allow', 'allow', 'ask']),
    blocked: same(['deny', 'deny', 'deny', 'deny']),
  },
  // Every call asks, a grant or a `never` notwithstanding; `blocked` still denies.
  always: {
    none: same(['ask', 'ask', 'ask', 'ask']),
    'on-changes': same(['ask', 'ask', 'ask', 'ask']),
    always: same(['ask', 'ask', 'ask', 'ask']),
    never: same(['ask', 'ask', 'ask', 'ask']),
    blocked: same(['deny', 'deny', 'deny', 'deny']),
  },
  // Only a read-only tool is left to its own setting, and a grant does not lift a deny.
  'read-only': {
    none: same(['allow', 'deny', 'deny', 'deny']),
    'on-changes': same(['allow', 'deny', 'deny', 'deny']),
    always: same(['ask', 'deny', 'deny', 'deny']),
    never: same(['allow', 'deny', 'deny', 'deny']),
    blocked: same(['deny', 'deny', 'deny', 'deny']),
  },
  // The one loosening mode: the `on-changes` ask is skipped for a tool that declares its tier.
  // Never a tool set to `always` or `blocked`, and never a tool that declares nothing.
  'allow-all': {
    none: {
      ungranted: ['allow', 'allow', 'allow', 'ask'],
      granted: ['allow', 'allow', 'allow', 'allow'],
    },
    'on-changes': {
      ungranted: ['allow', 'allow', 'allow', 'ask'],
      granted: ['allow', 'allow', 'allow', 'allow'],
    },
    always: same(['ask', 'ask', 'ask', 'ask']),
    never: same(['allow', 'allow', 'allow', 'ask']),
    blocked: same(['deny', 'deny', 'deny', 'deny']),
  },
};

const RANK: Readonly<Record<Verdict, number>> = { allow: 0, ask: 1, deny: 2 };
const OUTCOME = { allow: 'success', ask: 'action_required', deny: 'error' } as const;

/** Every cell of the table, as a flat list a test can loop over. */
const CELLS = PERMISSION_MODES.flatMap((mode) =>
  SETTINGS.flatMap((setting) =>
    (['ungranted', 'granted'] as const).flatMap((grant) =>
      TIERS.map((tier, index) => ({
        mode,
        setting,
        grant,
        tier,
        expected: TABLE[mode][setting][grant][index] as Verdict,
      })),
    ),
  ),
);

const subject = (metadata: ToolMetadata | undefined) =>
  createTool({
    name: 'subject',
    description: 'The tool under test',
    input: z.object({}),
    ...(metadata === undefined ? {} : { metadata }),
    execute: async () => ({ ran: true }),
  });

/** The outcome of one call to `subject` in a toolbox governed only by the hook. */
async function outcomeOf(options: {
  readonly tier: Tier;
  readonly setting: Setting;
  readonly granted: boolean;
  readonly mode: PermissionMode | (() => never) | undefined;
}): Promise<string> {
  const { tier, setting, granted, mode } = options;
  const toolbox = createToolbox([subject(METADATA[tier])], {
    policy: createToolApprovalHooks(setting === 'none' ? {} : { subject: setting }, {
      remembered: () => granted,
      ...(mode === undefined
        ? {}
        : { permissionMode: typeof mode === 'function' ? mode : () => mode }),
    }),
  });
  const result = await toolbox.execute(createToolCall('subject', {}));
  return result.outcome;
}

describe('the approval precedence table (COR-1936)', () => {
  it('covers every mode, setting, grant and tier exactly once', () => {
    expect(CELLS).toHaveLength(4 * 5 * 2 * 4);
    expect(new Set(CELLS.map((cell) => JSON.stringify(cell))).size).toBe(CELLS.length);
  });

  it('is the verdict decideToolApproval gives for every cell', () => {
    for (const { mode, setting, grant, tier, expected } of CELLS) {
      const verdict = decideToolApproval({
        mode,
        setting: setting === 'none' ? 'on-changes' : setting,
        tier: tier === 'unclassified' ? undefined : tier,
        remembered: grant === 'granted',
      });
      expect({ mode, setting, grant, tier, verdict }).toEqual({
        mode,
        setting,
        grant,
        tier,
        verdict: expected,
      });
    }
  });

  it('is the outcome of a real toolbox call through the hook for every cell', async () => {
    for (const { mode, setting, grant, tier, expected } of CELLS) {
      const outcome = await outcomeOf({ tier, setting, granted: grant === 'granted', mode });
      expect({ mode, setting, grant, tier, outcome }).toEqual({
        mode,
        setting,
        grant,
        tier,
        outcome: OUTCOME[expected],
      });
    }
  });

  describe('the shape the table must keep', () => {
    it('lets always and read-only only tighten what the default mode decided', () => {
      for (const mode of ['always', 'read-only'] as const) {
        for (const setting of SETTINGS) {
          for (const grant of ['ungranted', 'granted'] as const) {
            TIERS.forEach((tier, index) => {
              const base = TABLE['on-changes'][setting][grant][index] as Verdict;
              const tightened = TABLE[mode][setting][grant][index] as Verdict;
              expect({ mode, setting, grant, tier, ok: RANK[tightened] >= RANK[base] }).toEqual({
                mode,
                setting,
                grant,
                tier,
                ok: true,
              });
            });
          }
        }
      }
    });

    it('lets allow-all differ from on-changes only by lifting an ask of a tool set to on-changes', () => {
      for (const setting of SETTINGS) {
        for (const grant of ['ungranted', 'granted'] as const) {
          TIERS.forEach((tier, index) => {
            const base = TABLE['on-changes'][setting][grant][index] as Verdict;
            const loosened = TABLE['allow-all'][setting][grant][index] as Verdict;
            if (base === loosened) return;
            expect({ setting, tier, base, loosened }).toEqual({
              setting,
              tier,
              base: 'ask',
              loosened: 'allow',
            });
            expect(['none', 'on-changes']).toContain(setting);
            expect(tier).not.toBe('unclassified');
          });
        }
      }
    });

    it('lets no mode and no grant allow a tool that is blocked, or ask less than a tool set to always', () => {
      for (const mode of PERMISSION_MODES) {
        for (const grant of ['ungranted', 'granted'] as const) {
          expect(TABLE[mode].blocked[grant]).toEqual(['deny', 'deny', 'deny', 'deny']);
          for (const verdict of TABLE[mode].always[grant]) expect(verdict).not.toBe('allow');
        }
      }
    });

    it('denies a tool that is not read-only in read-only mode whatever else is true of it', () => {
      for (const setting of SETTINGS) {
        for (const grant of ['ungranted', 'granted'] as const) {
          expect(TABLE['read-only'][setting][grant].slice(1)).toEqual(['deny', 'deny', 'deny']);
        }
      }
    });
  });

  describe('a hook with no permission mode', () => {
    it('decides as the default mode does, so a run outside a chat keeps each tool’s own setting', async () => {
      for (const setting of SETTINGS) {
        for (const grant of ['ungranted', 'granted'] as const) {
          for (const [index, tier] of TIERS.entries()) {
            const outcome = await outcomeOf({
              tier,
              setting,
              granted: grant === 'granted',
              mode: undefined,
            });
            expect(outcome).toBe(OUTCOME[TABLE['on-changes'][setting][grant][index] as Verdict]);
          }
        }
      }
    });
  });

  describe('a permission mode that cannot be read', () => {
    it('counts as read-only: a tool that is not read-only is denied, a read-only one runs', async () => {
      const unreadable = () => {
        throw new Error('The session store is down.');
      };
      for (const [tier, expected] of [
        ['read-only', 'success'],
        ['mutating', 'error'],
        ['dangerous', 'error'],
        ['unclassified', 'error'],
      ] as const) {
        expect(await outcomeOf({ tier, setting: 'never', granted: true, mode: unreadable })).toBe(
          expected,
        );
      }
    });

    it('says the mode could not be read, and not that the chat is read-only', async () => {
      const hooks = createToolApprovalHooks(
        {},
        {
          permissionMode: () => {
            throw new Error('The session store is down.');
          },
        },
      );
      const decision = await hooks.beforeExecute?.({
        toolName: 'subject',
        metadata: METADATA.mutating,
      } as never);
      expect(decision).toMatchObject({ allow: false, status: 'deny' });
      expect((decision as { reason: string }).reason).toContain('could not be read');
      expect((decision as { reason: string }).reason).not.toContain('read-only mode');
    });
  });

  describe('the grant', () => {
    it('is asked about only when it would change the answer', async () => {
      const asked: string[] = [];
      const toolbox = (mode: PermissionMode, setting: ToolApprovalMode, tier: Tier) =>
        createToolbox([subject(METADATA[tier])], {
          policy: createToolApprovalHooks(
            { subject: setting },
            {
              remembered: (toolName) => {
                asked.push(`${mode}:${setting}:${tier}:${toolName}`);
                return true;
              },
              permissionMode: () => mode,
            },
          ),
        });
      const run = (mode: PermissionMode, setting: ToolApprovalMode, tier: Tier) =>
        toolbox(mode, setting, tier).execute(createToolCall('subject', {}));

      await run('on-changes', 'on-changes', 'mutating');
      await run('allow-all', 'on-changes', 'mutating');
      await run('on-changes', 'on-changes', 'read-only');
      await run('always', 'on-changes', 'mutating');
      await run('read-only', 'on-changes', 'mutating');
      await run('on-changes', 'always', 'mutating');
      await run('on-changes', 'blocked', 'mutating');
      await run('on-changes', 'never', 'unclassified');

      // Only the first asked: `allow-all` already lifts the ask, a read-only tool does not ask,
      // and the other four are decided before a grant can matter.
      expect(asked).toEqual(['on-changes:on-changes:mutating:subject']);
    });
  });
});
