import { type Event, EventType } from '@ag-ui/core';

/** The open step's semantic state, independent of the bounded resume log. */
export class ProjectionCheckpoint {
  private events: Event[] = [];

  record(event: Event): void {
    if (event.type === EventType.STEP_STARTED) this.events = [];
    if (event.type === EventType.STEP_FINISHED) {
      this.events = [];
      return;
    }
    if (event.type === EventType.TEXT_MESSAGE_CONTENT) {
      const index = this.events.findIndex(
        (entry) =>
          entry.type === EventType.TEXT_MESSAGE_CONTENT && entry.messageId === event.messageId,
      );
      const previous = this.events[index];
      if (previous?.type === EventType.TEXT_MESSAGE_CONTENT) {
        this.events[index] = { ...previous, delta: previous.delta + event.delta };
        return;
      }
    }
    this.events.push(event);
  }

  /** Do not replay rows the durable conversation at this cut already contains. */
  read(held: ReadonlySet<string>): Event[] {
    const heldCalls = new Set(
      this.events.flatMap((event) =>
        event.type === EventType.TOOL_CALL_START &&
        event.parentMessageId !== undefined &&
        held.has(event.parentMessageId)
          ? [event.toolCallId]
          : [],
      ),
    );
    return this.events.filter((event) => {
      if ('messageId' in event && typeof event.messageId === 'string' && held.has(event.messageId))
        return false;
      if (
        'toolCallId' in event &&
        typeof event.toolCallId === 'string' &&
        heldCalls.has(event.toolCallId)
      )
        return false;
      if (event.type === EventType.CUSTOM) {
        const value: unknown = event.value;
        if (
          typeof value === 'object' &&
          value !== null &&
          'messageId' in value &&
          typeof value.messageId === 'string' &&
          held.has(value.messageId)
        )
          return false;
      }
      return true;
    });
  }
}
