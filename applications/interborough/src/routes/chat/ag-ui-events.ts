/**
 * Reads Bureau's SSE frames without losing their opaque IDs. The pinned AG-UI
 * schema validates each event before the application's transport consumes it.
 */
import { EventType } from '@ag-ui/core';
import { EventSchemas } from '@ag-ui/core/schemas';

export class AgUiHttpError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`The AG-UI request failed with HTTP ${status}.`);
    this.name = 'AgUiHttpError';
    this.status = status;
  }
}

export type AgUiEventFrame = {
  readonly event: ReturnType<typeof EventSchemas.parse>;
  readonly id: string | undefined;
};
type ReadEventsOptions = {
  readonly onCursor?: (cursor: string | undefined) => void;
  readonly onFrame?: () => void;
};

function parseBlock(block: string): AgUiEventFrame | undefined {
  let id: string | undefined;
  const data: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('id:')) id = line.slice(3).trimStart();
    if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  if (data.length === 0) return undefined;
  const event: unknown = JSON.parse(data.join('\n'));
  const parsed = EventSchemas.safeParse(event);
  if (!parsed.success) throw new Error('The AG-UI stream carried an invalid event.');
  return { event: parsed.data, id };
}

export async function* readEventFrames(
  open: () => Promise<Response>,
): AsyncGenerator<AgUiEventFrame> {
  const response = await open();
  if (!response.ok) throw new AgUiHttpError(response.status);
  if (response.body === null) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  try {
    for (;;) {
      const result = await reader.read();
      pending += decoder.decode(result.value ?? new Uint8Array(), { stream: !result.done });
      pending = pending.replaceAll('\r\n', '\n');
      const blocks = pending.split('\n\n');
      pending = blocks.pop() ?? '';
      for (const block of blocks) {
        const parsed = parseBlock(block.replaceAll('\r\n', '\n'));
        if (parsed !== undefined) yield parsed;
      }
      if (result.done) {
        const parsed = parseBlock(pending);
        if (parsed !== undefined) yield parsed;
        return;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/**
 * The cursor commit each event {@link readEvents} yielded is owed, keyed by the event object
 * itself: the event passes through the page's generators to Chat's mapper unchanged, and only the
 * mapper knows when it has been accepted. An event that is never acknowledged is simply collected.
 */
const pendingCursors = new WeakMap<object, () => void>();

/**
 * Commits the resume cursor `event` carried, if {@link readEvents} yielded it with one and it has
 * not been acknowledged yet. Call it once Chat's mapper has accepted the event (and, for a
 * `MESSAGES_SNAPSHOT`, once the transcript has been replaced with it), so a reattach resumes after
 * the last event the transcript holds: never past one it lost, never before one it has. A second
 * call for the same event does nothing.
 */
export function acknowledgeEvent(event: unknown): void {
  if (typeof event !== 'object' || event === null) return;
  const commit = pendingCursors.get(event);
  if (commit === undefined) return;
  pendingCursors.delete(event);
  commit();
}

/**
 * Reads the AG-UI events of a response. `options.onCursor` is not told of a frame's cursor when the
 * frame is read: it is told when the event is passed to {@link acknowledgeEvent}, so the callback's
 * own ownership checks run at acknowledgment.
 */
export async function* readEvents(
  open: () => Promise<Response>,
  options: ReadEventsOptions = {},
): AsyncGenerator<unknown> {
  const { onCursor } = options;
  for await (const frame of readEventFrames(open)) {
    options.onFrame?.();
    // Replacing the transcript invalidates the old cursor until the complete
    // snapshot/checkpoint opening has supplied its new cut ID.
    if (
      onCursor !== undefined &&
      (frame.event.type === EventType.MESSAGES_SNAPSHOT || frame.id !== undefined)
    ) {
      const cursor = frame.id || undefined;
      pendingCursors.set(frame.event, () => onCursor(cursor));
    }
    yield frame.event;
  }
}
