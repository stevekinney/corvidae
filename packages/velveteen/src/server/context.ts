import { AsyncLocalStorage } from "node:async_hooks";
import type { RequestEvent } from "./types.ts";
// A host and its independently bundled application must observe the same async context.
const key = Symbol.for("velveteen.request-context");
const global = globalThis as typeof globalThis & {
  [key]?: AsyncLocalStorage<RequestEvent>;
};
export const requestContext = (global[key] ??=
  new AsyncLocalStorage<RequestEvent>());
export function getRequestEvent(): RequestEvent {
  const event = requestContext.getStore();
  if (!event) throw new Error("Request event is unavailable outside a request");
  return event;
}
