---
'@lostgradient/weft': minor
---

Weft's UI entry, `./ui`, now exports the component surface it will publish as `@lostgradient/weft/ui`; the published package does not carry the entry yet. `WeftDashboard`, renamed from `WeftConsole`, is the whole application, and `DashboardView`, `WorkflowsView`, `ReviewsView`, `WorkersView`, `SchedulesView`, `StorageView`, and `SystemView` render one area each. The layers they share are exported beside them: the client helpers, `readRuntimeConfig`, `createQueryClient` and `queryKeys`, the `router` with `matchRoute` and `workflowDetailPath`, and the live sources `FleetEventSource`, `WorkflowTailSource`, and `PollingSource` with their helpers and types. Importing anything from the entry also imports the dashboard's stylesheet.

A view renders outside `WeftDashboard` below only a client from `provideClient()` and a `QueryClientProvider` around `createQueryClient()`. It resolves the caller's principal itself and supplies its own fleet event source and toast region when no ancestor did. `router` reads `window` on first use instead of when its module loads, so the entry imports without a DOM.
