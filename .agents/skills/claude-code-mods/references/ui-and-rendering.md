# UI and rendering

Every place a mod can draw is a render site. Claude Code fires `ui.render` each time it is about to draw one, and the hook returns what to draw: a plain-data tree of elements, Claude Code's own drawing, or Claude Code's drawing with changed props. Native mod UI is not HTML, React, or Svelte. It is a small, validated element vocabulary that each surface (the terminal, the Desktop app, the VS Code extension, the mobile app) paints its own way.

## The render hook

```tsx
import { atom, read } from 'claude-code';
import type { Register } from 'claude-code';

// The `agents` value is declared in the plugin's contract, as in the reactive-pane template.
const agents = atom({ plugin: 'agent-roster', key: 'agents' } as const, [], { shape: 'agents-1' });

export const register: Register = (on) => {
  on('ui.render', { component: 'Pane', requestId: 'agent-roster' }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e);
    const rows = await read($, agents);
    return (
      <Box flexDirection="column">
        {rows.map((row) => (
          <Text>{row.description}</Text>
        ))}
      </Box>
    );
  });
};
```

The snippets below are `on(...)` calls from inside the same `register`.

The hook's `e` carries everything about the instance being drawn:

| Field | Meaning |
| :-- | :-- |
| `e.component` | The render site, such as `Pane` or `ToolUse` |
| `e.surface` | `terminal`, `desktop`, `vscode`, or `mobile`. Narrowing it narrows the element table. |
| `e.requestId` | The instance: a pane's `id`, a tool call's `tool_use_id`, a message's id, an agent id for the spinner |
| `e.props` | The site's plain-data props, listed below |
| `e.viewport` | `columns`, `rows`, and `isFullscreen` in cells, once the surface has measured. In the terminal and the Desktop app it is absent before then, and its `rows` is the whole window. |

The hook can answer in three ways:

- **Draw**: return a tree, and the sites after this mod do not draw
- **Leave the site alone**: return `next(e)`
- **Change a detail**: return `next({ ...e, props })` to keep Claude Code's drawing with changed props

Size a pane or band tree to `e.props.bodyColumns`, never to `e.viewport.columns`. A width change re-runs every hooked site once the resize settles. A height change alone redraws nothing.

## Elements

Get the elements from the surface's own table, `$.ui.resolve(e)`, inside each hook. They are not globals, and each surface's table differs (2.1.321 declarations):

| Element | Terminal | Desktop | VS Code | Mobile |
| :-- | :-: | :-: | :-: | :-: |
| `Box`, `Text`, `Button`, `Link`, `Code`, `Markdown`, `Input`, `Select` | ✓ | ✓ | ✓ | ✓ |
| `Svg` |  | ✓ | ✓ | ✓ |
| `Client` | ✓ | ✓ |  |  |
| `Raster`, `Image` | ✓ |  |  |  |

A mobile app that has not said it draws `Input` or `Select` receives an empty `Box` in their place, and a hook cannot tell. The VS Code extension ignores some props and draws the element as if they were absent: `Box` `position` and `hover`, `Text` `size`, `mono`, and `tabular`, `Button` `hotkey`, `plain`, `autoFocus`, `action`, `variant`, and `role`, `Code` `language`, `path`, `startLine`, `format`, and `wrap`, and `Input` `rows` ([mods reference](https://code.claude.com/docs/en/plugins/mods/reference)).

The props that matter most, from the declarations:

| Element | Props |
| :-- | :-- |
| `Box` | `key`, `flexDirection`, `flexGrow`, `flexShrink`, `flexWrap`, `alignItems`, `alignSelf`, `justifyContent`, `gap`, `columnGap`, `rowGap`, `margin*`, `padding*`, `width`, `height`, `minWidth`, `minHeight`, `borderStyle`, `borderColor`, `borderDimColor`, `backgroundColor`, `position`, `top`, `left`, `right`, `bottom`, `overflow`, `display`, `hover` |
| `Text` | `color`, `backgroundColor`, `dimColor`, `weight`, `size`, `mono`, `tabular`, `italic`, `underline`, `strikethrough`, `inverse`, `wrap`, `dir`, `hover`; `bold` is deprecated in favor of `weight` |
| `Button` | `key`, `label`, `onPress`, `hotkey`, `action`, `plain`, `dimColor`, `variant` (`primary` or `secondary`), `role` (`dismiss`), `autoFocus`, `hover`, and children of strings and `Text` only |
| `Code` | `source` (the text), `language`, `path` (only to infer the language; never read), `startLine`, `format` (`source` or `diff`), `wrap` (`wrap` or `truncate-end`) |
| `Markdown` | `text` (not children), `key`, `dimColor`, `onLinkPress`, `pressableLinks` |
| `Link` | `href`, `label` |
| `Input` | `key`, `label`, `placeholder`, `value`, `submitLabel`, `rows`, `onSubmit`, `onInput`, `autoFocus` |
| `Select` | `key`, `label`, `options` of `{ value, label }`, `value`, `onSelect`, `autoFocus` |
| `Svg` | `source` (up to 131,072 characters), `alt`, `width`, `height`, `isInteractive` |
| `Raster` | `key`, `columns` (up to 512), `rows` (up to 256), `cells` (base64 of three 32-bit numbers per cell: code point, color, background) |
| `Image` | `key`, `source` (PNG or RGBA bytes up to 2 MiB, or a file or shared-memory name), `columns` and `rows` (up to 255), `alt` |
| `Client` | `module` (a string-literal path), `key`, `props` (JSON), `width`, `height`, `flexGrow` |

Details that trip people up:

- **Spacing and borders**: spacing props take cells or a step name from `xs` to `xl` (2.1.299 or later; an older build refuses the tree). `borderStyle` is one of `single`, `double`, `round`, `bold`, `singleDouble`, `doubleSingle`, `classic`, `arrow`, `dashed`, or `quote`. Any other name draws no border.
- **Colors**: a color is a theme key (`text`, `subtle`, `success`, `error`, `warning`, `suggestion`, `permission`, `diffAdded`, and others) or a raw color string. `$.theme` is not a design-token object: it only sets and clears a backdrop the Desktop and mobile apps draw (2.1.319 or later).
- **Text wrapping**: `wrap` takes `wrap`, `end`, `middle`, `truncate`, `truncate-start`, `truncate-middle`, or `truncate-end`. The typography props `size`, `weight`, `mono`, and `tabular` are requests that the terminal mostly ignores.
- **Buttons**: `autoFocus`, and the `focus`, `closeOnEscape`, and `holdToasts` fields of `$.ui.open`, accept only `true`. Omit them rather than passing `false`, which throws. A `hotkey` is one digit or lowercase letter.
- **Links**: in the Desktop app and VS Code, a `Link` draws as plain text unless its `href` is a canonical `https:` URL with no `@` (the interface page also allows `http://localhost`, and the declaration says remote surfaces take `https:` only). The terminal draws any scheme.
- **Markdown**: `Markdown` draws model-style text. A link outside `https:`, `http:`, or `file:` draws as text.

A tree that does not validate (an element the surface lacks, an unknown prop, a child where none goes) fails the hook, which is then skipped while the next drawing stands. The line reads, for example, `my-mod: ui.render hook skipped: returned the wrong shape (a tree Pane refuses: Text prop "bogusProp" is not allowed)`. A tree past a size limit is refused at that site as `ui.render (<site>) refused: <reason>`.

## Render sites

| Site | What it is | Adds or customizes | Surfaces | `e.props` |
| :-- | :-- | :-- | :-- | :-- |
| `Pane` | A framed region the mod opened with `$.ui.open` | Adds | Terminal, Desktop, VS Code | `title`, `isFocused`, `bodyColumns`, `placement`, `scroll`, `view` |
| `AbovePrompt` | The shared band directly above the prompt | Adds, shared | Terminal, Desktop | `hasSurvey`, `isCollapsed` (declared in 2.1.321), `isWorking`, `maxRows`, `bodyColumns`, `scroll`, `view` |
| `Placed` | A row the mod placed in the transcript with `$.ui.place` | Adds | Terminal | `id`, `plugin`, `onScreen` |
| `Backdrop` | A drawing behind the conversation, set with `$.theme.set` | Adds | Desktop, mobile | `id`, `plugin`, `glass`, `colorScheme` |
| `UserMessage` | Every user-role row: prompts, task notifications, messages from other agents or sessions | Customizes | Terminal, Desktop, VS Code | `text`, `origin`, `isExpanded`, `task` or `from`, `onScreen` |
| `AssistantMessage` | A reply | Customizes | Terminal, Desktop, VS Code | `text`, `isFirstOfReply`, `isSummary`, `onScreen` |
| `ToolUse` | A tool call's row | Customizes | Terminal, Desktop, VS Code | `tool`, `input`, `isRunning`, `isErrored`, `isInterrupted`, `isExpanded`, `output`, `onScreen` |
| `ToolResult` | A tool call's result | Customizes | Terminal, Desktop, VS Code | `tool`, `output`, `isErrored`, `isExpanded`, `onScreen` |
| `ToolGroup` | A collapsed group of calls | Customizes | Terminal, Desktop, VS Code | `calls`, `isActive`, `isExpanded`, `isCallsOnly`, `onScreen` |
| `ToolProgress` | A running tool's live progress line | Customizes | Terminal | `kind`, `hint` |
| `CommandOutput` | The row a slash command printed | Customizes | Terminal, Desktop | `command`, `args`, `text`, `isErrored`, `onScreen` |
| `AskUserQuestion` | The dialog Claude asks questions in | Customizes, with limits | Terminal, Desktop, VS Code | `tool`, `questions`, `metadataSource` |
| `Spinner` | The line that animates while Claude works | Customizes | Terminal, Desktop, VS Code | `word`, `message`, `suffix`, `mode` |
| `TurnDuration` | The line that closes a turn | Customizes | Terminal | `word`, `durationMs`, `isExpanded`, `waitingFor`, `onScreen` |
| `InfoNotice` | Status lines under the logo | Customizes | Terminal | `text`, `command`, `onScreen` |
| `SessionMode` | The mode labels in the footer | Customizes | Terminal, Desktop | `modes` |
| `PromptHint` | The hint line under the prompt | Customizes | Terminal, Desktop | `isDraft`, `isWorking`, `hint`, `tail` |

The props come from the 2.1.321 declarations and the surfaces from the documented render-site table, which can grow; check the build's `RenderComponent` type rather than a count. The permission prompt is not a render site, so no mod can change what it shows.

## Panes

```typescript
on('command.run', { command: 'agent-roster' }, async ($) => {
  const opened = await $.ui.open({
    id: 'agent-roster',
    title: 'Agents',
    focus: true,
    closeOnEscape: true,
  });
  // Where the pane waits, reason says why: too narrow for an unasked open, or no surface placing panes.
  return opened.isPlaced ? {} : { text: `The agents pane is waiting: ${opened.reason}` };
});

on('command.run', { command: 'agent-roster-close' }, async ($) => {
  await $.ui.close({ id: 'agent-roster' });
  return {};
});
```

- **Opening draws nothing**: Claude Code then fires `ui.render` for `{ component: 'Pane', requestId: id }`. Calling `$.ui.open` again with the same `id` retitles the pane in place.
- **Placement**: the surface decides. In a wide fullscreen terminal a pane docks beside the transcript (`placement: 'dock'`, from 110 columns); otherwise it sits above the prompt (`'inline'`). VS Code docks at 800 pixels or wider. No API places a pane on the left, at the bottom, or floating, and none splits panes. With several panes open, each becomes a tab.
- **Size**: `rows` asks for height inline, by default a third of the space. `columns` asks for width when docked, at most 45%, and a width the person has set wins. VS Code ignores both. Inside the pane, `e.props.bodyColumns` is the width and `e.props.scroll.bodyRows` the rows available. A taller tree scrolls as a whole, and the scroll position belongs to the engine.
- **Opening unasked**: a pane opened from a timer or a `turn.start` hook, rather than a command or a press, appears only in a terminal at least 144 columns wide, or 110 once the person has opened that pane themselves. Otherwise it waits with `isPlaced: false`. Use a toast to say something is available instead.
- **Focus and keys**: `focus: true` is granted only while the prompt is empty and nothing else has keyboard focus. While a pane has focus, Tab and the arrows move between controls, Enter presses, a hotkey presses its button, and Esc returns focus to the prompt (and closes the pane with `closeOnEscape`). A mod cannot bind Tab or the arrow keys.
- **`holdToasts`**: holds every toast, other mods' included, while the pane shows. Use it only for a dialog the person answers and leaves.
- **Closing**: the person closes a pane from its close mark or Ctrl+X then X. `ui.close` fires with `e.origin.kind` set to `plugin`, `person`, or `unload`, and a hook may refuse it. `$.ui.panes()` lists the mod's open panes.

A command that opens a pane should be registered with `immediate: true`, so it runs while Claude is working, and should answer with text where `isPlaced` is false, as in `claude -p` ([reactive-pane template](../assets/templates/reactive-pane/README.md)).

## The band above the prompt

There is one band, and every mod shares it. A mod earlier in the chain that returns a tree without the result of `next(e)` hides every later mod's band. Compose instead:

```tsx
on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
  const rows = await read($, agents);
  if (e.props.hasSurvey || rows.length === 0) return next(e);
  const { Box, Text } = $.ui.resolve(e);
  const theirs = await next(e);
  return (
    <Box flexDirection="column">
      <Text dimColor>{`Agents: ${rows.length}`}</Text>
      {theirs}
    </Box>
  );
});
```

- **The wrapper**: the `Box` around `theirs`, and every `Box` around it, takes no `width`, `height`, `minWidth`, `minHeight`, `position`, `top`, `left`, `right`, `bottom`, `display`, or `overflow` ([troubleshooting](https://code.claude.com/docs/en/plugins/mods/troubleshoot)).
- **Size**: keep the band to a line or two. Several mods stack there, and a tree past `e.props.maxRows` scrolls.
- **Collapsing**: the person can collapse the band (Ctrl+X then Ctrl+A, or the `[-]` mark), and then no hotkey or action binding presses a button in it. 2.1.321 declares `e.props.isCollapsed`; the documentation says a mod cannot tell. Either way, never make the band the only place for something the person must answer.
- **Hotkeys**: a digit `hotkey` on a band button also fires when the person types that digit alone into an empty prompt and pauses.

## Changing what Claude Code already draws

At a site Claude Code draws itself, `await next(e)` resolves to a reference to that drawing, `{ type: 'engine', ref }`, unless a later mod returned its own tree. A hook can keep the reference as it is, place it inside a `Box` beside its own elements, change it through `next({ ...e, props })`, or replace it entirely. On the mobile app, a `ToolUse` tree that keeps the row usually draws as one quiet line, or as a card under the row when the holding `Box` has a `borderStyle` or `backgroundColor`.

- **`AskUserQuestion`**: a tree must hold the engine's reference exactly once, with the mod's elements above it, or Claude Code draws its own dialog. The tree is held to 12 rows on the terminal and 48 on the other surfaces, and the terminal refuses `Markdown` there. No position, offset, width, or height is allowed. VS Code keeps its own question card and draws the mod's elements above it.
- **Display only**: rewriting `UserMessage` `text` or `AssistantMessage` props changes the row on screen, never what the model read or the transcript stores. Changing what is stored is `session.append`'s job, before the row is stored.
- **Expanded rows**: a hook that draws a compact row of its own should return `next(e)` while `e.props.isExpanded` (Ctrl+O), so the full row still shows.
- **Acting on a message**: capture its identity in the handler, from `e.requestId` (the message's id) or `e.props.text`, and act from the button's handler, not from the render hook.

## Placed rows

`$.ui.place({ id })` (2.1.314 or later, terminal only) adds a row at the end of the transcript that stays where it was placed and that Claude does not see. Draw it at the `Placed` site, checking both `e.props.plugin === $.plugin.name` and `e.props.id`, because every mod's hook hears every row. Placing the same `id` again while its row exists returns the same `requestId`. Change the row by redrawing it, not by placing it again.

A row ends when the conversation ends, when the person rewinds past it, or, outside fullscreen rendering, at a compaction. `--resume` does not bring it back. A mod holds at most 500 rows at a time. Where nothing draws placed rows, the call resolves `isPlaced: false`, so answer with text there.

## Presses, typing, and selections

Controls keep their handlers in the mod: `Button` `onPress(e)` (with `e.surface`), `Input` `onSubmit(value)` and `onInput(value)`, and `Select` `onSelect(value)`. Before a handler runs, Claude Code fires `ui.press`, `ui.input`, or `ui.select` with the control's key in `e.element`. Another mod's hook sees what the person typed into your `Input` and can change it or keep your handler from running. Never put a secret in a control's value (Recommendation).

- **Keys**: every `Input` and `Select` needs a non-empty string `key`. A `Button` without a `key` uses its label, so buttons in a list each need their own `key`, or presses and tests cannot tell them apart. A `Text` takes no `key` at all; key the `Box` that holds a row instead.
- **Text fields**: an `Input` redrawn with the same `value` keeps what the person is typing. A different `value` replaces it. Submitting an `Input` starts no turn unless the handler calls `$.prompt.submit`.

## Redraws and side-effect-free rendering

A drawing is a snapshot of the last tree the hook returned. Claude Code draws a site again when its props change, when the terminal's width changes, and after a handled `ui.fault`. It draws again too when the mod writes a `$.state` value that drawing read, or calls `$.ui.invalidate('ui.render')`. Redraws are throttled to ten a second, or thirty in the terminal for the visible pane, the expanded band, and the prompt hint, and calls that come faster are coalesced into one redraw.

Because a render hook runs again whenever any of those happen, sometimes once per surface, it must have no side effects (Recommendation):

- **Do in a render hook**: read `$.state`, read module variables, compute, and return a tree
- **Do in handlers, timers, and other events' hooks**: fetch, run processes, submit prompts, open panes, write `$.state` (refused while drawing), write `$.store`, start timers, call models

A fetch started from a render hook repeats on every redraw. To keep data fresh, refresh on events or a timer and let the write redraw the readers. To animate a `Raster` or `Image` already on screen without a render pass, use `$.ui.blit({ requestId, key, ... })`.

## `Client`

A `Client` element draws a region from a second module of the mod, for animation, pointer input, and custom graphics. It works in the terminal and the Desktop app.

- **The module**: `module` is a string-literal path relative to the hooks module, read from the source before anything runs. A variable or computed path is refused at load. The module exports a function `(props, surface) => tree`.
- **What the module receives**: no `$`. It gets `surface`, with the element table (no nested `Client`, `Raster`, or `Image`), local `state` and `setState`, `columns`, `rows`, an `every(ms, fn)` frame clock, `onPointer`, `onKey`, and `post(data)`.
- **Talking to the hooks module**: `post` sends plain data to the hooks module's `ui.message` hooks, one post per frame at most. A hook answering `{ props }` gives the instance new props. Props are at most 100,000 characters of JSON, never closures.
- **Failures**: three renders in a row that each call `setState` with nothing in between is a render loop, and the instance unmounts. A throw or a tree past the bounds unmounts it too, and the mod's `ui.fault` hooks receive `e.phase` (`load`, `render`, or `run`) and `e.reason`.

## Showing something without a site

| Call | Where it appears |
| :-- | :-- |
| `$.ui.status(text)` | One line under the prompt, prefixed with the mod's name, until replaced or cleared with `undefined` |
| `$.ui.toast(text, { timeoutMs })` | A short notification, 4 seconds by default; a mod's newer toast can replace its older one |
| `$.ui.log(text)` | A dim transcript line Claude does not read; `{ to: 'debug' }` sends it to the debug log instead |
| `$.ui.notice(tool_use_id, text)` | One line under the open dialog for that tool call |
| `$.ui.notify(text, { title })` | A notification through the person's own channel; resolves `isSent`, which does not mean it was seen |
| `$.ui.copy({ text, surface })` | The clipboard of the named surface; resolves `isCopied` |
| `$.ui.selection()` | What the person last selected with the mouse in the fullscreen terminal, or `undefined` |
| `$.ui.view({ agentId })` | Switches the main view to an agent's transcript, only in answer to the person's own input |

Text there is cut at 2,000 characters on the terminal. In VS Code, status lines and toasts sit above the prompt box, cut at 200 and 500 characters.
