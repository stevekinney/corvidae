/**
 * Maps a peer's tasks, messages, and artifacts to the plain shapes the peer client returns.
 * Everything here treats the peer's content as untrusted: a `url` part is kept as a reference
 * and never fetched, `raw` bytes are never carried, and oversized content is dropped.
 *
 * @module a2a/peer-parts
 */

import { type Artifact, type Message, type Part, TaskState } from '@a2a-js/sdk';

import type { A2APeerArtifact, A2APeerPart, A2APeerTaskState } from './peer-client-types.ts';

/** The largest artifact content, in UTF-16 code units, the client keeps per artifact. */
export const DEFAULT_PEER_ARTIFACT_LIMIT = 1_048_576;

const STATE_NAMES: ReadonlyMap<TaskState, A2APeerTaskState> = new Map([
  [TaskState.TASK_STATE_SUBMITTED, 'submitted'],
  [TaskState.TASK_STATE_WORKING, 'working'],
  [TaskState.TASK_STATE_INPUT_REQUIRED, 'input-required'],
  [TaskState.TASK_STATE_AUTH_REQUIRED, 'auth-required'],
  [TaskState.TASK_STATE_COMPLETED, 'completed'],
  [TaskState.TASK_STATE_FAILED, 'failed'],
  [TaskState.TASK_STATE_CANCELED, 'canceled'],
  [TaskState.TASK_STATE_REJECTED, 'rejected'],
]);

/** The client's name for a wire `TaskState`; an unspecified or unknown state reads as `working`. */
export function peerStateOf(state: TaskState | undefined): A2APeerTaskState {
  return (state === undefined ? undefined : STATE_NAMES.get(state)) ?? 'working';
}

/** Whether `state` means the task will not progress without a new message from the caller. */
export function isStopState(state: A2APeerTaskState): boolean {
  return state !== 'submitted' && state !== 'working';
}

/** The text parts of `message` joined by a newline; empty when it has none. */
export function textOfMessage(message: Message | undefined): string {
  if (message === undefined) return '';
  const texts: string[] = [];
  for (const part of message.parts) {
    if (part.content?.$case === 'text') texts.push(part.content.value);
  }
  return texts.join('\n');
}

function sizeOf(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Maps one wire part. Returns the mapped part and the size it counts against the artifact's
 * budget.
 */
function mapPart(part: Part, remaining: number): { part: A2APeerPart; size: number } {
  const mediaType = part.mediaType;
  const filename = part.filename;
  const content = part.content;
  if (content === undefined) return { part: { kind: 'text', text: '' }, size: 0 };
  switch (content.$case) {
    case 'text':
      return content.value.length > remaining
        ? { part: { kind: 'omitted', mediaType, filename, reason: 'too-large' }, size: 0 }
        : { part: { kind: 'text', text: content.value }, size: content.value.length };
    case 'data': {
      const size = sizeOf(content.value);
      return size > remaining
        ? { part: { kind: 'omitted', mediaType, filename, reason: 'too-large' }, size: 0 }
        : { part: { kind: 'data', data: content.value }, size };
    }
    case 'url':
      return { part: { kind: 'reference', url: content.value, mediaType, filename }, size: 0 };
    default:
      return { part: { kind: 'omitted', mediaType, filename, reason: 'binary' }, size: 0 };
  }
}

/** Maps a wire artifact, spending at most `limit` characters of content across its parts. */
export function mapArtifact(artifact: Artifact, limit: number): A2APeerArtifact {
  let remaining = limit;
  const parts: A2APeerPart[] = [];
  for (const part of artifact.parts) {
    const mapped = mapPart(part, remaining);
    remaining -= mapped.size;
    parts.push(mapped.part);
  }
  return {
    artifactId: artifact.artifactId,
    name: artifact.name,
    description: artifact.description,
    parts,
  };
}

/**
 * Applies an artifact update to `artifacts`: `append` adds the update's parts to the artifact
 * with the same identifier, and otherwise the update replaces (or adds) it.
 */
export function applyArtifactUpdate(
  artifacts: readonly Artifact[],
  update: Artifact,
  append: boolean,
): Artifact[] {
  const index = artifacts.findIndex((entry) => entry.artifactId === update.artifactId);
  if (index === -1) return [...artifacts, update];
  const next = [...artifacts];
  const existing = artifacts[index];
  next[index] =
    append && existing !== undefined
      ? { ...existing, parts: [...existing.parts, ...update.parts] }
      : update;
  return next;
}
