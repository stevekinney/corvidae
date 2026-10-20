/**
 * Fixtures for the tests of a restored approval's skill policy (COR-1613, COR-1620): a tool that
 * needs approval, a skill catalog whose one skill narrows what a run may call, and a model that
 * asks for a charge and then activates that skill.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { GenerateFunction, Toolbox } from '@lostgradient/operative';
import { createTool, createToolbox } from 'armorer';
import { z } from 'zod';

import { discoverSkills, type SkillCatalogRevision } from './skills';
import type { Bureau } from './types';

const roots: string[] = [];

/** Removes the skill directories the catalogs of a test file wrote. */
export async function removeSkillRoots(): Promise<void> {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
}

/** `charge-card` needs approval; the skill tools do not. */
export function chargeApprovalToolbox(charges: number[]): Toolbox {
  return createToolbox(
    [
      createTool({
        name: 'charge-card',
        version: '1.0.0',
        description: 'Charge a payment card',
        input: z.object({ cents: z.number() }),
        async execute({ cents }) {
          charges.push(cents);
          return { charged: cents };
        },
      }),
    ],
    {
      approvalSecret: 'skill-policy-secret',
      policy: {
        beforeExecute: (context) =>
          context.toolName === 'charge-card'
            ? {
                allow: false,
                status: 'needs_approval',
                reason: 'Operator approval required',
                action: { message: 'Approve charge' },
              }
            : { allow: true },
      },
    },
  ) as unknown as Toolbox;
}

/** A skill catalog on disk, whose one skill, `lock`, narrows a run to the tools it names. */
export interface SkillCatalogOnDisk {
  readonly root: string;
  readonly allowedTools: string;
  discover(): Promise<SkillCatalogRevision>;
  /** Rewrites the skill's instructions, which changes its digest. */
  rewrite(instructions: string): Promise<void>;
}

/**
 * A catalog with `lock`. With `allowedTools` of `deactivate_skill`, `charge-card` is refused;
 * with `charge-card, deactivate_skill` it is allowed.
 */
export async function skillCatalogOnDisk(
  allowedTools = 'deactivate_skill',
): Promise<SkillCatalogOnDisk> {
  const root = await mkdtemp(join(tmpdir(), 'bureau-restored-skill-policy-'));
  roots.push(root);
  await mkdir(join(root, 'lock'), { recursive: true });
  const write = (instructions: string) =>
    writeFile(
      join(root, 'lock', 'SKILL.md'),
      [
        '---',
        'name: lock',
        'description: Narrows the run to the tools it allows',
        `allowed-tools: ${allowedTools}`,
        '---',
        '',
        instructions,
        '',
      ].join('\n'),
    );
  await write('Only the allowed tools.');
  return {
    root,
    allowedTools,
    discover: () =>
      discoverSkills({
        sources: [{ id: 'user', kind: 'user', location: root, precedence: 20 }],
      }),
    rewrite: write,
  };
}

/** Step 0 asks for a charge, step 1 activates the locking skill, and step 2 stops or waits. */
export function lockedAfterCharging(finish: 'stop' | 'wait'): GenerateFunction {
  return async (context) => {
    if (context.step === 0) {
      return {
        content: '',
        toolCalls: [{ id: 'charge-X', name: 'charge-card', arguments: { cents: 4242 } }],
      };
    }
    if (context.step === 1) {
      return {
        content: '',
        toolCalls: [{ id: 'lock-1', name: 'activate_skill', arguments: { name: 'lock' } }],
      };
    }
    if (finish === 'stop') return { content: 'done', toolCalls: [] };
    return new Promise((_resolve, reject) => {
      context.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  };
}

/** Polls by the clock: the steps in question are separated by real work, not by event-loop turns. */
export async function pollForTime<T>(
  check: () => Promise<T | undefined>,
  what: string,
): Promise<T> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Condition was not met: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Whether the session has recorded an active skill. */
export async function skillsRecorded(bureau: Bureau, sessionId: string): Promise<boolean> {
  const session = await bureau.getSession(sessionId);
  const records = session?.metadata['activeSkillRecords'];
  return Array.isArray(records) && records.length > 0;
}

/** Lets the steps after the skill's activation commit before a test restarts the process. */
export async function letStepsCommit(): Promise<void> {
  for (let turn = 0; turn < 100; turn += 1) await new Promise((resolve) => setTimeout(resolve, 2));
}
