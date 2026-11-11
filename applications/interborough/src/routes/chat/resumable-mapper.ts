import {
  EventType,
  type Event,
  type MessagesSnapshotEvent,
  type RunStartedEvent,
} from '@ag-ui/core';
import { EventSchemas } from '@ag-ui/core/schemas';
import {
  createConversationHistory,
  mapAGUIEventsToChatStream,
  type ChatStreamEvent,
  type ConversationHistory,
} from '@lostgradient/chat';
import { mergeAGUIMessages } from 'conversationalist';

function isEvent(value: unknown): value is Event {
  return EventSchemas.safeParse(value).success;
}
function parsedEvent(value: unknown): Event {
  if (!isEvent(value)) throw new Error('The AG-UI stream carried an invalid event.');
  return value;
}
function identity(event: RunStartedEvent): unknown {
  const metadata: unknown = event.metadata?.['@lostgradient/bureau'];
  return typeof metadata === 'object' && metadata !== null && 'runId' in metadata
    ? metadata.runId
    : event.runId;
}

/** Application-owned recovery state. Chat's mapper continues to enforce its normal protocol. */
export class ResumableMapper {
  private base: ConversationHistory | undefined;
  private journal: Event[] = [];
  private completed = false;

  constructor(private readonly replace: (history: ConversationHistory) => void) {}

  private remember(event: Event): void {
    const previous = this.journal.at(-1);
    // Retain semantic content, not a second object for every token chunk.
    if (
      event.type === EventType.TEXT_MESSAGE_CONTENT &&
      previous?.type === event.type &&
      previous.messageId === event.messageId
    ) {
      this.journal[this.journal.length - 1] = { ...event, delta: previous.delta + event.delta };
    } else if (
      event.type === EventType.TOOL_CALL_ARGS &&
      previous?.type === event.type &&
      previous.toolCallId === event.toolCallId
    ) {
      this.journal[this.journal.length - 1] = { ...event, delta: previous.delta + event.delta };
    } else this.journal.push(event);
  }

  /**
   * Maps one attachment's events onto Chat frames, primed with the semantic prefix earlier
   * attachments of the same run were accepted with. `acknowledge` is told of each event this
   * attachment read, once Chat's mapper has accepted it, and of a `MESSAGES_SNAPSHOT` once the
   * transcript has been replaced with it. It is never told of an event replayed from the journal,
   * of one the mapper rejected, or of one that was read and not yet accepted.
   */
  async *map(
    events: AsyncIterable<unknown>,
    conversation: ConversationHistory,
    acknowledge: (event: Event) => void = () => undefined,
  ): AsyncGenerator<ChatStreamEvent> {
    let sequence = 0;
    for await (const frame of this.segments(events, conversation, acknowledge)) {
      yield { ...frame, sequence: sequence++ };
    }
  }

  private async *segments(
    events: AsyncIterable<unknown>,
    conversation: ConversationHistory,
    acknowledge: (event: Event) => void,
  ): AsyncGenerator<ChatStreamEvent> {
    const iterator = events[Symbol.asyncIterator]();
    try {
      const first = await iterator.next();
      if (first.done) {
        yield* mapAGUIEventsToChatStream([], { conversation });
        return;
      }
      const parsed = parsedEvent(first.value);
      if (parsed.type !== EventType.RUN_STARTED) {
        yield* mapAGUIEventsToChatStream(
          (async function* () {
            yield parsed;
            for (;;) {
              const next = await iterator.next();
              if (next.done) return;
              yield next.value;
            }
          })(),
          { conversation, onEventAccepted: acknowledge },
        );
        return;
      }
      const previous = this.journal[0];
      const fresh =
        this.completed ||
        previous?.type !== EventType.RUN_STARTED ||
        identity(previous) !== identity(parsed);
      // Nothing is recorded until the mapper accepts this attachment's start: a read cancelled
      // before then leaves the journal as the last accepted event left it.
      let base = fresh ? conversation : this.base;
      let prefix: Event[] = fresh ? [parsed] : [parsed, ...this.journal.slice(1)];
      let adopted = false;
      // A new HTTP attachment repeats RUN_STARTED. Prime a fresh mapper with the
      // already consumed semantic prefix, suppressing its old message outputs.
      let emittedStart = false;
      for (;;) {
        let priming = true;
        let snapshot: MessagesSnapshotEvent | undefined;
        const primed = prefix;
        const primedBase = base;
        const accept = (event: Event): void => {
          if (priming) {
            // The journal already holds what priming replays. Only this attachment's own start
            // is new, and accepting it makes the primed prefix this run's journal.
            if (event !== parsed) return;
            if (!adopted) {
              adopted = true;
              this.base = primedBase;
              this.journal = primed.slice();
              this.completed = false;
            }
            acknowledge(event);
            return;
          }
          this.remember(event);
          if (event.type === EventType.RUN_FINISHED || event.type === EventType.RUN_ERROR)
            this.completed = true;
          acknowledge(event);
        };
        const segment = (async function* () {
          yield* primed;
          priming = false;
          for (;;) {
            const next = await iterator.next();
            if (next.done) return;
            const event = parsedEvent(next.value);
            if (event.type === EventType.MESSAGES_SNAPSHOT) {
              snapshot = event;
              return;
            }
            yield event;
          }
        })();
        try {
          for await (const frame of mapAGUIEventsToChatStream(segment, {
            conversation: primedBase ?? conversation,
            onEventAccepted: accept,
          })) {
            if (!priming || (!emittedStart && frame.type === 'run.started')) {
              if (frame.type === 'run.started') emittedStart = true;
              yield frame;
            }
          }
        } catch (error) {
          // Ending a segment at a snapshot deliberately leaves the old mapper
          // incomplete. Only this exact boundary resets it; real failures escape.
          if (snapshot === undefined) throw error;
        }
        if (snapshot === undefined) return;
        const replacement = mergeAGUIMessages(
          createConversationHistory({ id: parsed.threadId }),
          snapshot.messages,
        );
        // The snapshot is accepted only once the transcript has been replaced with it: a
        // replacement that throws leaves the journal and the cursor where they were.
        this.replace(replacement);
        base = replacement;
        prefix = [parsed];
        this.base = replacement;
        this.journal = [parsed];
        acknowledge(snapshot);
      }
    } finally {
      await iterator.return?.();
    }
  }
}
