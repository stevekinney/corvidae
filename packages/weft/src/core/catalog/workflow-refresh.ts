import type { WorkflowRevisionManifest } from '../contract/types.ts';
import { parseWorkflowRevisionManifest } from '../contract/manifest-parse.ts';
import type { RegisteredWorkflowDefinition } from '../types/workflow-registry.ts';
import { WorkflowCatalog } from './workflow-catalog.ts';
import type { WorkflowCatalogActivationMode, WorkflowCatalogActivePointer } from './types.ts';

export type WorkflowRefreshArtifact = Readonly<{
  manifest: WorkflowRevisionManifest;
  bytes: Uint8Array;
  digest?: string;
  identity?: Readonly<{ name: string; revision: string }>;
  runtime?: string;
}>;

export type WorkflowRefreshResponse = Readonly<{
  status: 200 | 304;
  etag?: string;
  artifact?: WorkflowRefreshArtifact;
}>;

export type WorkflowRefreshDiagnostics = Readonly<{
  name: string;
  state: 'idle' | 'checking' | 'not-modified' | 'warming' | 'activated' | 'installed' | 'failed';
  etag?: string | undefined;
  revision?: string | undefined;
  digest?: string | undefined;
  generation?: number | undefined;
  checkedAt?: number | undefined;
  error?: string | undefined;
}>;

export type WorkflowRefreshOptions = Readonly<{
  activate?: WorkflowCatalogActivationMode;
  expectedGeneration?: number;
  signal?: AbortSignal;
}>;

export type WorkflowRefreshSource = Readonly<{
  fetch: (request: { etag?: string | undefined; signal?: AbortSignal | undefined }) => Promise<WorkflowRefreshResponse>;
  warm: (artifact: WorkflowRefreshArtifact) => Promise<RegisteredWorkflowDefinition>;
  validateRuntime?: (runtime: string | undefined) => void | Promise<void>;
}>;

export type WorkflowRefreshCoordinatorOptions = Readonly<{
  catalog: WorkflowCatalog;
  sources: ReadonlyMap<string, WorkflowRefreshSource>;
  maxArtifactBytes?: number;
  pollIntervalMs?: number;
  maxBackoffMs?: number;
  now?: () => number;
}>;

export type WorkflowRefreshResult = Readonly<{
  status: 'not-modified' | 'installed' | 'activated';
  etag?: string | undefined;
  manifest?: WorkflowRevisionManifest | undefined;
  pointer?: WorkflowCatalogActivePointer | undefined;
}>;
type RefreshResult = WorkflowRefreshResult;

const DEFAULT_MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
const DEFAULT_POLL_INTERVAL_MS = 60_000;
const DEFAULT_MAX_BACKOFF_MS = 15 * 60_000;

/**
 * Opt-in, single-flight workflow refresh. Fetching is deliberately supplied by
 * the host so this class remains usable with fetch, a registry client, or a
 * test transport without embedding a network policy in the catalog.
 */
export class WorkflowRefreshCoordinator implements AsyncDisposable {
  readonly #catalog: WorkflowCatalog;
  readonly #sources: ReadonlyMap<string, WorkflowRefreshSource>;
  readonly #maxArtifactBytes: number;
  readonly #pollIntervalMs: number;
  readonly #maxBackoffMs: number;
  readonly #now: () => number;
  readonly #etags = new Map<string, string>();
  readonly #artifacts = new Map<string, WorkflowRefreshArtifact>();
  readonly #diagnostics = new Map<string, WorkflowRefreshDiagnostics>();
  readonly #inFlight = new Map<string, Promise<RefreshResult>>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #stopped = false;
  #backoffMs: number;

  constructor(options: WorkflowRefreshCoordinatorOptions) {
    this.#catalog = options.catalog;
    this.#sources = options.sources;
    this.#maxArtifactBytes = options.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
    this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.#maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.#now = options.now ?? Date.now;
    if (!Number.isSafeInteger(this.#maxArtifactBytes) || this.#maxArtifactBytes <= 0) {
      throw new RangeError('maxArtifactBytes must be a positive safe integer');
    }
    if (!Number.isFinite(this.#pollIntervalMs) || this.#pollIntervalMs <= 0) {
      throw new RangeError('pollIntervalMs must be positive');
    }
    this.#backoffMs = this.#pollIntervalMs;
  }

  async refresh(name: string, options?: WorkflowRefreshOptions): Promise<RefreshResult> {
    if (this.#stopped) throw new Error('Workflow refresh coordinator is stopped');
    const existing = this.#inFlight.get(name);
    if (existing !== undefined) return existing;
    const promise = this.#refresh(name, options).finally(() => this.#inFlight.delete(name));
    this.#inFlight.set(name, promise);
    return promise;
  }

  diagnostics(name?: string): readonly WorkflowRefreshDiagnostics[] {
    if (name !== undefined) {
      const diagnostic = this.#diagnostics.get(name);
      return diagnostic === undefined ? [] : [diagnostic];
    }
    return [...this.#diagnostics.values()];
  }

  /** Start opt-in polling. Polling failures back off and never activate stale data. */
  startPolling(): void {
    if (this.#stopped || this.#timer !== undefined) return;
    this.#schedulePoll(this.#pollIntervalMs);
  }

  /** Run one bounded maintenance cycle for hosts using `backgroundTasks: 'manual'`. */
  async runMaintenance(): Promise<readonly RefreshResult[]> {
    if (this.#stopped) return [];
    const results: RefreshResult[] = [];
    for (const name of this.#sources.keys()) {
      results.push(await this.refresh(name));
    }
    return results;
  }

  stopPolling(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.#stopped = true;
    this.stopPolling();
    await Promise.allSettled(this.#inFlight.values());
    this.#inFlight.clear();
    this.#artifacts.clear();
  }

  async #refresh(name: string, options?: WorkflowRefreshOptions): Promise<RefreshResult> {
    const source = this.#sources.get(name);
    if (source === undefined) throw new Error(`No workflow refresh source registered for "${name}"`);
    this.#record(name, { state: 'checking' });
    try {
      const response = await this.#fetch(name, source, options?.signal);
      if (response.status === 304) return this.#notModified(name);
      const artifact = await this.#prepare(name, source, response);
      const activation = await this.#install(name, source, artifact, options);
      const result = this.#result(name, artifact.manifest, activation);
      this.#record(name, { state: result.status, ...(activation?.applied === true ? { generation: activation.pointer.generation } : {}), checkedAt: this.#now() });
      this.#backoffMs = this.#pollIntervalMs;
      return result;
    } catch (error) {
      this.#record(name, { state: 'failed', checkedAt: this.#now(), error: error instanceof Error ? error.message : String(error) });
      this.#backoffMs = Math.min(this.#maxBackoffMs, Math.max(this.#pollIntervalMs, this.#backoffMs * 2));
      throw error;
    }
  }

  async #fetch(name: string, source: WorkflowRefreshSource, signal: AbortSignal | undefined): Promise<WorkflowRefreshResponse> {
    return source.fetch({ ...(this.#etags.has(name) ? { etag: this.#etags.get(name) } : {}), ...(signal === undefined ? {} : { signal }) });
  }

  #notModified(name: string): RefreshResult {
    this.#record(name, { state: 'not-modified', checkedAt: this.#now() });
    this.#backoffMs = this.#pollIntervalMs;
    const etag = this.#etags.get(name);
    return etag === undefined ? { status: 'not-modified' } : { status: 'not-modified', etag };
  }

  async #prepare(name: string, source: WorkflowRefreshSource, response: WorkflowRefreshResponse): Promise<WorkflowRefreshArtifact> {
    const artifact = response.artifact;
    if (artifact === undefined) throw new Error('Refresh response status 200 omitted artifact');
    const digest = await digestBytes(artifact.bytes);
    this.#validateArtifact(name, artifact, digest);
    const parsed = await parseWorkflowRevisionManifest(artifact.manifest);
    if (!parsed.ok) throw new Error(`Workflow artifact manifest is invalid: ${parsed.reason}`);
    await source.validateRuntime?.(artifact.runtime);
    this.#artifacts.set(digest, artifact);
    this.#etags.set(name, response.etag ?? digest);
    this.#record(name, { state: 'warming', etag: response.etag ?? digest, revision: artifact.manifest.revision, digest });
    return artifact;
  }

  async #install(name: string, source: WorkflowRefreshSource, artifact: WorkflowRefreshArtifact, options?: WorkflowRefreshOptions) {
    const definition = await source.warm(artifact);
    await this.#catalog.install(artifact.manifest, definition);
    if (options?.activate !== 'if-compatible') return undefined;
    const activationOptions = options.expectedGeneration === undefined ? undefined : { expectedGeneration: options.expectedGeneration };
    return this.#catalog.activateCandidate(name, artifact.manifest, activationOptions);
  }

  #result(name: string, manifest: WorkflowRevisionManifest, activation: Awaited<ReturnType<WorkflowCatalog['activateCandidate']>> | undefined): RefreshResult {
    const etag = this.#etags.get(name);
    if (activation?.applied === true) return { status: 'activated', ...(etag === undefined ? {} : { etag }), manifest, pointer: activation.pointer };
    return { status: 'installed', ...(etag === undefined ? {} : { etag }), manifest };
  }

  #validateArtifact(name: string, artifact: WorkflowRefreshArtifact, digest: string): void {
    if (artifact.bytes.byteLength > this.#maxArtifactBytes) throw new Error(`Workflow artifact exceeds ${this.#maxArtifactBytes} bytes`);
    if (artifact.digest !== undefined && artifact.digest !== digest) throw new Error('Workflow artifact digest does not match its bytes');
    if (artifact.identity !== undefined && (artifact.identity.name !== name || artifact.identity.revision !== artifact.manifest.revision)) {
      throw new Error('Workflow artifact identity does not match its requested catalog identity');
    }
    if (artifact.manifest.name !== name) throw new Error('Workflow artifact manifest name does not match its requested catalog identity');
    if (!artifact.manifest.revision) throw new Error('Workflow artifact manifest revision is empty');
    this.#record(name, { digest });
  }

  #record(name: string, patch: Partial<WorkflowRefreshDiagnostics>): void {
    const previous = this.#diagnostics.get(name);
    this.#diagnostics.set(name, { name, state: previous?.state ?? 'idle', ...previous, ...patch });
  }

  #schedulePoll(delay: number): void {
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.runMaintenance().then(() => this.#schedulePoll(this.#pollIntervalMs)).catch(() => this.#schedulePoll(this.#backoffMs));
    }, delay);
  }
}

async function digestBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer);
  return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}
