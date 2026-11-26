# Credentials

`@lostgradient/credentials/api-keys` issues machine credentials against application-owned service-account and management policies. Supply storage with atomic conditional batches and current primary reads shared by every host. `authorizeManagement` receives the actor, action, workspace, subject, and requested scopes; it must check current management and delegation authority. `resolveAuthority` returns the service account's current workspace, subject, and scopes, or `null` when membership is no longer active.

`issue` and `rotate` return a secret once. Store that secret in the caller's secret store; use the returned public ID for later rotation or revocation. `list` returns metadata without the secret or verifier. Rotation accepts an absolute `retiresAt` time in milliseconds, allowing both credentials until that instant. Authentication checks the committed record and current service authority on every request, intersecting the credential's scopes with current authority.

`withSession` composes the verifier with an application session authenticator. An explicit `X-API-Key` is authoritative: an invalid key, an empty key, or a simultaneous `Authorization` header returns a 401 without consulting the session. Configure an OAuth-only MCP route separately and do not forward API keys as ambient credentials on nested requests.

`@lostgradient/credentials/browser-sign-in` provides a server-only Fetch service for OpenID Connect sign-in. Supply an HTTPS public origin, an application-specific cookie name and workspace, an OIDC registration, shared storage with atomic conditional batches, and application-owned account and membership resolvers. The storage must provide current reads and atomic conditional writes across every host that uses it. Use a separate storage and cookie namespace for each application.

The package runs on Cloudflare Workers with `nodejs_compat`. A Worker must supply a Web-standard Fetch runtime, Web Crypto, and a storage implementation with current reads and atomic conditional batches; bind those application-owned dependencies when constructing the services.

`oidc` defers discovery until the first sign-in request. Hosts that route outbound requests through an injected Fetch implementation can pass it as `fetch` to `oidc`.

```ts
import { createBrowserSignIn, oidc } from '@lostgradient/credentials/browser-sign-in';

const browser = createBrowserSignIn({
  publicOrigin,
  storage,
  cookieName: 'my_app_session',
  workspaceId,
  provider: oidc({ issuer, clientId, clientSecret }),
  resolveAccount: accounts.forExternalIdentity,
  resolveMembership: accounts.currentMembership,
});
```

Route `/auth/*` requests to `browser.fetch`. A protected page can call `browser.currentSession(request)` and redirect a signed-out navigation with `browser.startSignIn(request)`. Resolve membership on every request and return only safe display data to the page. The application owns the identity mapping and must use both issuer and subject; equal email addresses do not establish account ownership.

For a hosted MCP issuer, create its `OAuthStore` with the same `storage` object supplied to `createBrowserSignIn`, then pass `browser.oauthIdentity(oauthStore, principalForGrant)` as `hostedOAuth`'s `identity`. The composition checks that the issuer uses that store before serving requests. Every application instance may open its own connection to the same atomic storage namespace, but each instance must pass its own shared storage object to both services. Consent approval checks the browser session in the same atomic write as the grant and code; sign-out after approval leaves the connector grant active. The identity and its session proof are server-only and must not be returned to a browser or logged.

For a cookie-authenticated write, call `browser.validWrite(request)` before changing state. It requires the configured origin and the `x-csrf-token` header returned by `currentSession`. Submit sign-out as `POST /auth/sign-out` with the same proof. The service revokes the session in shared storage and clears the cookie. Session credentials and upstream tokens do not belong in page data or diagnostics.
