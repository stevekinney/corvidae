/**
 * Registering workflow documents with an engine. Each document becomes its own
 * workflow type through `registerSource()`, so it lists, runs, schedules, and
 * recovers like a code-defined workflow. Weft persists no documents: the host
 * supplies them, and these helpers register exactly what they are handed.
 *
 * @module document-workflow/register
 */

import { deriveWorkflowDefinitionRevision } from '../core/engine/definition-revision.ts';
import type { Engine } from '../core/engine/index.ts';
import { activateRegisteredSourceRevision } from '../core/engine/source-activation.ts';
import { listWorkflowSources } from '../core/engine/source-listing.ts';
import { workflowSource } from '../core/source/index.ts';
import {
  validateWorkflowDocument,
  workflowDocumentVersion,
  type DocumentWorkflowHost,
  type WorkflowDocument,
} from './document.ts';
import { buildDocumentWorkflowDefinition } from './interpreter.ts';

/** The identity a registered document has in the engine. */
export type RegisteredWorkflowDocument = Readonly<{
  /** The workflow type name, taken from the document. */
  name: string;
  /** The document's version, `sha256:` plus the SHA-256 of its canonical JSON. */
  workflowVersion: string;
  /** The engine revision derived from the document's contract and version. */
  revision: string;
}>;

/** The documents a host hands {@link registerWorkflowDocuments}. */
export interface WorkflowDocumentSet {
  /** The revision each workflow type runs for new instances: one document per name. */
  readonly active: readonly unknown[];
  /**
   * Other revisions the host still holds. Register every revision that has an
   * in-flight run or a pinned schedule, or recovery cannot load it.
   */
  readonly retained?: readonly unknown[];
}

const DOCUMENT_SOURCE_EXPORT = 'workflow';

async function registerValidatedDocument(
  engine: Engine,
  host: DocumentWorkflowHost,
  document: WorkflowDocument,
): Promise<RegisteredWorkflowDocument> {
  const workflowVersion = await workflowDocumentVersion(document);
  const definition = await buildDocumentWorkflowDefinition(document, host);
  const revision = await deriveWorkflowDefinitionRevision(definition);
  const identity = { name: document.name, workflowVersion, revision };

  const alreadyRegistered = listWorkflowSources(engine).some(
    (source) => source.name === document.name && source.revision === revision,
  );
  if (!alreadyRegistered) {
    engine.registerSource(
      workflowSource(
        {
          name: document.name,
          location: `workflow-document:${workflowVersion}`,
          exportName: DOCUMENT_SOURCE_EXPORT,
          revision,
          workflowVersion,
        },
        async () => ({ [DOCUMENT_SOURCE_EXPORT]: definition }),
      ),
    );
  }
  return identity;
}

/**
 * Validate `input` against `host` and register it as a workflow type named by
 * the document, without loading or activating it. A name with a single
 * registered revision runs that revision; use {@link registerWorkflowDocuments}
 * when a name has more than one. Registering a document whose revision is
 * already registered is a no-op.
 */
export function registerWorkflowDocument(
  engine: Engine,
  host: DocumentWorkflowHost,
  input: unknown,
): Promise<RegisteredWorkflowDocument> {
  return registerValidatedDocument(engine, host, validateWorkflowDocument(input, host));
}

/**
 * Register every document the host supplies, then make each `active` document
 * the revision that new instances of its type run. Call it before starting the
 * engine's workflows and before `recoverAll()`, so recovery can load the
 * revision each in-flight run is pinned to. Every document is validated before
 * anything is registered. Returns the `active` documents' identities, then the
 * `retained` ones', in the order given.
 */
export async function registerWorkflowDocuments(
  engine: Engine,
  host: DocumentWorkflowHost,
  documents: WorkflowDocumentSet,
): Promise<readonly RegisteredWorkflowDocument[]> {
  const active = documents.active.map((input) => validateWorkflowDocument(input, host));
  const retained = (documents.retained ?? []).map((input) => validateWorkflowDocument(input, host));

  const activeNames = new Set<string>();
  for (const document of active) {
    if (activeNames.has(document.name)) {
      throw new Error(
        `Workflow document "${document.name}" has more than one active revision; supply one active document per name.`,
      );
    }
    activeNames.add(document.name);
  }

  const registeredRetained: RegisteredWorkflowDocument[] = [];
  for (const document of retained) {
    registeredRetained.push(await registerValidatedDocument(engine, host, document));
  }
  const registeredActive: RegisteredWorkflowDocument[] = [];
  for (const document of active) {
    registeredActive.push(await registerValidatedDocument(engine, host, document));
  }
  for (const identity of registeredActive) {
    await activateRegisteredSourceRevision(engine, identity.name, identity.revision);
  }
  return [...registeredActive, ...registeredRetained];
}
