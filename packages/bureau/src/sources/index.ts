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
  WorkflowSource,
} from './definition-source';
export { hashDefinitionBytes, SourceConflictError } from './definition-source';
export type { DirectorySourceOptions } from './directory-source';
export type {
  ListedObject,
  ListedPage,
  ObjectLocation,
  ObjectStoreClient,
  ObjectStoreOperations,
  ObjectWriteCondition,
} from './object-operations';
export type { ObjectSourceOptions } from './object-source';
export {
  workflowFileDirectory,
  type WorkflowFileDirectoryOptions,
} from './workflow-file-directory';
export { workflowObjectSource, type WorkflowObjectSourceOptions } from './workflow-object-source';
