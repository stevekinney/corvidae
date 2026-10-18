/**
 * Derive the content-addressed revision a workflow definition will have once
 * it is loaded, without registering it. A host that builds a definition at
 * runtime (see `document-workflow/`) needs that revision up front, because
 * `registerSource()` compares `descriptor.revision` with the revision derived
 * from the loaded contract and rejects a mismatch.
 *
 * @module core/engine/definition-revision
 */

import { ActivityRegistry } from '../activity-registry.ts';
import { buildWorkflowManifestFromDefinition } from '../registry-workflow-manifest.ts';
import type { WorkflowDefinition } from '../types.ts';
import { copyWorkflowDefinition } from './construction.ts';
import {
  buildPerWorkflowActivityRegistry,
  buildRegistrationEntry,
  isBuilderWorkflowDefinition,
} from './registration.ts';

/**
 * The revision the engine derives for `definition` when `registerSource()`
 * resolves it: the same registration, per-workflow activity, and manifest
 * pipeline the loader path runs, so the result equals the revision a
 * successful load would install.
 */
export async function deriveWorkflowDefinitionRevision(
  definition: WorkflowDefinition,
): Promise<string> {
  const entry = buildRegistrationEntry(definition.name, definition);
  const registered = copyWorkflowDefinition(definition.name, entry);
  const activityDefinitions = isBuilderWorkflowDefinition(definition)
    ? buildPerWorkflowActivityRegistry(definition.activities).listDefinitions()
    : new ActivityRegistry().listDefinitions();
  const manifest = await buildWorkflowManifestFromDefinition(registered, activityDefinitions);
  return manifest.revision;
}
