import type { Snippet } from 'svelte';

import type {
  FlatHTMLAnchorAttributes,
  FlatHTMLButtonAttributes,
} from '../../_internal/forwarded-html-attributes.generated.ts';
import type { WellKnownDataTestId } from '../../_internal/well-known-data-attributes.ts';

/**
 * Visual style of the button.
 *
 * `secondary` is an outline-style button (filled surface + border). It is kept as `secondary`
 * rather than `outline` because: (a) today's `secondary` is already outline-flavored, (b) `ghost`
 * covers the transparent-background case, and (c) 27+ call sites depend on `secondary` today.
 *
 * `soft` / `soft-danger` use a tinted fill with no border — mid-emphasis between `ghost` and
 * `primary`/`danger`. Background is `color-mix(in oklch, accent, transparent 88%)` so it
 * resolves against the current theme's accent/danger color in both light and dark modes.
 *
 * @default `"secondary"`
 */
export type ButtonVariant =
  'primary' | 'secondary' | 'soft' | 'danger' | 'soft-danger' | 'ghost' | 'ghost-danger';

/**
 * Size of the button. All sizes use compact visual heights; see button.a11y.md for touch-target guidance.
 *
 * @default `"md"`
 */
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

type SharedBase = WellKnownDataTestId & {
  /** Visual style. */
  variant?: ButtonVariant;
  /** Size of the button. */
  size?: ButtonSize;
  /** Expand to container width. */
  fullWidth?: boolean;
  /** Disable the button and show a spinner. */
  loading?: boolean;
  /** DECORATIVE icon rendered before the label/children. Always wrapped in aria-hidden.
   *  If the icon conveys meaning, supply accessible text via `label`/`aria-label` instead. */
  leadingIcon?: Snippet;
  /** DECORATIVE icon rendered after the label/children. Always wrapped in aria-hidden.
   *  Same accessible-name guidance as `leadingIcon`. */
  trailingIcon?: Snippet;
  /** Custom class merged with `.cinder-button`. */
  class?: string;
  /**
   * Marks the Button rendered by `InlineConfirm`'s cancel action so it can be found with
   * `querySelector('[data-cinder-inline-cancel]')` (`inline-confirm.svelte`).
   *
   * Named rather than a general `data-*` index signature: the flattened attribute types above
   * are already at TypeScript's type complexity budget for this two-arm union (see the comment
   * on `ButtonOnlyProps`/`LinkButtonProps` below) — adding an index signature, even a small one,
   * reintroduces TS2590. A consumer needing an arbitrary `data-*` attribute on Button can still
   * set it via the DOM after render; this workspace's own use is the one named case.
   */
  'data-cinder-inline-cancel'?: boolean;
};

// At least one of `label` or `children` must be provided so the button has an accessible name.
//
// The union shape (rather than `label?: string; children?: Snippet`) gives TypeScript a
// compile-time guarantee that a consumer can't write `<Button />` with neither. The Phase 4
// analyzer reads this two-variant shape to generate correct prop-control UI for each branch.
// Runtime limitation: `string` includes `""`, so a literal empty label still satisfies
// `WithLabel`. The dev-mode guard in the instance script catches that case.
//
// `iconOnly` lives only in the union branches (not SharedBase) so the discriminant is real:
// `WithChildren` genuinely forbids `iconOnly={true}`, and `WithIconOnly` requires it.
type WithLabel = { label: string; children?: Snippet; iconOnly?: false };
type WithChildren = { label?: string; children: Snippet; iconOnly?: false };
type IconOnlyAccessibleName =
  | { label: string; 'aria-label'?: string; 'aria-labelledby'?: string }
  | { label?: string; 'aria-label': string; 'aria-labelledby'?: string }
  | { label?: string; 'aria-label'?: string; 'aria-labelledby': string };
type IconOnlyVisual =
  | { children: Snippet; leadingIcon?: Snippet; trailingIcon?: Snippet }
  | { children?: Snippet; leadingIcon: Snippet; trailingIcon?: Snippet }
  | { children?: Snippet; leadingIcon?: Snippet; trailingIcon: Snippet };
// Icon-only buttons require a name source and a visual icon source at compile time.
// `children` is accepted as the visual icon only; it is not a name source in this mode.
type WithIconOnly = { iconOnly: true } & IconOnlyAccessibleName & IconOnlyVisual;
type SharedProps = SharedBase & (WithLabel | WithChildren | WithIconOnly);

// Forwarded through the flattened (non-generic) copies of `HTMLButtonAttributes` /
// `HTMLAnchorAttributes` — see `_internal/forwarded-html-attributes.generated.ts` (COR-239).
// Referencing svelte/elements' own generic interfaces from both arms of this union makes
// `keyof ButtonProps` (which svelte's `Component<Props, {}, Bindings>` computes to check its
// `Bindings` constraint) re-walk their multi-level generic inheritance chain once per arm,
// which is exactly what tips a published consumer's `skipLibCheck: false` type-check into
// TS2590. The flattened copies are structurally identical, non-generic object types, so `keyof`
// stays cheap regardless of how many arms reference them.
type ButtonOnlyProps = SharedProps & Omit<FlatHTMLButtonAttributes, 'class'> & { href?: undefined };
type LinkButtonProps = SharedProps & Omit<FlatHTMLAnchorAttributes, 'class'> & { href: string };

/** Props for the Button component. */
export type ButtonProps = ButtonOnlyProps | LinkButtonProps;

/**
 * Cinder-specific props for the Button component, used by the schema generator.
 * Excludes the inherited HTML attribute surface that consumers can spread via
 * `...rest` — those are documented in the underlying element's MDN reference.
 */
export interface ButtonSchemaProps {
  /**
   * Visual style.
   * @default "secondary"
   */
  variant?: ButtonVariant;
  /**
   * Size of the button.
   * @default "md"
   */
  size?: ButtonSize;
  /**
   * Expand to container width.
   * @default false
   */
  fullWidth?: boolean;
  /**
   * Disable the button and show a spinner.
   * @default false
   */
  loading?: boolean;
  /**
   * Render the button with only an icon. Requires an accessible name source.
   * @default false
   */
  iconOnly?: boolean;
  /** Render as an anchor `<a>` element with this href. */
  href?: string;
  /** Visible text label. Must be non-empty if provided. */
  label?: string;
  /** Custom class merged with `.cinder-button`. */
  class?: string;
}
