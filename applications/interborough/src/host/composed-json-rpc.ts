/**
 * One JSON-RPC endpoint over two catalogs (COR-2269).
 *
 * Weft's server owns `/jsonrpc` and answers it for the engine's operations; Bureau serves its own
 * at `/bureau/jsonrpc`. A client that wants one catalog (`rpc.discover`) and one endpoint, with
 * `bureau.agents.list` and `weft.storage.capabilities` side by side, calls `/jsonrpc`: the host
 * answers each call by the catalog that owns its method, relays Weft's through the relay as it
 * always has, and hands Bureau's to Bureau's own handler, so a call there has the same result, and
 * the same refusal, as the same call at `/bureau/jsonrpc`.
 *
 * `/bureau/jsonrpc` is unchanged. A body with no Bureau method and no `rpc.discover` is not read
 * here at all: it goes to the relay untouched.
 *
 * @module composed-json-rpc
 */

/** The path both catalogs are composed at. */
export const COMPOSED_JSON_RPC_PATH = '/jsonrpc';

/**
 * The one operation both catalogs define on `main`: Bureau's handler registers Weft's own
 * `getPrincipalOperation` (`weft.system.principal`), so a client of `/bureau/jsonrpc` can ask who
 * it is. It is the same definition, not a second one. On `/jsonrpc` Weft keeps it, as before, and
 * its answer is the engine's identity for the relay, so Bureau does not contribute it. Any other
 * name both define is a duplicate.
 */
const SHARED_WITH_WEFT: ReadonlySet<string> = new Set(['weft.system.principal']);

/** The most bytes of a body the composition reads, the cap Weft's own adapter applies. */
const MAXIMUM_BODY_BYTES = 1024 * 1024;

/** The most calls Weft's own adapter takes in a batch. */
const MAXIMUM_BATCH_ITEMS = 100;

const JSON_RPC_VERSION = '2.0';
const JSON_RPC_INTERNAL_ERROR = -32603;
const DISCOVER_METHOD = 'rpc.discover';

/**
 * The operation names Bureau contributes to the composed catalog. An operation name the two
 * catalogs both define is an error naming it: neither is overwritten, and a call could not say
 * which one it meant.
 */
export function composeOperationNames(
  weftNames: Iterable<string>,
  bureauNames: Iterable<string>,
): ReadonlySet<string> {
  const weft = new Set(weftNames);
  const contributed = new Set<string>();
  for (const name of bureauNames) {
    if (SHARED_WITH_WEFT.has(name) || name === DISCOVER_METHOD) continue;
    if (weft.has(name) || contributed.has(name)) {
      throw new Error(`duplicate operation name in the composed JSON-RPC catalog: ${name}`);
    }
    contributed.add(name);
  }
  return contributed;
}

/** What the composed endpoint calls on the host. */
export type ComposedJsonRpc = {
  /** The methods Bureau answers on the composed endpoint. */
  readonly bureauMethods: ReadonlySet<string>;
  /** Refuses a request Weft's operations may not serve, or `undefined` to serve it. */
  readonly authorizeEngine: (request: Request) => Promise<Response | undefined>;
  /** Weft's server, through the relay. */
  readonly relay: (request: Request) => Promise<Response>;
  /** Refuses a request Interborough's API scopes do not let the caller send Bureau, or `undefined`. */
  readonly refuseBureau: (request: Request) => Promise<Response | undefined>;
  /** Bureau's handler, which takes the request as `/bureau/jsonrpc` would. */
  readonly bureau: (request: Request) => Promise<Response>;
};

type Owner = 'weft' | 'bureau' | 'discover';

type Entry = { readonly raw: unknown; readonly owner: Owner; readonly notification: boolean };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function entryOf(raw: unknown, bureauMethods: ReadonlySet<string>): Entry {
  if (!isRecord(raw) || typeof raw['method'] !== 'string') {
    return { raw, owner: 'weft', notification: false };
  }
  const method = raw['method'];
  const owner: Owner =
    method === DISCOVER_METHOD ? 'discover' : bureauMethods.has(method) ? 'bureau' : 'weft';
  return { raw, owner, notification: !Object.hasOwn(raw, 'id') };
}

/** The body, read from a clone and bounded; `undefined` when it is too large to read here. */
async function boundedText(request: Request): Promise<string | undefined> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAXIMUM_BODY_BYTES) return undefined;
  const body = request.clone().body;
  if (body === null) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > MAXIMUM_BODY_BYTES) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(part.value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** `request` carrying `payload` in its place, with the same method, address, headers and signal. */
function withBody(request: Request, payload: unknown): Request {
  const headers = new Headers(request.headers);
  headers.delete('content-length');
  return new Request(request.url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: request.signal,
  });
}

async function resultOf(response: Response): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = await response.json();
    return isRecord(parsed) && isRecord(parsed['result']) ? parsed['result'] : undefined;
  } catch {
    return undefined;
  }
}

/** One catalog's `rpc.discover` document, or the response that was not one. */
async function discoverDocument(
  request: Request,
  call: (request: Request) => Promise<Response>,
): Promise<Record<string, unknown> | Response> {
  const response = await call(
    withBody(request, { jsonrpc: JSON_RPC_VERSION, id: 'discover', method: DISCOVER_METHOD }),
  );
  return (await resultOf(response.clone())) ?? response;
}

/**
 * `rpc.discover` over both catalogs: Weft's document with Bureau's methods added. The two documents
 * share their `errors` components, which are identical, so Weft's are kept.
 */
async function composedDiscover(
  request: Request,
  id: unknown,
  composed: ComposedJsonRpc,
): Promise<Record<string, unknown> | Response> {
  const weft = await discoverDocument(request, composed.relay);
  if (weft instanceof Response) return weft;
  const bureau = await discoverDocument(request, composed.bureau);
  if (bureau instanceof Response) return bureau;
  const weftMethods = Array.isArray(weft['methods']) ? weft['methods'] : [];
  const bureauMethods = (Array.isArray(bureau['methods']) ? bureau['methods'] : []).filter(
    (method: unknown) =>
      isRecord(method) &&
      typeof method['name'] === 'string' &&
      composed.bureauMethods.has(method['name']),
  );
  return {
    jsonrpc: JSON_RPC_VERSION,
    id: typeof id === 'string' || typeof id === 'number' ? id : null,
    result: { ...weft, methods: [...weftMethods, ...bureauMethods] },
  };
}

/** One entry's answer: a JSON-RPC response, `undefined` for a notification, or a whole-request response. */
async function answerOf(
  request: Request,
  entry: Entry,
  composed: ComposedJsonRpc,
): Promise<Record<string, unknown> | undefined | Response> {
  if (entry.owner === 'discover') {
    const answer = await composedDiscover(
      request,
      isRecord(entry.raw) ? entry.raw['id'] : undefined,
      composed,
    );
    return entry.notification && !(answer instanceof Response) ? undefined : answer;
  }
  const response = await (entry.owner === 'bureau' ? composed.bureau : composed.relay)(
    withBody(request, entry.raw),
  );
  if (response.status === 204) return undefined;
  try {
    const parsed: unknown = await response.clone().json();
    if (isRecord(parsed) && parsed['jsonrpc'] === JSON_RPC_VERSION) return parsed;
  } catch {
    // Not JSON-RPC: the transport itself refused the request.
  }
  return response;
}

/**
 * Serve a POST to `/jsonrpc` by the catalog that owns each method, or `undefined` when no method
 * in the body is Bureau's and none is `rpc.discover`, so the relay serves the request as before.
 *
 * A single call is answered exactly as its catalog's own endpoint answers it. A batch runs in
 * order and answers in order, with a response for each call that has an id. A refusal that is not
 * a JSON-RPC response answers the whole batch only when the host rejects it before dispatch. Once
 * a batch starts, a transport refusal answers the individual call and the other answers survive.
 */
export async function serveComposedJsonRpc(
  request: Request,
  composed: ComposedJsonRpc,
): Promise<Response | undefined> {
  if (request.method !== 'POST') return undefined;
  const text = await boundedText(request);
  if (text === undefined) return undefined;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return undefined;
  }
  const batch = Array.isArray(body);
  const calls: unknown[] = Array.isArray(body) ? body : [body];
  // Weft answers an oversize batch with its own error, so it is left to Weft.
  if (batch && calls.length > MAXIMUM_BATCH_ITEMS) return undefined;
  const entries = calls.map((raw) => entryOf(raw, composed.bureauMethods));
  if (entries.every((entry) => entry.owner === 'weft')) return undefined;
  // The two gates the host owns run once, before any of the batch runs, so a batch they refuse is
  // refused whole, as Bureau's own is. Bureau's handler still authenticates each call it serves.
  if (entries.some((entry) => entry.owner !== 'bureau')) {
    const denied = await composed.authorizeEngine(request);
    if (denied !== undefined) return denied;
  }
  if (entries.some((entry) => entry.owner === 'bureau')) {
    const refused = await composed.refuseBureau(request);
    if (refused !== undefined) return refused;
  }
  const [first] = entries;
  // A lone Bureau call is Bureau's own response, byte for byte.
  if (!batch && first?.owner === 'bureau') return composed.bureau(request);
  const answers: Record<string, unknown>[] = [];
  for (const entry of entries) {
    const answer = await answerOf(request, entry, composed);
    if (answer instanceof Response) {
      if (!batch) return answer;
      if (!entry.notification) {
        const id = isRecord(entry.raw) ? entry.raw['id'] : undefined;
        answers.push({
          jsonrpc: JSON_RPC_VERSION,
          id: typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id)) ? id : null,
          error: {
            code: JSON_RPC_INTERNAL_ERROR,
            message: 'Upstream request refused',
            data: { status: answer.status },
          },
        });
      }
    } else if (answer !== undefined && !entry.notification) {
      answers.push(answer);
    }
  }
  if (!batch) {
    const [only] = answers;
    return only === undefined ? new Response(null, { status: 204 }) : Response.json(only);
  }
  return answers.length === 0
    ? new Response(null, { status: 204 })
    : Response.json(answers, { headers: { 'cache-control': 'no-store' } });
}
