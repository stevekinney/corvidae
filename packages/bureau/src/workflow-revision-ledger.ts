/**
 * The saved versions of a workflow file and whether each can take over from the one before it
 * (COR-2009): what the workflow page's History tab lists and what the builder says before a save.
 *
 * Weft's own verdict (`bureau.workflows.revisions`) answers a different question: two documents
 * that differ in any way are incompatible to Weft, because a revision's identity follows its
 * content, and every instance stays on the revision it began on. A person asks instead whether a
 * run started on one version can carry on once the next is saved: a run waiting at a step whose
 * signal was renamed would never receive it, and one whose step was removed has nowhere to go,
 * while renaming a step or rewording an agent's message changes nothing a running instance relies
 * on. {@link compareWorkflowRevisions} answers that, change by change.
 *
 * ## Numbering
 *
 * Bureau numbers the versions of a workflow `1.0.0`, `1.1.0`, `1.2.0`, … in the order they were
 * saved. The number says which save it was, not how large the change was: the compatibility
 * verdict says that. A version is the file's content without `agent` and `paused`, so pausing,
 * resuming, or an agent taking over the file adds none, and neither does a hand edit that only
 * changes whitespace. A title or a step name does add one, although it leaves the Weft
 * `workflowVersion` as it was, because Bureau strips titles before Weft sees the document. The
 * history of an identifier spans a delete: a file created again under it continues the numbering.
 *
 * ## Keys
 *
 * `bureau-workflow-revision:v1:<identifier>:<ordinal>` holds a {@link WorkflowRevisionRecord}, the
 * ordinal zero-padded to six digits so the keys sort in the order they were saved. A plugin's
 * identifier holds a colon (`linear:sync`), so a read by prefix keeps only the keys whose
 * identifier, split before the last colon, is the one asked for. A record is written only when its
 * key is absent, so two Bureaus that observe the same save record it once.
 *
 * @module workflow-revision-ledger
 */

import { createHash } from 'node:crypto';

import {
  type ConditionalTextValueStore,
  MemoryStorage,
  type TextValueStore,
  textValueStore,
} from '@lostgradient/storage';

import type { TaskPersonSurface } from './task-origin';
import type { WorkflowFileContents, WorkflowFileStep, WorkflowFileTrigger } from './workflow-file';

/** Where the records of the revision ledger live. */
export const WORKFLOW_REVISION_KEY_PREFIX = 'bureau-workflow-revision:v1:';

/** The label of the version saved `ordinal`-th, from zero: `1.0.0`, `1.1.0`, `1.2.0`, … */
export function workflowRevisionLabel(ordinal: number): string {
  return `1.${String(ordinal)}.0`;
}

/** What a version holds: the file's content as written, without `agent` and `paused`. */
export interface WorkflowRevisionContent {
  /** The workflow's `title`, or `null`. */
  readonly title: string | null;
  /** The workflow's `description`, or `null`. */
  readonly description: string | null;
  /** The trigger as written. */
  readonly trigger: WorkflowFileTrigger;
  /** The steps as written, titles and `review` included. */
  readonly steps: readonly WorkflowFileStep[];
  /** The input schema, or `null`. */
  readonly inputSchema: Readonly<Record<string, unknown>> | null;
  /** The output schema, or `null`. */
  readonly outputSchema: Readonly<Record<string, unknown>> | null;
}

/** The content a usable file's version is made of. */
export function revisionContentOf(file: WorkflowFileContents): WorkflowRevisionContent {
  return {
    title: file.title,
    description: file.description,
    trigger: file.trigger,
    steps: file.steps,
    inputSchema: file.inputSchema,
    outputSchema: file.outputSchema,
  };
}

/**
 * One difference between a version and the one before it. `step` is the step's position, counted
 * from 1, in the version before for a removed step and in the new version otherwise; steps are
 * compared position by position. `breaking` is whether a run started on the version before could
 * not carry on under this one.
 */
export type WorkflowRevisionChange =
  | {
      readonly kind: 'title';
      readonly from: string | null;
      readonly to: string | null;
      readonly breaking: false;
    }
  | { readonly kind: 'description'; readonly breaking: false }
  | {
      readonly kind: 'trigger';
      readonly from: WorkflowFileTrigger;
      readonly to: WorkflowFileTrigger;
      readonly breaking: false;
    }
  | { readonly kind: 'input-schema'; readonly breaking: true }
  | { readonly kind: 'output-schema'; readonly breaking: true }
  | { readonly kind: 'step-added'; readonly step: number; readonly breaking: false }
  | { readonly kind: 'step-removed'; readonly step: number; readonly breaking: true }
  | { readonly kind: 'step-replaced'; readonly step: number; readonly breaking: true }
  | {
      readonly kind: 'step-renamed';
      readonly step: number;
      readonly from: string | null;
      readonly to: string | null;
      readonly breaking: false;
    }
  | { readonly kind: 'step-reworded'; readonly step: number; readonly breaking: false }
  | {
      readonly kind: 'step-agent';
      readonly step: number;
      readonly from: string;
      readonly to: string;
      readonly breaking: false;
    }
  | { readonly kind: 'step-input'; readonly step: number; readonly breaking: true }
  | {
      readonly kind: 'step-signal';
      readonly step: number;
      readonly from: string;
      readonly to: string;
      readonly breaking: true;
    }
  | {
      readonly kind: 'step-review';
      readonly step: number;
      readonly from: boolean;
      readonly to: boolean;
      readonly breaking: false;
    }
  | { readonly kind: 'step-duration'; readonly step: number; readonly breaking: false };

/** Whether a version can take over from the one before it. */
export type WorkflowRevisionCompatibility = 'compatible' | 'breaking';

/** JSON with every object's keys sorted, so two equal values always have the same text. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

/** The SHA-256 of a version's content, hex: equal for two files that hold the same version. */
export function revisionContentDigest(content: WorkflowRevisionContent): string {
  return createHash('sha256').update(canonicalJson(content)).digest('hex');
}

function titleOf(step: WorkflowFileStep): string | null {
  return typeof step['title'] === 'string' ? step['title'] : null;
}

function inputOf(step: WorkflowFileStep): Record<string, unknown> {
  const input = step['input'];
  return typeof input === 'object' && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

/** The changes between one step and the step at the same position in the next version. */
function compareStep(
  before: WorkflowFileStep,
  after: WorkflowFileStep,
  step: number,
): WorkflowRevisionChange[] {
  if (
    before['kind'] !== after['kind'] ||
    before['handler'] !== after['handler'] ||
    before['workflow'] !== after['workflow']
  ) {
    return [{ kind: 'step-replaced', step, breaking: true }];
  }
  const changes: WorkflowRevisionChange[] = [];
  if (titleOf(before) !== titleOf(after)) {
    changes.push({
      kind: 'step-renamed',
      step,
      from: titleOf(before),
      to: titleOf(after),
      breaking: false,
    });
  }
  switch (after['kind']) {
    case 'await-signal': {
      if (before['signal'] !== after['signal']) {
        changes.push({
          kind: 'step-signal',
          step,
          from: String(before['signal']),
          to: String(after['signal']),
          breaking: true,
        });
      }
      const reviewBefore = before['review'] === true;
      const reviewAfter = after['review'] === true;
      if (reviewBefore !== reviewAfter) {
        changes.push({
          kind: 'step-review',
          step,
          from: reviewBefore,
          to: reviewAfter,
          breaking: false,
        });
      }
      break;
    }
    case 'sleep': {
      if (!same(before['duration'], after['duration'])) {
        changes.push({ kind: 'step-duration', step, breaking: false });
      }
      break;
    }
    default: {
      const inputBefore = inputOf(before);
      const inputAfter = inputOf(after);
      if (after['handler'] !== 'agent') {
        if (!same(inputBefore, inputAfter))
          changes.push({ kind: 'step-input', step, breaking: true });
        break;
      }
      if (inputBefore['agent'] !== inputAfter['agent']) {
        changes.push({
          kind: 'step-agent',
          step,
          from: String(inputBefore['agent']),
          to: String(inputAfter['agent']),
          breaking: false,
        });
      }
      if (inputBefore['message'] !== inputAfter['message']) {
        changes.push({ kind: 'step-reworded', step, breaking: false });
      }
    }
  }
  return changes;
}

/**
 * Every change from `before` to `after`, in the order of the file: the title, the description, the
 * trigger, the schemas, then the steps by position. Renaming the workflow or a step, rewording or
 * re-assigning an agent step, waiting for a person or no longer doing so, a new duration, a new
 * trigger, and a step added at the end are compatible: a run in flight carries on. A step replaced
 * by one of another kind or handler, a step removed, a contributed activity given another input, a
 * signal wait given another signal, and either schema changed are breaking.
 */
export function compareWorkflowRevisions(
  before: WorkflowRevisionContent,
  after: WorkflowRevisionContent,
): WorkflowRevisionChange[] {
  const changes: WorkflowRevisionChange[] = [];
  if (before.title !== after.title) {
    changes.push({ kind: 'title', from: before.title, to: after.title, breaking: false });
  }
  if (before.description !== after.description) {
    changes.push({ kind: 'description', breaking: false });
  }
  if (!same(before.trigger, after.trigger)) {
    changes.push({ kind: 'trigger', from: before.trigger, to: after.trigger, breaking: false });
  }
  if (!same(before.inputSchema, after.inputSchema)) {
    changes.push({ kind: 'input-schema', breaking: true });
  }
  if (!same(before.outputSchema, after.outputSchema)) {
    changes.push({ kind: 'output-schema', breaking: true });
  }
  const shared = Math.min(before.steps.length, after.steps.length);
  for (let index = 0; index < shared; index += 1) {
    changes.push(...compareStep(before.steps[index]!, after.steps[index]!, index + 1));
  }
  for (let index = shared; index < after.steps.length; index += 1) {
    changes.push({ kind: 'step-added', step: index + 1, breaking: false });
  }
  for (let index = shared; index < before.steps.length; index += 1) {
    changes.push({ kind: 'step-removed', step: index + 1, breaking: true });
  }
  return changes;
}

/** The verdict of a list of changes: breaking when any change is. */
export function compatibilityOf(
  changes: readonly WorkflowRevisionChange[],
): WorkflowRevisionCompatibility {
  return changes.some((change) => change.breaking) ? 'breaking' : 'compatible';
}

/** How a version reached the ledger. */
export interface WorkflowRevisionAttribution {
  /** `write` for a save through Bureau (an operation or a tool), `file` for a file Bureau found changed. */
  readonly origin: 'write' | 'file';
  /** Who saved it, as the audit trail names them (`agent-run:<runId>`, a principal), when known. */
  readonly actor?: string | undefined;
  /** Where a person saved it from (`web`, `palette`, `api`), when they said. */
  readonly surface?: TaskPersonSurface | undefined;
}

/** One saved version of a workflow, as the ledger keeps it. */
export interface WorkflowRevisionRecord {
  /** The record's format. */
  readonly schemaVersion: 1;
  /** The workflow's identifier. */
  readonly id: string;
  /** Which save this is, from 0. */
  readonly ordinal: number;
  /** The version's label, {@link workflowRevisionLabel} of `ordinal`. */
  readonly version: string;
  /** When Bureau recorded the save. */
  readonly savedAt: string;
  /** The SHA-256 of the file's bytes when it was saved. */
  readonly hash: string;
  /** The Weft `workflowVersion` the file registered as, which titles leave unchanged. */
  readonly workflowVersion: string;
  /** {@link revisionContentDigest} of `content`. */
  readonly contentDigest: string;
  /** How the version reached the ledger. */
  readonly origin: 'write' | 'file';
  /** Who saved it, or `null`. */
  readonly actor: string | null;
  /** Where a person saved it from, or `null`. */
  readonly surface: TaskPersonSurface | null;
  /** What the version holds. */
  readonly content: WorkflowRevisionContent;
  /** The version before this one, or `null` for the first. */
  readonly previousVersion: string | null;
  /** Every change from the version before; empty for the first. */
  readonly changes: readonly WorkflowRevisionChange[];
  /** Whether this version can take over from the one before it; `null` for the first. */
  readonly compatibility: WorkflowRevisionCompatibility | null;
}

/** What a usable file is, for {@link WorkflowRevisionLedger.observe}. */
export interface ObservedWorkflowFile extends WorkflowFileContents {
  /** The workflow's identifier. */
  readonly id: string;
  /** The SHA-256 of the file's bytes. */
  readonly hash: string;
  /** The Weft `workflowVersion` of its document. */
  readonly version: string;
}

/** What saving a definition would make: {@link planWorkflowRevision}'s answer. */
export interface WorkflowRevisionPlan {
  /** The version saving makes, or `null` when it would change nothing that makes a version. */
  readonly version: string | null;
  /** The version it replaces, or `null` when there is none. */
  readonly previousVersion: string | null;
  /** Every change from the version it replaces. */
  readonly changes: readonly WorkflowRevisionChange[];
  /** Whether it can take over from the version it replaces; `null` with no version or no change. */
  readonly compatibility: WorkflowRevisionCompatibility | null;
}

/** What saving `content` after `latest` would record, without recording it. */
export function planWorkflowRevision(
  latest: WorkflowRevisionRecord | undefined,
  content: WorkflowRevisionContent,
): WorkflowRevisionPlan {
  if (latest === undefined) {
    return {
      version: workflowRevisionLabel(0),
      previousVersion: null,
      changes: [],
      compatibility: null,
    };
  }
  if (latest.contentDigest === revisionContentDigest(content)) {
    return { version: null, previousVersion: latest.version, changes: [], compatibility: null };
  }
  const changes = compareWorkflowRevisions(latest.content, content);
  return {
    version: workflowRevisionLabel(latest.ordinal + 1),
    previousVersion: latest.version,
    changes,
    compatibility: compatibilityOf(changes),
  };
}

/** The saved versions of every workflow. */
export interface WorkflowRevisionLedger {
  /**
   * Record `file` as a new version of its workflow when its content differs from the newest one
   * recorded, attributed to `attribution`, and resolve the newest record either way.
   */
  readonly observe: (
    file: ObservedWorkflowFile,
    attribution: WorkflowRevisionAttribution,
  ) => Promise<WorkflowRevisionRecord>;
  /** The recorded versions of `id`, oldest first. A record that cannot be read is skipped. */
  readonly list: (id: string) => Promise<readonly WorkflowRevisionRecord[]>;
  /** The newest recorded version of `id`, or `undefined` when there is none. */
  readonly latest: (id: string) => Promise<WorkflowRevisionRecord | undefined>;
  /** Write `record` under its key, replacing what is there: for a seed that writes history. */
  readonly put: (record: WorkflowRevisionRecord) => Promise<void>;
}

/** What {@link createWorkflowRevisionLedger} keeps its records in. */
export interface WorkflowRevisionLedgerOptions {
  /** Where the records live. Omit for a ledger that lasts as long as the process. */
  readonly store?: TextValueStore | undefined;
  /** The time a save is recorded at. */
  readonly nowISO: () => string;
}

/** The key of the `ordinal`-th version of `id`. */
export function workflowRevisionKey(id: string, ordinal: number): string {
  return `${WORKFLOW_REVISION_KEY_PREFIX}${id}:${String(ordinal).padStart(6, '0')}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `text` as a record for `id`, or `undefined` when it is not one. */
function parseRecord(text: string | null, id: string): WorkflowRevisionRecord | undefined {
  if (text === null) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (
    !isRecord(value) ||
    value['schemaVersion'] !== 1 ||
    value['id'] !== id ||
    typeof value['ordinal'] !== 'number' ||
    typeof value['savedAt'] !== 'string' ||
    typeof value['contentDigest'] !== 'string' ||
    !isRecord(value['content']) ||
    !Array.isArray(value['changes'])
  ) {
    return undefined;
  }
  return value as unknown as WorkflowRevisionRecord;
}

function isConditional(store: TextValueStore): store is ConditionalTextValueStore {
  return typeof (store as Partial<ConditionalTextValueStore>).conditionalBatch === 'function';
}

/** The ledger kept in `store`. */
export function createWorkflowRevisionLedger(
  options: WorkflowRevisionLedgerOptions,
): WorkflowRevisionLedger {
  const store = options.store ?? textValueStore(new MemoryStorage());
  /** The newest record of each workflow this process has read or written. */
  const newest = new Map<string, WorkflowRevisionRecord>();

  async function list(id: string): Promise<WorkflowRevisionRecord[]> {
    const records: WorkflowRevisionRecord[] = [];
    for (const key of await store.list(`${WORKFLOW_REVISION_KEY_PREFIX}${id}:`)) {
      const rest = key.slice(WORKFLOW_REVISION_KEY_PREFIX.length);
      // A plugin's identifier holds a colon, so another workflow's keys can share the prefix.
      if (rest.slice(0, rest.lastIndexOf(':')) !== id) continue;
      const record = parseRecord(await store.get(key), id);
      if (record !== undefined) records.push(record);
    }
    records.sort((left, right) => left.ordinal - right.ordinal);
    const last = records.at(-1);
    if (last !== undefined) newest.set(id, last);
    return records;
  }

  async function latest(id: string): Promise<WorkflowRevisionRecord | undefined> {
    const records = await list(id);
    return records.at(-1);
  }

  /** Write `record` when its key is absent; `false` when another writer got there first. */
  async function writeNew(record: WorkflowRevisionRecord): Promise<boolean> {
    const key = workflowRevisionKey(record.id, record.ordinal);
    const text = JSON.stringify(record);
    if (isConditional(store)) {
      return store.conditionalBatch(
        [{ key, expectedValue: null }],
        [{ type: 'set', key, value: text }],
      );
    }
    if (await store.has(key)) return false;
    await store.set(key, text);
    return true;
  }

  return {
    async observe(file, attribution) {
      const content = revisionContentOf(file);
      const digest = revisionContentDigest(content);
      const known = newest.get(file.id);
      if (known?.contentDigest === digest) return known;
      // Two attempts: a lost race means another Bureau recorded a version first, so plan again.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const previous = await latest(file.id);
        if (previous?.contentDigest === digest) return previous;
        const plan = planWorkflowRevision(previous, content);
        const ordinal = previous === undefined ? 0 : previous.ordinal + 1;
        const record: WorkflowRevisionRecord = {
          schemaVersion: 1,
          id: file.id,
          ordinal,
          version: workflowRevisionLabel(ordinal),
          savedAt: options.nowISO(),
          hash: file.hash,
          workflowVersion: file.version,
          contentDigest: digest,
          origin: attribution.origin,
          actor: attribution.actor ?? null,
          surface: attribution.surface ?? null,
          content,
          previousVersion: plan.previousVersion,
          changes: plan.changes,
          compatibility: plan.compatibility,
        };
        if (await writeNew(record)) {
          newest.set(file.id, record);
          return record;
        }
      }
      // Both attempts lost to other writers: what they recorded is the history now.
      const recorded = await latest(file.id);
      if (recorded === undefined) throw new Error(`No version of "${file.id}" could be recorded.`);
      return recorded;
    },
    list,
    latest,
    async put(record) {
      await store.set(workflowRevisionKey(record.id, record.ordinal), JSON.stringify(record));
      newest.delete(record.id);
    },
  };
}
