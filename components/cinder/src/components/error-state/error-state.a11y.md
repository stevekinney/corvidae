# ErrorState · accessibility

## Pattern

ErrorState stands where an `EmptyState` would, for a region whose data failed to load. It renders through `Alert` with the `danger` variant, which owns `role="alert"`, so the failure is announced assertively when the component mounts. Exactly one element carries `role="alert"`. The alert is named by the title through `aria-labelledby`.

Purpose: Centered error placeholder with a title, description, optional detail, and optional retry button for a region whose data failed to load.

## Use when

- Replacing a primary content region after its query or request failed, so the failure never looks like an empty result.
- Offering the user a retry for a region that can be reloaded.

## Avoid when

- Communicating that a region has no data — use empty-state instead.
- Reporting the result of a just-completed action — use alert or toast-region.

## Keyboard and focus

The only interactive element is the optional retry `Button`, which is a native button reachable with Tab and activated with Enter or Space. ErrorState never moves focus. When a retry replaces the error with content, the caller decides where focus goes next.

## Names, roles, and state

The title renders as a heading at `headingLevel` (default 2), so pick the level that fits the surrounding outline. The optional `detail`, such as a fault code, is plain text and is announced with the alert. The retry button's accessible name is its `retryLabel`; make it specific when several error states share a page. Meaning is carried by text, never by color alone.

## Verification

- Render ErrorState with and without `onRetry` in the playground or a focused test fixture.
- Confirm a screen reader announces the alert when it appears.
- Tab to the retry button and activate it with Enter and Space.
- Check contrast of the title, description, and detail in light and dark themes.

Related components: `alert`, `empty-state`, `banner`.
