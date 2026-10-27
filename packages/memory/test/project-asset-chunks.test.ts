import { MemoryStorage } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { createInMemoryEvidenceProjectionStorage } from '../src/create-in-memory-evidence-projection-storage';
import { createWeftEvidenceProjectionStorage } from '../src/create-weft-evidence-projection-storage';
import type { TransformationStep } from '../src/evidence-projection-schema';
import type { EvidenceProjectionStorage } from '../src/evidence-projection-storage';
import { digestOfText, MemoryEvidenceValidationError } from '../src/evidence-schema';
import { projectAssetChunks } from '../src/project-asset-chunks';
import {
  FIXED_AT,
  makeAssetEvidence,
  makeInlineEvidence,
  NAMESPACE,
  TENANT,
} from './evidence-projection-fixtures';

const EXTRACTED = [
  '# Scanned report',
  '',
  'The first paragraph describes the quarterly results in some detail.',
  '',
  'The second paragraph describes the outlook for the next quarter.',
  '',
  'The third paragraph lists the open risks and their owners.',
].join('\n');
const OCR_TEXT = 'raw optical character output';
const PRODUCER = { kind: 'service', id: 'ocr', version: '3' } as const;

const BACKENDS: ReadonlyArray<readonly [string, () => EvidenceProjectionStorage]> = [
  ['in-memory', () => createInMemoryEvidenceProjectionStorage()],
  ['weft', () => createWeftEvidenceProjectionStorage(new MemoryStorage())],
];

function ocrThenExtract(assetDigest: string): TransformationStep[] {
  return [
    {
      step: 'ocr',
      producer: PRODUCER,
      inputDigest: assetDigest,
      outputDigest: digestOfText(OCR_TEXT),
    },
    {
      step: 'extract',
      producer: PRODUCER,
      inputDigest: digestOfText(OCR_TEXT),
      outputDigest: digestOfText(EXTRACTED),
    },
  ];
}

function run(
  storage: EvidenceProjectionStorage,
  overrides: Partial<Parameters<typeof projectAssetChunks>[0]> &
    Pick<Parameters<typeof projectAssetChunks>[0], 'evidence' | 'extracted'>,
) {
  return projectAssetChunks({
    storage,
    tenantId: TENANT,
    namespace: NAMESPACE,
    chunker: 'markdown',
    chunking: { maximumTokens: 20, overlapTokens: 0 },
    projectorRevision: 'chunker:1',
    policyRevision: 'policy:1',
    now: () => FIXED_AT + 5,
    idFor: (ordinal) => `chunk-${ordinal}`,
    ...overrides,
  });
}

for (const [label, makeBackend] of BACKENDS) {
  describe(`projectAssetChunks (${label})`, () => {
    it('carries the asset identity and digest through every transformation step', async () => {
      const storage = makeBackend();
      const asset = makeAssetEvidence('doc1');
      await storage.appendEvidence(asset);
      const { chunks } = await run(storage, {
        evidence: asset,
        extracted: { text: EXTRACTED, steps: ocrThenExtract(asset.digest) },
      });

      expect(chunks.length).toBeGreaterThan(1);
      for (const written of chunks) {
        const stored = await storage.getProjection(TENANT, NAMESPACE, written.id);
        expect(stored).toEqual(written);
        expect(stored?.kind).toBe('chunk');
        expect(stored?.sources).toEqual([{ evidenceId: 'doc1', digest: asset.digest }]);
        if (stored?.kind !== 'chunk') throw new Error('expected a chunk');
        const { steps, text } = stored.payload;
        expect(steps.map((step) => step.step)).toEqual(['ocr', 'extract', 'chunk']);
        expect(steps[0]?.inputDigest).toBe(asset.digest);
        steps.forEach((step, index) => {
          if (index > 0) expect(step.inputDigest).toBe(steps[index - 1]?.outputDigest ?? '');
        });
        expect(steps[2]?.inputDigest).toBe(digestOfText(EXTRACTED));
        expect(steps.at(-1)?.outputDigest).toBe(digestOfText(text));
      }
      // The source asset is untouched by projecting from it.
      expect(await storage.getEvidence(TENANT, 'doc1')).toEqual(asset);
    });

    it('chunks inline evidence with no extraction steps when the text is the evidence', async () => {
      const storage = makeBackend();
      const inline = makeInlineEvidence('note1', { text: EXTRACTED });
      await storage.appendEvidence(inline);
      const { chunks } = await run(storage, {
        evidence: inline,
        extracted: { text: EXTRACTED, steps: [] },
      });
      expect(chunks.length).toBeGreaterThan(1);
      const first = chunks[0];
      if (first?.kind !== 'chunk') throw new Error('expected a chunk');
      expect(first.payload.steps).toHaveLength(1);
      expect(first.payload.steps[0]?.inputDigest).toBe(inline.digest);
    });

    it('supports the text and html chunkers', async () => {
      const storage = makeBackend();
      const asset = makeAssetEvidence('doc2');
      await storage.appendEvidence(asset);
      const html = '<html><body><h1>Title</h1><p>Hello from the page.</p></body></html>';
      const steps: TransformationStep[] = [
        {
          step: 'extract',
          producer: PRODUCER,
          inputDigest: asset.digest,
          outputDigest: digestOfText(html),
        },
      ];
      const viaHtml = await run(storage, {
        evidence: asset,
        extracted: { text: html, steps },
        chunker: 'html',
        idFor: (ordinal) => `html-${ordinal}`,
      });
      expect(viaHtml.chunks.length).toBeGreaterThan(0);
      const viaText = await run(storage, {
        evidence: asset,
        extracted: { text: html, steps },
        chunker: 'text',
        idFor: (ordinal) => `text-${ordinal}`,
      });
      expect(viaText.chunks.length).toBeGreaterThan(0);
    });

    it('refuses a chain that does not start at the evidence digest, before reading storage', async () => {
      const storage = makeBackend();
      const asset = makeAssetEvidence('doc1'); // never stored: the check must fire first
      const steps = ocrThenExtract(digestOfText('some other asset'));
      const error = await rejectionOf(
        run(storage, { evidence: asset, extracted: { text: EXTRACTED, steps } }),
      );
      expect(error).toBeInstanceOf(MemoryEvidenceValidationError);
      expect((error as MemoryEvidenceValidationError).code).toBe('digest-mismatch');
    });

    it('refuses extracted text its last step did not produce', async () => {
      const storage = makeBackend();
      const asset = makeAssetEvidence('doc1');
      const error = await rejectionOf(
        run(storage, {
          evidence: asset,
          extracted: { text: `${EXTRACTED} edited`, steps: ocrThenExtract(asset.digest) },
        }),
      );
      expect((error as MemoryEvidenceValidationError).code).toBe('digest-mismatch');
    });

    it('refuses a chain with a broken link between extraction steps', async () => {
      const storage = makeBackend();
      const asset = makeAssetEvidence('doc1');
      const steps = ocrThenExtract(asset.digest);
      const [ocr, extract] = steps;
      const broken = [ocr!, { ...extract!, inputDigest: digestOfText('not the ocr output') }];
      const error = await rejectionOf(
        run(storage, { evidence: asset, extracted: { text: EXTRACTED, steps: broken } }),
      );
      expect((error as MemoryEvidenceValidationError).code).toBe('digest-mismatch');
    });

    it('refuses step-less text that is not the evidence itself', async () => {
      const storage = makeBackend();
      const inline = makeInlineEvidence('note1', { text: 'the real note' });
      const error = await rejectionOf(
        run(storage, { evidence: inline, extracted: { text: 'a different text', steps: [] } }),
      );
      expect((error as MemoryEvidenceValidationError).code).toBe('digest-mismatch');
    });
  });
}
