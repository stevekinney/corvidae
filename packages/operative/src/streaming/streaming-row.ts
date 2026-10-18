import type { Conversation, MediaContent, MultiModalContent } from 'conversationalist';

import { GeneratedMediaNotAdmittedError } from '../errors';
import {
  type GeneratedMediaAdmission,
  settleMediaAdmission,
  type StepGeneratedMediaAdmitter,
} from '../generated-media';
import {
  deriveParts,
  type InlineMediaContent,
  inlineMediaParts,
  rowContentForParts,
} from '../response-parts';
import type { GenerateContext, GenerateResponse, StreamingHandle } from '../types';
import { cancelStreamingIfActive } from './cancel-streaming';
import { createStreamStateMachine } from './stream-state-machine';
import type {
  CompletedPartView,
  LivePartEvent,
  ManagedAssetSource,
  PartKind,
  StreamEvent,
  StreamPart,
  StreamStateMachine,
} from './types';

/** The part-level events a streaming row announces, in order. */
export type PartStreamEvent = Extract<StreamEvent, { type: `stream:part-${string}` }>;

export interface StreamingRowObserver {
  /** Called for every part event that changed the state, in order. */
  onPartEvent?: ((event: PartStreamEvent) => void) | undefined;
  /** Called with each answer-text delta, and the text of every text part so far. */
  onText?: ((delta: string, accumulated: string) => void) | undefined;
}

/** The part index a hand-written function's `update` text lives at. */
const UPDATE_PART_INDEX = 0;

const MEDIA_TYPES: ReadonlySet<string> = new Set(['image', 'audio', 'video', 'document', 'file']);

function isMedia(part: MultiModalContent): part is MediaContent {
  return MEDIA_TYPES.has(part.type);
}

/** The length of the bytes an inline source carries, for the completed view only. */
function inlineByteLength(source: Extract<MediaContent['source'], { kind: 'inline' }>): number {
  if (source.encoding === 'utf8') return new TextEncoder().encode(source.data).byteLength;
  const padding = source.data.endsWith('==') ? 2 : source.data.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((source.data.length * 3) / 4) - padding);
}

/** A completed part as an event shows it: a media part never carries its source. */
function viewOf(part: MultiModalContent): CompletedPartView {
  if (!isMedia(part)) return part;
  const { source, ...rest } = part;
  return {
    ...rest,
    ...(source.kind === 'inline' ? { byteLength: inlineByteLength(source) } : {}),
  };
}

type AdmissionOutcome =
  | { readonly ok: true; readonly part: MediaContent }
  | { readonly ok: false; readonly error: GeneratedMediaNotAdmittedError };

interface TrackedAdmission {
  admission: GeneratedMediaAdmission | undefined;
  readonly outcome: Promise<AdmissionOutcome>;
}

/**
 * The row a streaming wrapper owns for one response. It appends the streaming row, hands the
 * adapter a {@link StreamingHandle}, keeps the row current as parts arrive, admits a generated
 * media part as a managed asset the moment it completes, and finishes by committing the settled
 * parts in the same write that clears the streaming flag. Both `withStreaming` and
 * `withEnhancedStreaming` are thin shells around it; the enhanced one observes the part events.
 *
 * The part machinery is the one {@link createStreamStateMachine}: a delta that machine would not
 * apply (a duplicate sequence, a late delta, a string delta for media) is dropped here too, so
 * the row, the events and the final snapshot cannot disagree.
 */
export function createStreamingRow(options: {
  readonly conversation: Conversation;
  readonly context: GenerateContext;
  readonly machine?: StreamStateMachine | undefined;
  readonly observer?: StreamingRowObserver | undefined;
}) {
  const { conversation, context, observer } = options;
  const machine = options.machine ?? createStreamStateMachine();
  const admitter: StepGeneratedMediaAdmitter | undefined = context.generatedMediaAdmitter;
  const messageId = conversation.appendStreamingMessage('assistant');

  const admissions = new Map<number, TrackedAdmission>();
  let updateSequence = 0;
  let lastWrittenRow: string | undefined;
  let updateMode = false;

  function findPart(partIndex: number): StreamPart | undefined {
    return machine.getState().parts.find((part) => part.partIndex === partIndex);
  }

  function accumulatedText(): string {
    return machine
      .getState()
      .parts.filter((part) => part.kind === 'text')
      .map((part) => part.text ?? '')
      .join('');
  }

  /** Applies a part command and announces the matching event, unless the machine would ignore it. */
  function apply(
    command: Parameters<StreamStateMachine['process']>[0],
    event: PartStreamEvent,
  ): boolean {
    if (!machine.accepts(command)) return false;
    machine.process(command);
    observer?.onPartEvent?.(event);
    return true;
  }

  /** The row's content as it stands: the parts seen so far, with media only once it is available. */
  function interimParts(): MultiModalContent[] {
    const interim: MultiModalContent[] = [];
    for (const part of machine.getState().parts) {
      if (part.status === 'failed') continue;
      if (part.part !== undefined) {
        interim.push(part.part);
      } else if (part.status === 'streaming' && part.kind === 'text' && part.text) {
        interim.push({ type: 'text', text: part.text });
      } else if (part.status === 'streaming' && part.kind === 'thinking' && part.text) {
        interim.push({ type: 'thinking', thinking: part.text, signature: '' });
      }
    }
    return interim;
  }

  function writeRow(): void {
    const parts = interimParts();
    if (parts.length === 0) return;
    const content = rowContentForParts(parts);
    const serialized = JSON.stringify(content);
    if (serialized === lastWrittenRow) return;
    lastWrittenRow = serialized;
    conversation.updateStreamingMessage(messageId, content);
  }

  function startAdmission(partIndex: number, part: InlineMediaContent): void {
    const admissionContext = { step: context.step, partIndex, messageId };
    let tracked!: TrackedAdmission;
    const outcome = (async (): Promise<AdmissionOutcome> => {
      try {
        if (admitter === undefined) {
          throw new GeneratedMediaNotAdmittedError({
            reason: 'no-admitter',
            step: context.step,
            partIndex,
            messageId,
            modality: part.type,
          });
        }
        const admission = await admitter.admit({ part, partIndex, messageId });
        tracked.admission = admission;
        apply(
          { type: 'part-link-asset', messageId, partIndex, source: admission.source },
          { type: 'stream:part-asset-linked', messageId, partIndex, source: admission.source },
        );
        const admitted = await settleMediaAdmission(admission, part, admissionContext);
        const source = admitted.source as ManagedAssetSource;
        apply(
          { type: 'part-asset-available', messageId, partIndex, source },
          { type: 'stream:part-asset-available', messageId, partIndex, source },
        );
        writeRow();
        return { ok: true, part: admitted };
      } catch (error) {
        const typed =
          error instanceof GeneratedMediaNotAdmittedError
            ? error
            : new GeneratedMediaNotAdmittedError({
                reason: 'admission-failed',
                step: context.step,
                partIndex,
                messageId,
                modality: part.type,
                detail: error instanceof Error ? error.message : String(error),
                cause: error,
              });
        apply(
          { type: 'part-fail', messageId, partIndex, error: typed },
          { type: 'stream:part-failed', messageId, partIndex, error: typed },
        );
        return { ok: false, error: typed };
      }
    })();
    tracked = { admission: undefined, outcome };
    admissions.set(partIndex, tracked);
  }

  function startPart(partIndex: number, kind: PartKind, mimeType?: string): void {
    apply(
      {
        type: 'part-start',
        messageId,
        partIndex,
        kind,
        ...(mimeType === undefined ? {} : { mimeType }),
      },
      {
        type: 'stream:part-start',
        messageId,
        partIndex,
        kind,
        ...(mimeType === undefined ? {} : { mimeType }),
      },
    );
  }

  function completePart(partIndex: number, part: MultiModalContent): void {
    const view = viewOf(part);
    const completed = apply(
      { type: 'part-complete', messageId, partIndex, part: view },
      { type: 'stream:part-complete', messageId, partIndex, part: view },
    );
    if (!completed) return;
    if (isMedia(part)) {
      if (part.source.kind === 'inline') {
        startAdmission(partIndex, part as InlineMediaContent);
      } else if (part.source.kind === 'managed-asset') {
        const source = part.source;
        apply(
          { type: 'part-asset-available', messageId, partIndex, source },
          { type: 'stream:part-asset-available', messageId, partIndex, source },
        );
      }
    }
    writeRow();
  }

  function reportPart(event: LivePartEvent): void {
    switch (event.type) {
      case 'start':
        startPart(event.partIndex, event.kind, event.mimeType);
        return;
      case 'delta': {
        const applied = apply(
          {
            type: 'part-delta',
            messageId,
            partIndex: event.partIndex,
            sequence: event.sequence,
            delta: event.delta,
          },
          {
            type: 'stream:part-delta',
            messageId,
            partIndex: event.partIndex,
            sequence: event.sequence,
            delta: event.delta,
          },
        );
        if (!applied) return;
        if (event.delta.kind === 'text') observer?.onText?.(event.delta.text, accumulatedText());
        writeRow();
        return;
      }
      case 'progress':
        apply(
          {
            type: 'part-progress',
            messageId,
            partIndex: event.partIndex,
            sequence: event.sequence,
            receivedBytes: event.receivedBytes,
            ...(event.totalBytes === undefined ? {} : { totalBytes: event.totalBytes }),
          },
          {
            type: 'stream:part-progress',
            messageId,
            partIndex: event.partIndex,
            sequence: event.sequence,
            receivedBytes: event.receivedBytes,
            ...(event.totalBytes === undefined ? {} : { totalBytes: event.totalBytes }),
          },
        );
        return;
      case 'complete':
        completePart(event.partIndex, event.part);
        return;
      case 'failed':
        apply(
          { type: 'part-fail', messageId, partIndex: event.partIndex, error: event.error },
          { type: 'stream:part-failed', messageId, partIndex: event.partIndex, error: event.error },
        );
        return;
    }
  }

  /** The legacy channel: cumulative text so far, as a hand-written function reports it. */
  function update(content: string): void {
    updateMode = true;
    if (!findPart(UPDATE_PART_INDEX)) startPart(UPDATE_PART_INDEX, 'text');
    const previous = findPart(UPDATE_PART_INDEX)?.text ?? '';
    const delta = content.slice(previous.length);
    if (delta.length > 0) {
      reportPartDelta(delta);
    }
    // The row shows exactly what the function reported, as it always has.
    conversation.updateStreamingMessage(messageId, content);
    lastWrittenRow = JSON.stringify(content);
  }

  function reportPartDelta(text: string): void {
    updateSequence += 1;
    const sequence = updateSequence;
    const applied = apply(
      {
        type: 'part-delta',
        messageId,
        partIndex: UPDATE_PART_INDEX,
        sequence,
        delta: { kind: 'text', text },
      },
      {
        type: 'stream:part-delta',
        messageId,
        partIndex: UPDATE_PART_INDEX,
        sequence,
        delta: { kind: 'text', text },
      },
    );
    if (applied) observer?.onText?.(text, accumulatedText());
  }

  const handle: StreamingHandle = { messageId, update, reportPart };

  /** Aborts every admission still open and waits for each to settle. */
  async function settleOpenAdmissions(reason: string): Promise<void> {
    for (const tracked of admissions.values()) tracked.admission?.abort(reason);
    await Promise.allSettled([...admissions.values()].map((tracked) => tracked.outcome));
  }

  return {
    messageId,
    handle,
    machine,

    /**
     * Commits the settled response: completes parts the function left open, waits for every
     * admission, then finalizes the row with the settled parts in one write. A refused or
     * cancelled admission cancels the row and throws a {@link GeneratedMediaNotAdmittedError}
     * carrying the response's usage. A response with no parts commits no row.
     */
    async finish(response: GenerateResponse): Promise<GenerateResponse> {
      const finalParts: readonly MultiModalContent[] =
        response.parts ?? deriveParts(response.content);

      // Parts the function never completed (an update-only function's text) close with the
      // response's own version of them.
      for (const part of machine.getState().parts) {
        if (part.status !== 'streaming') continue;
        const settled = finalParts[part.partIndex];
        if (settled !== undefined) completePart(part.partIndex, settled);
        else if (part.kind === 'text')
          completePart(part.partIndex, { type: 'text', text: part.text ?? '' });
      }

      // Generated media that was never reported part by part is admitted now.
      for (const { index, part } of inlineMediaParts(finalParts)) {
        if (admissions.has(index)) continue;
        if (!findPart(index)) startPart(index, part.type, part.mimeType);
        if (findPart(index)?.status === 'streaming') completePart(index, part);
        else startAdmission(index, part);
      }

      if (context.signal?.aborted) {
        for (const tracked of admissions.values())
          tracked.admission?.abort('The run was cancelled');
      }
      const outcomes = new Map<number, AdmissionOutcome>();
      for (const [index, tracked] of admissions) outcomes.set(index, await tracked.outcome);
      const failure = [...outcomes.values()].find((outcome) => !outcome.ok);
      if (failure && !failure.ok) {
        await settleOpenAdmissions('A sibling admission failed');
        cancelStreamingIfActive(conversation, messageId);
        failure.error.usage = response.usage;
        throw failure.error;
      }

      const parts = finalParts.map((part, index) => {
        const outcome = outcomes.get(index);
        return outcome?.ok ? outcome.part : part;
      });

      if (parts.length === 0) {
        // Nothing to commit: do not leave an empty assistant row behind.
        cancelStreamingIfActive(conversation, messageId);
        const { messageAppended: _appended, messageId: _id, ...rest } = response;
        return { ...rest, parts: [] };
      }

      conversation.finalizeStreamingMessage(messageId, {
        ...(response.usage === undefined ? {} : { tokenUsage: response.usage }),
        ...(response.metadata === undefined ? {} : { metadata: response.metadata }),
        content: rowContentForParts(parts),
      });
      return { ...response, parts, messageAppended: true, messageId };
    },

    /** Abandons the row: aborts every open admission, waits for them to settle, cancels the row. */
    async abandon(): Promise<void> {
      await settleOpenAdmissions('The stream failed');
      cancelStreamingIfActive(conversation, messageId);
    },

    /** True once a hand-written function has used the legacy `update` channel. */
    get usedUpdate(): boolean {
      return updateMode;
    },
  };
}
