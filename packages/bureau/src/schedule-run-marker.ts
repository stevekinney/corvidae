import type { ScheduledAgentRunInput } from '@lostgradient/operative';
import { type ConversationHistory, getOwn } from 'conversationalist';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
export type RecoveredScheduleMarker =
  | { status: 'found'; scheduleId: string }
  | { status: 'missing'; sessionId?: string }
  | { status: 'read-error'; error: unknown; sessionId?: string };

export function persistedScheduleMarker(input: ScheduledAgentRunInput): string | undefined {
  if (typeof input.scheduleId !== 'string') return undefined;
  const scheduleId = input.scheduleId.trim();
  return scheduleId.length > 0 ? scheduleId : undefined;
}
export function hasPersistedScheduleMarker(input: ScheduledAgentRunInput): boolean {
  return persistedScheduleMarker(input) !== undefined;
}
/**
 * Weft 0.10+ native `KEYS.scheduleRun(...)` marker: an object of shape
 * `{ id, occurrence? }` written by `encodeScheduleRunMetadata` (see weft's
 * `src/core/engine/schedule-run-metadata.ts`). Pre-0.10 stores may still hold
 * the legacy plain-string marker, handled separately in
 * {@link decodeScheduleRunMarker}.
 */
function isScheduleRunMarkerObject(value: unknown): value is { id: string; occurrence?: number } {
  if (!isRecord(value)) return false;
  const { id, occurrence } = value;
  return typeof id === 'string' && (occurrence === undefined || typeof occurrence === 'number');
}
/**
 * Decode a `KEYS.scheduleRun(...)` storage value (already `decode()`d from
 * bytes) into its schedule id, accepting both the legacy plain-string marker
 * and Weft 0.10+'s `{ id, occurrence? }` metadata object. Returns `undefined`
 * when the value is neither shape, or the id is blank. The returned id is
 * always trimmed, so accidental whitespace never propagates into downstream
 * equality checks or embedded session ids.
 */
export function decodeScheduleRunMarker(decoded: unknown): string | undefined {
  if (typeof decoded === 'string') {
    const trimmed = decoded.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (isScheduleRunMarkerObject(decoded)) {
    const trimmed = decoded.id.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return undefined;
}
export function recoveredMarkerSessionId(
  marker: RecoveredScheduleMarker | undefined,
): string | undefined {
  return marker?.status === 'found' ? undefined : marker?.sessionId;
}
function lastScheduledFirePromptIndex(history: ConversationHistory, runId: string): number {
  for (let index = history.ids.length - 1; index >= 0; index -= 1) {
    const message = getOwn(history.messages, history.ids[index]!);
    if (message?.role === 'user' && message.metadata['scheduledFireRunId'] === runId) {
      return index;
    }
  }
  return -1;
}
function removeConversationIndexRange(
  history: ConversationHistory,
  startIndex: number,
  endIndex: number,
): ConversationHistory {
  const ids = history.ids.filter((_, index) => index < startIndex || index > endIndex);
  const messages: Record<string, ConversationHistory['messages'][string]> = {};
  for (const [position, id] of ids.entries()) {
    const message = getOwn(history.messages, id);
    if (message) messages[id] = { ...message, position };
  }
  return { ...history, ids, messages };
}
export function removeLastScheduledFireTranscript(
  history: ConversationHistory,
  runId: string,
): ConversationHistory {
  const promptIndex = lastScheduledFirePromptIndex(history, runId);
  if (promptIndex === -1) return history;
  const nextUserIndex = history.ids.findIndex((id, index) => {
    if (index <= promptIndex) return false;
    return getOwn(history.messages, id)?.role === 'user';
  });
  const endIndex = nextUserIndex === -1 ? history.ids.length - 1 : nextUserIndex - 1;
  return removeConversationIndexRange(history, promptIndex, endIndex);
}
