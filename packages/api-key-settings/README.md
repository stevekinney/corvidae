# API key settings

`@lostgradient/api-key-settings/backchannel` exposes API key management operations and a Fetch handler. Supply the existing Credentials API key service, a session authenticator, current manager and target policy, row actions, an overlap cutoff, a public origin, and a browser write guard. Policies must use current authority for each invocation; service credentials are not management actors.

Mount the handler at `/key-admin/jsonrpc`. Its responses are private and non-cacheable. If composing the operations into another catalog, the host must apply the same session admission, origin and write-guard checks and response cache policy.

For an explicitly trusted local operator without an `Origin` header, supply `guardTrustedOperatorWrite` to verify that operator at the request boundary. The handler never infers that trust from a loopback address.

`@lostgradient/api-key-settings/svelte` exports the scoped provider and generated read and command bindings. Keep the provider mounted across route changes, and supply a distinct scope whenever the actor, workspace, or membership authority changes. The optional `@lostgradient/api-key-settings/ui` entry renders the standard page and requires Cinder; headless bindings do not import it. Issue and rotate return secrets only to the submitting caller. Copy the secret before dismissing it.

Commands are never replayed automatically. If a response is lost, the outcome is uncertain; the page reads metadata once so the operator can reconcile before another attempt.
