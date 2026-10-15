import type { ContentSource, MultiModalContent } from '../../multi-modal';
import type { JSONValue, MessageInput } from '../../types';
import type { A2AArtifact, A2AStruct } from './proto-types';

export type * from './proto-types';

/** The `ContentSource` member that names an artifact held by a remote A2A agent. */
export type A2AReferenceSource = Extract<ContentSource, { kind: 'a2a-reference' }>;

/**
 * A pointer to one A2A `Artifact`: the agent that produced it, identified by
 * its agent card URL, the task it was produced for, and the artifact's
 * `artifactId`. The proto makes an `artifactId` unique only within a task, so
 * the task is part of the reference. The proto defines no reference message,
 * so this pairs the agent identity with the proto's `Task.id` and
 * `Artifact.artifact_id` fields.
 */
export interface A2AArtifactReference {
  agentCardUrl: string;
  taskId: string;
  artifactId: A2AArtifact['artifactId'];
}

/**
 * Artifacts one A2A agent produced for a single task, used to resolve
 * references to them. A reference resolves against a catalog only when both
 * its `agentCardUrl` and its `taskId` match. Within the task an `artifactId`
 * is unique, so a catalog holding the same `artifactId` twice is malformed and
 * cannot resolve that id.
 */
export interface A2AArtifactCatalog {
  agentCardUrl: string;
  taskId: string;
  artifacts: ReadonlyArray<A2AArtifact>;
}

/**
 * A Conversationalist message input imported from an A2A `Message`.
 *
 * It carries no `id`: `appendMessages` treats an input with an `id` as an
 * already-built message and skips conversation plugins, and the local message
 * id is not the remote agent's to choose. The A2A `messageId` travels
 * alongside as `messageId`, which building a message ignores.
 */
export interface A2AInboundMessage extends MessageInput {
  messageId: string;
  role: 'user' | 'assistant';
  content: MultiModalContent[];
  metadata?: Record<string, JSONValue>;
}

/** Conversationalist content for an A2A `Artifact`, with the artifact's own fields. */
export interface A2AArtifactContent {
  artifactId: string;
  name?: string;
  description?: string;
  content: string | ReadonlyArray<MultiModalContent>;
  metadata?: A2AStruct;
  extensions?: string[];
}
