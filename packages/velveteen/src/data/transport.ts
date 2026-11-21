import { createDecoder } from "./codec.ts";
import { assertPayload } from "./validate.ts";
import { dataMediaType } from "./contract.ts";
import type { Transport } from "./custom-transport.ts";

/** Read the initial frame immediately while deferred frames continue through the same native stream. */
export async function readDataResponse(
  response: Response,
  signal?: AbortSignal,
  transport: Transport = {},
) {
  if (
    !response.body ||
    !response.headers.get("content-type")?.startsWith(dataMediaType)
  )
    throw new Error("Expected a Velveteen data response");
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "",
    ended = false;
  let decoder: ReturnType<typeof createDecoder> | undefined;
  async function next(): Promise<unknown> {
    while (!buffer.includes("\n")) {
      const chunk = await reader.read();
      if (chunk.done) {
        ended = true;
        if (buffer.trim()) throw new Error("Data stream was truncated");
        return;
      }
      buffer += chunk.value;
    }
    const index = buffer.indexOf("\n"),
      line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    return JSON.parse(line);
  }
  const cancel = (
    reason: unknown = new DOMException("Aborted", "AbortError"),
  ) => {
    decoder?.abort(reason);
    void reader.cancel(reason).catch(() => {});
  };
  const abort = () => cancel(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) {
    decoder?.abort(signal.reason);
    await reader.cancel(signal.reason).catch(() => {});
    throw signal.reason ?? new DOMException("Aborted", "AbortError");
  }
  let first: unknown;
  try {
    first = await next();
    if (
      !first ||
      typeof first !== "object" ||
      !("type" in first) ||
      first.type !== "initial" ||
      !("value" in first) ||
      typeof first.value !== "string"
    )
      throw new Error("Invalid initial data frame");
    decoder = createDecoder(first.value, transport);
    assertPayload(decoder.value);
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    signal?.removeEventListener("abort", abort);
    throw error;
  }
  const done = (async () => {
    try {
      while (!ended) {
        const frame = await next();
        if (frame === undefined) break;
        decoder.accept(frame);
      }
      decoder.finish();
    } catch (error) {
      decoder.abort(error);
      await reader.cancel(error).catch(() => {});
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
      reader.releaseLock();
    }
  })();
  // Every deferred promise receives transport errors; consumers may additionally observe completion.
  void done.catch(() => {});
  return { payload: decoder.value, done, cancel };
}
