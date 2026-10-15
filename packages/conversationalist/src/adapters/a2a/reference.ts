import type { ContentSource } from '../../multi-modal';
import { A2AMappingError, unsupportedA2AContent } from './errors';
import type {
  A2AArtifact,
  A2AArtifactCatalog,
  A2AArtifactReference,
  A2AReferenceSource,
} from './types';

/**
 * Maps an `a2a-reference` content source to the A2A artifact it names. Any
 * other source kind throws an `A2AMappingError` naming that kind.
 */
export function toA2AArtifactReference(source: ContentSource): A2AArtifactReference {
  if (source.kind !== 'a2a-reference') {
    throw unsupportedA2AContent(
      source.kind,
      'only an a2a-reference content source names an A2A artifact.',
    );
  }
  return {
    agentCardUrl: source.agentCardUrl,
    taskId: source.taskId,
    artifactId: source.artifactId,
  };
}

/** Maps an A2A artifact reference back to an `a2a-reference` content source. */
export function fromA2AArtifactReference(reference: A2AArtifactReference): A2AReferenceSource {
  return {
    kind: 'a2a-reference',
    agentCardUrl: reference.agentCardUrl,
    taskId: reference.taskId,
    artifactId: reference.artifactId,
  };
}

/**
 * Builds the `a2a-reference` content source for an artifact the agent at
 * `catalog.agentCardUrl` produced for the task `catalog.taskId`.
 */
export function referenceA2AArtifact(
  catalog: Pick<A2AArtifactCatalog, 'agentCardUrl' | 'taskId'>,
  artifact: Pick<A2AArtifact, 'artifactId'>,
): A2AReferenceSource {
  return fromA2AArtifactReference({
    agentCardUrl: catalog.agentCardUrl,
    taskId: catalog.taskId,
    artifactId: artifact.artifactId,
  });
}

/**
 * Resolves an `a2a-reference` content source to the artifact it names in the
 * catalog of one agent's artifacts for one task. A reference to another agent
 * or another task, or to an artifact the catalog does not hold, throws an
 * `error:not-found` `A2AMappingError`, so two tasks that each hold an artifact
 * with the same `artifactId` never resolve to each other's artifact. A catalog
 * holding the referenced `artifactId` more than once is malformed, because an
 * `artifactId` is unique within its task, and throws an `error:validation`
 * `A2AMappingError` rather than guessing.
 */
export function resolveA2AArtifactReference(
  source: ContentSource,
  catalog: A2AArtifactCatalog,
): A2AArtifact {
  const reference = toA2AArtifactReference(source);
  const context = {
    agentCardUrl: reference.agentCardUrl,
    taskId: reference.taskId,
    artifactId: reference.artifactId,
  };
  const matches =
    reference.agentCardUrl === catalog.agentCardUrl && reference.taskId === catalog.taskId
      ? catalog.artifacts.filter((candidate) => candidate.artifactId === reference.artifactId)
      : [];
  const [artifact] = matches;
  if (matches.length > 1) {
    throw new A2AMappingError(
      'error:validation',
      'a2a-reference',
      `A2A artifact ${reference.artifactId} of task ${reference.taskId} from ${reference.agentCardUrl} appears ${matches.length} times in the catalog; an artifactId is unique within its task.`,
      { ...context, matches: matches.length },
    );
  }
  if (artifact !== undefined) return artifact;
  throw new A2AMappingError(
    'error:not-found',
    'a2a-reference',
    `A2A artifact ${reference.artifactId} of task ${reference.taskId} from ${reference.agentCardUrl} was not found.`,
    context,
  );
}
