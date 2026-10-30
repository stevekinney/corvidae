/**
 * The reference documents of a file agent (COR-1866): the files its `references` key names, read
 * through the agent source, and what they add to the agent.
 *
 * ## What a document is
 *
 * A reference is a path, relative to the agent file's directory. The catalog reads each one on
 * every scan, as UTF-8 text, at most {@link AGENT_REFERENCE_SIZE_LIMIT} bytes each and
 * {@link AGENT_REFERENCES_TOTAL_SIZE_LIMIT} together. A document that is missing, unreadable or
 * not UTF-8 makes the agent `invalid` with `missing-reference`; one over a limit makes it
 * `invalid` with `reference-too-large`. Each problem names the path.
 *
 * ## What they add
 *
 * The text of the documents, in the order the file lists them, follows the file's instructions
 * ({@link renderInstructions}). The definition holds the paths and never the text: the text is
 * kept beside the definition in the run's snapshot, and a saved version records only each
 * document's digest.
 *
 * ## Identity
 *
 * A document changes the agent without changing the agent file, so the file's hash cannot say
 * which agent a run used. {@link referenceIdentity} folds the digests into one hash: with no
 * documents it is the file's own hash, so an agent without references keeps every revision, version
 * and snapshot it already has. The catalog raises the agent's `definitionRevision` for a new
 * identity, and a snapshot is keyed by it. `definitionHash`, and the `expectedHash` of a write,
 * stay the hash of the file's bytes.
 *
 * @module agent-reference-documents
 */

import { createHash } from 'node:crypto';

import { z } from 'zod';

import {
  AGENT_REFERENCE_SIZE_LIMIT,
  AGENT_REFERENCES_TOTAL_SIZE_LIMIT,
  type AgentFileProblem,
} from './agent-file';
import type { AgentSource, SiblingRead } from './sources/definition-source';

/** What a saved version records of a document: which one, and the SHA-256 of its bytes. */
export interface AgentReferenceDigest {
  /** The path the agent file's `references` named, relative to the agent file's directory. */
  readonly path: string;
  /** The SHA-256 of the document's bytes, as lowercase hex. */
  readonly digest: string;
}

/** A reference document as a run read it. */
export interface AgentReferenceDocument extends AgentReferenceDigest {
  /** The document's text. */
  readonly content: string;
}

const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;

/** The digest of a document, as stored. */
export const agentReferenceDigestSchema = z.strictObject({
  path: z.string().min(1),
  digest: z.string().regex(DIGEST_PATTERN),
});

/** A document as a snapshot stores it. */
export const agentReferenceDocumentSchema = z.strictObject({
  path: z.string().min(1),
  digest: z.string().regex(DIGEST_PATTERN),
  content: z.string(),
});

/** The SHA-256 of `bytes`, as lowercase hex. */
function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The digests of `documents`, in their order. */
export function digestsOf(
  documents: readonly AgentReferenceDocument[],
): readonly AgentReferenceDigest[] {
  return documents.map(({ path, digest }) => ({ path, digest }));
}

/**
 * The hash that identifies an agent file together with the documents it read: `fileHash` itself
 * when there are none, otherwise the SHA-256 of the file's hash and each document's path and
 * digest, in the order the file lists them.
 */
export function referenceIdentity(
  fileHash: string,
  documents: readonly AgentReferenceDigest[],
): string {
  if (documents.length === 0) return fileHash;
  return sha256(
    `${fileHash}\n${documents.map(({ path, digest }) => `${path}\0${digest}\n`).join('')}`,
  );
}

/** Whether two lists name the same documents with the same digests, in the same order. */
export function sameDigests(
  left: readonly AgentReferenceDigest[] | undefined,
  right: readonly AgentReferenceDigest[] | undefined,
): boolean {
  const a = left ?? [];
  const b = right ?? [];
  return (
    a.length === b.length &&
    a.every((digest, index) => digest.path === b[index]?.path && digest.digest === b[index].digest)
  );
}

/**
 * The instructions a run is given: the file's, then each document under a heading that names its
 * path. With no documents, the instructions as they are.
 */
export function renderInstructions(
  instructions: string,
  documents: readonly AgentReferenceDocument[],
): string {
  if (documents.length === 0) return instructions;
  const sections = documents.map(
    ({ path, content }) => `## Reference: ${path}\n\n${content.replace(/\n+$/u, '')}`,
  );
  const reference = `# Reference documents\n\n${sections.join('\n\n')}`;
  return instructions.trim() === '' ? reference : `${instructions.trimEnd()}\n\n${reference}`;
}

/** The documents read, or the problem that made the agent invalid. */
export type ReferenceLoad =
  | { readonly ok: true; readonly documents: readonly AgentReferenceDocument[] }
  | { readonly ok: false; readonly problem: AgentFileProblem };

const decoder = new TextDecoder('utf-8', { fatal: true });

function problemFor(
  code: 'missing-reference' | 'reference-too-large',
  index: number,
  path: string,
  message: string,
): ReferenceLoad {
  const text = `The reference "${path}" ${message}`;
  return {
    ok: false,
    problem: { code, message: text, issues: [{ path: `references.${index}`, message: text }] },
  };
}

/**
 * The bytes of the documents read last, by {@link referenceCacheKey}, with the stamp the source gave each. A source
 * that can tell a document is unchanged by its stamp answers `unchanged` and the bytes here are
 * used, so a poll that finds nothing moved reads no content.
 */
export type ReferenceCache = Map<string, { readonly stamp: string; readonly bytes: Uint8Array }>;

/**
 * The key a document is cached under: its path, within the layer that holds the agent naming it
 * (COR-1873). A plugin's documents sit beside the plugin's files, so `guide.md` of `linear:triager`
 * and `guide.md` of the owner's agent are two documents.
 */
export function referenceCacheKey(definitionId: string | undefined, path: string): string {
  const separator = definitionId?.indexOf(':') ?? -1;
  return separator === -1 || definitionId === undefined
    ? path
    : `${definitionId.slice(0, separator)}:${path}`;
}

/**
 * Read the documents `paths` name through `source`, one after another so the first problem in the
 * file's order is the one reported. With a `cache`, a document the source reports unchanged is not
 * read again, and each document read is remembered by its stamp. `definitionId` is the agent that
 * names them, which a layered source reads them for from that agent's layer. Never rejects.
 */
export async function loadReferenceDocuments(
  source: Pick<AgentSource, 'readSibling'>,
  paths: readonly string[],
  cache?: ReferenceCache,
  definitionId?: string,
): Promise<ReferenceLoad> {
  const documents: AgentReferenceDocument[] = [];
  let total = 0;
  for (const [index, path] of paths.entries()) {
    let read: Exclude<SiblingRead, { kind: 'unchanged' }>;
    try {
      const key = referenceCacheKey(definitionId, path);
      const cached = cache?.get(key);
      const answer = await source.readSibling(path, {
        limit: AGENT_REFERENCE_SIZE_LIMIT,
        ...(cached === undefined ? {} : { unlessStamp: cached.stamp }),
        ...(definitionId === undefined ? {} : { definitionId }),
      });
      if (answer.kind === 'unchanged') {
        // A source answers `unchanged` only to a stamp it was given, which came with these bytes.
        read =
          cached === undefined
            ? { kind: 'missing' }
            : { kind: 'found', bytes: cached.bytes, stamp: cached.stamp };
      } else {
        read = answer;
        if (answer.kind === 'found' && answer.stamp !== undefined) {
          cache?.set(key, { stamp: answer.stamp, bytes: answer.bytes });
        } else {
          cache?.delete(key);
        }
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return problemFor('missing-reference', index, path, `could not be read: ${reason}`);
    }
    if (read.kind === 'missing') {
      return problemFor('missing-reference', index, path, 'does not exist.');
    }
    if (read.kind === 'too-large') {
      return problemFor(
        'reference-too-large',
        index,
        path,
        `is ${read.size} bytes; a reference may be at most ${AGENT_REFERENCE_SIZE_LIMIT}.`,
      );
    }
    total += read.bytes.byteLength;
    if (total > AGENT_REFERENCES_TOTAL_SIZE_LIMIT) {
      return problemFor(
        'reference-too-large',
        index,
        path,
        `takes the references past ${AGENT_REFERENCES_TOTAL_SIZE_LIMIT} bytes in all.`,
      );
    }
    let content: string;
    try {
      content = decoder.decode(read.bytes);
    } catch {
      return problemFor('missing-reference', index, path, 'is not valid UTF-8.');
    }
    documents.push({ path, content, digest: sha256(read.bytes) });
  }
  return { ok: true, documents };
}
