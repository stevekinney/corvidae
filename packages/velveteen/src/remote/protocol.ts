import { parse, stringify } from "devalue";
export const remoteContentType = "application/x-velveteen-remote";
export const remoteProtocolVersion = 1 as const;
export const remoteBatchPath = "_batch";
export const remoteBatchLimit = 32;
export const validRemoteName = (name: string) =>
  /^[A-Za-z][A-Za-z0-9_-]*$/.test(name) &&
  !["constructor", "prototype", "__proto__"].includes(name);
export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
/** One non-streaming rich-value boundary for both remote arguments and results. */
function assertSerializable(value: unknown, seen = new Set<object>()) {
  if (typeof value === "function" || typeof value === "symbol")
    throw new TypeError("Unsupported remote value");
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  if (value instanceof Promise || value instanceof Blob)
    throw new TypeError("Unsupported remote value");
  if (value instanceof Map) {
    for (const [key, item] of value) {
      assertSerializable(key, seen);
      assertSerializable(item, seen);
    }
    return;
  }
  if (value instanceof Set) {
    for (const item of value) assertSerializable(item, seen);
    return;
  }
  if (
    value instanceof Date ||
    value instanceof RegExp ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value)
  )
    return;
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    throw new TypeError("Unsupported remote value");
  if (Object.getOwnPropertySymbols(value).length)
    throw new TypeError("Unsupported remote value");
  for (const descriptor of Object.values(
    Object.getOwnPropertyDescriptors(value),
  )) {
    if (descriptor.get || descriptor.set)
      throw new TypeError("Unsupported remote accessor");
    assertSerializable(descriptor.value, seen);
  }
}
export function encodeRemote(value: unknown): string {
  assertSerializable(value);
  return stringify(value);
}
export function decodeRemote(text: string): unknown {
  const value: unknown = parse(text);
  assertSerializable(value);
  return value;
}
export type RemoteSuccess = {
  version: 1;
  ok: true;
  kind: "query" | "command";
  value: unknown;
  refresh?: {
    name: string;
    input: unknown;
    value?: unknown;
    error?: { message: string };
  }[];
};
export type RemoteBatchEntry = { name: string; input: unknown };
export type RemoteBatchSuccess = { name: string; ok: true; value: unknown };
export type RemoteBatchFailure = {
  name: string;
  ok: false;
  error: { message: string };
};
export type RemoteBatchResponse = {
  version: 1;
  ok: true;
  kind: "batch";
  entries: (RemoteBatchSuccess | RemoteBatchFailure)[];
};
export function isRemoteBatchResponse(
  value: unknown,
): value is RemoteBatchResponse {
  return (
    isRecord(value) &&
    value.version === 1 &&
    value.ok === true &&
    value.kind === "batch" &&
    Array.isArray(value.entries) &&
    value.entries.every(
      (entry: unknown) =>
        isRecord(entry) &&
        typeof entry.name === "string" &&
        (entry.ok === true
          ? Object.hasOwn(entry, "value")
          : entry.ok === false &&
            isRecord(entry.error) &&
            typeof entry.error.message === "string"),
    )
  );
}
export type RemoteFailure = {
  version: 1;
  ok: false;
  error: { message: string };
};
export type RemoteRedirect = {
  version: 1;
  ok: false;
  redirect: string;
  status: number;
};
export function isRemoteSuccess(value: unknown): value is RemoteSuccess {
  return (
    isRecord(value) &&
    value.version === 1 &&
    value.ok === true &&
    (value.kind === "query" || value.kind === "command") &&
    Object.hasOwn(value, "value")
  );
}
