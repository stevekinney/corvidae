import { copyA2AStruct, fromA2APart } from './content';
import { A2AMappingError, unsupportedA2AContent } from './errors';
import type {
  A2AArtifact,
  A2AArtifactContent,
  A2AInboundMessage,
  A2AMessage,
  A2APart,
  A2ARole,
} from './types';

/**
 * Converts an A2A `Message` to a Conversationalist message input.
 *
 * `ROLE_USER` maps to `user` and `ROLE_AGENT` to `assistant`; an unspecified
 * role throws an `A2AMappingError`. The `messageId` stays `messageId` rather
 * than becoming the local `id`, so appending the result runs conversation
 * plugins and mints a local id. The `metadata` struct becomes message
 * metadata, and each part maps through `fromA2APart`. Context, task,
 * extension, and reference-task fields belong to the A2A task lifecycle and
 * remain on the caller's A2A message. A message without parts throws an
 * `A2AMappingError`, as it does on the way out.
 */
export function fromA2AMessage(message: A2AMessage): A2AInboundMessage {
  return {
    messageId: message.messageId,
    role: fromA2ARole(message.role),
    content: fromRequiredParts(message.parts, 'message'),
    ...(message.metadata !== undefined ? { metadata: copyA2AStruct(message.metadata) } : {}),
  };
}

/**
 * Converts an A2A `Artifact` to Conversationalist content with the artifact's
 * own fields; the inverse of `toA2AArtifact`. An artifact without parts
 * throws an `A2AMappingError`.
 */
export function fromA2AArtifact(artifact: A2AArtifact): A2AArtifactContent & {
  content: A2AInboundMessage['content'];
} {
  return {
    artifactId: artifact.artifactId,
    ...(artifact.name !== undefined ? { name: artifact.name } : {}),
    ...(artifact.description !== undefined ? { description: artifact.description } : {}),
    content: fromRequiredParts(artifact.parts, 'artifact'),
    ...(artifact.metadata !== undefined ? { metadata: copyA2AStruct(artifact.metadata) } : {}),
    ...(artifact.extensions !== undefined ? { extensions: [...artifact.extensions] } : {}),
  };
}

function fromA2ARole(role: A2ARole): A2AInboundMessage['role'] {
  if (role === 'ROLE_USER') return 'user';
  if (role === 'ROLE_AGENT') return 'assistant';
  throw unsupportedA2AContent(role, 'an A2A message must be sent by a user or an agent.');
}

function fromRequiredParts(
  parts: ReadonlyArray<A2APart> | undefined,
  kind: 'message' | 'artifact',
): A2AInboundMessage['content'] {
  if (parts !== undefined && parts.length > 0) return parts.map(fromA2APart);
  throw new A2AMappingError(
    'error:validation',
    kind,
    `An A2A ${kind} must contain at least one part.`,
  );
}
