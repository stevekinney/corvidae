/**
 * What the settings tests share: the schema the Bureau publishes (built as
 * `bureau.settings.schema()` builds it), a snapshot with a value for every key, and a Bureau stub
 * that serves them and applies an update the way the real one does: all or none, against the
 * revision the caller read.
 */
import { SETTING_APPLY, SETTING_KEYS, settingsSchema } from '@lostgradient/bureau';
import { z } from 'zod';

import type { SchemaNode, SettingKeyState } from '../../lib/bureau-settings.ts';
import {
  installBureauStub,
  StubFault,
  type BureauStub,
  type StubSubscriptionRequest,
} from '../../lib/bureau-stub.test-support.ts';

/** The JSON Schema the Bureau publishes. */
export const PUBLISHED_SCHEMA = z.toJSONSchema(settingsSchema, { io: 'input' }) as {
  properties: Record<string, SchemaNode>;
};

/** A value for every key, as a Bureau that has all of them set would report. */
export const SETTING_VALUES: Record<string, unknown> = {
  'tools.humanInput': {},
  'tools.wakeup': true,
  'tools.decide': true,
  modelPolicy: { policyRevision: 0 },
  'decisions.fallbackModel': 'anthropic/claude-haiku-5-5',
  'decisions.maximumPerTask': 20,
  'retention.audit': 'forever',
  'retention.events': { olderThan: 86_400_000 },
  'retention.tasks': 'forever',
  'retention.receipts': { olderThan: 604_800_000 },
  'retention.checkpoints': { keepLast: 5 },
  'sessionInput.sessionBacklogLimit': 100,
  'sessionInput.principalBacklogLimit': 500,
  'children.delegation.defaultTimeToLiveMilliseconds': 600_000,
  'engine.retention': { completed: 604_800_000 },
  'engine.retentionSweepInterval': 3_600_000,
  'engine.retentionSweepBatchSize': 100,
  'engine.history': { maxEvents: 10_000 },
  'engine.payloadSize': { maxBytes: null },
  'engine.checkpointSizeWarningThreshold': 1_048_576,
  'engine.schedulerPollIntervalMs': 1_000,
  'engine.checkpointHistory': 5,
  'engine.maxNestingDepth': 8,
  'engine.workflowClaimTtl': 30_000,
  'engine.workflowClaimRenewInterval': 10_000,
  durable: true,
  maintenance: 'automatic',
  'durableOwnership.ownership': 'none',
  workflowVersion: 'v1',
  'a2a.push.enabled': false,
  'a2a.push.sweepIntervalMs': 3_600_000,
};

/** What the Bureau holds: the values, the revision, and the keys the deployment locked. */
export type SettingsServed = {
  values: Record<string, unknown>;
  revision: number;
  persisted: boolean;
  locked: Set<string>;
  /** Why a locked key is locked, by key. A locked key with no entry is held for `deployment`. */
  lockReasons: Record<string, 'deployment' | 'shared-storage'>;
};

export function servedSettings(overrides: Partial<SettingsServed> = {}): SettingsServed {
  return {
    values: { ...SETTING_VALUES },
    revision: 3,
    persisted: true,
    locked: new Set(),
    lockReasons: {},
    ...overrides,
  };
}

function keyStates(served: SettingsServed): Record<string, SettingKeyState> {
  return Object.fromEntries(
    SETTING_KEYS.map((key): [string, SettingKeyState] => [
      key,
      {
        apply: SETTING_APPLY[key],
        locked: served.locked.has(key),
        ...(served.locked.has(key)
          ? { lockReason: served.lockReasons[key] ?? ('deployment' as const) }
          : {}),
        pendingRestart: false,
      },
    ]),
  );
}

/** What `bureau.settings.get` answers for `served`, as of now. */
export function settingsSnapshot(served: SettingsServed) {
  return {
    values: served.values,
    revision: served.revision,
    persisted: served.persisted,
    keys: keyStates(served),
  };
}

/**
 * Serves `bureau.settings.get`, `.schema`, and `.update` from `served`. An update names a stale
 * revision as `StaleRevision`, a locked key as `Unprocessable`, and applies every key of a patch or
 * none, as the Bureau does. `extra` answers the other operations a test needs.
 */
export function installSettingsBureau(
  served: SettingsServed,
  extra: Record<string, (params: Record<string, unknown>) => unknown> = {},
  stream?: SettingsStream,
  hostMode?: 'local' | 'remote',
): BureauStub {
  return installBureauStub(
    {
      'bureau.settings.get': () => settingsSnapshot(served),
      'bureau.settings.schema': () => ({ schema: PUBLISHED_SCHEMA }),
      'bureau.settings.update': (params) => {
        const patch = params['patch'] as Record<string, unknown>;
        if (params['expectedRevision'] !== served.revision) {
          throw new StubFault('StaleRevision', 409, 'The settings changed since they were read.', {
            expectedRevision: params['expectedRevision'],
            currentRevision: served.revision,
          });
        }
        const locked = Object.keys(patch).filter((key) => served.locked.has(key));
        if (locked.length > 0) {
          throw new StubFault('Unprocessable', 422, `Locked: ${locked.join(', ')}.`, {
            reason: 'locked',
          });
        }
        served.values = { ...served.values, ...patch };
        served.revision += 1;
        const pendingRestart = Object.keys(patch).filter(
          (key) => SETTING_APPLY[key as never] === 'restart',
        );
        return { revision: served.revision, pendingRestart };
      },
      ...extra,
    },
    {
      ...(stream === undefined
        ? {}
        : { subscriptions: { 'bureau.settings.events': stream.handler } }),
      ...(hostMode === undefined ? {} : { hostMode }),
    },
  );
}

/**
 * A `bureau.settings.events` stream a test drives: `push` sends one change, `end` ends the
 * connection as the Bureau does at its time limit, and `opened` lists the `Last-Event-ID` each
 * connection named (`undefined` for the first).
 */
export type SettingsStream = {
  readonly handler: (request: StubSubscriptionRequest) => Response;
  readonly opened: Array<string | undefined>;
  push(revision: number, keys?: readonly string[]): void;
  end(): void;
  /** Whether the page has taken in every change pushed so far (it has read them off the connection). */
  drained(): boolean;
};

/** A stream with no change yet. Each connection gets its own body; `push` and `end` act on the latest. */
export function settingsStream(): SettingsStream {
  const encoder = new TextEncoder();
  const opened: Array<string | undefined> = [];
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  return {
    opened,
    handler: ({ lastEventId, signal }) => {
      opened.push(lastEventId);
      const body = new ReadableStream<Uint8Array>({
        start: (streamController) => {
          controller = streamController;
          signal?.addEventListener('abort', () => {
            try {
              streamController.close();
            } catch {
              // Already closed by `end`.
            }
          });
        },
      });
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    },
    push: (revision, keys = []) => {
      const event = {
        kind: 'settings.changed',
        cursor: String(revision),
        emittedAtMs: 0,
        revision,
        keys,
      };
      controller?.enqueue(
        encoder.encode(
          `id: ${event.cursor}\nevent: settings.changed\ndata: ${JSON.stringify(event)}\n\n`,
        ),
      );
    },
    end: () => {
      controller?.close();
    },
    drained: () => controller === undefined || (controller.desiredSize ?? 1) > 0,
  };
}
