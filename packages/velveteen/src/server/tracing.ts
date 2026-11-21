import type { ActionResult } from "../actions/server.ts";
import { getControl } from "../data/errors.ts";
import type { LoadObserver } from "../data/loads.ts";
import type { RequestEvent } from "./types.ts";

type Outcome = "success" | "error" | "canceled";

/** Completed timing and outcome data for one operation in a server request. */
export type RequestTraceSpan = Readonly<{
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: "request" | "server.load" | "universal.load" | "action";
  routeId: string | null;
  outcome: Outcome;
  startTime: number;
  endTime: number;
  status?: number;
  loadKey?: string;
}>;

export function createRequestTrace(
  onTrace: ((span: RequestTraceSpan) => void) | undefined,
  request: RequestEvent,
) {
  if (!onTrace) return;
  const report = onTrace;
  const traceId = crypto.randomUUID();

  function start(
    name: RequestTraceSpan["name"],
    route: string | null,
    parentSpanId: string | null,
    loadKey?: string,
  ) {
    const spanId = crypto.randomUUID();
    const startTime = performance.now();
    let completed = false;
    return {
      spanId,
      finish(outcome: Outcome, status?: number, routeId = route) {
        if (completed) return;
        completed = true;
        try {
          const delivery = report({
            traceId,
            spanId,
            parentSpanId,
            name,
            routeId,
            outcome,
            startTime,
            endTime: performance.now(),
            ...(status === undefined ? {} : { status }),
            ...(loadKey === undefined ? {} : { loadKey }),
          });
          void Promise.resolve(delivery).catch(() => {});
        } catch {
          // Observers must never affect request processing or release.
        }
      },
    };
  }

  const root = start("request", null, null);
  async function invoke<Value>(
    span: ReturnType<typeof start>,
    signal: AbortSignal,
    operation: () => Value | Promise<Value>,
    statusOf?: (value: Value) => number,
  ): Promise<Value> {
    const cancel = () => span.finish("canceled");
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    try {
      const value = await operation();
      const status = statusOf?.(value);
      span.finish(
        status !== undefined && status >= 400 ? "error" : "success",
        status,
      );
      return value;
    } catch (cause) {
      const control = getControl(cause);
      span.finish(
        control?.kind === "redirect" ? "success" : "error",
        control?.status,
      );
      throw cause;
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }

  return {
    loads(
      name: "server.load" | "universal.load",
      event: RequestEvent,
    ): LoadObserver {
      return (key, operation) =>
        invoke(
          start(name, event.route.id, root.spanId, key),
          event.signal,
          operation,
        );
    },
    action(event: RequestEvent, operation: () => Promise<ActionResult>) {
      return invoke(
        start("action", event.route.id, root.spanId),
        event.signal,
        operation,
        (value) => value.status,
      );
    },
    finish(outcome: Outcome, status?: number, route?: string | null) {
      root.finish(
        outcome === "success" && status !== undefined && status >= 400
          ? "error"
          : outcome,
        status,
        route ?? request.route.id,
      );
    },
  };
}
