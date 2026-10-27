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

export async function* readEvents(
  open: () => Promise<Response>,
  options: ReadEventsOptions = {},
): AsyncGenerator<unknown> {
  for await (const frame of readEventFrames(open)) {
    options.onFrame?.();
    // Replacing the transcript invalidates the old cursor until the complete
    // snapshot/checkpoint opening has supplied its new cut ID.
    if (frame.event.type === EventType.MESSAGES_SNAPSHOT || frame.id !== undefined) {
      options.onCursor?.(frame.id || undefined);
    }
    yield frame.event;
  }
}
