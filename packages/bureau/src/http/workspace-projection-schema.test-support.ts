import { z } from 'zod';
import { BUREAU_HANDLER_OPERATIONS } from './create-bureau-handler.ts';
import {
  WORKSPACE_CONFORMANCE_GROUPS,
  WORKSPACE_MOUNT_CONFORMANCE,
} from './workspace-conformance.test-support.ts';

type Schema = Record<string, unknown>;

/** Enumerate declared fields and open values in every live output and event serializer. */
export function workspaceProjectionFields(): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const operation of BUREAU_HANDLER_OPERATIONS) {
    for (const producer of ['output', 'event'] as const) {
      const schema = producer === 'output' ? operation.outputSchema : operation.eventSchema;
      if (schema === undefined) continue;
      const root = z.toJSONSchema(schema) as Schema;
      const fields = new Set<string>();
      const visit = (node: unknown, path: string, references: ReadonlySet<string>): void => {
        if (typeof node !== 'object' || node === null || Array.isArray(node)) return;
        const value = node as Schema;
        const reference = value['$ref'];
        if (typeof reference === 'string') {
          fields.add(`${path} -> ${reference}`);
          if (reference.startsWith('#/') && !references.has(reference)) {
            let target: unknown = root;
            for (const part of reference.slice(2).split('/')) {
              const key = part.replaceAll('~1', '/').replaceAll('~0', '~');
              target =
                typeof target === 'object' && target !== null
                  ? Reflect.get(target, key)
                  : undefined;
            }
            visit(target, path, new Set([...references, reference]));
          }
        }
        const properties = value['properties'];
        if (typeof properties === 'object' && properties !== null && !Array.isArray(properties)) {
          for (const [key, child] of Object.entries(properties)) {
            const childPath = `${path}.${key}`;
            fields.add(childPath);
            visit(child, childPath, references);
          }
        }
        if (
          value['additionalProperties'] !== undefined &&
          value['additionalProperties'] !== false
        ) {
          fields.add(`${path}.*`);
          visit(value['additionalProperties'], `${path}.*`, references);
        }
        if (Object.keys(value).length === 0) fields.add(`${path}.*`);
        if (value['items'] !== undefined) visit(value['items'], `${path}[]`, references);
        for (const keyword of ['anyOf', 'oneOf', 'allOf'] as const) {
          const choices = value[keyword];
          if (Array.isArray(choices))
            choices.forEach((choice, index) =>
              visit(choice, `${path}|${keyword}[${index}]`, references),
            );
        }
      };
      visit(root, '$', new Set());
      result[`${producer}:${operation.name}`] = [...fields].toSorted();
    }
  }
  return Object.fromEntries(
    Object.entries(result).toSorted(([left], [right]) => left.localeCompare(right)),
  );
}

/** Metadata producers whose response is checked beside an owner-readable private resource. */
const CROSS_PRODUCER_NAMES: ReadonlySet<string> = new Set([
  'bureau.deployment.get',
  'bureau.events.catalog',
  'bureau.events.format',
  'bureau.plugins.contributions',
  'bureau.guardrails.list',
  'bureau.skills.list',
  'bureau.health.attention',
  'bureau.settings.get',
  'bureau.settings.schema',
  'bureau.settings.update',
  'bureau.schedules.list',
  'bureau.schedules.get',
  'bureau.schedules.create',
  'bureau.schedules.pause',
  'bureau.schedules.resume',
  'bureau.schedules.cancel',
  'bureau.schedules.update',
  'bureau.schedules.skipnext',
  'bureau.schedules.unskip',
  'bureau.hooks.create',
  'bureau.hooks.update',
  'bureau.hooks.delete',
  'bureau.hooks.get',
  'bureau.hooks.list',
  'bureau.hooks.test',
  'bureau.workflows.get',
  'bureau.workflows.create',
  'bureau.workflows.update',
  'bureau.workflows.validate',
  'bureau.workflows.pause',
  'bureau.workflows.resume',
  'bureau.workflows.delete',
  'bureau.workflows.list',
  'bureau.workflows.revisions',
  'bureau.workflows.history',
  'bureau.workflows.impact',
  'bureau.workflows.start',
  'bureau.agents.catalog',
  'bureau.agents.list',
  'bureau.agents.models',
  'bureau.agents.references',
  'bureau.agents.try',
  'bureau.agents.definitions.create',
  'bureau.agents.definitions.update',
  'bureau.agents.definitions.delete',
  'bureau.agents.definitions.get',
  'bureau.agents.definitions.list',
  'bureau.agents.definitions.revisions',
  'bureau.agents.versions.list',
  'bureau.agents.versions.restore',
  'bureau.agents.overrides.get',
  'bureau.agents.overrides.update',
]);

/** These producers themselves return the seeded private value to the owner. */
const OWNER_POSITIVE_NAMES: ReadonlySet<string> = new Set([
  'bureau.contexts.get',
  'bureau.contexts.list',
  'bureau.contexts.rename',
  'bureau.reviews.get',
  'bureau.reviews.list',
  'bureau.notifications.list',
  'bureau.workflows.runs.get',
  'bureau.memory.list',
  'bureau.memory.search',
  'bureau.memory.get',
  'bureau.memory.remember',
  'bureau.memory.correct',
  'bureau.memory.export',
]);

/** Per-producer evidence; unclassified rows deliberately fail the inventory test. */
type ProjectionEvidence =
  | { mode: 'cross-producer'; ownerProducer: string }
  | { mode: 'owner-positive'; ledgerBound: boolean }
  | { mode: 'denied'; reason: string }
  | { mode: 'schema-safe'; reason: string }
  | { mode: 'unclassified' };

const SCHEMA_SAFE_OUTPUTS: Readonly<Record<string, string>> = {
  'weft.system.principal':
    'The principal output contains only the authenticated caller identity and scopes (principal operation output schema).',
  'bureau.contexts.input':
    'The input response contains an admission outcome and receipt identifiers, revision, time and delivery state; it omits the input payload (contexts operation output schema).',
  'bureau.contexts.retract':
    'The retract response contains an outcome and admission receipt, not the queued input payload (contexts operation output schema).',
  'bureau.contexts.window':
    'The context window response contains category names and token counts, not transcript or input text (contexts operation output schema).',
  'bureau.contexts.delete':
    'The delete receipt contains context and task identifiers, cleanup states, and the fixed shutting-down reason, not session content (contextsDeleteOutput).',
  'bureau.contexts.forgetgrants':
    'The response lists forgotten tool names, not prompts, arguments, or tool results (contextsForgetGrants output schema).',
  'bureau.contexts.steer':
    'The response is an effort or permission command receipt and its policy outcome; it carries no transcript, prompt, or tool input (contexts-steer-operation output schema).',
  'bureau.contexts.fork':
    'The response is the new context identifier and carried effort and permission command outcomes; it does not carry the forked conversation (contexts-fork-operation output schema).',
  'bureau.contexts.regenerate':
    'The response is the context and message identifiers and the committed revision; it does not carry the regenerated answer or any other row (contexts-regenerate-operation output schema).',
  'bureau.contexts.archive':
    'The archive receipt contains the context identifier, a changed flag and the archive time, not the title, preview or any message (contextArchiveReceiptSchema).',
  'bureau.contexts.unarchive':
    'The unarchive receipt contains the context identifier, a changed flag and a null archive time, not the title, preview or any message (contextArchiveReceiptSchema).',
  'bureau.notifications.markread':
    'The notification update output is only the count of records updated (notifications operation output schema).',
  'bureau.notifications.dismiss':
    'The notification dismissal output is only the count of records updated (notifications operation output schema).',
  'bureau.memory.share':
    'The share receipt contains the memory identifier, grantee and grantor identifiers, and change flag, not memory content (memory share output schema).',
  'bureau.memory.share.revoke':
    'The revoke receipt contains the memory identifier, grantee and grantor identifiers, and change flag, not memory content (memory share revoke output schema).',
  'bureau.memory.hold':
    'The legal-hold receipt contains the memory identifier, changed flag, and hold status, not memory content (holdOutput).',
  'bureau.memory.hold.release':
    'The hold-release receipt contains the memory identifier, changed flag, and hold status, not memory content (holdOutput).',
  'bureau.memory.quarantine':
    'The quarantine receipt contains the memory identifier and affected and changed counts, not memory content (quarantineOutput).',
  'bureau.assets.uploads.abort':
    'The abort receipt contains only the upload identity and whether an upload was aborted (upload abort output schema).',
  'bureau.workflows.signal':
    'The signal receipt contains started run identifiers and delivered or rejected counts, not the signal payload (workflow signal output schema).',
  'bureau.goals.cancel':
    'The cancellation receipt contains the goal identifier, outcome, status and revision; it does not return the cancellation reason (goals cancel output schema).',
  'bureau.goals.update':
    'The update receipt contains the goal identifier, outcome, status and revision; it does not return the prompt, agent or validator it wrote (goals update output schema).',
  'bureau.workflows.runs.list':
    'runSummarySchema returns run identity, workflow, status, time and origin; trigger, input, result and error belong only to runDetailSchema.',
  'bureau.schedules.runnow':
    'runNowOutput contains a started or queued task identifier, or a skipped outcome and blocking identifier; it does not return schedule input.',
  'bureau.schedules.missed':
    'missedOutput contains schedule and owner identifiers, occurrence and record times, count, and the fixed late or dst-gap reason; it does not return input.',
  'bureau.assets.uploads.complete':
    'Uploads supply only bytes and an optional media type; assetView returns metadata and stable rejection information, never the uploaded bytes (createInput and assetView).',
  'bureau.workflows.runs.cancel':
    'The workflow cancellation output is a run identifier and cancellation status, not workflow input or result (workflowsRunsCancelOperation).',
  'bureau.workflows.runs.history':
    'historyRuns projects bounded event type, time, step and summary and never returns raw event data (workflow-runtime historyEventOf).',
  'bureau.settings.events':
    'The subscription response is a subscription identifier; its separately inventoried event carries the change (settings event output schema).',
  'bureau.tasks.events':
    'The subscription response carries only its identifier and cursor; its separately inventoried event carries the private artifact (task event output schema).',
  'operative.runs.events':
    'The subscription response carries only its identifier and cursor; its separately inventoried event carries the private error (run event output schema).',
  'bureau.agents.definitions.duplicate':
    'The duplicate response contains the shared definition identifier and hash and the names of what the copy loses, not invocation state (agent definitions duplicate output schema).',
};

export const WORKSPACE_PROJECTION_CONFORMANCE = (() => {
  const rows: Record<
    string,
    { testFile: string; fixture: string; sentinel: string; evidence: ProjectionEvidence }
  > = {};
  for (const group of WORKSPACE_CONFORMANCE_GROUPS) {
    for (const [operation, outcome] of group.operations) {
      const key = `output:${operation}`;
      if (rows[key] !== undefined) throw new Error(`Duplicate projection ${key}`);
      const reason = SCHEMA_SAFE_OUTPUTS[operation];
      const evidence: ProjectionEvidence = CROSS_PRODUCER_NAMES.has(operation)
        ? {
            mode: 'cross-producer',
            ownerProducer: operation.startsWith('bureau.workflows.')
              ? 'bureau.workflows.runs.get'
              : 'bureau.contexts.get',
          }
        : OWNER_POSITIVE_NAMES.has(operation)
          ? { mode: 'owner-positive', ledgerBound: true }
          : outcome === 'deployment'
            ? {
                mode: 'denied',
                reason:
                  'Workspace authorization refuses deployment operations before invoking the serializer (authorizeWorkspaceClass).',
              }
            : reason !== undefined
              ? { mode: 'schema-safe', reason }
              : [
                    'bureau.tasks.get',
                    'bureau.tasks.list',
                    'bureau.tasks.cancel',
                    'bureau.tasks.inspect',
                    'bureau.tasks.respond',
                    'bureau.reviews.resolve',
                    'bureau.audit.query',
                    'bureau.assets.get',
                    'bureau.assets.uploads.create',
                    'bureau.assets.uploads.append',
                    'bureau.goals.get',
                    'bureau.goals.list',
                    'bureau.goals.create',
                    'bureau.memory.forget',
                  ].includes(operation)
                ? { mode: 'owner-positive', ledgerBound: false }
                : { mode: 'unclassified' };
      const taskError = [
        'bureau.tasks.get',
        'bureau.tasks.list',
        'bureau.tasks.cancel',
        'bureau.tasks.inspect',
      ].includes(operation);
      const goalReason = ['bureau.goals.get', 'bureau.goals.list', 'bureau.goals.create'].includes(
        operation,
      );
      const approvalFeedback =
        operation === 'bureau.tasks.respond' || operation === 'bureau.reviews.resolve';
      const uploadMedia =
        operation === 'bureau.assets.uploads.create' ||
        operation === 'bureau.assets.uploads.append';
      rows[key] = uploadMedia
        ? {
            testFile: group.testFile,
            fixture: 'An upload echoes its caller-provided media type to its owner',
            sentinel: 'application/x-private-media-92f4',
            evidence,
          }
        : approvalFeedback
          ? {
              testFile: group.testFile,
              fixture: 'A rejected tool approval returns its owner-private feedback',
              sentinel: 'PRIVATE-APPROVAL-FEEDBACK-31ac',
              evidence,
            }
          : goalReason
            ? {
                testFile: group.testFile,
                fixture: 'A canceled goal contains an owner-private reason',
                sentinel: 'PRIVATE-GOAL-CANCELLATION-4f2a',
                evidence,
              }
            : taskError
              ? {
                  testFile:
                    operation === 'bureau.tasks.get' || operation === 'bureau.tasks.list'
                      ? 'workspace-privacy.test.ts'
                      : 'workspace-task-privacy.test.ts',
                  fixture: 'A failed task contains a private status message',
                  sentinel: 'PRIVATE-TASK-ERROR-a02f',
                  evidence,
                }
              : {
                  testFile: group.testFile,
                  fixture: group.inputFixture,
                  sentinel: group.sentinel,
                  evidence,
                };
    }
  }
  for (const mount of Object.values(WORKSPACE_MOUNT_CONFORMANCE)) {
    rows[`mount:${mount.key}`] = {
      testFile: mount.testFile,
      fixture: mount.inputFixture,
      sentinel: mount.sentinel,
      evidence:
        mount.key === '/fixture-plugin'
          ? {
              mode: 'schema-safe',
              reason:
                'The contributed fixture returns only its fixed administrator configuration marker; authorization is exercised for all six actors.',
            }
          : { mode: 'owner-positive', ledgerBound: false },
    };
  }
  Object.assign(rows, {
    'event:bureau.events': {
      testFile: 'workspace-deployment-privacy.test.ts',
      fixture: 'Deployment-only event feed',
      sentinel: '',
      evidence: {
        mode: 'denied',
        reason: 'Workspace authorization rejects this deployment event feed before subscription.',
      },
    },
    'event:bureau.settings.events': {
      testFile: 'workspace-settings-privacy.test.ts',
      fixture: 'Administrator receives a real settings change beside a private task',
      sentinel: 'PRIVATE-SETTINGS-NEIGHBOR-a81c',
      evidence: { mode: 'cross-producer', ownerProducer: 'bureau.contexts.get' },
    },
    'event:bureau.tasks.events': {
      testFile: 'workspace-task-privacy.test.ts',
      fixture: 'Completed owned task returns a private answer artifact',
      sentinel: 'PRIVATE-TASK-ANSWER-e5b2',
      evidence: { mode: 'owner-positive', ledgerBound: false },
    },
    'event:operative.runs.events': {
      testFile: 'workspace-task-privacy.test.ts',
      fixture: 'Owned run failure projects the seeded error message',
      sentinel: 'PRIVATE-TASK-ANSWER-e5b2',
      evidence: { mode: 'owner-positive', ledgerBound: false },
    },
  });
  return rows;
})();

export const WORKSPACE_CROSS_PRODUCERS: ReadonlySet<string> = new Set(
  Object.entries(WORKSPACE_PROJECTION_CONFORMANCE)
    .filter(([key, row]) => key.startsWith('output:') && row.evidence.mode === 'cross-producer')
    .map(([key]) => key.slice('output:'.length)),
);
export const WORKSPACE_OWNER_POSITIVE_PRODUCERS: ReadonlySet<string> = new Set(
  Object.entries(WORKSPACE_PROJECTION_CONFORMANCE)
    .filter(
      ([key, row]) =>
        key.startsWith('output:') &&
        row.evidence.mode === 'owner-positive' &&
        row.evidence.ledgerBound,
    )
    .map(([key]) => key.slice('output:'.length)),
);
