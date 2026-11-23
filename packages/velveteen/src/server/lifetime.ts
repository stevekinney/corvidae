/** Keep abort propagation alive until the consumer finishes or cancels the body. */
export function ownResponse(
  response: Response,
  controller: AbortController,
  release: () => void,
  head = false,
  complete?: (outcome: "success" | "error" | "canceled") => void,
): Response {
  const reader = response.body?.getReader();
  let closed = false;
  let cancelPromise: Promise<void> | undefined;
  const finish = (outcome: "success" | "error" | "canceled") => {
    if (closed) return;
    closed = true;
    complete?.(outcome);
    controller.signal.removeEventListener("abort", abort);
    reader?.releaseLock();
    release();
  };
  const cancelReader = (reason?: unknown) => {
    if (!reader) return Promise.resolve();
    if (cancelPromise) return cancelPromise;
    const cancellation = Promise.withResolvers<void>();
    cancelPromise = cancellation.promise;
    void reader.cancel(reason).then(
      () => cancellation.resolve(),
      () => cancellation.resolve(),
    );
    return cancelPromise;
  };
  const settle = async (
    reason?: unknown,
    outcome: "error" | "canceled" | "success" = "error",
  ) => {
    await cancelReader(reason);
    finish(controller.signal.aborted ? "canceled" : outcome);
  };
  const abort = () => {
    void settle(controller.signal.reason, "canceled");
  };
  if (head || !reader) {
    void settle(undefined, "success");
    return new Response(null, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }
  controller.signal.addEventListener("abort", abort, { once: true });
  const stream = new ReadableStream<Uint8Array>({
    async pull(output) {
      try {
        controller.signal.throwIfAborted();
        const item = await reader.read();
        controller.signal.throwIfAborted();
        if (item.done) {
          finish("success");
          output.close();
        } else output.enqueue(item.value);
      } catch (error) {
        await settle(error);
        output.error(error);
      }
    },
    async cancel(reason) {
      const canceled = cancelReader(reason);
      controller.abort(
        reason ?? new DOMException("Response canceled", "AbortError"),
      );
      await canceled;
      finish("canceled");
    },
  });
  if (controller.signal.aborted) void settle(controller.signal.reason);
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
export async function abortable<Value>(
  work: Promise<Value>,
  signal: AbortSignal,
): Promise<Value> {
  signal.throwIfAborted();
  const aborted = Promise.withResolvers<never>();
  const abort = () => aborted.reject(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  try {
    return await Promise.race([work, aborted.promise]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
