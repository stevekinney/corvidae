/**
 * Reading AG-UI streams in tests: the frames of a Server-Sent Events body, parsed
 * back into events with their SSE ids, and checked against `@ag-ui/core`'s own
 * schema, so a test that reads a stream also proves every event on it is valid.
 */
import type { Event } from '@ag-ui/core';
import { EventSchemas } from '@ag-ui/core/schemas';

export type ReceivedFrame = { readonly event: Event; readonly id: string | undefined };

/** Parses an SSE body. Every `data:` line must be one event the pinned schema accepts. */
export function parseAgUiFrames(body: string): ReceivedFrame[] {
  const frames: ReceivedFrame[] = [];
  for (const block of body.split('\n\n')) {
    if (block.trim() === '') continue;
    let id: string | undefined;
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('id: ')) id = line.slice(4);
      else if (line.startsWith('data: ')) data.push(line.slice(6));
    }
    const parsed = EventSchemas.safeParse(JSON.parse(data.join('\n')));
    if (!parsed.success) {
      throw new Error(`Not an AG-UI event: ${parsed.error.message}\n${data.join('\n')}`);
    }
    frames.push({ event: parsed.data as Event, id });
  }
  return frames;
}

/** Reads a response to its end and parses it. */
export async function readAgUiStream(response: Response): Promise<ReceivedFrame[]> {
  return parseAgUiFrames(await response.text());
}

/** The event types of a stream, in order, for a compact sequence assertion. */
export function typesOf(frames: ReadonlyArray<ReceivedFrame>): Array<Event['type']> {
  return frames.map((frame) => frame.event.type);
}

/** The Bureau metadata an event carries. */
export function bureauMetadata(event: Event): Record<string, unknown> {
  return (event.metadata?.['@lostgradient/bureau'] ?? {}) as Record<string, unknown>;
}

/**
 * Reads a response frame by frame, so a test can act while the stream is still
 * open (attach to the run, release a barrier) and keep reading afterwards.
 */
export class FrameReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private pending = '';
  private ended = false;
  readonly received: ReceivedFrame[] = [];

  constructor(response: Response) {
    if (response.body === null) throw new Error('The response has no body');
    this.reader = response.body.getReader();
  }

  /** The next frame, or `undefined` once the stream has ended. */
  async next(): Promise<ReceivedFrame | undefined> {
    for (;;) {
      const boundary = this.pending.indexOf('\n\n');
      if (boundary >= 0) {
        const block = this.pending.slice(0, boundary + 2);
        this.pending = this.pending.slice(boundary + 2);
        const [frame] = parseAgUiFrames(block);
        if (frame === undefined) continue;
        this.received.push(frame);
        return frame;
      }
      if (this.ended) return undefined;
      const { done, value } = await this.reader.read();
      if (done) this.ended = true;
      else this.pending += this.decoder.decode(value, { stream: true });
    }
  }

  /** Reads until a frame of `type` arrives, and returns every frame read on the way. */
  async until(type: Event['type']): Promise<ReceivedFrame[]> {
    const read: ReceivedFrame[] = [];
    for (;;) {
      const frame = await this.next();
      if (frame === undefined) throw new Error(`The stream ended before a ${type} event`);
      read.push(frame);
      if (frame.event.type === type) return read;
    }
  }

  /** Reads to the end. */
  async rest(): Promise<ReceivedFrame[]> {
    const read: ReceivedFrame[] = [];
    for (;;) {
      const frame = await this.next();
      if (frame === undefined) return read;
      read.push(frame);
    }
  }

  async cancel(): Promise<void> {
    await this.reader.cancel();
  }
}
