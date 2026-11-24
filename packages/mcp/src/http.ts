export interface VerifiedGrant {
  issuer: string;
  audience: string | readonly string[];
  expiresAt: number;
  subject: string;
  grantId?: string;
  clientId?: string;
  tenant?: string;
  scopes: readonly string[];
}

export interface Principal {
  delegableScopes: readonly string[];
}

export interface ProtectedHttpOptions<T extends Principal> {
  origin: string;
  resourcePath: string;
  issuer: string;
  scopes: readonly string[];
  allowedOrigins?: readonly string[];
  maximumRequestBytes?: number;
  verifyAccessToken(token: string): Promise<VerifiedGrant | null>;
  subscribeGrantRevocation?(grantId: string, listener: () => void): () => void;
  resolvePrincipal(grant: VerifiedGrant): Promise<T | null>;
  dispatch(
    request: Request,
    context: {
      grant: VerifiedGrant;
      requireScopes(
        scopes: readonly string[],
      ): Promise<{ ok: true; principal: T } | { ok: false; response: Response }>;
    },
  ): Response | Promise<Response>;
}

export function createProtectedHttpHandler<T extends Principal>(
  options: ProtectedHttpOptions<T>,
): (request: Request) => Promise<Response> {
  options = {
    ...options,
    scopes: [...options.scopes],
    allowedOrigins: [...(options.allowedOrigins ?? [])],
  };
  const origin = new URL(options.origin);
  if (
    origin.protocol !== 'https:' ||
    origin.origin !== options.origin ||
    !options.resourcePath.startsWith('/') ||
    options.resourcePath.startsWith('//') ||
    new URL(options.resourcePath, origin).pathname !== options.resourcePath
  )
    throw new TypeError('Invalid public resource configuration');
  const issuer = new URL(options.issuer);
  if (
    issuer.protocol !== 'https:' ||
    issuer.hash ||
    issuer.search ||
    issuer.username ||
    issuer.password ||
    options.scopes.some((scope) => !/^[\x21\x23-\x5B\x5D-\x7E]+$/.test(scope)) ||
    !Number.isSafeInteger(options.maximumRequestBytes ?? 1024 * 1024) ||
    (options.maximumRequestBytes ?? 1024 * 1024) < 0
  )
    throw new TypeError('Invalid authorization configuration');
  const resource = new URL(options.resourcePath, origin).href;
  const metadataPath = `/.well-known/oauth-protected-resource${options.resourcePath}`;
  const metadata = new URL(metadataPath, origin).href;
  const challenge = (error?: string, scopes?: readonly string[]) =>
    `Bearer resource_metadata="${metadata}"${error ? `, error="${error}"` : ''}${scopes ? `, scope="${scopes.join(' ')}"` : ''}`;
  const handle = async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (path === metadataPath && request.method === 'GET')
      return Response.json({
        resource,
        authorization_servers: [options.issuer],
        scopes_supported: options.scopes,
      });
    if (path !== options.resourcePath) return new Response(null, { status: 404 });
    const requestOrigin = request.headers.get('origin');
    if (requestOrigin && !options.allowedOrigins!.includes(requestOrigin))
      return new Response(null, { status: 403 });
    if (request.method === 'OPTIONS')
      return new Response(null, {
        status: 204,
        headers: requestOrigin
          ? {
              'access-control-allow-origin': requestOrigin,
              'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
              'access-control-allow-headers':
                'authorization, content-type, mcp-protocol-version, mcp-session-id',
            }
          : {},
      });
    const authorization = request.headers.get('authorization');
    const match = authorization?.match(/^Bearer ([A-Za-z0-9\-._~+/]+=*)$/i);
    const unauthorized = () =>
      new Response(null, {
        status: 401,
        headers: { 'www-authenticate': challenge(authorization ? 'invalid_token' : undefined) },
      });
    if (!match || match[1]!.length > 8192) return unauthorized();
    let grant: VerifiedGrant | null;
    try {
      grant = await options.verifyAccessToken(match[1]!);
    } catch {
      return unauthorized();
    }
    if (
      !grant ||
      grant.issuer !== options.issuer ||
      !(typeof grant.audience === 'string'
        ? grant.audience === resource
        : grant.audience.includes(resource)) ||
      !Number.isFinite(grant.expiresAt) ||
      grant.expiresAt <= Date.now()
    )
      return unauthorized();
    grant = Object.freeze({
      ...grant,
      audience:
        typeof grant.audience === 'string' ? grant.audience : Object.freeze([...grant.audience]),
      scopes: Object.freeze([...grant.scopes]),
    });
    const binding = {
      issuer: grant.issuer,
      subject: grant.subject,
      grantId: grant.grantId,
      clientId: grant.clientId,
      tenant: grant.tenant,
      audience: JSON.stringify(grant.audience),
      scopes: [...grant.scopes],
    };
    if (!(await options.resolvePrincipal(grant))) return unauthorized();
    const maximum = options.maximumRequestBytes ?? 1024 * 1024;
    if (Number(request.headers.get('content-length')) > maximum)
      return new Response(null, { status: 413 });
    if (request.body) {
      const reader = request.body.getReader();
      const chunks: Uint8Array<ArrayBuffer>[] = [];
      let length = 0;
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        length += result.value.byteLength;
        if (length > maximum) {
          await reader.cancel();
          return new Response(null, { status: 413 });
        }
        chunks.push(new Uint8Array(result.value));
      }
      request = new Request(request, { method: request.method, body: new Blob(chunks) });
    }
    if (request.signal.aborted) return new Response(null, { status: 499 });
    const token = match[1]!;
    const requiredScopes = new Set<string>();
    const current = async () => {
      try {
        const fresh = await options.verifyAccessToken(token);
        if (
          !fresh ||
          fresh.issuer !== binding.issuer ||
          fresh.subject !== binding.subject ||
          fresh.grantId !== binding.grantId ||
          fresh.clientId !== binding.clientId ||
          fresh.tenant !== binding.tenant ||
          JSON.stringify(fresh.audience) !== binding.audience ||
          !Number.isFinite(fresh.expiresAt) ||
          fresh.expiresAt <= Date.now() ||
          !binding.scopes.every((scope) => fresh.scopes.includes(scope))
        )
          return null;
        const currentPrincipal = await options.resolvePrincipal(fresh);
        if (
          !currentPrincipal ||
          ![...requiredScopes].every((scope) => currentPrincipal.delegableScopes.includes(scope))
        )
          return null;
        return { ...currentPrincipal, delegableScopes: [...currentPrincipal.delegableScopes] };
      } catch {
        return null;
      }
    };
    if (!(await current()) || request.signal.aborted) return unauthorized();
    const response = await options.dispatch(request, {
      grant,
      async requireScopes(scopes) {
        const requested = [...scopes];
        if (requested.some((scope) => !options.scopes.includes(scope)))
          return { ok: false, response: new Response(null, { status: 403 }) };
        const principal = await current();
        if (!principal || request.signal.aborted) return { ok: false, response: unauthorized() };
        const missing = requested.filter((scope) => !binding.scopes.includes(scope));
        if (requested.some((scope) => !principal.delegableScopes.includes(scope)))
          return { ok: false, response: new Response(null, { status: 403 }) };
        if (missing.length)
          return {
            ok: false,
            response: new Response(null, {
              status: 403,
              headers: { 'www-authenticate': challenge('insufficient_scope', missing) },
            }),
          };
        for (const scope of requested) requiredScopes.add(scope);
        return { ok: true, principal };
      },
    });
    if (!response.body) return response;
    const reader = response.body.getReader();
    let closed = false;
    let cancelled = false;
    let finished = false;
    let output: ReadableStreamDefaultController<Uint8Array>;
    let unsubscribe = () => {};
    const finish = () => {
      if (finished || cancelled) return;
      finished = true;
      unsubscribe();
      request.signal.removeEventListener('abort', abort);
      output.close();
    };
    const close = async () => {
      if (closed) return;
      closed = true;
      await reader.cancel();
    };
    const abort = () => {
      void close().then(finish);
    };
    request.signal.addEventListener('abort', abort, { once: true });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        output = controller;
        if (binding.grantId && options.subscribeGrantRevocation) {
          unsubscribe = options.subscribeGrantRevocation(binding.grantId, () => {
            void close().then(finish);
          });
        }
      },
      async pull(controller) {
        const beforeRead = await current();
        if (closed || request.signal.aborted || !beforeRead) {
          await close();
          finish();
          return;
        }
        const result = await reader.read();
        const beforeRelease = await current();
        if (closed || request.signal.aborted || !beforeRelease) {
          await close();
          finish();
        } else if (result.done) {
          closed = true;
          finish();
        } else controller.enqueue(result.value);
      },
      async cancel() {
        cancelled = true;
        unsubscribe();
        request.signal.removeEventListener('abort', abort);
        await close();
      },
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
  return async (request) => {
    const response = await handle(request);
    const requestOrigin = request.headers.get('origin');
    if (!requestOrigin || !options.allowedOrigins!.includes(requestOrigin)) return response;
    const headers = new Headers(response.headers);
    headers.set('access-control-allow-origin', requestOrigin);
    headers.append('vary', 'Origin');
    headers.set(
      'access-control-expose-headers',
      'WWW-Authenticate, MCP-Session-Id, MCP-Protocol-Version',
    );
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}
