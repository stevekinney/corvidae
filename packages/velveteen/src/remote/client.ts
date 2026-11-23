import type { Fetch } from "../data/contract.ts";
import {
  decodeRemote,
  encodeRemote,
  isRecord,
  isRemoteBatchResponse,
  isRemoteSuccess,
  remoteBatchLimit,
  remoteBatchPath,
  remoteContentType,
  validRemoteName,
  type RemoteBatchEntry,
} from "./protocol.ts";

export type RemoteClientOptions = {
  baseURL: string | URL;
  fetch?: Fetch;
  invalidate: () => void | Promise<void>;
  signal?: AbortSignal;
  redirect?: (location: string) => void | Promise<void>;
};
type InputOf<Value> = Value extends { validate(value: unknown): infer Input }
  ? Input
  : never;
type OutputOf<Value> = Value extends {
  batch: true;
  handle: (...arguments_: never[]) => infer Resolver;
}
  ? Awaited<Resolver> extends (...arguments_: never[]) => infer Result
    ? Awaited<Result>
    : never
  : Value extends { handle: (...arguments_: never[]) => infer Result }
    ? Awaited<Result>
    : never;
type QueryNames<Definitions> = {
  [Name in keyof Definitions & string]: Definitions[Name] extends {
    kind: "query";
  }
    ? Name
    : never;
}[keyof Definitions & string];

export type RemoteQuery<Output> = {
  get(): Promise<Output>;
  refresh(): Promise<Output>;
  subscribe(observer: (value: Output) => void): () => void;
};
export type RemoteClient<Definitions extends Record<string, unknown>> = {
  call<Name extends keyof Definitions & string>(
    name: Name,
    input: InputOf<Definitions[Name]>,
    options?: { signal?: AbortSignal },
  ): Promise<OutputOf<Definitions[Name]>>;
  query<Name extends QueryNames<Definitions>>(
    name: Name,
    input: InputOf<Definitions[Name]>,
  ): RemoteQuery<OutputOf<Definitions[Name]>>;
};

type Read = PromiseWithResolvers<unknown>;
type CachedQuery = RemoteBatchEntry & {
  current?: { value: unknown };
  read?: Read;
  lastCommand: number;
  subscribers: Set<(value: unknown) => void>;
};

/** A client owns the cache and batches reads initiated in the same browser turn. */
export function createRemoteClient<Definitions extends Record<string, unknown>>(
  options: RemoteClientOptions,
): RemoteClient<Definitions> {
  const base = new URL(options.baseURL);
  if (!["http:", "https:"].includes(base.protocol))
    throw new TypeError("Invalid remote base");
  base.pathname = base.pathname.replace(/\/?$/, "/");
  base.search = "";
  base.hash = "";

  const signal = options.signal ?? new AbortController().signal;
  const cache = new Map<string, CachedQuery>();
  const queued = new Map<CachedQuery, Read>();
  let scheduled = false;
  let callOrder = 0;
  const keyFor = (name: string, encodedInput: string) =>
    `${name}:${encodedInput}`;

  function notify(observer: (value: unknown) => void, value: unknown) {
    try {
      void Promise.resolve(observer(value)).catch(() => {});
    } catch {
      // A subscriber cannot change the result of a remote exchange.
    }
  }

  function publish(entry: CachedQuery, value: unknown) {
    entry.current = { value };
    for (const observer of entry.subscribers) notify(observer, value);
  }

  function applyRefresh(refresh: unknown, order: number) {
    if (!Array.isArray(refresh)) return;
    for (const item of refresh) {
      if (
        !isRecord(item) ||
        typeof item.name !== "string" ||
        !Object.hasOwn(item, "input") ||
        !Object.hasOwn(item, "value")
      )
        continue;
      const entry = cache.get(keyFor(item.name, encodeRemote(item.input)));
      if (!entry || entry.lastCommand >= order) continue;
      entry.lastCommand = order;
      const previous = entry.read;
      entry.read = undefined;
      queued.delete(entry);
      publish(entry, item.value);
      previous?.resolve(item.value);
    }
  }

  async function send(name: string, body: unknown, requestSignal: AbortSignal) {
    requestSignal.throwIfAborted();
    const response = await (options.fetch ?? globalThis.fetch)(
      new Request(new URL(`_remote/${encodeURIComponent(name)}`, base), {
        method: "POST",
        headers: { "content-type": remoteContentType },
        body: encodeRemote(body),
        signal: requestSignal,
        redirect: "error",
      }),
    );
    if (
      response.headers.get("content-type")?.split(";")[0] !== remoteContentType
    ) {
      await response.body?.cancel();
      throw new TypeError("Invalid remote content type");
    }
    const result = decodeRemote(await readBody(response, requestSignal));
    requestSignal.throwIfAborted();
    return { result, ok: response.ok };
  }

  async function readBatch(reads: [CachedQuery, Read][]) {
    const reject = (entry: CachedQuery, read: Read, cause: unknown) => {
      if (entry.read === read) entry.read = undefined;
      read.reject(cause);
    };
    try {
      const { result, ok } = await send(
        remoteBatchPath,
        {
          version: 1,
          kind: "batch",
          entries: reads.map(([{ name, input }]) => ({ name, input })),
        },
        signal,
      );
      if (
        !ok ||
        !isRemoteBatchResponse(result) ||
        result.entries.length !== reads.length ||
        result.entries.some(({ name }, index) => name !== reads[index][0].name)
      )
        throw new TypeError("Malformed remote batch response");
      for (const [index, [entry, read]] of reads.entries()) {
        const answer = result.entries[index];
        if (!answer.ok) {
          reject(entry, read, new Error(answer.error.message));
          continue;
        }
        if (entry.read === read) {
          entry.read = undefined;
          publish(entry, answer.value);
        }
        read.resolve(answer.value);
      }
    } catch (cause) {
      for (const [entry, read] of reads) reject(entry, read, cause);
    }
  }

  function flush() {
    scheduled = false;
    const reads = [...queued];
    queued.clear();
    for (let offset = 0; offset < reads.length; offset += remoteBatchLimit)
      void readBatch(reads.slice(offset, offset + remoteBatchLimit));
  }

  function get(entry: CachedQuery, refresh: boolean) {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (!refresh && entry.current) return Promise.resolve(entry.current.value);
    const pending = refresh ? queued.get(entry) : entry.read;
    if (pending) return pending.promise;
    const read = Promise.withResolvers<unknown>();
    entry.read = read;
    queued.set(entry, read);
    if (!scheduled) {
      scheduled = true;
      setTimeout(flush, 0);
    }
    return read.promise;
  }

  const query = (name: string, input: unknown): RemoteQuery<unknown> => {
    if (!validRemoteName(name)) throw new TypeError("Invalid remote name");
    const encodedInput = encodeRemote(input);
    const key = keyFor(name, encodedInput);
    const existing = cache.get(key);
    const entry: CachedQuery = existing ?? {
      name,
      input: decodeRemote(encodedInput),
      lastCommand: 0,
      subscribers: new Set(),
    };
    if (!existing) cache.set(key, entry);
    return {
      get: () => get(entry, false),
      refresh: () => get(entry, true),
      subscribe(observer) {
        entry.subscribers.add(observer);
        if (entry.current) notify(observer, entry.current.value);
        return () => {
          entry.subscribers.delete(observer);
        };
      },
    };
  };

  const call = async (
    name: string,
    input: unknown,
    settings?: { signal?: AbortSignal },
  ) => {
    if (!validRemoteName(name)) throw new TypeError("Invalid remote name");
    const requestSignal = settings?.signal
      ? AbortSignal.any([signal, settings.signal])
      : signal;
    const order = ++callOrder;
    const { result, ok } = await send(
      name,
      { version: 1, name, input },
      requestSignal,
    );
    if (!isRemoteSuccess(result)) {
      if (isRecord(result) && result.version === 1 && result.ok === false) {
        if (
          typeof result.redirect === "string" &&
          Number.isInteger(result.status) &&
          Number(result.status) >= 300 &&
          Number(result.status) <= 308
        ) {
          const destination = new URL(result.redirect, base);
          if (!["http:", "https:"].includes(destination.protocol))
            throw new TypeError("Invalid remote redirect");
          if (!options.redirect)
            throw new Error("Remote redirect requires a navigation callback");
          await options.redirect(destination.href);
          return undefined;
        }
        if (isRecord(result.error) && typeof result.error.message === "string")
          throw new Error(result.error.message);
      }
      throw new TypeError("Malformed remote response");
    }
    if (!ok) throw new TypeError("Invalid remote response status");
    if (result.kind === "command") {
      applyRefresh(result.refresh, order);
      await options.invalidate();
      requestSignal.throwIfAborted();
    }
    return result.value;
  };

  return {
    call: call as RemoteClient<Definitions>["call"],
    query: query as RemoteClient<Definitions>["query"],
  };
}

async function readBody(
  response: Response,
  signal: AbortSignal,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const abort = () => {
    void reader.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const decoder = new TextDecoder();
  let text = "";
  try {
    signal.throwIfAborted();
    while (true) {
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}
