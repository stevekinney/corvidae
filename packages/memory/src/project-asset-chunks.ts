import { chunkMarkdown, chunkText, type ChunkingOptions, type ContentChunk } from './chunking';
import type { EvidenceProjectionRecord, TransformationStep } from './evidence-projection-schema';
import type {
  EvidenceProjectionCommitResult,
  EvidenceProjectionStorage,
} from './evidence-projection-storage';
import {
  digestOfText,
  MemoryEvidenceValidationError,
  type EvidenceRecord,
} from './evidence-schema';
import { chunkHtml } from './html-chunking';

export interface ProjectAssetChunksOptions {
  readonly storage: EvidenceProjectionStorage;
  readonly tenantId: string;
  readonly namespace: string;
  /** The stored evidence the chunks derive from (a managed asset, or inline text). */
  readonly evidence: EvidenceRecord;
  /**
   * The text extracted from the evidence and the steps that produced it. The
   * first step's `inputDigest` is the evidence digest and the last step's
   * `outputDigest` is the digest of `text`. With no steps the text is the
   * evidence itself (inline evidence), so its digest must equal the evidence's.
   */
  readonly extracted: { readonly text: string; readonly steps: readonly TransformationStep[] };
  readonly chunker: 'markdown' | 'text' | 'html';
  readonly chunking?: ChunkingOptions;
  readonly projectorRevision: string;
  readonly policyRevision: string;
  readonly now: () => number;
  readonly idFor: (ordinal: number) => string;
}

export interface ProjectAssetChunksResult {
  readonly chunks: readonly EvidenceProjectionRecord[];
  readonly commit: EvidenceProjectionCommitResult;
}

function mismatch(detail: string): never {
  throw new MemoryEvidenceValidationError('digest-mismatch', 'projection', detail);
}

/** Checks the extraction chain before any read and returns the digest the chunker starts from. */
function verifyExtraction(
  evidence: EvidenceRecord,
  extracted: ProjectAssetChunksOptions['extracted'],
): string {
  const textDigest = digestOfText(extracted.text);
  const first = extracted.steps[0];
  const last = extracted.steps.at(-1);
  if (first === undefined || last === undefined) {
    if (textDigest !== evidence.digest) {
      mismatch('Extracted text without extraction steps must be the evidence itself.');
    }
    return evidence.digest;
  }
  if (first.inputDigest !== evidence.digest) {
    mismatch('The first extraction step does not start from the evidence digest.');
  }
  if (last.outputDigest !== textDigest) {
    mismatch('The last extraction step does not produce the extracted text.');
  }
  extracted.steps.forEach((step, index) => {
    if (index > 0 && step.inputDigest !== extracted.steps[index - 1]?.outputDigest) {
      mismatch(`Extraction step ${index} does not start from the previous step's output.`);
    }
  });
  return last.outputDigest;
}

async function runChunker(options: ProjectAssetChunksOptions): Promise<ContentChunk[]> {
  const { extracted, chunking } = options;
  switch (options.chunker) {
    case 'markdown':
      return chunkMarkdown(extracted.text, chunking);
    case 'text':
      return chunkText({ text: extracted.text }, chunking);
    case 'html':
      return chunkHtml(extracted.text, chunking);
  }
}

/**
 * The projection-based successor of chunked ingestion. The caller supplies the
 * text it extracted and the steps that produced it; every chunk becomes a
 * `chunk` projection of the stored evidence whose `steps` form an unbroken
 * digest chain from the evidence digest, through each extraction step, to the
 * digest of the chunk's own text. The write verifies that chain, so source
 * identity is proved by digests rather than by a copied identifier.
 */
export async function projectAssetChunks(
  options: ProjectAssetChunksOptions,
): Promise<ProjectAssetChunksResult> {
  const { storage, tenantId, namespace, evidence, extracted } = options;
  const startDigest = verifyExtraction(evidence, extracted);
  const chunks = await runChunker(options);
  const at = options.now();
  const records = chunks.map((chunk): EvidenceProjectionRecord => {
    const chunkStep: TransformationStep = {
      step: 'chunk',
      producer: {
        kind: 'service',
        id: `memory.chunk.${options.chunker}`,
        version: options.projectorRevision,
      },
      inputDigest: startDigest,
      outputDigest: digestOfText(chunk.text),
    };
    return {
      schemaVersion: 1,
      id: options.idFor(chunk.index),
      tenantId,
      namespace,
      kind: 'chunk',
      revision: 1,
      projectorRevision: options.projectorRevision,
      policyRevision: options.policyRevision,
      sources: [{ evidenceId: evidence.id, digest: evidence.digest }],
      validity: { validFrom: at },
      confidence: 1,
      status: 'active',
      transition: { kind: 'created', at },
      payload: {
        text: chunk.text,
        ordinal: chunk.index,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        ...(chunk.heading === undefined ? {} : { heading: chunk.heading }),
        steps: [...extracted.steps, chunkStep],
      },
    };
  });
  const commit = await storage.commit({ tenantId, projections: records });
  return { chunks: records, commit };
}
