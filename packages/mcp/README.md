# Protected MCP HTTP

`@lostgradient/mcp/http` wraps a Fetch dispatcher with protected-resource discovery and bearer admission. Configure a canonical HTTPS origin, resource path, external issuer, advertised scopes, a verifier, and a current-principal resolver. The verifier must authenticate the token using the issuer's keys or authenticated introspection and return its issuer, audience, subject, scopes, and expiration in Unix milliseconds. The principal resolver must consult current membership and return its delegable scopes. The handler checks the configured issuer, audience, and expiration and does not accept cookies or API keys as bearer credentials.

The dispatcher receives the verified grant. Immediately before invoking an operation, await `context.requireScopes(requiredScopes)` and return `decision.response` when `decision.ok` is false. When it succeeds, use `decision.principal` for that operation. The decision resolves current membership and refuses canceled requests; a missing scope produces an upgrade challenge only when the principal can delegate it. The dispatcher owns operation authorization and must propagate the request's cancellation signal to its work. Response streams are cancelled on client cancellation and their chunks are released only while the token and membership remain current. Public discovery URLs always use the configured origin, never forwarded host headers. `allowedOrigins` admits browser origins; by default no browser origin is admitted. `maximumRequestBytes` bounds request bodies and defaults to one mebibyte.

`@lostgradient/mcp/oauth` supplies `hostedOAuth` and an `OAuthStore`. Supply the issuer and resource URLs, scope descriptions, explicit starting scopes, storage, and application functions for the browser session, sign-in, and current membership. Mount the returned Fetch handler at the issuer and pass its `verifyAccessToken` to the protected HTTP handler. Each consent creates its own grant, and the verifier checks current membership before admitting a token. Store credentials only in the issuer; never put browser cookies, client secrets, or verifiers in application logs.

`@lostgradient/mcp/oauth/postgres` supplies `createPostgresOAuthStores`, backed by the existing PostgreSQL storage adapter. Point each instance at the same primary and table and dispose the returned store when the host stops. Run `bun run --cwd packages/mcp test:oauth:postgres` with a loopback PostgreSQL URL in `WEFT_TEST_POSTGRES_URL`, or with `initdb` and `pg_ctl` on `PATH`, to exercise the live cross-instance contract.

The same entry provides `createPostgresGrantRevocationChannel`. Pass its `publish` callback to the hosted issuer as `notifyGrantRevoked` and its `subscribe` callback to the protected HTTP handler as `subscribeGrantRevocation`. Dispose the channel on shutdown. A lost notification cannot release private output because the handler rechecks the durable grant before each chunk.

## Hosted connector probes

These independent probes exercise a public deployment before a real Claude or ChatGPT connector is tested. Pass a canonical HTTPS origin, its absolute MCP mount path, and the scope names to each command. The OAuth probe additionally requires the expected browser identity provider origin. For example, from `packages/mcp`:

```bash
bun run probe:deployed-smoke -- https://equipment-catalog-production.up.railway.app /api/mcp equipment:read equipment:write
bun run probe:inspector -- https://equipment-catalog-production.up.railway.app /api/mcp equipment:read equipment:write
bun run probe:deployed-oauth -- https://equipment-catalog-production.up.railway.app /api/mcp equipment:read equipment:write --identity-origin https://equipment-issuer-production.up.railway.app
```

For the standalone deployment use `https://equipment-armorer-production.up.railway.app` and `/mcp`. The smoke probe checks public DNS, TLS, discovery, audience, scopes, and the unauthenticated challenge. Inspector runs the pinned Inspector CLI without stored authorization and prints its interactive continuation. The OAuth probe dynamically registers a public client, checks an invalid grant and the redirect to the expected identity provider, then listens on loopback while the operator signs in and approves consent. It exchanges the code, initializes MCP, and revokes the token without printing it. Each invocation creates a persistent registered client. Pass `--prepare-only` to stop before interactive sign-in; rerun without that flag to complete it. Use the synthetic staging identities and confirm the selected consent subject before approving.

These commands do not establish acceptance for hosted Claude or ChatGPT: the operator must separately complete sign-in, tool calls, permission changes, and revocation in each real client against both resources.
