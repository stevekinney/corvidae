import { createDefaultRuntimeServices, type RuntimeServices } from '@repo/lifecycle';

import type { ChunkingOptions, ContentChunk } from './chunking';
import { chunkMarkdown } from './chunking';
import { sha256Hex } from './hash';
import type { Memory, MemoryEntry, MemoryMetadata } from './types';

export const SOURCE_DOCUMENT_KEY = '__sourceDocument';
export const CHUNK_INDEX_KEY = '__chunkIndex';

/**
 * The pluggable loader contract: turn a document's text into chunks.
 * `chunkMarkdown` is the default; pass `chunkHtml`, `chunkText` (wrapped to
 * close over structure hints), or any custom function that matches this
 * signature. No loader is bundled beyond Markdown and HTML — everything else
 * (PDF, DOCX, ...) extracts text externally and hands it to `chunkText`.
 */
export type ChunkerFunction = (
  document: string,
  options?: ChunkingOptions,
) => ContentChunk[] | Promise<ContentChunk[]>;

export interface IngestOptions extends ChunkingOptions {
  /** Identifier for the source document. Used for result deduplication in recall. */
  sourceIdentifier?: string;
  /** Additional metadata to attach to each chunk. */
  metadata?: Partial<MemoryMetadata>;
  /** Progress callback fired after each chunk is stored. */
  onProgress?: (progress: { completed: number; total: number }) => void;
  /**
   * Loader that turns `content` into chunks. Defaults to `chunkMarkdown`.
   * Pass `chunkHtml` to ingest HTML, or a custom function that closes over
   * pre-extracted text and structure hints (see `chunkText`) for other
   * formats such as PDF.
   */
  chunk?: ChunkerFunction;
  /**
   * Runtime services to read the default `sourceIdentifier` from when it is
   * omitted. Defaults to the real implementation
   * (`createDefaultRuntimeServices()`). A test composes its own via
   * `createManualRuntimeServices()` from `lifecycle`.
   */
  runtime?: RuntimeServices;
}

export interface IngestResult {
  sourceIdentifier: string;
  entries: MemoryEntry[];
  chunkCount: number;
}

async function storeChunks(
  memory: Memory,
  chunks: ContentChunk[],
  sourceIdentifier: string,
  metadata: Partial<MemoryMetadata> | undefined,
  onProgress: IngestOptions['onProgress'],
): Promise<MemoryEntry[]> {
  const entries: MemoryEntry[] = [];
  for (const chunk of chunks) {
    const dedupeKey = await sha256Hex(`${sourceIdentifier}\0${chunk.index}\0${chunk.text}`);
    entries.push(
      await memory.rememberOnce(chunk.text, {
        ...metadata,
        [SOURCE_DOCUMENT_KEY]: sourceIdentifier,
        [CHUNK_INDEX_KEY]: chunk.index,
        dedupeKey,
      }),
    );
    onProgress?.({ completed: entries.length, total: chunks.length });
  }
  return entries;
}

/**
 * Chunks content and stores each chunk as a separate memory entry via
 * `memory.rememberOnce()`.
 *
 * Each chunk's metadata includes `__sourceDocument` and `__chunkIndex` keys
 * that enable `recall()` to deduplicate results from the same source document,
 * returning only the highest-scoring chunk per source.
 *
 * Idempotent: each chunk's `dedupeKey` is derived from the source identifier,
 * chunk index, and chunk text, so re-ingesting the same document through any
 * loader (with the same `sourceIdentifier`) stores no new entries.
 */
export async function ingest(
  memory: Memory,
  content: string,
  options?: IngestOptions,
): Promise<IngestResult> {
  const runtime = options?.runtime ?? createDefaultRuntimeServices();
  const sourceIdentifier = options?.sourceIdentifier ?? runtime.identifiers.next('source-document');
  const chunker = options?.chunk ?? chunkMarkdown;
  const chunks = await chunker(content, options);

  const entries = await storeChunks(
    memory,
    chunks,
    sourceIdentifier,
    options?.metadata,
    options?.onProgress,
  );

  return {
    sourceIdentifier,
    entries,
    chunkCount: chunks.length,
  };
}
