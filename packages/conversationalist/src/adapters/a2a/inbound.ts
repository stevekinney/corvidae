import { copyA2AStruct, fromA2APart } from './content';
import { unsupportedA2AContent } from './errors';
import type {
  A2AArtifact,
  A2AArtifactContent,
  A2AInboundMessage,
  A2AMessage,
  A2ARole,
} from './types';

/**
 * Converts an A2A `Message` to a Conversationalist message input.
 *
 * `ROLE_USER` maps to `user` and `ROLE_AGENT` to `assistant`; an unspecified
 * role throws an `A2AMappingError`. The `messageId` becomes `id`, the
 * `metadata` struct becomes message metadata, and each part maps through
 * `fromA2APart`. Context, task, extension, and reference-task fields belong to
 * the A2A task lifecycle and remain on the caller's A2A message.
 */
export function fromA2AMessage(message: A2AMessage): A2AInboundMessage {
  return {
    id: message.messageId,
    role: fromA2ARole(message.role),
    content: message.parts.map(fromA2APart),
    ...(message.metadata !== undefined ? { metadata: copyA2AStruct(message.metadata) } : {}),
  };
}

/**
 * Converts an A2A `Artifact` to Conversationalist content with the artifact's
 * own fields; the inverse of `toA2AArtifact`.
 */
export function fromA2AArtifact(artifact: A2AArtifact): A2AArtifactContent & {
  content: A2AInboundMessage['content'];
} {
  return {
    artifactId: artifact.artifactId,
    ...(artifact.name !== undefined ? { name: artifact.name } : {}),
    ...(artifact.description !== undefined ? { description: artifact.description } : {}),
    content: artifact.parts.map(fromA2APart),
    ...(artifact.metadata !== undefined ? { metadata: copyA2AStruct(artifact.metadata) } : {}),
    ...(artifact.extensions !== undefined ? { extensions: [...artifact.extensions] } : {}),
  };
}

function fromA2ARole(role: A2ARole): A2AInboundMessage['role'] {
  if (role === 'ROLE_USER') return 'user';
  if (role === 'ROLE_AGENT') return 'assistant';
  throw unsupportedA2AContent(role, 'an A2A message must be sent by a user or an agent.');
}
