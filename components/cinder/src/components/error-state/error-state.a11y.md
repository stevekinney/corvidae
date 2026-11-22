# ErrorState accessibility

## Pattern

ErrorState stands where an `EmptyState` would, for a region whose data failed to load. By default it renders through `Alert` with the `danger` variant, which owns `role="alert"`, so the failure is announced assertively when the component mounts; the `flat` variant puts `role="alert"` on its own body instead. Exactly one element carries `role="alert"`. The alert is named by the title through `aria-labelledby`.

Purpose: Error placeholder, centered in an alert or flat on the surrounding surface, with a title, description, optional detail, and optional retry button for a region whose data failed to load.

## Use when

- Replacing a primary content region after its query or request failed, so the failure never looks like an empty result.
- Offering the user a retry for a region that can be reloaded.

## Avoid when

- Communicating that a region has no data — use empty-state instead.
- Reporting the result of a just-completed action — use alert or toast-region.

## Keyboard and focus

The only interactive element is the optional retry `Button`, which is a native button reachable with Tab and activated with Enter or Space. ErrorState never moves focus. When a retry replaces the error with content, the caller decides where focus goes next.

## Names, roles, and state

The title renders as a heading at `headingLevel` (default 2), so pick the level that fits the surrounding outline. The optional `remediation`, the next step to take, is a paragraph inside the labelled region, directly after the description and before any progress line, so assistive technology reads what failed and then what to do, in that order, as part of the alert. The optional `detail`, such as a fault code, is plain text and is announced with the alert. The retry button's accessible name is its `retryLabel`; make it specific when several error states share a page. Meaning is carried by text, never by color alone.

The role follows the tone. `danger` is always `role="alert"`. `warning` is `role="status"`, announced politely, because a problem the person can resolve, such as a conflicting change, need not interrupt what a screen reader is saying. `neutral` is a plain `role="group"` and is not announced, because nothing failed. `announce` raises a `warning` or `neutral` state to `role="alert"`; use it when the state replaces the content the person came for, so staying quiet would leave them with nothing. Whatever the role, exactly one element carries it and it is named by the title.

## Verification

- Render ErrorState with and without `onRetry` in the playground or a focused test fixture.
- Render it with `remediation` and confirm a screen reader reads the title, the description, then the remediation.
- Confirm a screen reader announces the alert when it appears.
- Tab to the retry button and activate it with Enter and Space.
- Check contrast of the title, description, and detail in light and dark themes.

Related components: `alert`, `empty-state`, `banner`.
