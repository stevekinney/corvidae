# Connected apps

This optional package exposes personal approval management through `@lostgradient/connected-apps/backchannel`, generated bindings through `@lostgradient/connected-apps/svelte`, and a Cinder page through `@lostgradient/connected-apps/ui`. A host supplies a current human session, an active workspace membership check, a browser write guard, and the hosted issuer adapter or external management callbacks. The operations address one grant at a time and are excluded from MCP.

For a PostgreSQL hosted issuer, create one `createPostgresGrantRevocationChannel` per host from `@lostgradient/mcp/oauth/postgres`. Pass its `publish` method as the issuer's `notifyGrantRevoked` and its `subscribe` method as the protected HTTP handler's `subscribeGrantRevocation`. Dispose the channel when the host stops. Notifications close the corresponding streams promptly; each private output also checks durable authority in case a notification is lost. Hosts must point at the same primary database and issuer.

An external issuer supplies only the inventory and revocation callbacks its management API supports. When inventory is unavailable, the page shows the configured management destination instead of an empty inventory or a disconnect control.
