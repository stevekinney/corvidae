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
  return { agentCardUrl: source.agentCardUrl, artifactId: source.artifactId };
}

/** Maps an A2A artifact reference back to an `a2a-reference` content source. */
export function fromA2AArtifactReference(reference: A2AArtifactReference): A2AReferenceSource {
  return {
    kind: 'a2a-reference',
    agentCardUrl: reference.agentCardUrl,
    artifactId: reference.artifactId,
  };
}

/** Builds the `a2a-reference` content source for an artifact the agent at `agentCardUrl` produced. */
export function referenceA2AArtifact(
  agentCardUrl: string,
  artifact: Pick<A2AArtifact, 'artifactId'>,
): A2AReferenceSource {
  return fromA2AArtifactReference({ agentCardUrl, artifactId: artifact.artifactId });
}

/**
 * Resolves an `a2a-reference` content source to the artifact it names in the
 * catalog of one agent's artifacts for one task. A reference to another agent,
 * or to an artifact the catalog does not hold, throws an `error:not-found`
 * `A2AMappingError`. A catalog holding the referenced `artifactId` more than
 * once (for example, artifacts gathered from several tasks) throws an
 * `error:validation` `A2AMappingError` rather than guessing.
 */
export function resolveA2AArtifactReference(
  source: ContentSource,
  catalog: A2AArtifactCatalog,
): A2AArtifact {
  const reference = toA2AArtifactReference(source);
  const context = { agentCardUrl: reference.agentCardUrl, artifactId: reference.artifactId };
  const matches =
    reference.agentCardUrl === catalog.agentCardUrl
      ? catalog.artifacts.filter((candidate) => candidate.artifactId === reference.artifactId)
      : [];
  const [artifact] = matches;
  if (matches.length > 1) {
    throw new A2AMappingError(
      'error:validation',
      'a2a-reference',
      `A2A artifact ${reference.artifactId} from ${reference.agentCardUrl} appears ${matches.length} times in the catalog; an artifactId is unique only within one task.`,
      { ...context, matches: matches.length },
    );
  }
  if (artifact !== undefined) return artifact;
  throw new A2AMappingError(
    'error:not-found',
    'a2a-reference',
    `A2A artifact ${reference.artifactId} from ${reference.agentCardUrl} was not found.`,
    context,
  );
}
