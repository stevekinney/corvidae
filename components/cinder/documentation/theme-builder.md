# Theme builder interaction specification

This is the implementation-facing interaction record for CIN-573/TB03. It describes the approved Cinder theme builder at an exact design revision and leaves the required human product and accessibility decisions visible. The builder is a route in `applications/playground`, not a new published Cinder component. The source contract is the [R4 approved specification](https://linear.app/lost-gradient/document/theme-builder-approved-specification-and-issue-graph-e620a80331ee); the additions are the [R5 open-source amendment](https://linear.app/lost-gradient/document/theme-builder-open-source-research-and-planning-amendment-e2cff94ed833).

> [!WARNING] Review status
>
> This document is ready for Steve's design review and for review by Steve or his named human accessibility practitioner. Those approvals are pending. An agent must not fill either approval field.

## Contract and boundaries

The visible Theme builder action opens /theme-builder with a default Cinder light/dark theme. A theme draft contains immutable source documents and resolver, user overrides, and an embedded Cinder base snapshot with its version and source digest. Local named themes support create, rename, duplicate, switch, download, recoverable delete, restore, and explicit permanent delete. Names are trimmed, one to 80 characters, and unique case-insensitively. A duplicate or imported copy appends the first available numeric suffix while preserving the limit; rename reports a conflict instead of silently changing the name.

There is one draft model and one validation pipeline. The last valid committed revision drives preview and checks; partially typed or invalid input stays visible and is saved separately as draft input. A stale preview is labeled. Reset can target a field, category, concrete color mode, or whole theme and never changes the immutable Cinder base. Each committed edit, reset, import, remediation, and applied proposal is one undoable transaction; native text undo has priority while an input is focused.

The builder does not add a backend, account, collaboration, URL-encoded draft, font service, or telemetry of theme values. Imported content cannot add HTML, scripts, stylesheets, resource URLs, or arbitrary CSS properties. The preview iframe is a layout boundary, not a security sandbox: validation remains the security boundary.

## Layout model

The page has a stable shell, persistent toolbar, catalogue/editor surface, preview surface, checks summary, and persistent draft status area. Custom values apply only to the preview iframe and its portal container; they never restyle builder chrome. The catalogue has six fields—friendly name/value, path, CSS property, type, and context—not six columns in the overall shell.

    Theme builder action
             |
       /theme-builder
             |
    Theme/context toolbar ---- Export
       |          |          |
    Catalogue   Editor    Preview iframe
       |          |          |
             Checks/status
             |
    Draft revision -> last valid preview
             |       -> IndexedDB record
             |       -> export and validation report

### Desktop at 1440px

At 1440px the shell has 16px outer padding and gaps, a 208px category rail, a flexible editor region, and a 360px preview/checks region. Inside the editor region, the catalogue exposes six fields in its inspector table: friendly name, value, path, CSS property, type, and context. The table has a bounded scroll region; the selected token's editor and provenance appear beneath the catalogue in the same region.

    +----------------+----------------------------------------+----------------------+
    | Categories     | Theme / context / Export               | Status / Undo / Redo |
    +----------------+----------------------------------------+----------------------+
    | Foundations    | Search and catalogue filters           | Preview: Components  |
    | Semantic       | Six-field token catalogue              | Example selector     |
    | Components     | Selected token: Shipped / Draft        | Trusted iframe       |
    | Source         | Apply / Reset / Source and dependents  | Checks and findings  |
    +----------------+----------------------------------------+----------------------+

The toolbar names active theme, concrete context, draft status, findings, and preview revision. Category navigation is a navigation landmark. The catalogue has a caption, headers, and one selected row whose state is not conveyed by color alone. The editor labels Shipped and Draft values separately, with FormField owning labels and errors. The selected token editor uses a disclosure for Source and dependencies; following a dependent uses the existing catalogue selection and offers Back to originating token.

### Tablet at 768px

From 768px through 1199px, the layout uses a 176px category rail and a flexible main region after subtracting 16px outer padding and a 16px gap. At 768px, the main region is 544px wide. The catalogue exposes its six fields as stacked label/value pairs, followed by the selected token's editor in that region. Preview and checks occupy a full-width row below. At 1200px and wider, use the desktop arrangement; below 768px, use the mobile tabs.

    +----------------+----------------------------------------------+
    | Categories     | Theme / context / Export / Status            |
    +----------------+----------------------------------------------+
    | Foundations    | Search and catalogue filters                 |
    | Semantic       | Friendly name / Value                        |
    | Components     | Path, property, type and context stacked     |
    | Source         | Selected token: Shipped / Draft              |
    |                | Apply / Reset / Source and dependents        |
    +----------------+----------------------------------------------+
    | Preview/checks | Full-width row below the rail and editor     |
    +----------------+----------------------------------------------+

Focus order remains toolbar, categories, catalogue, editor, preview, checks, and status. No control is hidden behind horizontal overflow.

### Mobile at 390px

Below 768px the workbench uses Edit, Preview, and Checks tabs. Selection, draft revision, active context, and scroll position survive tab changes. The catalogue becomes one-token stacked rows and never reuses the desktop table.

    +------------------------------+
    | Theme: Cinder default        |
    | light | default       Export |
    | Saved locally | 1 finding    |
    +------------------------------+
    | Edit   Preview   Checks      |
    +------------------------------+
    | Search tokens                |
    | [Changed] [Aliases] [Issues] |
    | Body spacing                 |
    | 1rem                         |
    | [Path, property, type]       |
    | Draft value [1rem]           |
    | Shipped: 1rem                |
    | Source and dependencies      |
    | [Reset field]                |
    +------------------------------+
    | Draft revision 12 | Undo    |
    +------------------------------+

The disclosure exposes path, CSS property, type, context, inherited value, source, and dependents beneath the friendly name/value row. Provenance before/after rows stack vertically. Export and status remain accessible.

### Narrow mobile at 320px

At 320px labels wrap before controls shrink below usable size. Buttons become a full-width action stack, values remain readable, and preview is not rendered beside the editor.

    +----------------------+
    | Theme                |
    | light | default      |
    | Export               |
    | Saved | 1 finding    |
    +----------------------+
    | Edit Preview Checks  |
    +----------------------+
    | Search               |
    | Body spacing         |
    | 1rem                 |
    | Details              |
    | Draft value          |
    | Shipped: 1rem        |
    | Reset field          |
    | Source and deps      |
    +----------------------+

All three mobile tabs—`Edit`, `Preview`, and `Checks`—remain directly visible at 320px, with no overflow menu. Acceptance is no horizontal page overflow, no clipped focus indicator, and no provenance or proposal row requiring side-by-side comparison.

## Workflow and state record

The workflow uses explicit committed revisions. A slider frame updates draft input locally but announces only its committed value; validation and iframe responses include revision and concrete context and are discarded when stale.

    Start -> Dirty edit -> Valid committed revision -> Checks -> Fix proposal -> Valid
    | | | |
    | +-> Invalid ----+ +-> Alias/recipe disclosure
    | +-> Storage conflict
    +-> Import preflight -> supported or failure
    +-> Rename -> conflict or success
    +-> Trash -> restore or permanent delete
    +-> Export

### Preview catalogue and state board

The preview navigation has exactly eight categories: `Foundations`, `Components`, `Forms`, `Data`, `Feedback`, `Overlay`, `Charts`, and `Application`. It uses the approved trusted examples and IDs:

| Category | Exact scenes and purpose | State board |
| --- | --- | --- |
| Foundations | Token scales and type specimens | Default and context variants where a specimen supports them |
| Components | `button/variants`, `link/basic`, `tabs/basic`, plus the selected existing example | Default, hover, focus-visible, active/selected, disabled, and invalid only where exposed; the manifest marks non-applicable states |
| Forms | `input/basic`, `input/with-error`, `select/basic`, `select/with-error`, `checkbox/basic`, `checkbox/with-error` | The same state set, with invalid only on the error scenes |
| Data | `table/basic` | Default, hover, focus-visible, selected where exposed; non-applicable states are explicit |
| Feedback | `callout/variants` | Default and variant semantics; hover/selected are marked non-applicable |
| Overlay | `modal/with-form`, `popover/basic` | Closed/open, focus-visible, and dismissal behavior; hover/selected are marked non-applicable |
| Charts | `line-chart/multi-series` | Default and focus-visible where exposed; interaction states are marked non-applicable |
| Application | Trusted settings/dashboard arrangement built from the same fixtures | Default, focus-visible, selected, disabled, and invalid only on controls that expose them |

The initial preview category is `Components`, with `button/variants` selected. The initial editor selection is the first foundation token in the registry's stable source order. Selecting another preview example does not change the selected token. The Application scene places a settings form (`input/basic`, `select/basic`, `checkbox/basic`, and `button/variants`) before a summary containing `callout/variants`, `table/basic`, and `line-chart/multi-series`; `modal/with-form` and `popover/basic` supply its overlay actions. At a preview width of 768px or wider, the form and summary occupy equal columns with a 16px gap; below that width they stack in that same order. Every control uses the trusted example's existing content and behavior.

The state board is a manifest-driven matrix. It never invents a state that the underlying component does not expose. The approved regression routes remain `/`, `/page/button`, `/page/input`, `/page/select`, `/page/checkbox`, `/page/tabs`, `/page/callout`, `/page/table`, `/page/line-chart`, `/page/modal`, `/page/popover`, `/theme-builder`, and `/theme-builder/preview`.

### Start and dirty edit

Start shows the embedded Cinder base, active named theme, light/dark and motion context, empty findings, and Saved locally. A dirty edit changes status to Unsaved locally, increments draft input state, and leaves the last valid preview visible until commit. Text fields save explicitly; sliders commit on pointer-up, keyboard adjustment, or blur. Continuous slider movement is one history entry. A persistence failure says Unsaved locally and offers download recovery.

### Invalid draft and checks/fix

An invalid field keeps its text, sets aria-invalid true, and places a path-addressed error in associated error text. Preview and export use the last valid revision and say so. Checks separate Accessibility errors, Needs review, and advisory findings. A fix proposal lists exact before/after value, target context, dependent paths, representation change, and whether Apply or download-only recovery is available.

Apply is disabled when source, lock, target, context, or base revision changed. A failed proposal leaves source, preview, and history unchanged. A successful proposal is one transaction and is announced after commit.

### Complete editing state table

| Interaction | Draft/input state | Preview/check state | History and announcement |
| --- | --- | --- | --- |
| Context switch | Keep selected token, draft input, and dirty status; resolve the target concrete context | Recompute only for the new light/dark and motion context; mark old results stale | Context switch is not an edit and adds no history entry; announce the new context after the committed switch |
| Reset field | Remove only the selected token override | Recompute selected context from the base/layer precedence | One transaction; announce `Reset {path}` |
| Reset category | Remove overrides in the selected category only | Recompute affected contexts and list affected dependents | One transaction; announce count and category |
| Reset color mode | Remove overrides for the selected light/dark mode only | Re-evaluate all six contexts; mutate only the selected color-mode override scope | One transaction; announce mode and count |
| Reset whole theme | Remove all user overrides; preserve immutable base/source | Recompute all six concrete contexts | One transaction; announce `Reset theme`; undo restores exact overrides |
| Dirty text/number input | Preserve the exact partial string separately from last valid source | Keep last-valid preview and show path-addressed error when invalid | Native text undo/redo wins while focused; commit adds one history entry |
| Slider gesture | Update draft input during movement | Do not validate/announce every frame; preview updates on committed pointer-up value | Entire gesture is one transaction; announce final value only |
| Undo/redo | Restore source, aliases, metadata, selected context, and draft status atomically | Recompute affected preview/check revision | Builder history runs only when no text control is actively editing; announce scope |
| Alias rebind | Require compatible target and show before/after dependents | Preview updates only after explicit Apply | One transaction; announce target and dependent count |
| Replace alias with literal | Show representation change and preserve source metadata until Apply | Apply only after every usage contract validates | One transaction; undo restores alias exactly |
| Recipe input edit | Show recipe inputs and trusted base digest | Recompute derived values; unsupported imported recipes stay invalid | One transaction; announce recipe input and findings |
| Recipe replace with literal | Explicit action only when representable | Validate complete CSS usage contract before Apply | One transaction; undo restores trusted recipe |
| Import | Keep current draft untouched through preflight | Apply only supported/valid outcome; unsupported/invalid keeps last-valid preview | Successful import is one transaction; rejection announces recovery action |
| Export | No draft mutation | Export current valid envelope/contexts/report; future drafts download unchanged | No history entry; announce ready or failure |

All thirteen DTCG types have a named editor path: `color` uses text plus `ColorPicker`; `dimension` uses a numeric value and `px`/`rem` unit; `fontFamily` uses ordered fallback text; `fontWeight` uses a numeric or named weight; `duration` uses a nonnegative value and `ms`/`s` unit; `cubicBezier` uses four finite numeric fields, with only the first and third constrained to 0–1; `number` uses a typed numeric profile; `strokeStyle` uses a named style or its structured dash array and line cap; `border` uses width, style, and color members; `transition` uses duration, timing function, and delay members; `shadow` uses offset, blur, spread, and color members; `gradient` uses ordered color/position stops; and `typography` uses family, size, weight, letter spacing, and numeric line height members. Composite arrays expose named move-up, move-down, add, and remove controls. Each editor preserves aliases, metadata, and authored units. Source-only imported tokens use the same editor types without inventing CSS bindings.

### Alias and recipe editing

An alias displays authored value, resolved value, effective type, source path, winning context/layer, and direct references. Rebinding requires a compatible target. Replacing with a literal is explicit and shows affected dependents before Apply; references are never silently severed.

Recipe-controlled values show inputs and trusted shipped recipe source digest. Replace with literal is available only when representable and valid against every recorded CSS usage contract. Unsupported imported recipes remain visible with an error and cannot execute.

### Seed, proposal, preview, apply

Palette creation and spacing proposals are previews, not immediate mutations. Seed or factor controls show baseline, target scope, locked members, current overrides, aliases/recipes, every affected path, and dependents. Component and Application previews update only from the proposal snapshot. Cancel discards it. Apply commits selected changes as one transaction. Download proposal works for a valid proposal that cannot be applied locally.

For spacing, Compact is 0.75, Standard is 1, and Comfortable is 1.25 over the selected existing foundation spacing scale. These are ordinary source overrides—not a density mode or accessibility guarantee. Units, zero values, aliases, recipes, locked members, explicit overrides, and selected scope are displayed. Reapplying the same proposal is a no-change result with no history entry. A check failure after Apply reports its outcome without silently repairing another token.

The proposal surface is explicit at every stage:

| Stage | Annotated state |
| --- | --- |
| Seed | `Create palette` shows seed color, family (`Accent`, `Neutral`, or status), concrete light/dark context, baseline source value, and the generation algorithm/gamut target. No draft value changes. |
| Proposal | Before/after rows list every proposed path, source space/value, proposed value, locked member, existing override, alias/recipe, and dependent. `Cancel`, `Apply`, and `Download proposal` are separate actions. |
| Preview | Components and Application scenes are labeled `Proposal preview`; current draft and shipped values remain available for comparison. A stale proposal names its base revision/context and disables Apply. |
| Apply | A successful Apply shows the selected scope and committed revision, records one history entry, re-runs checks, and announces the result once. |
| Post-check failure | The preview remains applied and the checks panel shows the exact finding, severity, affected paths, and `Undo`/`Open proposal` actions. It never silently repairs another token or claims the preset is accessible. |

The same annotations apply to Compact, Standard, and Comfortable spacing proposals. A proposal whose source or context changed is stale and can only be cancelled or downloaded.

### Source and dependencies disclosure

The disclosure is an accessible list/table, never a graph canvas. It includes authored and resolved values, effective type origin, winning source, overridden layers, direct references or recipe inputs, transitive dependents grouped by concrete context, public CSS usage, and source/CSS/portable disposition.

| State | Display and action |
| --- | --- |
| Two-hop alias | Show both hops, winning source, and each changed dependent once per context. Follow dependent selects the existing catalogue row. |
| Overridden context | Show context and later winning layer; reset names the scope before removing an override. |
| No dependents | Say No dependents in the evaluated contexts. |
| Source-only token | Say Source only; no CSS property binding. Do not invent a property. |
| Unknown metadata | Preserve as inert metadata and label it Unverified metadata supplied by source. |
| Invalid/cyclic result | Show the existing path-addressed diagnostic; no successful provenance result. |
| Stale result | Show evaluated revision/context; refresh before following or applying. |
| Empty disclosure | Keep heading and an explanatory empty state. |

Following a dependent retains originating context and token. Back to originating token returns to the original row and restores focus to the disclosure trigger. On mobile, before/after and dependency rows stack.

### Import preflight

No import mutates the draft before resource limits, unsafe-input checks, schema validation, and semantic validation finish.

| Outcome | Preflight result |
| --- | --- |
| Supported Cinder envelope | Recognized Cinder Theme v1; show scope, contexts, preserved metadata, and target compatibility. Apply or Cancel. |
| Supported DTCG document | Schema-first 2025.10; list known targets, extra Source tokens, references, inert extensions, and source/CSS/portable limitations. Apply or Cancel. |
| Recognized unsupported profile/dialect | Explain inspected shape and unsupported features without claiming brand or standards failure. Keep draft unchanged; Download unchanged. |
| Invalid input | Show strict JSON/path diagnostics such as invalid em dimensions, missing effective type, or invalid strokeStyle. Keep draft and last-valid preview unchanged; Download unchanged. |

Unknown formats remain unrecognized rather than guessed from filenames. Source URL, package version, and license are shown only when supplied in metadata or a pinned fixture manifest, labeled unverified. No remote references are fetched.

### Rename, trash, and permanent deletion

Rename uses a `Modal` with the current name in its description. Empty, overlong, or case-insensitive duplicate names keep the modal open and attach the error to `Input`. Delete uses `ConfirmDialog`, then moves the theme to recoverable local trash. Trash counts toward limits and is never evicted automatically. Restore is available. Permanent delete requires a second explicit confirmation and removes the record and history; Escape and Cancel leave the theme intact.

### Storage conflict and export

An IndexedDB record includes a monotonically increasing revision and base snapshot. If another tab changes the same draft, show a blocking conflict Callout with Reload latest and Save as copy; never overwrite silently. A storage error retains in-memory edits, labels the draft unsaved, and enables download recovery.

Export remains in the toolbar on all tabs. It offers a lossless Cinder Theme v1 envelope, deployment CSS with explicit light/dark and motion behavior, one portable DTCG document per concrete context, and a validation report. Unsupported future drafts remain downloadable and are never rewritten.

## Controls and Cinder primitive mapping

No published component is admitted for layout alone.

| Builder control | Existing Cinder primitive or evidence | Required behavior |
| --- | --- | --- |
| Toolbar/actions | [`Button`](../src/components/button/README.md) with `variant`, `size`, `label`, and icon slots | Every icon-only action has an accessible name; loading exposes busy state. |
| Text, numeric, search, name inputs | [`FormField`](../src/components/form-field/README.md) plus [`Input`](../src/components/input/README.md) with `id`, `label`, `description`, `error`, `type`, and `value` | Stable ids, associated help/error, invalid state, native text undo. |
| Color value and picker | [`ColorPicker`](../src/components/color-picker/README.md) plus `Input` | Preserve authored color space; numeric/text entry remains available. |
| Foundation parameter | [`ParameterField`](../src/components/parameter-field/README.md) | Typed value and constraint presentation for dimensions, opacity, duration, numeric profiles. |
| Context/category choice | [`Select`](../src/components/select/README.md) and [`Dropdown`](../src/components/dropdown/README.md) | Keyboard selection, anchored trigger, explicit current value. |
| Mobile tabs and preview scenes | [`Tabs`](../src/components/tabs/index.ts), [`TabList`](../src/components/tab-list/tab-list.types.ts), [`Tab`](../src/components/tab/tab.types.ts), and [`TabPanel`](../src/components/tab-panel/tab-panel.types.ts) | Bind `Tabs.value`; use separate exports and actual `activateOnFocus`/orientation behavior. |
| Rename and rich proposal confirmation | [`Modal`](../src/components/modal/modal.types.ts) | `open`, `title`, `triggerRef`, `describedById`, dismissal, and focus restoration are explicit. |
| Delete/permanent confirmation | [`ConfirmDialog`](../src/components/confirm-dialog/confirm-dialog.types.ts) | Use `confirmLabel`, `destructive`, `typeToConfirm`, and `onConfirm`; cancel remains the safe default. |
| Urgent blocking error | [`AlertDialog`](../src/components/alert-dialog/alert-dialog.types.ts) | Use only when Escape/backdrop dismissal must be disabled and explicit acknowledgement is required. |
| Findings/import outcomes | [`Callout`](../src/components/callout/README.md) plus a separate native `aria-live` announcer | Callout is static status content; its implementation strips live-region attributes, so announcements are emitted by the dedicated announcer. |
| Source/dependencies metadata | Existing disclosure and Lucide chevron | Rotating chevron; nested navigation uses lateral chevrons. |
| Short explanations | [`Tooltip`](../src/components/tooltip/README.md) | Supplements an accessible name; never carries the only state. |
| Floating panels | cinder-\_floating-surface class | Bounded surface, visible focus, viewport-safe placement. |
| Announcements | Dedicated native `aria-live` region and `cinder-sr-only` utility | Announce commits, checks, conflicts, and import results; not slider frames. |

The color-only panel and the separate token inspector that preceded the builder are gone. Their patterns live on in one editor: [`theme-color-editor.svelte`](../../../applications/playground/src/shell-app/theme-color-editor.svelte) (`ColorPicker`, `Input`, channel fields), [`theme-foundation-editor.svelte`](../../../applications/playground/src/shell-app/theme-foundation-editor.svelte), [`theme-composite-editor.svelte`](../../../applications/playground/src/shell-app/theme-composite-editor.svelte), [`theme-token-editor-generic.svelte`](../../../applications/playground/src/shell-app/theme-token-editor-generic.svelte) and the catalogue's inspect view in [`theme-workbench-catalogue.svelte`](../../../applications/playground/src/shell-app/theme-workbench-catalogue.svelte) (`FormField`, `Input`, a semantic table). The builder has one draft model and no second color-only model. The [`Callout`](../src/components/callout/callout.svelte) implementation is deliberately not the live region; the separate announcer owns that responsibility.

## Keyboard, focus, and announcement matrix

| Surface/state | Keyboard contract | Focus contract | Announcement |
| --- | --- | --- | --- |
| Shell entry | Skip link first; Tab through toolbar and landmarks | Skip link lands on builder heading | Theme builder on route entry |
| Catalogue | Up/Down rows; Home/End bounds; Enter selects; typeahead/search filters | Selected row has visible focus and selection semantics | Selected name and value on committed selection |
| Tabs | Left/Right; Home/End; activation follows horizontal focus | Panel focus moves without losing token selection | Selected tab |
| Form input | Native editing/undo; Enter commits a valid field; Escape restores the uncommitted field draft | Error remains adjacent; commit returns focus to field | Saved path or invalid reason |
| Slider/number | Arrow; PageUp/PageDown; Home/End bounds | One focus target through gesture | Path and value on commit only |
| Color picker | Existing picker keyboard model; Escape closes popover first | Closing restores picker trigger | Color value committed |
| Select/Dropdown | Arrow navigation; Enter selects; Escape closes | Trigger regains focus | Selected option and context |
| Source disclosure | Enter/Space opens; Escape closes; Tab exits | Trigger is return target | Expanded/collapsed |
| Dependent navigation | Enter follows; Back returns; Escape closes disclosure | Back restores originating token and trigger focus | Showing dependent and origin |
| Modal/ConfirmDialog | Tab stays inside; Escape/backdrop dismisses user-initiated dialogs; Enter activates the named action | Restore opener | Rename conflict or moved to trash |
| Import preflight | Tab outcome/details/actions | Apply disabled for unsupported/invalid | Disposition and revision |
| Checks/fix | Enter finding; Apply/Cancel explicit | Failed fix leaves focus on proposal | Checks complete with counts |
| Undo/redo/reset | Toolbar buttons and documented shortcuts; text undo wins in focused input | Focus remains on edited field | Undid or reset scope |
| Export | Enter format menu; Escape closes | Restore toolbar trigger | Export ready or failed |
| Storage conflict | Tab Reload latest and Save as copy | Callout receives focus once | Another tab changed this draft |

The settled command set is Mod+Z/Mod+Shift+Z for builder history only when no text input is actively editing, Mod+Enter to commit a focused valid field, and Escape for the innermost open popover, disclosure, or dismissible Modal. Native text undo always wins inside an Input. Arrow keys, Home, and End are reserved for the focused Select/Dropdown, Tabs, catalogue row, slider, or typed editor described in the matrix; no builder shortcut shadows browser editing.

## Checks and responsive acceptance matrix

| Requirement | 1440px | 768px | 390px | 320px |
| --- | --- | --- | --- | --- |
| Navigation/context | 208px rail, flexible editor, 360px preview/checks | 176px rail, flexible main region, full-width preview/checks row | Edit/Preview/Checks tabs | Three tabs stay in one row |
| Catalogue | Six named fields in inspector table | Six named fields as stacked pairs in main region | One-token stacked rows | Wrapped one-token rows |
| Preview/checks | Adjacent persistent panels | Bounded panels below editor | Separate tabs, state retained | Separate tabs, no overflow |
| Provenance | Side pane | Below selected row | Stacked disclosure rows | Stacked, full-width recovery |
| Proposal before/after | Side-by-side | Side-by-side within the flexible main region | Vertical rows | Vertical rows |
| Focus | Visible, unobscured | Same | Same after tabs | Same after wrapping |
| Export/status | Persistent | Persistent | Persistent | Persistent |

The checks pipeline covers contrast, text resize, reflow, spacing, keyboard access, visible and non-obscured focus, target size, error identification/instructions, names/roles/values, motion, forced colors, and unknown gradient/image backgrounds. Missing measurement is Needs review; normative failures are errors; advisory findings do not change acceptance alone. The performance contract remains the existing 200ms p95 interaction measurement.

## Provenance and interoperability details

The runtime returns deterministic ordered provenance records and dependency identities for each evaluated revision/context. Duplicate dependents appear once per context. Source remains unchanged. Public CSS usage is shown separately from source-only tokens.

Import recognition is qualified: resolver version/resolutionOrder, Acronis values/platforms, Spectrum cascade records, and strict-JSON failures with JSON5-like syntax can be identified for diagnosis. Identification does not claim a brand converter or standards conformance. The offline fixture manifest pins URL, version/commit, SHA-256, license/attribution, disposition, and reason. The inspected Terrazzo Figma SDS positive fixtures are MIT-attributed. No Canonical LGPL assets or foreign preset gallery is included.

The inherited DTCG strokeStyle case remains a validation boundary: successful import preserves source and metadata, while malformed none, hidden, or banana values fail with original paths. Browser and command-line paths must report the same ordered provenance and diagnostics.

## Shipped behavior and automated evidence

COR-254 (TB12) is the acceptance pass over the integrated builder. This section records what shipped and which automated checks prove it; it does not record any human approval, and the approval fields in [theme-builder.a11y.md](theme-builder.a11y.md) are unchanged.

### Where it runs

The builder is the `/theme-builder` route of `applications/playground`, with its trusted preview frame at `/theme-builder/preview`. The static export (`bun run build`) writes both routes and their bundle graphs, including the evaluation worker. Documentation routes load none of it.

### Evaluation runs off the main thread

The token runtime evaluates in module workers (`theme-runtime-worker.ts`, built by the same `Bun.build` as the workbench and preview entries). `createWorkerEvaluator` implements the existing `ThemeEvaluator` seam, so no caller changed. The draft's own evaluation has a worker to itself; the checks, export and proposal surfaces share a second one, so an edit's preview is never queued behind the previous edit's background checks. The embedded Cinder base crosses the worker boundary once per worker, not with every edit. Responses are still matched to the revision and context they answer, and results are remembered per envelope on the main thread.

Because a context change now lands after a short evaluation, the Color mode and Motion selects show the requested context (`requestedContext`) while the change is in flight. A second change made in that moment builds on the first. If the change cannot be evaluated, the controls return to the applied context.

Cold start, measured on the same suite before and after (Chromium, `/theme-builder` loaded cold, until the draft, the preview and the checks panel are ready). Long tasks are main-thread tasks over 50ms.

| Condition | Before (in-thread) | After (workers) |
| --- | --- | --- |
| No throttling, longest task | 234 to 277ms (three tasks, 414 to 543ms in all) | 82 to 90ms (one task) |
| 4x CPU slowdown, longest task | 996ms (three tasks, 1780ms in all) | 348 to 373ms (two tasks, about 430ms in all) |
| 6x CPU slowdown, longest task | 1513ms (three tasks, 2733ms in all) | 570ms (about 710ms in all) |

The several-second block reported for a loaded host reproduces only under CPU slowdown. On an unloaded Apple-silicon desktop the first evaluation held the thread for roughly a quarter of a second. What remains after the change is the page's own script start-up; the runtime no longer blocks input.

### Automated suites

All run in Chromium against the development server and against the static export (`PLAYGROUND_BROWSER_STATIC=1`), from `applications/playground` with `bun run test:browser`.

| Suite | Covers |
| --- | --- |
| `theme-builder-workflow.playwright.ts` | Create a theme; edit a radius, a spacing token, a motion token, a color, a composite shadow member and an alias; invalid input kept and recovered; export source, CSS and portable subset and compare them with the preview; apply a palette, see its findings, apply one remediation fix and undo it; CSS blocked while errors remain; re-import the exported source to the identical draft; reload; all six contexts; 1440, 768, 390 and 320px with every tab free of horizontal overflow |
| `theme-builder-accessibility.playwright.ts` | Axe (`wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22aa`, every impact level) on the builder chrome in six contexts, on every preview scene in light and dark and on the reference scenes in the four other contexts, and on library dialogs, proposals, the export and import dialogs, the Source and dependencies disclosure, the checks panel (passing and failing) and the three mobile tabs; plus rendered 1.4.4, 1.4.10, 1.4.12, 2.4.7, 2.4.11, 2.5.8, forced colors and reduced motion checks. One test per scene, context or surface, so no test needs a raised budget |
| `theme-builder-keyboard.playwright.ts` | A forward and backward Tab pass with visible, unobscured focus and no trap; a keyboard-only edit, Apply and Undo; focus returned to the trigger after every dialog, by Escape and by its own button, including nested Trash and permanent-delete dialogs |
| `theme-builder-performance.playwright.ts` | p95 (19th of 20 samples, after three warm-ups) of at most 200ms for opening a category, filtering `radius`, committing a radius edit, committing an accent edit and switching light and dark |
| `theme-builder-responsiveness.playwright.ts` | The runtime runs in workers; the longest main-thread task during a cold start is at most 200ms, and at most 600ms at a 4x CPU slowdown |
| `theme-builder-foundations`, `-colors`, `-composites`, `-interchange`, `-remediation`, `-draft`, `-preview` | The issue-level scenarios of the foundation, color, composite and alias, import and export, remediation, draft and storage, and preview work |

Performance, in milliseconds, measured by `theme-builder-performance.playwright.ts` on an Apple-silicon desktop with no CPU throttling:

| Interaction           | Development server | Static export |
| --------------------- | ------------------ | ------------- |
| Open a category       | 27.2               | 30.1          |
| Filter `radius`       | 27.3               | 26.3          |
| Commit a radius edit  | 155.0              | 154.8         |
| Commit an accent edit | 155.8              | 154.6         |
| Switch light and dark | 45.2               | 44.5          |

The commit budgets leave about 45ms of margin: the edit is evaluated in a worker and returned, which costs more than evaluating in-thread but never blocks input.

### Defects found and fixed by the acceptance pass

- The import dialog's file input had no accessible name (Axe `label`, critical). It is now named "Theme file (JSON)".
- The color picker's three stacked copy-format buttons were 14px tall (WCAG 2.5.8, Axe `target-size`). They are now at least 24px tall, with a CSS regression test.
- A second preview-context change made before the first had landed discarded the first. The controls now build on the requested context.
- Browser suites that assumed a synchronous evaluation now wait for the frame, the closing dialog or the committed lock. The interchange suite addressed a field the foundation editors replaced.

### Still pending, and not claimed here

- Steve Kinney's design sign-off, recorded against the exact revision.
- The named practitioner's accessibility sign-off, including the manual VoiceOver, keyboard, focus and reflow checks.
- Manual reproducible runs in current stable Firefox and Safari/WebKit on macOS.
- Screenshots and findings at the four reference widths for the design sign-off.

## Review gate

This artifact is complete for implementation handoff when the coordinator can point to every contract state above, the exact Cinder primitive mapping, and the review record in docs/theme-builder.a11y.md. It is not complete for CIN-573 until Steve's design approval and Steve's or his named practitioner's recorded accessibility review match the exact artifact revision and report zero remaining findings.
