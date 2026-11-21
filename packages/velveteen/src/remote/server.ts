import { getControl } from "../data/errors.ts";
import type { PublicError } from "../data/contract.ts";
import type { RequestEvent } from "../server/types.ts";
import {
  decodeRemote,
  encodeRemote,
  isRecord,
  remoteBatchLimit,
  remoteBatchPath,
  remoteContentType,
  validRemoteName,
  type RemoteBatchEntry,
  type RemoteBatchFailure,
  type RemoteBatchSuccess,
} from "./protocol.ts";

type RemoteKind = "query" | "command";
export type RemoteDefinition<
  Input,
  Output,
  Kind extends RemoteKind = RemoteKind,
> = {
  kind: Kind;
  validate: (value: unknown) => Input;
  handle: (input: Input, event: RequestEvent) => Output | Promise<Output>;
  refresh?: (input: Input, output: Output) => readonly RemoteBatchEntry[];
};
type Resolver<Input, Output> = (input: Input) => Output | Promise<Output>;
export type BatchQueryDefinition<Input, Output> = {
  kind: "query";
  batch: true;
  validate: (value: unknown) => Input;
  handle: (
    inputs: Input[],
    event: RequestEvent,
  ) => Resolver<Input, Output> | Promise<Resolver<Input, Output>>;
};
type Definition = {
  kind: RemoteKind;
  validate: (value: unknown) => unknown;
  handle: (input: never, event: RequestEvent) => unknown;
  batch?: true;
  refresh?: (input: never, output: never) => readonly RemoteBatchEntry[];
};
export type RemoteDefinitions = Record<string, Definition>;

/** Only host-registered implementations are callable, with validated inputs. */
export function defineRemote<Input, Output, Kind extends RemoteKind>(
  definition: RemoteDefinition<Input, Output, Kind>,
): RemoteDefinition<Input, Output, Kind> {
  return definition;
}

/** Resolve a group of distinct validated inputs with one query handler. */
export function defineBatchQuery<Input, Output>(
  definition: Omit<BatchQueryDefinition<Input, Output>, "kind" | "batch">,
): BatchQueryDefinition<Input, Output> {
  return { ...definition, kind: "query", batch: true };
}

type Options = {
  publicError?: (
    cause: unknown,
    event: RequestEvent,
  ) => Promise<{ status: number; error: PublicError }>;
};
type Result = RemoteBatchSuccess | RemoteBatchFailure;
type Job = { input: unknown; indexes: number[] };

const respond = (value: unknown, status = 200) =>
  new Response(encodeRemote(value), {
    status,
    headers: {
      "content-type": remoteContentType,
      "cache-control": "private, no-store",
      vary: "Origin",
    },
  });
const failure = (status: number, message: string) =>
  respond({ version: 1, ok: false, error: { message } }, status);
const known = (definitions: RemoteDefinitions, name: string) =>
  validRemoteName(name) && Object.hasOwn(definitions, name);
const rejected = (name: string, message: string): RemoteBatchFailure => ({
  name,
  ok: false,
  error: { message },
});

async function errorReport(
  cause: unknown,
  event: RequestEvent,
  options: Options,
) {
  event.signal.throwIfAborted();
  const control = getControl(cause);
  if (control?.kind === "error")
    return { status: control.status, error: control.error };
  return (
    (await options.publicError?.(cause, event)) ?? {
      status: 500,
      error: { message: "Internal Error" },
    }
  );
}

async function createResolver(
  definition: Definition,
  inputs: unknown[],
  event: RequestEvent,
): Promise<Resolver<unknown, unknown>> {
  event.signal.throwIfAborted();
  if (!definition.batch)
    return (input) => definition.handle(input as never, event);
  const resolver = await definition.handle(inputs as never, event);
  if (typeof resolver !== "function")
    throw new TypeError("Expected a batched remote query resolver");
  return resolver as Resolver<unknown, unknown>;
}

async function resolveQueries(
  entries: RemoteBatchEntry[],
  definitions: RemoteDefinitions,
  event: RequestEvent,
  options: Options,
): Promise<Result[]> {
  const results: Result[] = [];
  results.length = entries.length;
  const groups = new Map<string, Map<string, Job>>();
  for (const [index, { name, input }] of entries.entries()) {
    const group = groups.get(name) ?? new Map<string, Job>();
    const key = encodeRemote(input);
    const existing = group.get(key);
    if (existing) {
      existing.indexes.push(index);
      continue;
    }
    try {
      group.set(key, {
        input: definitions[name].validate(input),
        indexes: [index],
      });
      groups.set(name, group);
    } catch {
      results[index] = rejected(name, "Bad Request");
    }
  }

  await Promise.all(
    [...groups].map(async ([name, group]) => {
      const jobs = [...group.values()];
      const assign = (job: Job, result: Result) => {
        for (const index of job.indexes) results[index] = result;
      };
      let resolve: Resolver<unknown, unknown>;
      try {
        resolve = await createResolver(
          definitions[name],
          jobs.map(({ input }) => input),
          event,
        );
      } catch (cause) {
        const { error } = await errorReport(cause, event, options);
        for (const job of jobs) assign(job, { name, ok: false, error });
        return;
      }
      await Promise.all(
        jobs.map(async (job) => {
          try {
            event.signal.throwIfAborted();
            const value = await resolve(job.input);
            encodeRemote(value);
            assign(job, { name, ok: true, value });
          } catch (cause) {
            const { error } = await errorReport(cause, event, options);
            assign(job, { name, ok: false, error });
          }
        }),
      );
    }),
  );
  event.signal.throwIfAborted();
  return results;
}

async function dispatchBatch(
  definitions: RemoteDefinitions,
  envelope: unknown,
  event: RequestEvent,
  options: Options,
) {
  if (
    !isRecord(envelope) ||
    envelope.version !== 1 ||
    envelope.kind !== "batch" ||
    !Array.isArray(envelope.entries) ||
    envelope.entries.length === 0
  )
    return failure(400, "Bad Request");
  if (envelope.entries.length > remoteBatchLimit)
    return failure(413, "Batch Too Large");
  const entries: RemoteBatchEntry[] = [];
  for (const entry of envelope.entries as unknown[]) {
    if (
      !isRecord(entry) ||
      typeof entry.name !== "string" ||
      !Object.hasOwn(entry, "input")
    )
      return failure(400, "Bad Request");
    if (!known(definitions, entry.name)) return failure(404, "Not Found");
    if (definitions[entry.name].kind !== "query")
      return failure(400, "Batch Requires Queries");
    entries.push({ name: entry.name, input: entry.input });
  }
  return respond({
    version: 1,
    ok: true,
    kind: "batch",
    entries: await resolveQueries(entries, definitions, event, options),
  });
}

/** Dispatch inside the application's hooks, request context and abort lifetime. */
export async function dispatchRemote(
  definitions: RemoteDefinitions,
  request: Request,
  event: RequestEvent,
  options: Options = {},
): Promise<Response> {
  if (request.method !== "POST")
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { allow: "POST" },
    });
  if (request.headers.get("origin") !== event.url.origin)
    return failure(403, "Forbidden");
  const marker = event.url.pathname.lastIndexOf("/_remote/");
  if (marker < 0) return failure(404, "Not Found");
  let name: string;
  try {
    name = decodeURIComponent(event.url.pathname.slice(marker + 9));
  } catch {
    return failure(400, "Bad Request");
  }
  if (name !== remoteBatchPath && !known(definitions, name))
    return failure(404, "Not Found");
  if (
    request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !==
    remoteContentType
  )
    return failure(415, "Unsupported Media Type");

  let envelope: unknown;
  try {
    envelope = decodeRemote(await request.text());
  } catch {
    event.signal.throwIfAborted();
    return failure(400, "Bad Request");
  }
  if (name === remoteBatchPath)
    return dispatchBatch(definitions, envelope, event, options);
  if (
    !isRecord(envelope) ||
    envelope.version !== 1 ||
    envelope.name !== name ||
    !Object.hasOwn(envelope, "input")
  )
    return failure(400, "Bad Request");

  const definition = definitions[name];
  let input: unknown;
  try {
    input = definition.validate(envelope.input);
  } catch {
    return failure(400, "Bad Request");
  }
  try {
    const resolve = await createResolver(definition, [input], event);
    const value = await resolve(input);
    event.signal.throwIfAborted();
    const refresh =
      definition.kind === "command" && definition.refresh
        ? await refreshQueries(
            definition.refresh(input as never, value as never),
            definitions,
            event,
            options,
          )
        : undefined;
    return respond({
      version: 1,
      ok: true,
      kind: definition.kind,
      value,
      ...(refresh ? { refresh } : {}),
    });
  } catch (cause) {
    event.signal.throwIfAborted();
    const control = getControl(cause);
    if (control?.kind === "redirect") {
      const destination = new URL(control.location, event.url);
      if (!["http:", "https:"].includes(destination.protocol))
        return failure(500, "Internal Error");
      return respond({
        version: 1,
        ok: false,
        redirect: destination.href,
        status: control.status,
      });
    }
    const { error, status } = await errorReport(cause, event, options);
    return respond({ version: 1, ok: false, error }, status);
  }
}

async function refreshQueries(
  requested: readonly RemoteBatchEntry[],
  definitions: RemoteDefinitions,
  event: RequestEvent,
  options: Options,
) {
  const entries = requested.filter(({ name, input }) => {
    if (!known(definitions, name) || definitions[name].kind !== "query")
      return false;
    try {
      encodeRemote(input);
      return true;
    } catch {
      return false;
    }
  });
  const results = await resolveQueries(entries, definitions, event, options);
  return results.map((result, index) => ({
    input: entries[index].input,
    ...result,
  }));
}
