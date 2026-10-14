import type { ContentSource, MultiModalContent } from '../../multi-modal';
import type { JSONValue } from '../../types';
import type { A2AArtifact, A2AStruct } from './proto-types';

export type * from './proto-types';

/** The `ContentSource` member that names an artifact held by a remote A2A agent. */
export type A2AReferenceSource = Extract<ContentSource, { kind: 'a2a-reference' }>;

/**
 * A pointer to one A2A `Artifact`: the agent that produced it, identified by
 * its agent card URL, and the artifact's `artifactId`. The proto defines no
 * reference message, so this pairs the agent identity with the proto field.
 */
export interface A2AArtifactReference {
  agentCardUrl: string;
  artifactId: A2AArtifact['artifactId'];
}

/** The artifacts one A2A agent has produced, used to resolve references to them. */
export interface A2AArtifactCatalog {
  agentCardUrl: string;
  artifacts: ReadonlyArray<A2AArtifact>;
}

/**
 * A Conversationalist message imported from an A2A `Message`. It satisfies
 * `MessageInput`; `id` carries the A2A `messageId`.
 */
export interface A2AInboundMessage {
  id: string;
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
