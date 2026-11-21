import type { ClientRouteManifest } from "../routing/manifest-types.ts";
import type {
  LoadRole,
  PagePayload,
  PublicError,
  UniversalResult,
} from "./contract.ts";

const control = Symbol.for("velveteen.control");
type Control =
  | { kind: "error"; status: number; error: PublicError }
  | { kind: "redirect"; status: number; location: string };
class ControlError extends Error {
  [control]: Control;
  constructor(value: Control) {
    super(value.kind === "error" ? value.error.message : value.location);
    this[control] = value;
  }
}
/** Stop a load or endpoint with a public HTTP error. */
export function error(status: number, message: string | PublicError): never {
  if (!Number.isInteger(status) || status < 400 || status > 599)
    throw new RangeError("Error status must be 400–599");
  throw new ControlError({
    kind: "error",
    status,
    error: typeof message === "string" ? { message } : message,
  });
}
/** Stop a load or endpoint with a redirect; the handler still validates its destination. */
export function redirect(status: number, location: string): never {
  if (!Number.isInteger(status) || status < 300 || status > 308)
    throw new RangeError("Redirect status must be 300–308");
  if (!location || /[\r\n]/.test(location))
    throw new TypeError("Invalid redirect destination");
  throw new ControlError({ kind: "redirect", status, location });
}
/** Symbol identity survives separately bundled application and host modules. */
export function getControl(value: unknown): Control | undefined {
  if (value && typeof value === "object" && control in value)
    return (value as ControlError)[control];
}
export class LoadFailure extends Error {
  constructor(
    readonly node: number,
    readonly role: LoadRole,
    override readonly cause: unknown,
    readonly partial: UniversalResult[] = [],
  ) {
    super(`Load failed for ${node}:${role}`, { cause });
  }
}
/** Select an error outside a failed layout, preserving only the successful ancestor branch. */
export function createErrorPayload(
  payload: PagePayload,
  routing: ClientRouteManifest,
  status: number,
  publicError: PublicError,
  failed?: { node: number; role: LoadRole },
): PagePayload {
  const route = routing.routes.find(
    (candidate) => candidate.id === payload.routeId,
  );
  let boundary: number | null = null;
  let boundaryPosition = -1;
  if (route) {
    const failurePosition =
      failed?.role === "layout"
        ? route.ancestors.indexOf(failed.node)
        : route.ancestors.length - 1;
    for (
      let index = failurePosition - (failed?.role === "layout" ? 1 : 0);
      index >= 0;
      index--
    ) {
      const candidate = route.errors[index];
      if (candidate !== null) {
        boundary = candidate;
        boundaryPosition = index;
        break;
      }
    }
  }
  const retained = route
    ? new Set(route.ancestors.slice(0, boundaryPosition + 1))
    : new Set<number>();
  return {
    ...payload,
    status,
    error: publicError,
    redirect: undefined,
    nodes: payload.nodes.filter(
      (node) => node.role === "layout" && retained.has(node.node),
    ),
    branch: [
      ...payload.branch.filter(
        (node) =>
          node.role === "layout" &&
          node.node !== null &&
          retained.has(node.node),
      ),
      { node: boundary, role: "error" },
    ],
  };
}
