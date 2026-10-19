/**
 * The workflow file format (COR-1527): one agent-authored workflow as a JSON file in a directory
 * the host names. A file is COR-1525's workflow document plus two Bureau fields, and nothing else:
 *
 * ```json
 * {
 *   "name": "nightly-digest",
 *   "agent": "writer",
 *   "paused": false,
 *   "trigger": { "kind": "schedule", "spec": "0 6 * * *" },
 *   "steps": [
 *     { "kind": "activity", "handler": "agent", "input": { "agent": "writer", "message": "..." } }
 *   ]
 * }
 * ```
 *
 * The filename without `.json` is the workflow's identifier and the document's `name` must equal
 * it. `agent` records which agent wrote the file (it is not checked against the agent catalog) and
 * `paused` stops the workflow starting anything new; Bureau strips both before it hands the
 * document to Weft, so neither is part of a revision. This module is the pure half: parsing,
 * validating, serializing, hashing. It touches no file and no engine.
 *
 * @module workflow-file
 */

import { createHash } from 'node:crypto';

import {
  canonicalWorkflowDocumentJson,
  type DocumentWorkflowHost,
  validateWorkflowDocument,
  WorkflowDocumentValidationError,
  type WorkflowDocument,
  type WorkflowDocumentIssue,
} from '@lostgradient/weft';

import { AGENT_IDENTIFIER_PATTERN } from './agent-file';

/** What a workflow's identifier must look like: a letter first, and it doubles as a path segment. */
export const WORKFLOW_IDENTIFIER_PATTERN = /^[a-z](?:[a-z0-9-]*[a-z0-9])?$/;

/** The longest identifier, so the ids Bureau derives from it stay inside Weft's 128 characters. */
export const WORKFLOW_IDENTIFIER_MAXIMUM_LENGTH = 64;

/** The extension a workflow file carries. Matched exactly: `x.JSON` is another kind of file. */
export const WORKFLOW_FILE_EXTENSION = '.json';

/** The largest workflow file Bureau reads, in bytes. A larger one is `invalid`. */
export const WORKFLOW_FILE_SIZE_LIMIT = 256 * 1024;

/** The handler name of the activity every agent step names. */
export const AGENT_STEP_HANDLER = 'agent';

/** Why a file cannot be used as a workflow. Carried on the listing, and on a refused write. */
export type WorkflowFileProblemCode =
  | 'invalid-identifier'
  | 'invalid-json'
  | 'invalid-document'
  | 'shadows-code-workflow'
  | 'file-too-large'
  | 'not-utf8'
  | 'unreadable';

/** One schema failure: where it is and what is wrong. */
export type WorkflowFileIssue = WorkflowDocumentIssue;

/** A file that cannot be used, as plain data a listing can carry. */
export interface WorkflowFileProblem {
  readonly code: WorkflowFileProblemCode;
  readonly message: string;
  /** Every failure found, for `invalid-document`. */
  readonly issues?: readonly WorkflowFileIssue[];
}

/** What a usable file holds, with `agent` and `paused` split from the document. */
export interface WorkflowFileContents {
  /** The identifier of the agent that wrote the file, or `null`. */
  readonly agent: string | null;
  readonly paused: boolean;
  /** The document Weft is handed: `name`, `trigger`, and `steps` exactly as written. */
  readonly document: WorkflowDocument;
}

/** What a caller supplies to write a file; Bureau sets `name` to the identifier. */
export interface WorkflowFileDefinition {
  readonly agent?: string | undefined;
  readonly paused?: boolean | undefined;
  readonly trigger: Readonly<{ kind: string } & Record<string, unknown>>;
  readonly steps: readonly Readonly<Record<string, unknown>>[];
}

export type ParsedWorkflowFile =
  | { readonly ok: true; readonly file: WorkflowFileContents }
  | { readonly ok: false; readonly problem: WorkflowFileProblem };

/** Why `id` cannot be a workflow identifier, or `undefined` when it can. */
export function checkWorkflowIdentifier(id: string): WorkflowFileProblem | undefined {
  if (id.length <= WORKFLOW_IDENTIFIER_MAXIMUM_LENGTH && WORKFLOW_IDENTIFIER_PATTERN.test(id)) {
    return undefined;
  }
  return {
    code: 'invalid-identifier',
    message: `"${id}" is not a valid workflow identifier: it must match ${WORKFLOW_IDENTIFIER_PATTERN.source} and be at most ${WORKFLOW_IDENTIFIER_MAXIMUM_LENGTH} characters.`,
  };
}

/** The SHA-256 of a file's bytes, hex: the hash `expectedHash` is compared against. */
export function hashWorkflowFileBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * A document's Weft `workflowVersion`: `sha256:` and the hex SHA-256 of its canonical JSON. The
 * same value `workflowDocumentVersion` returns, computed without waiting, because a scan is
 * synchronous per file.
 */
export function workflowVersionOf(document: WorkflowDocument): string {
  return `sha256:${createHash('sha256').update(canonicalWorkflowDocumentJson(document)).digest('hex')}`;
}

/** Decode a file's bytes as UTF-8, or `undefined` when they are not valid UTF-8. */
export function decodeWorkflowFile(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return undefined;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The issues with an `agent` step's `input`, which Weft's document schema leaves to the host. */
function agentStepIssues(document: WorkflowDocument): WorkflowFileIssue[] {
  const issues: WorkflowFileIssue[] = [];
  for (const [index, step] of document.steps.entries()) {
    if (step.kind !== 'activity' || step.handler !== AGENT_STEP_HANDLER) continue;
    const path = `steps[${String(index)}].input`;
    const input: unknown = step.input;
    if (!isPlainObject(input)) {
      issues.push({ path, message: 'an agent step needs an input of { agent, message }' });
      continue;
    }
    const extra = Object.keys(input).filter((key) => key !== 'agent' && key !== 'message');
    if (extra.length > 0) {
      issues.push({ path, message: `unknown key ${extra.map((key) => `"${key}"`).join(', ')}` });
    }
    const agent = input['agent'];
    if (typeof agent !== 'string' || !AGENT_IDENTIFIER_PATTERN.test(agent)) {
      issues.push({ path, message: '"agent" must be an agent identifier' });
    }
    if (typeof input['message'] !== 'string') {
      issues.push({ path, message: '"message" must be a string' });
    }
  }
  return issues;
}

/**
 * Parse a workflow file's text as the workflow `id`, validating it against `host`. Never throws:
 * a file that cannot be used comes back as a problem.
 */
export function parseWorkflowFile(
  id: string,
  text: string,
  host: DocumentWorkflowHost,
): ParsedWorkflowFile {
  const identifierProblem = checkWorkflowIdentifier(id);
  if (identifierProblem !== undefined) return { ok: false, problem: identifierProblem };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      problem: {
        code: 'invalid-json',
        message: `The file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
  if (!isPlainObject(value)) {
    return {
      ok: false,
      problem: { code: 'invalid-json', message: 'The file must hold one JSON object.' },
    };
  }
  const { agent, paused, ...documentInput } = value;
  const issues: WorkflowFileIssue[] = [];
  if (
    Object.hasOwn(value, 'agent') &&
    (typeof agent !== 'string' || !AGENT_IDENTIFIER_PATTERN.test(agent))
  ) {
    issues.push({ path: 'agent', message: 'must be an agent identifier' });
  }
  if (Object.hasOwn(value, 'paused') && typeof paused !== 'boolean') {
    issues.push({ path: 'paused', message: 'must be true or false' });
  }
  let document: WorkflowDocument | undefined;
  try {
    document = validateWorkflowDocument(documentInput, host);
  } catch (error) {
    if (!(error instanceof WorkflowDocumentValidationError)) throw error;
    issues.push(...error.issues);
  }
  if (document !== undefined) {
    if (document.name !== id) {
      issues.push({ path: 'name', message: `must equal the identifier "${id}"` });
    }
    issues.push(...agentStepIssues(document));
  }
  if (issues.length > 0 || document === undefined) {
    return {
      ok: false,
      problem: {
        code: 'invalid-document',
        message: `Invalid workflow file: ${issues
          .map((issue) => (issue.path === '' ? issue.message : `${issue.path}: ${issue.message}`))
          .join('; ')}`,
        issues,
      },
    };
  }
  return {
    ok: true,
    file: {
      agent: typeof agent === 'string' ? agent : null,
      paused: paused === true,
      document,
    },
  };
}

/**
 * The text of a file for `definition`, as the workflow `id`: two-space JSON with a trailing
 * newline, keys in the order `name`, `agent`, `paused`, `trigger`, `steps`.
 */
export function serializeWorkflowFile(id: string, definition: WorkflowFileDefinition): string {
  const body: Record<string, unknown> = { name: id };
  if (definition.agent !== undefined) body['agent'] = definition.agent;
  if (definition.paused !== undefined) body['paused'] = definition.paused;
  body['trigger'] = definition.trigger;
  body['steps'] = definition.steps;
  return `${JSON.stringify(body, null, 2)}\n`;
}

/** Why a read or write of a workflow file was refused, beyond the problem codes. */
export type WorkflowFileErrorCode =
  | WorkflowFileProblemCode
  | 'workflow-file-not-found'
  | 'workflow-file-exists'
  | 'workflow-file-changed';

/** A write or read of a workflow file that was refused. `problem` carries the detail, if any. */
export class WorkflowFileError extends Error {
  readonly code: WorkflowFileErrorCode;
  readonly problem: WorkflowFileProblem | undefined;

  constructor(code: WorkflowFileErrorCode, message: string, problem?: WorkflowFileProblem) {
    super(message);
    this.name = 'WorkflowFileError';
    this.code = code;
    this.problem = problem;
  }
}

/**
 * A write that lost to the file's current state: `create` found the file, or `update`, `pause`,
 * `resume`, or `delete` found bytes that do not hash to `expectedHash`. `currentHash` is the hash
 * of what is there.
 */
export class WorkflowFileConflictError extends WorkflowFileError {
  readonly currentHash: string | undefined;

  constructor(
    code: 'workflow-file-exists' | 'workflow-file-changed',
    message: string,
    currentHash?: string,
  ) {
    super(code, message);
    this.name = 'WorkflowFileConflictError';
    this.currentHash = currentHash;
  }
}
