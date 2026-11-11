# Class-level markup recipe

A design canvas that cannot mount the bundle, or that is plain HTML, still uses Cinder's real component styles. Link `tokens.css` and `components/bundle.css`, then write the markup below. The classes and `data-cinder-*` attributes are exactly what each Svelte component renders, so `bundle.css` styles them and a fix to a Cinder component reaches the canvas the next time the design system is republished. Do not write a look-alike class such as `.btn` or `.pill` and style it by hand: that is the divergence this recipe removes.

```html
<link rel="stylesheet" href="ds/cinder/tokens.css" />
<link rel="stylesheet" href="ds/cinder/components/bundle.css" />
```

## When to use the recipe, and when to mount

- Mount `Cinder.<Name>` (see "Consuming the components" in the brand book) when the canvas runs React and the component takes plain props.
- Use this recipe's markup when the canvas is static HTML, or when a component takes a Svelte snippet the canvas cannot supply, such as a row's `title`, a button's `leadingIcon` or a drawer's `footer`.
- Never mix a hand-drawn class with these. If a component is missing from the recipe, read its guideline page and copy the markup from its Svelte source, or ask for it to be added here.

## Rules

- Variants and sizes are attributes, never extra classes: `data-cinder-variant="primary"`, `data-cinder-size="md"`. An attribute with no value, such as `data-cinder-selected`, is a flag.
- Every id on the page is unique, and an `aria-labelledby` or `for` points at a real id.
- Icons are Lucide glyphs drawn inline at 16px with `stroke="currentColor"`, hidden with `aria-hidden="true"`. The meaning belongs in the visible label or an `aria-label`.
- Hidden text uses `class="cinder-sr-only"`.
- Light and dark come from `data-theme` on `html` or on a subtree. Write no colour in the canvas; use `var(--cinder-*)` tokens.
- Every page in "Page archetypes" is built from this markup. Copy a whole page from its `preview.html` when the canvas is a page of that kind.

## Button

One labelled primary per screen. Variants: `primary`, `secondary`, `ghost`, `ghost-accent`, `soft`, `danger`, `soft-danger`, `ghost-danger`. Sizes: `xs`, `sm`, `md`, `lg`. A link that looks like a button is an `a` with the same class.

```html
<button type="button" class="cinder-button" data-cinder-variant="primary" data-cinder-size="md">
  Save changes
</button>
<button type="button" class="cinder-button" data-cinder-variant="secondary" data-cinder-size="md">
  Cancel
</button>
<a href="#" class="cinder-button" data-cinder-variant="ghost" data-cinder-size="md">View history</a>
<button
  type="button"
  class="cinder-button"
  data-cinder-variant="ghost"
  data-cinder-size="md"
  data-cinder-icon-only
  aria-label="Add a place"
>
  <span class="cinder-button__icon" aria-hidden="true"
    ><svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M5 12h14" />
      <path d="M12 5v14" /></svg
  ></span>
</button>
```

## Chip

A short tag, not label and value metadata. Variants: `neutral`, `info`, `success`, `warning`, `danger`, `accent`. Sizes: `sm`, `md`. A toggle chip is a `button` with `aria-pressed`.

```html
<span
  class="cinder-chip"
  data-cinder-mode="display"
  data-cinder-variant="neutral"
  data-cinder-size="md"
  ><span class="cinder-chip__label">Rooftop</span></span
>
<button
  type="button"
  class="cinder-chip"
  data-cinder-mode="toggle"
  data-cinder-variant="neutral"
  data-cinder-size="md"
  aria-pressed="true"
>
  <span class="cinder-chip__label">Open now</span>
</button>
```

## SegmentedControl

A filter or a view switch. The visible label is optional, but the label element is always present.

```html
<div class="cinder-segmented-control-container">
  <span id="view-label" class="cinder-segmented-control-label cinder-sr-only">View</span>
  <div
    id="view"
    role="radiogroup"
    aria-labelledby="view-label"
    aria-orientation="horizontal"
    class="cinder-segmented-control"
    data-cinder-orientation="horizontal"
    data-cinder-size="md"
    data-cinder-selection-mode="single"
    data-cinder-variant="radiogroup"
  >
    <button
      type="button"
      role="radio"
      aria-checked="true"
      tabindex="0"
      class="cinder-segmented-control-option"
      data-cinder-segment-value="list"
      data-cinder-selected
    >
      List
    </button>
    <button
      type="button"
      role="radio"
      aria-checked="false"
      tabindex="-1"
      class="cinder-segmented-control-option"
      data-cinder-segment-value="map"
    >
      Map
    </button>
  </div>
</div>
```

A count follows the label with no space and carries its own separator:

```html
<button
  type="button"
  role="radio"
  aria-checked="true"
  tabindex="0"
  class="cinder-segmented-control-option"
  data-cinder-segment-value="waiting"
  data-cinder-selected
>
  Waiting on you<span class="cinder-segmented-control-option-count"
    ><span class="cinder-segmented-control-option-count-separator">, </span>3</span
  >
</button>
```

## Input and Select

A field is a label, a control and an error node that is always present. The control fills with `cinder-control-background` and draws a 3:1 boundary; do not remove either. For a filled field add `data-cinder-appearance="filled"` to the control: it takes the inset fill inside the same 1px control border and a 12px radius, never a fill without the edge. Under `data-density="comfortable"` a field with no `data-cinder-appearance` is already filled and 48px tall; `data-cinder-appearance="outlined"` opts one out.

```html
<div
  class="cinder-form-field cinder-input-field"
  data-cinder-variant="default"
  data-cinder-full-width
>
  <label id="name-label" for="name" class="cinder-form-field__label">Name</label>
  <div class="cinder-form-field__control cinder-input-host" data-cinder-full-width>
    <input
      id="name"
      class="cinder-input"
      type="text"
      aria-describedby="name-description"
      data-cinder-full-width
      data-cinder-variant="default"
      data-cinder-size="md"
    />
  </div>
  <p id="name-description" class="cinder-form-field__description">As it appears on the sign.</p>
  <p id="name-error" class="cinder-form-field__error" aria-live="polite"></p>
</div>
```

A Select is the native `select` with `appearance: none`, and Cinder draws its own chevron in the `cinder-select-field__chevron` span after it. Always include that span: it is the only caret, and without it the control has none. The browser's own caret never shows.

```html
<div class="cinder-form-field cinder-select-field" data-cinder-variant="default">
  <label id="area-label" for="area" class="cinder-form-field__label cinder-select-field__label"
    >Neighbourhood</label
  >
  <span class="cinder-select-field__control">
    <select
      id="area"
      class="cinder-_input-frame cinder-select"
      data-cinder-size="md"
      data-cinder-variant="default"
    >
      <option value="lodo" selected>LoDo</option>
      <option value="rino">RiNo</option>
    </select>
    <span class="cinder-select-field__chevron" aria-hidden="true"></span>
  </span>
  <p
    id="area-error"
    class="cinder-form-field__error cinder-select-field__error"
    aria-live="polite"
  ></p>
</div>
```

## Section and Card

A Section separates content by space under a heading and draws no box. Reach for it first.

```html
<section class="cinder-section" aria-labelledby="recent-title">
  <div class="cinder-section__header">
    <div class="cinder-section__heading">
      <h2 id="recent-title" class="cinder-section__title">Recent runs</h2>
      <p class="cinder-section__description">The last seven days.</p>
    </div>
    <div class="cinder-section__actions">
      <a href="#" class="cinder-button" data-cinder-variant="ghost" data-cinder-size="sm"
        >See all</a
      >
    </div>
  </div>
  <div class="cinder-section__content">Content goes here.</div>
</section>
```

A Card is for a real panel that needs its own surface. A card never draws a border and a shadow together: `data-cinder-edge` is `none`, `border` or `shadow`.

```html
<div
  class="cinder-card"
  data-cinder-variant="card"
  data-cinder-tone="default"
  data-cinder-padding="default"
  data-cinder-edge="border"
>
  <div class="cinder-card__header">
    <div class="cinder-card__title-row">
      <div class="cinder-card__title-group">
        <h3 id="card-title" class="cinder-card__title">Inbox</h3>
      </div>
    </div>
    <p class="cinder-card__description">Three items to process.</p>
  </div>
  <div class="cinder-card__body" data-cinder-padding="default">Content goes here.</div>
</div>
```

## GroupedList rows

One rounded surface with separators that start at the text. A row with an `href` is one link, and its title is never underlined. A time-led row leads with its time value and unit.

```html
<div class="cinder-grouped-list">
  <p id="places-header" class="cinder-grouped-list__header">Starting soon</p>
  <ul class="cinder-grouped-list__group" aria-labelledby="places-header">
    <li
      class="cinder-grouped-list-item cinder-grouped-list-item--linked cinder-grouped-list-item--timed"
    >
      <div class="cinder-grouped-list-item__content">
        <div
          class="cinder-grouped-list-item__lead cinder-grouped-list-item__lead--timed"
          data-cinder-urgency="urgent"
        >
          <span class="cinder-grouped-list-item__lead-value">25</span
          ><span class="cinder-grouped-list-item__lead-unit">min left</span>
        </div>
        <div class="cinder-grouped-list-item__text">
          <div class="cinder-grouped-list-item__title">
            <a class="cinder-grouped-list-item__link" href="#">Union Station Bar</a>
          </div>
        </div>
        <span class="cinder-grouped-list-item__chevron" aria-hidden="true"
          ><svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="m9 18 6-6-6-6" /></svg
        ></span>
      </div>
    </li>
    <li class="cinder-grouped-list-item">
      <div class="cinder-grouped-list-item__content">
        <div class="cinder-grouped-list-item__text">
          <div class="cinder-grouped-list-item__title">Ada changed the due date</div>
        </div>
        <div class="cinder-grouped-list-item__trailing">2 h</div>
      </div>
    </li>
  </ul>
</div>
```

## Badge and StatusDot

A Badge is a short status or count. A StatusDot is a dot with a word, and the word is always there. Variants and statuses: `neutral`, `info`, `success`, `warning`, `danger`, and `accent` for a badge. Badge sizes: `xs`, `sm`, `md`.

```html
<span class="cinder-badge" data-cinder-variant="warning" data-cinder-size="md">Waiting on you</span>
<span
  class="cinder-status-dot"
  data-cinder-status="success"
  data-cinder-size="md"
  role="img"
  aria-label="Connected"
  ><span class="cinder-status-dot__indicator" aria-hidden="true"></span
  ><span class="cinder-status-dot__label">Connected</span></span
>
```

## Callout

At most one tinted box per screen. A neutral callout carries no tint. Variants: `neutral`, `info`, `success`, `warning`, `danger`; every variant except `neutral` adds the two `cinder-_status-surface` classes.

```html
<aside class="cinder-callout" data-cinder-variant="neutral" aria-label="Note">
  <div class="cinder-callout__content">
    <p class="cinder-callout__title">Prices change on Friday</p>
    <p>Check the schedule before you head out.</p>
  </div>
</aside>
<aside
  class="cinder-callout cinder-_status-surface cinder-_status-surface-border"
  data-cinder-variant="warning"
  aria-label="Warning"
>
  <div class="cinder-callout__content">
    <p class="cinder-callout__title">This menu is out of date</p>
    <p>The kitchen last confirmed it in March.</p>
  </div>
  <div class="cinder-callout__action">
    <a href="#" class="cinder-button" data-cinder-variant="secondary" data-cinder-size="sm"
      >Ask the kitchen</a
    >
  </div>
</aside>
```

## Banner

A page-wide message, with its actions and an optional dismiss button. Variants as for Callout.

```html
<div
  class="cinder-banner cinder-_status-surface cinder-_status-surface-border"
  data-cinder-variant="info"
  role="region"
  aria-label="Announcement"
>
  <div class="cinder-banner__content">
    <strong class="cinder-banner__title" data-cinder-title-layout="stacked"
      >Happy hour changes</strong
    >
    <span class="cinder-banner__text">Three places moved their start to 4 pm.</span>
  </div>
  <div class="cinder-banner__actions">
    <a href="#" class="cinder-button" data-cinder-variant="secondary" data-cinder-size="sm"
      >See what changed</a
    >
  </div>
  <button
    type="button"
    class="cinder-_dismiss-button cinder-banner__dismiss"
    aria-label="Dismiss banner"
  >
    <svg
      class="cinder-banner__dismiss-icon"
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
    >
      <path
        d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z"
      />
    </svg>
  </button>
</div>
```

## Navigation

A side navigation is a list of links, grouped under static headings. The current page has `data-active="true"` and `aria-current="page"`.

```html
<nav class="cinder-side-navigation" aria-label="Main">
  <ul class="cinder-side-navigation__list">
    <li class="cinder-side-navigation__item">
      <a
        href="#"
        class="cinder-_row-item cinder-navigation-item cinder-side-navigation-item"
        aria-current="page"
        data-active="true"
        data-cinder-navigation-item
        data-variant="vertical"
        data-cinder-has-icon
      >
        <span class="cinder-side-navigation-item__icon" aria-hidden="true"
          ><svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <circle cx="12" cy="12" r="10" />
            <path d="M12 6v6l4 2" /></svg
        ></span>
        <span class="cinder-side-navigation-item__label">Today</span>
      </a>
    </li>
    <li class="cinder-side-navigation-group" data-cinder-static>
      <span id="nav-workspace" class="cinder-side-navigation-group__heading">Workspace</span>
      <ul
        id="nav-workspace-panel"
        class="cinder-side-navigation-group__panel"
        aria-labelledby="nav-workspace"
      >
        <li class="cinder-side-navigation__item">
          <a
            href="#"
            class="cinder-_row-item cinder-navigation-item cinder-side-navigation-item"
            data-active="false"
            data-cinder-navigation-item
            data-variant="vertical"
            >Approvals</a
          >
        </li>
      </ul>
    </li>
  </ul>
</nav>
```

A row of sections at the top of a page is a SegmentedControl whose options are links:

```html
<div class="cinder-segmented-control-container">
  <span id="sections-label" class="cinder-segmented-control-label cinder-sr-only">Sections</span>
  <nav
    id="sections"
    role="navigation"
    aria-labelledby="sections-label"
    class="cinder-segmented-control"
    data-cinder-orientation="horizontal"
    data-cinder-size="md"
    data-cinder-selection-mode="single"
    data-cinder-variant="navigation"
  >
    <a
      href="#"
      class="cinder-segmented-control-option"
      data-cinder-segment-value="overview"
      aria-current="page"
      data-cinder-current
      >Overview</a
    >
    <a href="#" class="cinder-segmented-control-option" data-cinder-segment-value="history"
      >History</a
    >
  </nav>
</div>
```

## Drawer

A modal drawer is a `dialog` that the canvas opens with `showModal()`. Its markup in flow, which is what a static board needs, is the non-modal `aside` below, with the panel at the `right` edge for a side drawer or the `bottom` edge for a peek sheet. The Drawer is fixed to the viewport and as wide and tall as it, so a board that shows one in the page puts it in a box with `position: relative` and `contain: layout`, which makes the box the containing block for fixed elements, and sizes the drawer to the box, as the Map archetype does:

```css
.stage {
  position: relative;
  contain: layout;
  overflow: hidden;
  min-block-size: 32rem;
}
.stage .cinder-drawer {
  position: absolute;
  inset: 0;
  inline-size: auto;
  block-size: auto;
}
```

A button in a page header's actions is drawn at `xs`, as `PageHeader` does, with the flag `data-cinder-compact`.

```html
<aside
  class="cinder-drawer"
  data-cinder-modal="false"
  aria-labelledby="drawer-title"
  data-cinder-portal-owner="drawer-scope"
>
  <div id="drawer-scope" class="cinder-drawer__portal-scope"></div>
  <div class="cinder-drawer__panel" data-cinder-placement="right" data-cinder-size="md">
    <header class="cinder-drawer__header">
      <h2 id="drawer-title" class="cinder-drawer__title">Filters</h2>
      <button type="button" class="cinder-drawer__close" aria-label="Close drawer">
        <svg
          class="cinder-drawer__close-icon"
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 20 20"
          fill="currentColor"
          aria-hidden="true"
        >
          <path
            d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z"
          />
        </svg>
      </button>
    </header>
    <div class="cinder-drawer__body cinder-_scroll-fade" tabindex="-1">Content goes here.</div>
    <div class="cinder-drawer__footer">
      <button
        type="button"
        class="cinder-button"
        data-cinder-variant="primary"
        data-cinder-size="md"
      >
        Apply
      </button>
    </div>
  </div>
</aside>
```

A bottom sheet adds the grabber before the header, and takes `data-cinder-placement="bottom"`:

```html
<div class="cinder-drawer__drag-handle" aria-hidden="true">
  <span class="cinder-drawer__drag-handle-pill"></span>
</div>
```
