/**
 * `@lostgradient/bureau/sources`: the Node-only definition sources, kept out of Bureau's main
 * entry so a browser or edge bundle that imports `createBureau` does not pull in `node:fs`.
 *
 * @module sources
 */

export { agentFileDirectory, type AgentFileDirectoryOptions } from './agent-file-directory';
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
export {
  workflowFileDirectory,
  type WorkflowFileDirectoryOptions,
} from './workflow-file-directory';
