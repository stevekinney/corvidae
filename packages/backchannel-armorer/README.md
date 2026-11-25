# Backchannel Armorer

`@lostgradient/backchannel-armorer` projects selected Armorer tools into a Backchannel server catalog. Use `operationsFromToolbox` with a pinned tool version, a public operation name, an access policy, and the operation behavior and schemas the catalog should expose.

The resulting operations execute the original tools through Armorer, including their input validation. Catalog construction rejects tools that require approval or can pause for input, including tools with policy hooks whose pause behavior cannot be determined. Serve those tools through native Armorer.

Run the projection tests with `bun run --filter=@lostgradient/backchannel-armorer test`.
