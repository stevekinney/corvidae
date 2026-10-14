import type { Message, MessageRole } from '../../types';
import { toA2AParts } from './content';
import { A2AMappingError, unsupportedA2AContent } from './errors';
import type { A2AArtifact, A2AArtifactContent, A2AMessage, A2APart, A2ARole } from './types';

/**
 * Converts a Conversationalist message to an A2A `Message`.
 *
 * `user` maps to `ROLE_USER` and `assistant` to `ROLE_AGENT`; every other role
 * throws an `A2AMappingError` naming the role. The message id becomes the
 * `messageId`, non-empty metadata becomes the `metadata` struct, and each
 * content part maps through {@link toA2APart}, so unsupported content throws
 * rather than being dropped. Context, task, and extension fields belong to
 * the A2A task lifecycle and are left for the caller to set.
 */
export function toA2AMessage(message: Message): A2AMessage {
  return {
    messageId: message.id,
    role: toA2ARole(message.role),
    parts: toRequiredParts(message.content, 'message'),
    ...(Object.keys(message.metadata).length > 0 ? { metadata: { ...message.metadata } } : {}),
  };
}

/**
 * Converts Conversationalist content and artifact fields to an A2A `Artifact`.
 * An artifact must contain at least one part.
 */
export function toA2AArtifact(artifact: A2AArtifactContent): A2AArtifact {
  return {
    artifactId: artifact.artifactId,
    ...(artifact.name !== undefined ? { name: artifact.name } : {}),
    ...(artifact.description !== undefined ? { description: artifact.description } : {}),
    parts: toRequiredParts(artifact.content, 'artifact'),
    ...(artifact.metadata !== undefined ? { metadata: { ...artifact.metadata } } : {}),
    ...(artifact.extensions !== undefined ? { extensions: [...artifact.extensions] } : {}),
  };
}

function toA2ARole(role: MessageRole): A2ARole {
  if (role === 'user') return 'ROLE_USER';
  if (role === 'assistant') return 'ROLE_AGENT';
  throw unsupportedA2AContent(role, 'A2A messages are sent only by a user or an agent.');
}

function toRequiredParts(
  content: A2AArtifactContent['content'],
  kind: 'message' | 'artifact',
): A2APart[] {
  const parts = toA2AParts(content);
  if (parts.length > 0) return parts;
  throw new A2AMappingError(
    'error:validation',
    kind,
    `An A2A ${kind} must contain at least one part.`,
  );
}
