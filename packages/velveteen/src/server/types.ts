import type { RemoteDefinitions } from "../remote/server.ts";
import type { RemoteForms } from "../remote/forms.ts";
import type { Component } from "svelte";
import type { ProductionGeneration } from "../build/manifest-types.ts";
import type { RouteParameterValue } from "../routing/manifest-types.ts";
import type {
  Data,
  Fetch,
  PublicError,
  RootProps,
  RuntimeRegistry,
  UniversalLoadEvent,
} from "../data/contract.ts";
import type { RequestTraceSpan } from "./tracing.ts";

declare global {
  /** Application declarations can add fields to the request-local record. */
  interface VelveteenLocals {
    [key: string]: unknown;
  }
}

export type CookieOptions = Omit<Bun.CookieInit, "name" | "value"> & {
  path: string;
};
type Cookies = {
  get(name: string): string | undefined;
  getAll(): { name: string; value: string }[];
  set(name: string, value: string, options: CookieOptions): void;
  delete(name: string, options: CookieOptions): void;
};
export type RequestEvent = {
  request: Request;
  url: URL;
  params: Record<string, RouteParameterValue>;
  route: { id: string | null };
  locals: Partial<VelveteenLocals>;
  cookies: Cookies;
  platform: unknown;
  fetch: Fetch;
  setHeaders(this: void, headers: Record<string, string>): void;
  getClientAddress(): string;
  signal: AbortSignal;
};
export type ServerLoadEvent = RequestEvent &
  Pick<UniversalLoadEvent, "parent" | "depends" | "untrack">;
type ServerLoad = (
  event: ServerLoadEvent,
) => Data | void | Promise<Data | void>;
export type ServerModule = { load?: ServerLoad; ssr?: boolean; csr?: boolean };
export type ServerHooks = {
  init?(): void | Promise<void>;
  handle?(input: {
    event: RequestEvent;
    resolve: (event?: RequestEvent) => Promise<Response>;
  }): Response | Promise<Response>;
  handleFetch?(input: {
    event: RequestEvent;
    request: Request;
    fetch: Fetch;
  }): Response | Promise<Response>;
  handleError?(input: {
    event: RequestEvent;
    error: unknown;
    status: number;
    message: string;
  }): PublicError | void | Promise<PublicError | void>;
  reroute?(input: {
    url: URL;
    fetch: Fetch;
  }): string | void | Promise<string | void>;
};
export type ServerRegistry = RuntimeRegistry & {
  Root: Component<RootProps>;
  render(
    component: Component<RootProps>,
    options: { props: RootProps },
  ): { body: string; head: string };
};
export type FetchHandler = (request: Request) => Response | Promise<Response>;
export type FetchService =
  FetchHandler | { fetch: FetchHandler; close?: () => void | Promise<void> };
export type ApplicationOptions = {
  mounts?: Readonly<Record<string, () => FetchService | Promise<FetchService>>>;
  prerendering?: boolean;
  remotes?: RemoteDefinitions;
  remoteForms?: RemoteForms;
  generation: ProductionGeneration;
  registry?: ServerRegistry;
  hooks?: ServerHooks;
  template?: string;
  platform?: unknown;
  getClientAddress?: (request: Request) => string;
  filterSerializedResponseHeaders?: (name: string, value: string) => boolean;
  onTrace?: (span: RequestTraceSpan) => void;
};
