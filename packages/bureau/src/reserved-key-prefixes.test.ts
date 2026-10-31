import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import {
  createAgent,
  createModelCatalog,
  stopWhen,
  waitForCondition,
  withBackendDescriptors,
} from '@lostgradient/operative';
import { MemoryStorage } from '@lostgradient/storage';
import { WEFT_RESERVED_KEY_PREFIXES } from '@lostgradient/weft';
import { afterEach, describe, expect, it } from 'bun:test';
import { Glob } from 'bun';

import type { AgentDefinitions } from './agent-catalog';
import { createBureau } from './create-bureau';
import {
  BUREAU_RESERVED_KEY_FAMILIES,
  BUREAU_RESERVED_KEY_PREFIXES,
  SHARED_KEY_FAMILIES_OF_A_CHAT,
} from './reserved-key-prefixes';

/**
 * Constants whose name ends in `PREFIX`, `KEY`, or `NAMESPACE` that hold something other than a
 * storage key or key prefix Bureau chooses: owner-label and workflow-id prefixes, and namespaces
 * that Weft files under its own keys. Adding to this list is a reviewed edit.
 */
const NOT_STORAGE_KEYS = new Set([
  'AUDIT_SCHEDULE_OWNER_PREFIX',
  'AUDIT_SESSION_OWNER_PREFIX',
  'AUDIT_AGENT_OWNER_PREFIX',
  'AUDIT_WORKFLOW_OWNER_PREFIX',
  'AUDIT_HOOK_OWNER_PREFIX',
  'CONTROLLER_PREFIX',
  'ATTEMPT_RUN_PREFIX',
  'SESSION_INPUT_NAMESPACE',
  'REVIEW_AUDIT_OUTBOX_NAMESPACE',
]);

/**
 * The shared families `SHARED_KEY_FAMILIES_OF_A_CHAT` classifies that Weft does not list in
 * `WEFT_RESERVED_KEY_PREFIXES`: Operative's session store, durable run records and attempt
 * artifacts, governed memory's records, ledger and consolidation stores, and Weft's schema-version
 * key, which it keeps apart from its engine prefixes.
 */
const SHARED_PREFIXES_OUTSIDE_WEFTS_LIST = new Set([
  'agent-session',
  'session-input-deliveries:v1:',
  'durable-run:',
  'weft:',
  'fresh-attempt-artifact:v1:',
  'app:agent-bureau:memory:v1:',
  'app:agent-bureau:memory-vectors:v1:',
  'app:agent-bureau:memory-governance:v1:',
  'app:agent-bureau:memory-evidence:v1:',
  'app:agent-bureau:memory-projection:v1:',
  'app:agent-bureau:memory-transition:v1:',
]);

/**
 * The key families the durable engine (Weft) and the session store (Operative) write into the
 * storage a Bureau shares with them. They are those packages' to reserve, not Bureau's.
 */
const ENGINE_KEY_PREFIXES = [
  'wf', // Weft: workflow state, checkpoints, generations, cleanup and terminal indexes
  'ev:', // Weft: event streams
  'durable-run:', // Weft: durable run cursors, steps, and transcripts
  'catalog-', // Weft: activity catalog entries and the active set
  'tag:', // Weft: tag index
  'weft:', // Weft: schema version
  'agent-session', // Operative: session bodies, summary index, and outbox
] as const;

/** A declared name, `const NAME = '…'`, whose name ends in a key word; bare `PREFIX` counts. */
const declaration =
  /\bconst\s+([A-Z0-9_]*(?:PREFIX|KEY|NAMESPACE))\b(?:\s*:[^=\n]+)?\s*=\s*'([^'\n]+)'/g;
/** A literal handed straight to a constructor, `keyPrefix: '…'`, as the command ledger takes it. */
const argument = /\b(keyPrefix|prefix|namespace)\s*:\s*'([^'\n]+)'/g;

function isStorageKey(name: string, value: string): boolean {
  return !NOT_STORAGE_KEYS.has(name) && !name.endsWith('METADATA_KEY') && !value.startsWith('/');
}

const sourceDirectory = import.meta.dir;

async function readSources(directory = sourceDirectory): Promise<Map<string, string>> {
  const sources = new Map<string, string>();
  for await (const path of new Glob('**/*.ts').scan({ cwd: directory })) {
    if (/\.test(-d)?\.ts$|\.test-support\.ts$|(^|\/)(test|testing)\//.test(path)) continue;
    const text = await Bun.file(`${directory}/${path}`).text();
    // A pattern in a doc comment or a line comment is documentation, not a key.
    sources.set(path, text.replace(/^\s*(\*|\/\/).*$/gm, ''));
  }
  return sources;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

const covers = (key: string) =>
  BUREAU_RESERVED_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));

const classifiedPrefixes = [...BUREAU_RESERVED_KEY_FAMILIES, ...SHARED_KEY_FAMILIES_OF_A_CHAT].map(
  (family) => family.prefix,
);

/**
 * Key constants the other packages declare that are not storage keys a chat's runs write, each
 * with why. Adding to this list is a reviewed edit; a key a chat does write is classified in
 * `SHARED_KEY_FAMILIES_OF_A_CHAT` instead.
 */
const NOT_CHAT_KEYS_OF_OTHER_PACKAGES = new Map<string, string>([
  ['GOAL_AUDIT_WORKFLOW_ID_PREFIX', 'a workflow id, not a storage key'],
  ['GOAL_WORKFLOW_ID_PREFIX', 'a workflow id, not a storage key'],
  [
    'PERSONA_PREFIX',
    'the identity provider’s persona store, which a host composes over a store of its own',
  ],
  ['HISTORY_PREFIX', 'the identity provider’s history, composed by a host over a store of its own'],
  [
    'USER_CONTEXT_KEY',
    'the identity provider’s user context, composed by a host over a store of its own',
  ],
]);

/** The packages whose keys a chat's runs write into the storage a Bureau shares with them. */
const OTHER_PACKAGES = ['operative', 'memory'] as const;

describe('BUREAU_RESERVED_KEY_PREFIXES', () => {
  it('lists every key constant and key-prefix argument declared in the source', async () => {
    const unlisted: string[] = [];
    let found = 0;
    for (const [path, text] of await readSources()) {
      for (const pattern of [declaration, argument]) {
        for (const [, name, value] of text.matchAll(pattern)) {
          if (name === undefined || value === undefined || !isStorageKey(name, value)) continue;
          found += 1;
          if (!covers(value)) unlisted.push(`${path}: ${name} = '${value}'`);
        }
      }
    }
    expect(found).toBeGreaterThan(40);
    expect(unlisted).toEqual([]);
  });

  it('lists only entries the source still declares', async () => {
    // The declaration itself spells every entry, so it is not the source that proves one is written.
    const sources = [...(await readSources())]
      .filter(([path]) => path !== 'reserved-key-prefixes.ts')
      .map(([, text]) => text);
    const stale = BUREAU_RESERVED_KEY_PREFIXES.filter(
      (prefix) =>
        !sources.some((text) => text.includes(`'${prefix}`) || text.includes(`\`${prefix}`)),
    );
    expect(stale).toEqual([]);
  });

  /**
   * COR-1934 — the guard beyond Bureau's own source. A key family another package writes, and a
   * prefix Weft reserves, that no classification covers is a family nobody asked what a chat
   * delete does to: the class test only sees the families its chats happen to write.
   */
  it('classifies every prefix Weft reserves', () => {
    const unclassified = WEFT_RESERVED_KEY_PREFIXES.filter(
      (reserved) => !classifiedPrefixes.some((prefix) => reserved.startsWith(prefix)),
    );
    expect(unclassified).toEqual([]);
  });

  it('classifies every key family that the packages Bureau runs on declare', async () => {
    const unclassified: string[] = [];
    let found = 0;
    for (const name of OTHER_PACKAGES) {
      const sources = await readSources(`${sourceDirectory}/../../${name}/src`);
      for (const [path, text] of sources) {
        for (const pattern of [declaration, argument]) {
          for (const [, constant, value] of text.matchAll(pattern)) {
            if (constant === undefined || value === undefined) continue;
            // A key family has a separator in it; a bare word is an identifier, not a family.
            if (!value.includes(':') || NOT_CHAT_KEYS_OF_OTHER_PACKAGES.has(constant)) continue;
            found += 1;
            if (!classifiedPrefixes.some((prefix) => value.startsWith(prefix))) {
              unclassified.push(`${name}/${path}: ${constant} = '${value}'`);
            }
          }
        }
      }
    }
    expect(found).toBeGreaterThan(8);
    expect(unclassified).toEqual([]);
  });

  it('has no duplicates', () => {
    expect(new Set(BUREAU_RESERVED_KEY_PREFIXES).size).toBe(BUREAU_RESERVED_KEY_PREFIXES.length);
  });

  /**
   * COR-1934 — every family says what a chat's delete does to it, and a family that is not purged
   * says why. The type refuses an entry without a classification; this is the check on the reason,
   * which the type cannot read.
   */
  it('classifies every family a chat delete reaches, with a reason for every family it does not purge', () => {
    const families = [...BUREAU_RESERVED_KEY_FAMILIES, ...SHARED_KEY_FAMILIES_OF_A_CHAT];
    const unexplained = families
      .filter((family) => family.onChatDelete !== 'purged' && family.reason.trim().length < 20)
      .map((family) => family.prefix);
    expect(unexplained).toEqual([]);
    const shared = SHARED_KEY_FAMILIES_OF_A_CHAT.map((family) => family.prefix);
    expect(new Set(shared).size).toBe(shared.length);
    expect(shared.filter((prefix) => BUREAU_RESERVED_KEY_PREFIXES.includes(prefix))).toEqual([]);
    // A shared family is one Weft reserves, or one of the few named above: a mistyped prefix
    // would otherwise sit in the list forever, classifying nothing.
    const unknown = shared.filter(
      (prefix) =>
        !SHARED_PREFIXES_OUTSIDE_WEFTS_LIST.has(prefix) &&
        !WEFT_RESERVED_KEY_PREFIXES.some(
          (weft) => prefix.startsWith(weft) || weft.startsWith(prefix),
        ),
    );
    expect(unknown).toEqual([]);
  });

  /**
   * The check no scan can make: every key a running Bureau actually writes. It covers what one
   * task, one settings change, and one session fork write to the Bureau's storage, which reaches
   * the audit trail, the task registry, the steering log, the command ledger, and the settings
   * record. It does not reach what needs a surface of its own (A2A and AG-UI over HTTP, children,
   * goals, workflows, schedules, interactive surfaces, skills, webhooks, managed assets, which
   * keep their own storage), so the source scan above is the guard for those.
   */
  it('covers every key a running Bureau writes, beyond the durable engine and session store', async () => {
    const storage = new MemoryStorage();
    const descriptors = createModelCatalog().descriptors.filter(
      (descriptor) => descriptor.provider === 'anthropic',
    );
    const bureau = await createBureau<AgentDefinitions>({
      agents: {
        agent: createAgent({
          generate: withBackendDescriptors(
            async () => ({ content: 'done', toolCalls: [] }),
            descriptors,
          ),
          stopWhen: stopWhen.noToolCalls(),
        }),
      },
      runtime: createManualRuntimeServices({ origin: '2026-10-23T00:00:00.000Z' }),
      storage,
      durable: true,
      durableOwnership: { ownership: 'none' },
    });
    cleanups.push(() => bureau.dispose());

    const owner = 'api-key:alice';
    const run = await bureau.tasks.start('agent', 'hello', { principal: owner });
    await run.result();
    const messageIds = async (): Promise<readonly string[]> => {
      const stored = await bureau.contexts.get(run.contextId);
      return stored?.conversationHistory.ids ?? [];
    };
    await waitForCondition(async () => {
      const ids = await messageIds();
      return ids.length >= 2;
    }, 'the run is stored');
    const storedIds = await messageIds();
    const throughMessageId = storedIds.at(-1)!;
    const applied = await bureau.settings.update(
      { 'tools.wakeup': false },
      { expectedRevision: 0, principal: owner },
    );
    expect(applied.outcome).toBe('applied');
    await bureau.contexts.fork(run.contextId, {
      owner,
      commandId: 'reserved-prefixes-fork',
      throughMessageId,
    });

    const unreserved: string[] = [];
    let bureauKeys = 0;
    for await (const [key] of storage.scan('')) {
      if (ENGINE_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
      bureauKeys += 1;
      if (!covers(key)) unreserved.push(key);
    }
    expect(bureauKeys).toBeGreaterThan(5);
    expect(unreserved).toEqual([]);
  });
});
