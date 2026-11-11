import type { Snippet } from 'svelte';
import type { HTMLAnchorAttributes, HTMLAttributes, HTMLButtonAttributes } from 'svelte/elements';
import type {
  AllKeys,
  DataAttributes,
  PadUnion,
  WithoutDataAttributes,
} from '../../_internal/union-props.ts';

/**
 * Visual style of the button.
 *
 * `soft` is the default (COR-2312): a filled pill with a tinted accent fill and no border, so a
 * row of actions reads as filled controls rather than a row of boxes. `soft-danger` is its danger
 * twin. Background is `color-mix(in oklch, accent, transparent 88%)` so it resolves against the
 * current theme's accent/danger color in both light and dark modes.
 *
 * `secondary` is the outline-style button (filled surface + border), kept for the places that
 * ask for it by name. It is kept as `secondary` rather than `outline` because `ghost` covers the
 * transparent-background case and many call sites name `secondary` explicitly.
 *
 * `link` reads as an inline text link: the accent text with no fill or border, underlined on
 * hover, for an action that sits beside a row's state as a word, such as Undo beside "Skipped".
 * It is still a button, so it acts and is announced as one.
 *
 * @default `"soft"`
 */
export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'soft'
  | 'danger'
  | 'soft-danger'
  | 'ghost'
  | 'ghost-danger'
  | 'ghost-accent';

/**
 * Size of the button. All sizes use compact visual heights; see button.a11y.md for touch-target guidance.
 *
 * `lg` is for page-level primary actions only. An action inside a row, card, dialog, or toolbar
 * uses `md` (or `sm` or `xs` where space is tight).
 *
 * @default `"md"`
 */
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg';

// COR-239: keyof Props became too complex for TypeScript to represent (TS2590) once a consumer
// type-checked this published declaration under `skipLibCheck: false`. Root cause (measured):
// a union with two or more arms each carrying svelte/elements' `data-${string}` index signature
// PLUS differing key sets / attribute interfaces (HTMLButtonAttributes vs HTMLAnchorAttributes).
// Fix: hoist the attribute surface common to both the button and anchor render paths into one
// non-union type with its `data-*` index signature removed (`SharedHtmlAttributes`), restore
// `data-*` forwarding via a single non-distributed `DataAttributes` intersected once, and keep
// only the button/anchor-SPECIFIC attributes inside the (padded) small union. See
// `src/_internal/union-props.ts` for the full mechanism. No prop was added, removed, widened, or
// narrowed for consumers of `ButtonProps` — arbitrary `data-*` props are still accepted on every
// arm, exactly as before.
type SharedHtmlAttributes = WithoutDataAttributes<
  Omit<HTMLAttributes<HTMLButtonElement | HTMLAnchorElement>, 'class'>
>;

type ButtonOnlyExtra = Omit<
  HTMLButtonAttributes,
  keyof HTMLAttributes<HTMLButtonElement> | 'class'
> & { href?: undefined };
type LinkButtonExtra = Omit<
  HTMLAnchorAttributes,
  keyof HTMLAttributes<HTMLAnchorElement> | 'class'
> & { href: string };

// The naming/icon-only discriminant below is intentionally written as an INLINE union rather
// than through separately-named types (this file previously had `WithLabel`, `WithChildren`,
// `IconOnlyAccessibleName`, `IconOnlyVisual`, and `WithIconOnly` as their own named aliases).
// That was measured to reintroduce TS2590 once combined with `SharedHtmlAttributes` and
// `DataAttributes` above, even though none of those named aliases themselves reference
// `data-*` — a named alias to a discriminated union, used as a union member alongside a
// large attribute type, is itself expensive for `keyof` here; the identical shapes written
// inline are not. See `src/_internal/union-props.ts`'s module doc for the general mechanism;
// this file-specific quirk (named vs. inline discriminant) was verified empirically against
// this exact component and is why the shapes below are not factored out despite the
// duplication that would otherwise be preferable.
//
// At least one of `label` or `children` must be provided so the button has an accessible name.
// The union shape (rather than `label?: string; children?: Snippet`) gives TypeScript a
// compile-time guarantee that a consumer can't write `<Button />` with neither. Runtime
// limitation: `string` includes `""`, so a literal empty label still satisfies the label arm;
// the dev-mode guard in the instance script catches that case. `iconOnly` lives only in the
// union branches (not `SharedBase`) so the discriminant is real: the children-only arm
// genuinely forbids `iconOnly={true}`, and the icon-only arm requires it. Icon-only buttons
// additionally require a name source (label/aria-label/aria-labelledby) and a visual icon
// source (children/leadingIcon/trailingIcon) at compile time; `children` is accepted as the
// visual icon only there — it is not a name source in that mode.
type ButtonDiscriminant = (ButtonOnlyExtra | LinkButtonExtra) &
  (
    | { label: string; children?: Snippet; iconOnly?: false }
    | { label?: string; children: Snippet; iconOnly?: false }
    | ({ iconOnly: true } & (
        | { label: string; 'aria-label'?: string; 'aria-labelledby'?: string }
        | { label?: string; 'aria-label': string; 'aria-labelledby'?: string }
        | { label?: string; 'aria-label'?: string; 'aria-labelledby': string }
      ) &
        (
          | { children: Snippet; leadingIcon?: Snippet; trailingIcon?: Snippet }
          | { children?: Snippet; leadingIcon: Snippet; trailingIcon?: Snippet }
          | { children?: Snippet; leadingIcon?: Snippet; trailingIcon: Snippet }
        ))
  );

// `PadUnion` normally pads every arm with every key it lacks (typed `?: never`) so all arms
// present an identical key set to `keyof`. That is wrong here for `aria-label`/`aria-labelledby`
// (present only in the icon-only sub-arms above, but ALSO real, already-optional keys on
// `SharedHtmlAttributes`) and for `leadingIcon`/`trailingIcon` (present only in the icon-only
// visual sub-arms above, but ALSO real, already-optional keys on the trailing cinder-props
// literal below): padding them as `never` on the label/children arms would intersect with their
// real type elsewhere and collapse it to `undefined`, silently rejecting values those arms must
// keep accepting (verified: `{ children, 'aria-label': 'x' }` — a real, previously-valid Button
// usage — stopped type-checking without this exclusion). Everything else about this discriminant
// (href vs. no-href, button- vs. anchor-specific attributes) still needs the padding, so only
// these four keys are excluded from it.
type ButtonPaddedKeys = Exclude<
  AllKeys<ButtonDiscriminant>,
  'aria-label' | 'aria-labelledby' | 'leadingIcon' | 'trailingIcon'
>;

/**
 * Props for the Button component. The cinder-specific base props are inlined here (rather than
 * factored into a separate named type) so `src/api-contract.test.ts`'s AST-only checker — which
 * looks for a literal object among a top-level intersection's members — can still see them.
 */
export type ButtonProps = SharedHtmlAttributes &
  DataAttributes &
  PadUnion<ButtonDiscriminant, ButtonPaddedKeys> & {
    /** Visual style. */
    variant?: ButtonVariant;
    /** Size of the button. `lg` is for page-level primary actions only; inline actions use `md`. */
    size?: ButtonSize;
    /** Expand to container width. */
    fullWidth?: boolean;
    /**
     * Show a spinner and make the button inert while work is in flight. The button gets
     * `aria-disabled` and `aria-busy` (not the native `disabled`, so it keeps focus), keeps its
     * label, ignores further presses, and holds the width it had at rest.
     */
    loading?: boolean;
    /**
     * Text a polite, visually hidden status announces while `loading` (for example `Saving…`).
     * The status node is rendered beside the button, so it never joins the button's accessible
     * name, and it is mounted from the start so the announcement is not lost. Omit it and no
     * status node is rendered.
     */
    loadingStatus?: string;
    /**
     * Marks a button that changes something (Edit, Save, Delete, a header "+"). Inside a stale
     * `<StaleRegion>` it goes inert: `aria-disabled`, still focusable, ignoring the press, and
     * described by the region's reason ("Off until it’s back"). It returns by itself when the
     * region stops being stale. A button that only reads (a link, Retry now) leaves this off and
     * stays live.
     */
    mutating?: boolean;
    /**
     * Rests as the bare glyph: drops the resting fill and rule an icon-only `ghost` button
     * otherwise paints, for a toolbar such as the shell's top bar. Hover, pressed and focus still
     * paint. It has no effect unless the button is `iconOnly` with `variant="ghost"`.
     * @default false
     */
    quiet?: boolean;
    /** DECORATIVE icon rendered before the label/children. Always wrapped in aria-hidden.
     *  If the icon conveys meaning, supply accessible text via `label`/`aria-label` instead. */
    leadingIcon?: Snippet;
    /** DECORATIVE icon rendered after the label/children. Always wrapped in aria-hidden.
     *  Same accessible-name guidance as `leadingIcon`. */
    trailingIcon?: Snippet;
    /**
     * A keyboard shortcut hint (a key such as `"N"`, or `["Ctrl", "K"]`) rendered after the label
     * through ShortcutHint. It is decorative and `aria-hidden`, so the accessible name stays the
     * label, and it is plain glyphs in the button's own color on every variant, hidden on touch
     * devices. It only displays the shortcut; registering the key is the application's job.
     */
    shortcut?: string | string[];
    /** Custom class merged with `.cinder-button`. */
    class?: string;
  };

/**
 * Cinder-specific props for the Button component, used by the schema generator.
 * Excludes the inherited HTML attribute surface that consumers can spread via
 * `...rest` — those are documented in the underlying element's MDN reference.
 */
export interface ButtonSchemaProps {
  /**
   * Visual style.
   * @default "soft"
   */
  variant?: ButtonVariant;
  /**
   * Size of the button. `lg` is for page-level primary actions only; inline actions use `md`.
   * @default "md"
   */
  size?: ButtonSize;
  /**
   * Expand to container width.
   * @default false
   */
  fullWidth?: boolean;
  /**
   * Show a spinner and make the button inert (`aria-disabled`, still focusable) while work is
   * in flight; the label stays and the width holds.
   * @default false
   */
  loading?: boolean;
  /**
   * Text a polite, visually hidden status announces while `loading`, rendered beside the button.
   */
  loadingStatus?: string;
  /**
   * Marks a button that changes something. Inside a stale `<StaleRegion>` it goes inert
   * (`aria-disabled`, still focusable) and is described by the region's reason.
   * @default false
   */
  mutating?: boolean;
  /**
   * Render the button with only an icon. Requires an accessible name source.
   * @default false
   */
  iconOnly?: boolean;
  /**
   * Rests as the bare glyph: drops the resting fill and rule an icon-only `ghost` button
   * otherwise paints, for a toolbar such as the shell's top bar. Hover, pressed and focus still
   * paint. It has no effect unless the button is `iconOnly` with `variant="ghost"`.
   * @default false
   */
  quiet?: boolean;
  /** Render as an anchor `<a>` element with this href. */
  href?: string;
  /** Visible text label. Must be non-empty if provided. */
  label?: string;
  /** Keyboard shortcut hint rendered after the label, `aria-hidden`; a key or an array of keys. */
  shortcut?: string | string[];
  /** Custom class merged with `.cinder-button`. */
  class?: string;
}
