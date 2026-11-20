import { parse, stringify } from "devalue";
import type { PublicError } from "./contract.ts";
import {
  transportReducers,
  transportRevivers,
  type Transport,
} from "./custom-transport.ts";
export { assertPayload } from "./validate.ts";
export type Settlement =
  | { type: "resolve"; id: number; value: string }
  | { type: "reject"; id: number; error: PublicError };
export type InitialFrame = { type: "initial"; value: string };

/** Inert JSON remains inert even when application data contains an HTML script terminator. */
export const escapeJson = (value: unknown) =>
  JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");

/** Encode once, then let native stream pulls deliver deferred settlements under backpressure. */
export function encodePayload(
  value: unknown,
  options: {
    signal?: AbortSignal;
    onError?: (error: unknown) => PublicError;
    transport?: Transport;
  } = {},
) {
  const identifiers = new Map<Promise<unknown>, number>();
  const pending = new Map<number, Promise<{ id: number; frame: Settlement }>>();
  let next = 1,
    closed = false;
  const stopped = Promise.withResolvers<never>();
  // The reader observes cancellation; marking this coordination promise handled avoids a detached rejection before the first pull.
  void stopped.promise.catch(() => {});
  const publicError = (error: unknown): PublicError => {
    try {
      return options.onError?.(error) ?? { message: "Internal Error" };
    } catch {
      return { message: "Internal Error" };
    }
  };
  const reducers = transportReducers(options.transport);
  const encode = (input: unknown): string =>
    stringify(input, {
      Promise: (candidate: unknown) => {
        if (!(candidate instanceof Promise)) return;
        const previous = identifiers.get(candidate);
        if (previous) return previous;
        const id = next++;
        identifiers.set(candidate, id);
        const task = candidate.then(
          (deferredValue) => {
            try {
              return {
                id,
                frame: {
                  type: "resolve" as const,
                  id,
                  value: closed ? "null" : encode(deferredValue),
                },
              };
            } catch (error) {
              return {
                id,
                frame: {
                  type: "reject" as const,
                  id,
                  error: publicError(error),
                },
              };
            }
          },
          (error) => ({
            id,
            frame: { type: "reject" as const, id, error: publicError(error) },
          }),
        );
        void task.catch(() => {});
        pending.set(id, task);
        return id;
      },
      ...reducers,
    });
  const initial = encode(value);
  let controller: ReadableStreamDefaultController<Settlement>;
  const cleanup = () => {
    closed = true;
    pending.clear();
    options.signal?.removeEventListener("abort", abort);
  };
  const abort = () => {
    if (closed) return;
    const error =
      options.signal?.reason ?? new DOMException("Aborted", "AbortError");
    cleanup();
    stopped.reject(error);
    controller.error(error);
  };
  const settlements = new ReadableStream<Settlement>({
    start(initialController) {
      controller = initialController;
      if (options.signal?.aborted) abort();
      else options.signal?.addEventListener("abort", abort, { once: true });
    },
    async pull(pullController) {
      if (closed) return;
      if (!pending.size) {
        cleanup();
        pullController.close();
        return;
      }
      try {
        const result = await Promise.race([
          ...pending.values(),
          stopped.promise,
        ]);
        if (closed) return;
        pending.delete(result.id);
        pullController.enqueue(result.frame);
        if (!pending.size) {
          cleanup();
          pullController.close();
        }
      } catch (error) {
        if (!closed) {
          cleanup();
          pullController.error(error);
        }
      }
    },
    cancel(reason) {
      cleanup();
      stopped.reject(reason ?? new DOMException("Cancelled", "AbortError"));
    },
  });
  return { initial, settlements };
}

/** Decode rich data without eval; unresolved deferred values fail when transport ends early. */
export function createDecoder(initial: string, transport: Transport = {}) {
  const pending = new Map<
    number,
    ReturnType<typeof Promise.withResolvers<unknown>>
  >();
  const all = new Map<
    number,
    ReturnType<typeof Promise.withResolvers<unknown>>
  >();
  const settled = new Set<number>();
  let ended = false;
  const revivers = transportRevivers(transport);
  const decode = (value: string): unknown =>
    parse(value, {
      ...revivers,
      Promise: (id: unknown) => {
        if (!Number.isSafeInteger(id) || typeof id !== "number" || id < 1)
          throw new Error("Invalid promise identifier");
        let deferred = all.get(id);
        if (!deferred) {
          deferred = Promise.withResolvers<unknown>();
          pending.set(id, deferred);
          all.set(id, deferred);
          void deferred.promise.catch(() => {});
        }
        return deferred.promise;
      },
    });
  const value = decode(initial);
  const abort = (reason: unknown) => {
    ended = true;
    for (const deferred of pending.values()) deferred.reject(reason);
    pending.clear();
  };
  return {
    value,
    accept(frame: unknown) {
      if (
        ended ||
        !frame ||
        typeof frame !== "object" ||
        !("id" in frame) ||
        typeof frame.id !== "number" ||
        !pending.has(frame.id) ||
        !("type" in frame)
      )
        throw new Error("Invalid promise settlement frame");
      const deferred = pending.get(frame.id)!;
      if (
        frame.type === "resolve" &&
        "value" in frame &&
        typeof frame.value === "string"
      ) {
        const settledValue = decode(frame.value);
        pending.delete(frame.id);
        settled.add(frame.id);
        deferred.resolve(settledValue);
      } else if (
        frame.type === "reject" &&
        "error" in frame &&
        frame.error &&
        typeof frame.error === "object" &&
        "message" in frame.error &&
        typeof frame.error.message === "string"
      ) {
        pending.delete(frame.id);
        settled.add(frame.id);
        deferred.reject(new Error(frame.error.message));
      } else throw new Error("Malformed promise settlement");
    },
    abort,
    finish() {
      if (pending.size) {
        const error = new Error("Data stream was truncated");
        abort(error);
        throw error;
      }
      ended = true;
    },
  };
}
