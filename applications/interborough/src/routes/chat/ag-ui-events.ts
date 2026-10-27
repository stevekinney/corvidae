/**
 * Reads an AG-UI event stream through `@ag-ui/client`'s own pipeline (`runHttpRequest` for the
 * response body, `transformHttpEventStream` for the Server-Sent Events), and hands the events
 * out as an async iterable, which is what `@lostgradient/chat`'s AG-UI transport takes.
 */
import { EventSchemas } from '@ag-ui/core/schemas';

export class AgUiHttpError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`The AG-UI request failed with HTTP ${status}.`);
    this.name = 'AgUiHttpError';
    this.status = status;
  }
}

export type AgUiEventFrame = { readonly event: unknown; readonly id: string | undefined };
type ReadEventsOptions = { readonly onCursor?: (cursor: string) => void };

function parseBlock(block: string): AgUiEventFrame | undefined {
  let id: string | undefined;
  const data: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('id:')) id = line.slice(3).trimStart();
    if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  if (data.length === 0) return undefined;
  const event: unknown = JSON.parse(data.join('\n'));
  if (!EventSchemas.safeParse(event).success)
    throw new Error('The AG-UI stream carried an invalid event.');
  return { event, id };
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
    if (frame.id !== undefined) options.onCursor?.(frame.id);
    yield frame.event;
  }
}
