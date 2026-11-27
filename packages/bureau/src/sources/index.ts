/**
 * `@lostgradient/bureau/sources`: the directory sources (Node only) and the S3 object sources
 * (Bun only), kept out of Bureau's main entry so a browser or edge bundle that imports
 * `createBureau` does not pull in `node:fs` or an object-store client.
 *
 * @module sources
 */

export { agentFileDirectory, type AgentFileDirectoryOptions } from './agent-file-directory';
export { agentObjectSource, type AgentObjectSourceOptions } from './agent-object-source';
export type {
  AgentSource,
  DefinitionEntry,
  DefinitionEntryProblem,
  DefinitionSource,
  DefinitionSourceChange,
  DefinitionSourceHost,
  GuardrailSource,
  ValidatorSource,
  WorkflowSource,
} from './definition-source';
export { hashDefinitionBytes, SourceConflictError, SourceReadOnlyError } from './definition-source';
export { layeredAgentSource, layeredWorkflowSource } from './layered-source';
export { pluginLayer } from './plugin-layer';
export type { DirectorySourceOptions } from './directory-source';
export type { DirectoryWatchMode } from './watched-directory';
export { DIRECTORY_POLL_INTERVAL_MILLISECONDS } from './watched-directory';
export type {
  ListedObject,
  ListedPage,
  ObjectLocation,
  ObjectStoreOperations,
  S3ObjectStoreOperations,
  ObjectWriteCondition,
} from './object-operations';
export type { ObjectSourceOptions } from './object-source';
export {
  workflowFileDirectory,
  type WorkflowFileDirectoryOptions,
} from './workflow-file-directory';
export { workflowObjectSource, type WorkflowObjectSourceOptions } from './workflow-object-source';
export {
  guardrailFileDirectory,
  type GuardrailFileDirectoryOptions,
} from './guardrail-file-directory';
export {
  guardrailObjectSource,
  type GuardrailObjectSourceOptions,
} from './guardrail-object-source';
export {
  validatorFileDirectory,
  type ValidatorFileDirectoryOptions,
} from './validator-file-directory';
export {
  validatorObjectSource,
  type ValidatorObjectSourceOptions,
} from './validator-object-source';
