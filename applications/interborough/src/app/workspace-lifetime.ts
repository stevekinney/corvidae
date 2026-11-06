/** Owns exactly one resolved identity and fences completions from older resolutions. */
export class WorkspaceLifetime<Identity> {
  readonly #resolve: () => Promise<Identity>;
  readonly #open: (identity: Identity) => () => void;
  readonly #fail: () => void;
  #generation = 0;
  #close: (() => void) | undefined;

  constructor(options: {
    readonly resolve: () => Promise<Identity>;
    readonly open: (identity: Identity) => () => void;
    readonly fail: () => void;
  }) {
    this.#resolve = options.resolve;
    this.#open = options.open;
    this.#fail = options.fail;
  }

  async refresh(resolve: () => Promise<Identity> = this.#resolve): Promise<void> {
    const generation = ++this.#generation;
    this.#close?.();
    this.#close = undefined;
    try {
      const identity = await resolve();
      if (generation === this.#generation) this.#close = this.#open(identity);
    } catch {
      if (generation === this.#generation) this.#fail();
    }
  }

  dispose(): void {
    this.#generation += 1;
    this.#close?.();
    this.#close = undefined;
  }
}

export function workspaceStorage(
  identity: { readonly workspaceId: string; readonly actorId: string },
  storage: Pick<Storage, 'getItem' | 'setItem'> | undefined,
): Pick<Storage, 'getItem' | 'setItem'> {
  const prefix = `interborough:identity:${JSON.stringify([identity.workspaceId, identity.actorId])}:`;
  return {
    getItem: (key) => storage?.getItem(prefix + key) ?? null,
    setItem: (key, value) => storage?.setItem(prefix + key, value),
  };
}

/** A storage view tied to one server-resolved identity, or an empty view if storage is unavailable. */
export function browserWorkspaceStorage(
  identity: { readonly workspaceId: string; readonly actorId: string } | undefined,
  kind: 'localStorage' | 'sessionStorage',
): Pick<Storage, 'getItem' | 'setItem'> {
  if (identity === undefined) return workspaceStorage({ workspaceId: '', actorId: '' }, undefined);
  try {
    return workspaceStorage(identity, window[kind]);
  } catch {
    return workspaceStorage(identity, undefined);
  }
}
