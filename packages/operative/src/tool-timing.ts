/**
 * When each tool call of a step ran (COR-2014).
 *
 * A step's `tool-result` rows are appended together once every call of the step has settled, so a
 * row's own `createdAt` says when the batch was written, not when its call started or finished,
 * and a call that waited on a person was asked for long before it ran. The step records each
 * call's start, when the toolbox is handed it, and its end, when it settles, on the run's clock,
 * and the call's result row carries both under {@link TOOL_TIMING_METADATA_KEY}.
 *
 * @module tool-timing
 */

import type { JSONValue } from 'armorer/protocol';

/** Where a `tool-result` row keeps when its call ran: a {@link ToolTiming}. */
export const TOOL_TIMING_METADATA_KEY = 'toolTiming';

/** When one tool call ran, as ISO 8601 times on the run's clock. */
export interface ToolTiming {
  /** When the toolbox was handed the call. */
  readonly startedAt: string;
  /** When the call settled: its answer, its failure, or the step giving up on it. */
  readonly endedAt: string;
}

/** Records when each call of a step started and ended. */
export class ToolTimingRecorder {
  private readonly starts = new Map<string, string>();
  private readonly ends = new Map<string, string>();

  constructor(private readonly now: () => string) {}

  /** The calls `callIds` name were handed to the toolbox now. */
  started(callIds: Iterable<string>): void {
    const at = this.now();
    for (const callId of callIds) if (!this.starts.has(callId)) this.starts.set(callId, at);
  }

  /** The call settled now. Only its first settlement counts, and only for a call that started. */
  ended(callId: string): void {
    if (this.starts.has(callId) && !this.ends.has(callId)) this.ends.set(callId, this.now());
  }

  /** Every started call that has not settled settled now: the toolbox answered them all. */
  endAll(): void {
    for (const callId of this.starts.keys()) this.ended(callId);
  }

  /** The metadata the call's result row carries, or `undefined` for a call that never started. */
  metadataOf(callId: string): Record<string, JSONValue> | undefined {
    const startedAt = this.starts.get(callId);
    if (startedAt === undefined) return undefined;
    const endedAt = this.ends.get(callId) ?? this.now();
    const timing: ToolTiming = { startedAt, endedAt };
    return { [TOOL_TIMING_METADATA_KEY]: { ...timing } };
  }
}
