import { expect } from 'bun:test';

import { ManualClock } from './fixtures/manual-clock.ts';
import {
  createScriptedBackend,
  type ScriptedBackend,
  type ScriptedBackendOptions,
} from './fixtures/scripted-backend.ts';
import { createScriptedStream, type ScriptedStream } from './fixtures/scripted-sources.ts';
import type {
  AttachmentGrant,
  AttachmentListener,
  AttachResult,
  OutputSource,
  SessionAttachment,
  SessionBudgets,
  SessionEvent,
} from './session-types.ts';
import { Session } from './session.ts';

export const SESSION_ID = '0b6f0c3e-8a1d-4c55-9a64-2f6e9b7d1c10';

/** Let every pending promise continuation run. Time itself only moves with `ManualClock.advance`. */
export function flush(): Promise<void> {
  return Bun.sleep(0);
}

export function utf8(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text);
}

/** Collects every event an attachment is told, in order. */
export class Recorder {
  readonly events: SessionEvent[];
  readonly listener: AttachmentListener;

  constructor() {
    this.events = [];
    this.listener = (event) => {
      this.events.push(event);
    };
  }

  ofType<Type extends SessionEvent['type']>(type: Type): Extract<SessionEvent, { type: Type }>[] {
    return this.events.filter(
      (event): event is Extract<SessionEvent, { type: Type }> => event.type === type,
    );
  }

  get types(): string[] {
    return this.events.map((event) => event.type);
  }
}

export type Harness = {
  readonly clock: ManualClock;
  readonly session: Session;
  readonly recorder: Recorder;
  readonly backend: ScriptedBackend | undefined;
  readonly stream: ScriptedStream;
};

export type HarnessOptions = {
  readonly sessionId?: string;
  readonly backend?: ScriptedBackendOptions | false;
  readonly sources?: readonly OutputSource[];
  readonly budgets?: Partial<SessionBudgets>;
  readonly clock?: ManualClock;
  readonly issueGeneration?: () => number;
};

/** A session over a scripted PTY backend and one scripted stream, unless the options say otherwise. */
export function createHarness(options: HarnessOptions = {}): Harness {
  const clock = options.clock ?? new ManualClock();
  // The default source rides the channel the backend's mode carries: a pty, a pipe's stdout, or an output-only stdout.
  const stream = createScriptedStream(
    options.backend === false || options.backend?.mode === 'pipe' ? 'stdout' : 'pty',
  );
  const backend = options.backend === false ? undefined : createScriptedBackend(options.backend);
  const session = new Session({
    sessionId: options.sessionId ?? SESSION_ID,
    profile: { profileId: 'shell' },
    dimensions: { columns: 80, rows: 24 },
    clock,
    sources: options.sources ?? [stream.source],
    ...(backend === undefined ? {} : { backend }),
    ...(options.budgets === undefined ? {} : { budgets: options.budgets }),
    ...(options.issueGeneration === undefined ? {} : { issueGeneration: options.issueGeneration }),
  });
  return { clock, session, recorder: new Recorder(), backend, stream };
}

export function expectAttached(result: AttachResult): SessionAttachment {
  if (!result.accepted) throw new Error(`attachment refused: ${result.reason}`);
  return result.attachment;
}

/** Start the session, take the attachment, and flush so the process is running and sources are reading. */
export async function startAndAttach(
  harness: Harness,
  grant: AttachmentGrant = 'interactive',
  requestedMode: 'read-only' | 'interactive' = 'interactive',
): Promise<SessionAttachment> {
  const attachment = expectAttached(
    harness.session.attach({ requestedMode, grant, listener: harness.recorder.listener }),
  );
  void harness.session.start();
  await flush();
  return attachment;
}

export function expectNoOutputAfterClosed(events: readonly SessionEvent[]): void {
  const closedAt = events.findIndex((event) => event.type === 'sessionClosed');
  expect(closedAt).toBeGreaterThanOrEqual(0);
  expect(events.slice(closedAt + 1)).toEqual([]);
  expect(events.filter((event) => event.type === 'sessionClosed')).toHaveLength(1);
}
