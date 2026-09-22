/**
 * Named (not indexed) `data-*` attributes for components whose Props type is a discriminated
 * union that already sits at TypeScript's type complexity budget (COR-239).
 *
 * `svelte/elements`' `HTMLAttributes<T>` carries `[key: \`data-${string}\`]: any`, forwarding
 * every `data-*` attribute a consumer writes. For most components that index signature comes
 * along for free via the interface itself. It cannot for the handful of components fixed here:
 * their Props type distributes a flattened copy of that interface (see
 * `forwarded-html-attributes.generated.ts`'s module doc) across two or more union arms to stay
 * under `Component<Props, {}, Bindings>`'s complexity budget, and adding the index signature
 * back — even alone, even the tiny `data-${string}` one without the `[key: symbol]` attachment
 * signature beside it — reliably tips that budget back over into TS2590 (verified empirically
 * against each affected component while diagnosing this issue; there was no configuration of
 * "just the small parts" that fit).
 *
 * `data-testid` is the one `data-*` attribute this workspace's own tests rely on across several
 * of those components (button, card, floating-action, navigation-item, pricing-card, tree) —
 * exactly the testing-library convention its name suggests. Naming it explicitly, rather than
 * restoring a general index signature, keeps those tests (and any consumer doing the same
 * thing) working without reintroducing the defect this file exists to fix. A consumer needing
 * a different arbitrary `data-*` attribute on one of these components can still set it on the
 * rendered DOM node after mount; this workspace's own use is the one named case.
 */
export type WellKnownDataTestId = {
  'data-testid'?: string;
};
