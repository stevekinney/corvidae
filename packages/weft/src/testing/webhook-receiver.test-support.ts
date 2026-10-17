/**
 * A loopback webhook receiver for the A2A push-delivery suites: it records every
 * request and answers each with the next scripted reply, or holds it open until the
 * client abandons it. It lives outside `src/a2a/`, whose non-test files must not use
 * the `Bun` global.
 */

export type ReceivedRequest = {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
};

type ScriptedReply =
  | { readonly kind: 'reply'; readonly status: number; readonly headers?: Record<string, string> }
  | { readonly kind: 'hold' };

export class TestReceiver {
  readonly requests: ReceivedRequest[] = [];
  /** Requests the client abandoned while the receiver held them. */
  readonly abandoned: ReceivedRequest[] = [];
  readonly #server: ReturnType<typeof Bun.serve>;
  readonly #script: ScriptedReply[] = [];
  readonly #waiters: Array<{ readonly index: number; readonly resolve: () => void }> = [];
  readonly #abandonWaiters: Array<() => void> = [];

  constructor() {
    this.#server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (request) => this.#handle(request),
    });
  }

  get port(): number {
    return this.#server.port ?? 0;
  }

  /** `127.0.0.1:<port>`, the allowlist entry for this receiver. */
  get host(): string {
    return `127.0.0.1:${this.port}`;
  }

  url(path = '/hook'): string {
    return `http://${this.host}${path}`;
  }

  reply(status: number, headers?: Record<string, string>): this {
    this.#script.push({ kind: 'reply', status, ...(headers === undefined ? {} : { headers }) });
    return this;
  }

  hold(): this {
    this.#script.push({ kind: 'hold' });
    return this;
  }

  /** Resolves with request `index` once the receiver has seen it. */
  async nextRequest(index = this.requests.length): Promise<ReceivedRequest> {
    if (this.requests.length <= index) {
      await new Promise<void>((resolve) => this.#waiters.push({ index, resolve }));
    }
    return this.requests[index]!;
  }

  /** Resolves once a held request has been abandoned by its client. */
  async nextAbandoned(): Promise<ReceivedRequest> {
    if (this.abandoned.length === 0) {
      await new Promise<void>((resolve) => this.#abandonWaiters.push(resolve));
    }
    return this.abandoned.at(-1)!;
  }

  async close(): Promise<void> {
    await this.#server.stop(true);
  }

  async #handle(request: Request): Promise<Response> {
    const received: ReceivedRequest = {
      method: request.method,
      path: new URL(request.url).pathname,
      headers: Object.fromEntries(request.headers),
      body: await request.text(),
    };
    this.requests.push(received);
    for (const waiter of this.#waiters.filter((entry) => entry.index < this.requests.length)) {
      this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
      waiter.resolve();
    }
    const reply = this.#script.shift() ?? { kind: 'reply', status: 200 };
    if (reply.kind === 'reply') return new Response(null, reply);
    return new Promise<Response>((resolve) => {
      request.signal.addEventListener(
        'abort',
        () => {
          this.abandoned.push(received);
          for (const notify of this.#abandonWaiters.splice(0)) notify();
          resolve(new Response(null, { status: 499 }));
        },
        { once: true },
      );
    });
  }
}
