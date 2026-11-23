# Credentials

`@lostgradient/credentials/browser-sign-in` provides a server-only Fetch service for OpenID Connect sign-in. Supply an HTTPS public origin, an application-specific cookie name and workspace, an OIDC registration, shared storage with atomic conditional batches, and application-owned account and membership resolvers. The storage must provide current reads and atomic conditional writes across every host that uses it. Use a separate storage and cookie namespace for each application.

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

For a cookie-authenticated write, call `browser.validWrite(request)` before changing state. It requires the configured origin and the `x-csrf-token` header returned by `currentSession`. Submit sign-out as `POST /auth/sign-out` with the same proof. The service revokes the session in shared storage and clears the cookie. Session credentials and upstream tokens do not belong in page data or diagnostics.
