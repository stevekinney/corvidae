import type { Modality, ModalityMatrix, MultiModalContent } from 'conversationalist';

import type { LivePartEvent } from '../streaming/types.ts';
import { ProviderContractError, type ProviderContractReason } from './errors.ts';
import { type DroppedReplayData } from './shared/replay-data.ts';
import type { GeminiGenerateContentResult } from './types.ts';

type GeminiResultPart = NonNullable<
  NonNullable<NonNullable<GeminiGenerateContentResult['candidates']>[number]['content']>['parts']
>[number];

/** Keys that make a Gemini part carry output. The part is classified by which one it has. */
const PAYLOAD_KEYS = [
  'text',
  'functionCall',
  'inlineData',
  'fileData',
  'executableCode',
  'codeExecutionResult',
  'functionResponse',
  'toolCall',
  'toolResponse',
  'audioTranscription',
] as const;

/** Keys that qualify a part without being output of their own. */
const MODIFIER_KEYS: ReadonlySet<string> = new Set([
  'thought',
  'thoughtSignature',
  'videoMetadata',
  'partMetadata',
  'mediaResolution',
  'mediaProcessing',
]);

/** Payloads the factory never enables a tool or request for: reaching one is a contract error. */
const UNMAPPED_PAYLOAD_KEYS: ReadonlySet<string> = new Set([
  'fileData',
  'executableCode',
  'codeExecutionResult',
  'functionResponse',
  'toolCall',
  'toolResponse',
  'audioTranscription',
]);

const KNOWN_KEYS: ReadonlySet<string> = new Set([...PAYLOAD_KEYS, ...MODIFIER_KEYS]);

/** What the mapper found that the response cannot carry. */
export interface GeminiMappingViolation {
  readonly reason: ProviderContractReason;
  readonly blockType: string;
  /** The part's position in the candidate's parts array. */
  readonly partIndex: number;
}

export interface GeminiMapping {
  /** The ordered output parts. */
  readonly parts: MultiModalContent[];
  /** Thought-summary text, in order; never answer text. */
  readonly thoughtSummaries: string[];
  /** Replay data the response carried that has no content representation. */
  readonly dropped: DroppedReplayData[];
  /** The first part outside the mapping table, if any; the adapter throws it with the usage. */
  readonly violation: GeminiMappingViolation | undefined;
}

function modalityOf(mimeType: string): Modality {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType === 'application/pdf') return 'document';
  return 'file';
}

/**
 * Maps a candidate's response parts to ordered content parts, incrementally, so the non-streaming
 * and streaming factories share one table and cannot disagree.
 *
 * A Gemini part is one object with every field optional. It is classified by its payload key and
 * qualified by modifier keys (see the module's key tables). Per payload:
 *
 * - `text` becomes a text part, coalescing with an adjacent one in both modes. With `thought: true`
 *   it is never answer text: it goes to `thoughtSummaries` and is flagged as dropped replay data
 *   (this also fixes thought text being concatenated into `content`).
 * - `functionCall` is the caller's (a tool call), and produces no part.
 * - `inlineData` becomes a media part with an `inline` base64 source, kept off every event: the
 *   wrapper admits it as a managed asset when it completes. A modality the backend does not
 *   advertise as output, or media with no media type, is a violation.
 * - Every other payload key, and any key outside both tables, is a violation naming it.
 * - A part with only modifiers is control; a `thoughtSignature` on it is dropped replay data.
 *
 * Gemini thought text is deliberately not a `thinking` part: that part requires a `signature`, which
 * Anthropic's outbound replays verbatim, so a manufactured one would turn the next Anthropic request
 * after a fallover into a 400.
 *
 * Violations are recorded, not thrown, so a streaming adapter can drain the stream, learn its usage,
 * and then throw.
 */
export function createGeminiPartMapper(options: {
  /** The selected backend's modality matrix; absent means no output modality is advertised. */
  readonly modalities: ModalityMatrix | undefined;
  readonly emit?: ((event: LivePartEvent) => void) | undefined;
}) {
  const { modalities, emit } = options;
  const parts: MultiModalContent[] = [];
  const thoughtSummaries: string[] = [];
  const dropped: DroppedReplayData[] = [];
  let violation: GeminiMappingViolation | undefined;
  /** The text part still accepting text, with the delta sequence reported so far. */
  let openText: { partIndex: number; text: string; sequence: number } | undefined;

  function closeText(): void {
    if (openText === undefined) return;
    const part: MultiModalContent = { type: 'text', text: openText.text };
    parts[openText.partIndex] = part;
    emit?.({ type: 'complete', partIndex: openText.partIndex, part });
    openText = undefined;
  }

  function appendText(text: string): void {
    if (text === '') return;
    if (openText === undefined) {
      const partIndex = parts.length;
      parts.push({ type: 'text', text: '' });
      openText = { partIndex, text: '', sequence: 0 };
      emit?.({ type: 'start', partIndex, kind: 'text' });
    }
    openText.text += text;
    openText.sequence += 1;
    parts[openText.partIndex] = { type: 'text', text: openText.text };
    emit?.({
      type: 'delta',
      partIndex: openText.partIndex,
      sequence: openText.sequence,
      delta: { kind: 'text', text },
    });
  }

  function violate(reason: ProviderContractReason, blockType: string, partIndex: number): void {
    violation ??= { reason, blockType, partIndex };
  }

  return {
    /** Maps one response part. `position` is its index in the candidate's parts, across chunks. */
    push(part: GeminiResultPart | Record<string, unknown>, position: number): void {
      const record = part as Record<string, unknown>;
      const keys = Object.keys(record).filter((key) => record[key] !== undefined);
      const unknownKey = keys.find((key) => !KNOWN_KEYS.has(key));
      if (unknownKey !== undefined) return violate('unlisted-block', unknownKey, position);
      const unmapped = keys.find((key) => UNMAPPED_PAYLOAD_KEYS.has(key));
      if (unmapped !== undefined) return violate('unlisted-block', unmapped, position);

      if (record['thoughtSignature'] !== undefined) {
        dropped.push({
          provider: 'gemini',
          providerPartIndex: position,
          field: 'thoughtSignature',
        });
      }

      const text = record['text'];
      if (typeof text === 'string' && text !== '') {
        if (record['thought'] === true) {
          thoughtSummaries.push(text);
          dropped.push({ provider: 'gemini', providerPartIndex: position, field: 'thought' });
        } else {
          appendText(text);
        }
        return;
      }

      const inline = record['inlineData'] as { mimeType?: string; data?: string } | undefined;
      if (inline !== undefined) {
        if (inline.mimeType === undefined || inline.data === undefined) {
          return violate('unlisted-block', 'inlineData', position);
        }
        const modality = modalityOf(inline.mimeType);
        if (modalities?.[modality]?.output !== true) {
          return violate('unadvertised-modality', modality, position);
        }
        closeText();
        const partIndex = parts.length;
        const media: MultiModalContent = {
          type: modality === 'file' ? 'file' : modality,
          mimeType: inline.mimeType,
          source: { kind: 'inline', data: inline.data, encoding: 'base64' },
        } as MultiModalContent;
        parts.push(media);
        emit?.({ type: 'start', partIndex, kind: media.type, mimeType: inline.mimeType });
        emit?.({ type: 'complete', partIndex, part: media });
      }
      // `functionCall` is a tool call, owned by the caller; modifier-only parts are control.
    },

    /** Closes the open text part and returns everything mapped. */
    finish(): GeminiMapping {
      closeText();
      return { parts, thoughtSummaries, dropped, violation };
    },
  };
}

/** Builds the contract error for a recorded violation. */
export function geminiViolationError(
  violation: GeminiMappingViolation,
  usage: ConstructorParameters<typeof ProviderContractError>[0]['usage'],
): ProviderContractError {
  return new ProviderContractError({
    provider: 'gemini',
    reason: violation.reason,
    blockType: violation.blockType,
    partIndex: violation.partIndex,
    usage,
  });
}
