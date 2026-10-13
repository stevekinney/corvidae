# Theme builder token capabilities

This is the clause-linked capability matrix for token authoring and DTCG portability. Every row names a capability Cinder's token tooling claims, the normative [DTCG 2025.10](https://www.designtokens.org/tr/2025.10/format/) clause that defines it, a fixture that must be accepted, a fixture that must be rejected, and the diagnostic the tooling actually reports. The rows are checked by `scripts/tokens/authoring-fixtures.test.ts`, which fails when a linked fixture is missing or a URL points outside the 2025.10 modules and their anchors.

The generated per-token data lives in [`src/tokens/runtime/authoring-catalogue.generated.ts`](../src/tokens/runtime/authoring-catalogue.generated.ts). Regenerate it with `bun run --filter=@lostgradient/cinder tokens:generate`; `tokens:check` fails when it drifts. The data model is in `src/tokens/runtime/authoring-types.ts`.

## How to read the matrix

- **DTCG section** links the clause in the 2025.10 Format, Color, or Resolver module.
- **Valid** and **Invalid** are fixtures under `scripts/tokens/fixtures/`. `theme-builder/` holds the fixtures this matrix owns; `valid/` and `invalid/` hold the per-type fixtures that already existed and are reused by reference.
- **Expected diagnostic** is the first issue `assertValidTokenDocument`, `assertValidResolverDocument`, or `resolveDocuments` reports, as `path: reason`. Validation reports many issues per failure; the first is the most specific.
- **CSS edit** says whether an edited value can be serialized into `tokens-base.css` directly. `recipe` means a trusted `cssRecipe` must carry the CSS.
- **DTCG export** says whether the token is exported whole (`complete`), as its DTCG value without the CSS recipe (`subset`), or not at all (`none`).
- **Owner test** is the test that fails first when the claim breaks.

Schema validation runs first. A value the vendored 2025.10 JSON Schema rejects is rejected before any Cinder-specific rule runs, so the diagnostics below come from the schema.

## Value types

| Capability | DTCG section | Valid | Invalid | Expected diagnostic | CSS edit | DTCG export | Owner test |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `color` | [Format 8.1](https://www.designtokens.org/tr/2025.10/format/#color) | [color](../scripts/tokens/fixtures/valid/color.tokens.json) | [color](../scripts/tokens/fixtures/invalid/color.tokens.json) | `sample.$value.colorSpace: must be one of ["srgb", ...]` | yes | complete | `validate.test.ts` |
| Color spaces | [Color 4.2](https://www.designtokens.org/tr/2025.10/color/#supported-color-spaces) | [all-types](../scripts/tokens/fixtures/theme-builder/all-types.tokens.json) | [color](../scripts/tokens/fixtures/invalid/color.tokens.json) | `sample.$value.colorSpace: must be one of [...]` | yes | complete | `authoring-fixtures.test.ts` |
| Color `none` component | [Color 4.1.1](https://www.designtokens.org/tr/2025.10/color/#the-none-keyword) | [all-types](../scripts/tokens/fixtures/theme-builder/all-types.tokens.json) | [color-short-components](../scripts/tokens/fixtures/theme-builder/negative/malformed-members.tokens.json) | `malformed.color-short-components.$value.components: must NOT have fewer than 3 items` | yes | complete | `authoring-fixtures.test.ts` |
| Color alpha is a number from 0 to 1 | [Color 4.1](https://www.designtokens.org/tr/2025.10/color/#format) | [all-types](../scripts/tokens/fixtures/theme-builder/all-types.tokens.json) | [color-alpha-none](../scripts/tokens/fixtures/theme-builder/negative/color-alpha-none.tokens.json) | `alpha.out-of-range.$value.alpha: must be <= 1` (and `none` is rejected as not a number) | yes | complete | `authoring-fixtures.test.ts` |
| Color `hex` fallback | [Color 4.1](https://www.designtokens.org/tr/2025.10/color/#format) | [all-types](../scripts/tokens/fixtures/theme-builder/all-types.tokens.json) | [hex-eight-digit](../scripts/tokens/fixtures/invalid/color-hex-eight-digit.tokens.json) | `sample.$value.hex: must match pattern "^#[0-9a-fA-F]{6}$"` | yes | complete | `validate.test.ts` |
| `dimension` | [Format 8.2](https://www.designtokens.org/tr/2025.10/format/#dimension) | [dimension](../scripts/tokens/fixtures/valid/dimension.tokens.json) | [dimension](../scripts/tokens/fixtures/invalid/dimension.tokens.json) | `sample.$value: must have required property 'unit'` | yes | complete | `validate.test.ts` |
| `fontFamily` | [Format 8.3](https://www.designtokens.org/tr/2025.10/format/#font-family) | [fontFamily](../scripts/tokens/fixtures/valid/fontFamily.tokens.json) | [fontFamily](../scripts/tokens/fixtures/invalid/fontFamily.tokens.json) | `sample.$value: must be string` | yes | complete | `validate.test.ts` |
| `fontWeight` | [Format 8.4](https://www.designtokens.org/tr/2025.10/format/#font-weight) | [fontWeight](../scripts/tokens/fixtures/valid/fontWeight.tokens.json) | [fontWeight](../scripts/tokens/fixtures/invalid/fontWeight.tokens.json) | `sample.$value: must be >= 1` | yes | complete | `validate.test.ts` |
| `duration` | [Format 8.5](https://www.designtokens.org/tr/2025.10/format/#duration) | [duration](../scripts/tokens/fixtures/valid/duration.tokens.json) | [duration](../scripts/tokens/fixtures/invalid/duration.tokens.json) | `sample: duration must have a non-negative numeric value and ms or s unit` | yes | complete | `validate.test.ts` |
| `cubicBezier` | [Format 8.6](https://www.designtokens.org/tr/2025.10/format/#cubic-bezier) | [cubicBezier](../scripts/tokens/fixtures/valid/cubicBezier.tokens.json) | [cubicBezier](../scripts/tokens/fixtures/invalid/cubicBezier.tokens.json) | `sample.$value.0: must be <= 1` | yes | complete | `validate.test.ts` |
| `number` | [Format 8.7](https://www.designtokens.org/tr/2025.10/format/#number) | [number](../scripts/tokens/fixtures/valid/number.tokens.json) | [number](../scripts/tokens/fixtures/invalid/number.tokens.json) | `sample.$value: must be number` | yes | complete | `validate.test.ts` |
| `strokeStyle` | [Format 9.3](https://www.designtokens.org/tr/2025.10/format/#stroke-style) | [strokeStyle](../scripts/tokens/fixtures/valid/strokeStyle.tokens.json) | [invalid-stroke-style](../scripts/tokens/fixtures/theme-builder/negative/invalid-stroke-style.tokens.json) | `stroke.none.$value: must be one of ["solid","dashed","dotted","double","groove","ridge","outset","inset"]` (also `hidden`, unknown names) | recipe | complete | `authoring-fixtures.test.ts` |
| `strokeStyle` object form | [Format 9.3.2](https://www.designtokens.org/tr/2025.10/format/#object-value) | [all-types](../scripts/tokens/fixtures/theme-builder/all-types.tokens.json) | [invalid-stroke-style](../scripts/tokens/fixtures/theme-builder/negative/invalid-stroke-style.tokens.json) | `stroke.empty-dash-array.$value.dashArray: must NOT have fewer than 1 items` | recipe | complete | `authoring-fixtures.test.ts` |
| `border` | [Format 9.4](https://www.designtokens.org/tr/2025.10/format/#border) | [border](../scripts/tokens/fixtures/valid/border.tokens.json) | [border](../scripts/tokens/fixtures/invalid/border.tokens.json) | `sample.$value: must have required property 'style'` | recipe | complete | `validate.test.ts` |
| `transition` | [Format 9.5](https://www.designtokens.org/tr/2025.10/format/#transition) | [transition](../scripts/tokens/fixtures/valid/transition.tokens.json) | [transition](../scripts/tokens/fixtures/invalid/transition.tokens.json) | `sample.$value: must NOT have additional property 'timingFuction'` | recipe | complete | `validate.test.ts` |
| `shadow` | [Format 9.6](https://www.designtokens.org/tr/2025.10/format/#shadow) | [shadow](../scripts/tokens/fixtures/valid/shadow.tokens.json) | [shadow](../scripts/tokens/fixtures/invalid/shadow.tokens.json) | `sample.$value: must have required property 'spread'` | yes | complete | `validate.test.ts` |
| `gradient` | [Format 9.7](https://www.designtokens.org/tr/2025.10/format/#gradient) | [gradient](../scripts/tokens/fixtures/valid/gradient.tokens.json) | [gradient](../scripts/tokens/fixtures/invalid/gradient.tokens.json) | `sample: gradient must contain at least two color-position stops` | recipe | complete | `validate.test.ts` |
| `typography` | [Format 9.8](https://www.designtokens.org/tr/2025.10/format/#typography) | [typography](../scripts/tokens/fixtures/valid/typography.tokens.json) | [typography](../scripts/tokens/fixtures/invalid/typography.tokens.json) | `sample.$value: must have required property 'fontWeight'` | recipe | complete | `validate.test.ts` |
| Wrong value shape for the declared type | [Format 8](https://www.designtokens.org/tr/2025.10/format/#types) | [all-types](../scripts/tokens/fixtures/theme-builder/all-types.tokens.json) | [wrong-type](../scripts/tokens/fixtures/theme-builder/negative/wrong-type.tokens.json) | `wrong.dimension-as-string.$value: must be object` | n/a | n/a | `authoring-fixtures.test.ts` |
| Malformed composite members | [Format 9](https://www.designtokens.org/tr/2025.10/format/#composite-types) | [all-types](../scripts/tokens/fixtures/theme-builder/all-types.tokens.json) | [malformed-members](../scripts/tokens/fixtures/theme-builder/negative/malformed-members.tokens.json) | `malformed.color-short-components.$value.components: must NOT have fewer than 3 items` | n/a | n/a | `authoring-fixtures.test.ts` |

## Document structure

| Capability | DTCG section | Valid | Invalid | Expected diagnostic | CSS edit | DTCG export | Owner test |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Group `$type` inheritance | [Format 6.7.3](https://www.designtokens.org/tr/2025.10/format/#type-inheritance) | [profile-base](../scripts/tokens/fixtures/theme-builder/profile-base.tokens.json) | [untyped-token](../scripts/tokens/fixtures/theme-builder/negative/untyped-token.tokens.json) | `orphan: token has no $type and no inherited type` | yes | complete | `authoring-provenance.test.ts` |
| Token `$type` | [Format 5.2.2](https://www.designtokens.org/tr/2025.10/format/#type-0) | [profile-base](../scripts/tokens/fixtures/theme-builder/profile-base.tokens.json) | [untyped-token](../scripts/tokens/fixtures/theme-builder/negative/untyped-token.tokens.json) | `orphan: token has no $type and no inherited type` | yes | complete | `authoring-provenance.test.ts` |
| Groups | [Format 6](https://www.designtokens.org/tr/2025.10/format/#groups) | [all-types](../scripts/tokens/fixtures/theme-builder/all-types.tokens.json) | [root-not-token](../scripts/tokens/fixtures/theme-builder/negative/root-not-token.tokens.json) | `group.$root: must NOT be valid` | yes | complete | `authoring-fixtures.test.ts` |
| `$root` token | [Format 6.2](https://www.designtokens.org/tr/2025.10/format/#root-tokens-in-groups) | [all-types](../scripts/tokens/fixtures/theme-builder/all-types.tokens.json) | [root-not-token](../scripts/tokens/fixtures/theme-builder/negative/root-not-token.tokens.json) | `group.$root: must NOT be valid` | yes | complete | `authoring-fixtures.test.ts` |
| Curly-brace alias, including two hops | [Format 7](https://www.designtokens.org/tr/2025.10/format/#aliases-references) | [profile-base](../scripts/tokens/fixtures/theme-builder/profile-base.tokens.json) | [missing-reference](../scripts/tokens/fixtures/theme-builder/negative/missing-reference.tokens.json) | `{nowhere.defined}: reference target does not exist` | yes | complete | `authoring-provenance.test.ts` |
| Alias cycle | [Format 7](https://www.designtokens.org/tr/2025.10/format/#aliases-references) | [profile-base](../scripts/tokens/fixtures/theme-builder/profile-base.tokens.json) | [reference-cycle](../scripts/tokens/fixtures/theme-builder/negative/reference-cycle.tokens.json) | `cycle.a: circular token alias` | n/a | n/a | `authoring-fixtures.test.ts` |
| `$ref` JSON Pointer alias | [Format 6.6.2](https://www.designtokens.org/tr/2025.10/format/#json-pointer-support) | [all-types](../scripts/tokens/fixtures/theme-builder/all-types.tokens.json) | [ref-and-value](../scripts/tokens/fixtures/theme-builder/negative/ref-and-value.tokens.json) | `token: must NOT have additional property '$value'` | yes | complete | `authoring-fixtures.test.ts` |
| `$extends` | [Format 6.4](https://www.designtokens.org/tr/2025.10/format/#extending-groups) | [profile-base](../scripts/tokens/fixtures/theme-builder/profile-base.tokens.json) | [extends-cycle](../scripts/tokens/fixtures/theme-builder/negative/extends-cycle.tokens.json) | `one: circular $extends reference` | yes | complete | `authoring-provenance.test.ts` |
| `$extensions` | [Format 5.2.3](https://www.designtokens.org/tr/2025.10/format/#extensions) | [all-types](../scripts/tokens/fixtures/theme-builder/all-types.tokens.json) | [invalid-extensions](../scripts/tokens/fixtures/theme-builder/negative/invalid-extensions.tokens.json) | `token.$extensions: must be object` | n/a | complete | `authoring-fixtures.test.ts` |
| `$deprecated` | [Format 5.2.4](https://www.designtokens.org/tr/2025.10/format/#deprecated) | [all-types](../scripts/tokens/fixtures/theme-builder/all-types.tokens.json) | [invalid-deprecated](../scripts/tokens/fixtures/theme-builder/negative/invalid-deprecated.tokens.json) | `token.$deprecated: must be boolean` | n/a | complete | `authoring-fixtures.test.ts` |

## Resolver and contexts

| Capability | DTCG section | Valid | Invalid | Expected diagnostic | CSS edit | DTCG export | Owner test |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Sets | [Resolver 4.1.4](https://www.designtokens.org/tr/2025.10/resolver/#sets) | [profile.resolver](../scripts/tokens/fixtures/theme-builder/profile.resolver.json) | [unknown-set](../scripts/tokens/fixtures/theme-builder/negative/unknown-set.resolver.json) | `$.resolutionOrder.0: resolutionOrder must reference an existing set or modifier: #/sets/missing` | yes | complete | `authoring-fixtures.test.ts` |
| Modifiers and contexts | [Resolver 4.1.5](https://www.designtokens.org/tr/2025.10/resolver/#modifiers) | [profile.resolver](../scripts/tokens/fixtures/theme-builder/profile.resolver.json) | [unknown-set](../scripts/tokens/fixtures/theme-builder/negative/unknown-set.resolver.json) | as above | yes | complete | `authoring-catalogue.test.ts` |
| Modifier `default` | [Resolver 4.1.5.3](https://www.designtokens.org/tr/2025.10/resolver/#default) | [profile.resolver](../scripts/tokens/fixtures/theme-builder/profile.resolver.json) | [unknown-set](../scripts/tokens/fixtures/theme-builder/negative/unknown-set.resolver.json) | as above | yes | complete | `authoring-catalogue.test.ts` |
| Resolution order decides precedence | [Resolver 4.1.6.2](https://www.designtokens.org/tr/2025.10/resolver/#ordering-of-sets-and-modifiers) | [profile.resolver](../scripts/tokens/fixtures/theme-builder/profile.resolver.json) | [unknown-set](../scripts/tokens/fixtures/theme-builder/negative/unknown-set.resolver.json) | as above | yes | complete | `authoring-provenance.test.ts` |
| Reference objects | [Resolver 4.2](https://www.designtokens.org/tr/2025.10/resolver/#reference-objects) | [profile.resolver](../scripts/tokens/fixtures/theme-builder/profile.resolver.json) | [unknown-set](../scripts/tokens/fixtures/theme-builder/negative/unknown-set.resolver.json) | as above | yes | complete | `authoring-catalogue.test.ts` |
| Resolution logic | [Resolver 6.4](https://www.designtokens.org/tr/2025.10/resolver/#resolution) | [profile.resolver](../scripts/tokens/fixtures/theme-builder/profile.resolver.json) | [unknown-set](../scripts/tokens/fixtures/theme-builder/negative/unknown-set.resolver.json) | as above | yes | complete | `authoring-provenance.test.ts` |

The six contexts the catalogue covers are the product of the two modifiers: `light` and `dark` crossed with `default`, `reduced`, and `forced-reduced-motion`. A context id is `<theme>/<motion>`.

## Cinder authoring rules

These are not DTCG clauses. They are carried in the `com.lostgradient.cinder` namespace of [`$extensions`](https://www.designtokens.org/tr/2025.10/format/#extensions), which the format reserves for vendor data.

| Capability | Valid | Invalid | Expected diagnostic | CSS edit | DTCG export | Owner test |
| --- | --- | --- | --- | --- | --- | --- |
| Spacing-scale membership (`scale: "spacing"`) | [profile-base](../scripts/tokens/fixtures/theme-builder/profile-base.tokens.json) | built in the test from the same fixture | `Scale "spacing" member "motion.fast" is not a public literal dimension in group "space".` | yes | complete | `authoring-catalogue.test.ts` |
| CSS usage profile for every public token | [profile-base](../scripts/tokens/fixtures/theme-builder/profile-base.tokens.json) | built in the test from the same fixture | `Token "..." has no CSS usage profile; add a rule to authoring-profiles.ts.` | yes | complete | `authoring-profiles.test.ts` |
| CSS-only token (no portable value) | [css-only](../scripts/tokens/fixtures/theme-builder/css-only.tokens.json) | a CSS-only token with no `cssRecipe`, built in the test | `CSS-only token "..." carries no cssRecipe, so it has no CSS value.` | css-only | none | `authoring-fixtures.test.ts` |

## CSS-only tokens

Four public tokens have a real CSS value that DTCG cannot represent. Each carries `nonRepresentableValue: true`, and the catalogue reports each with an explicit status instead of a value. The `$value` in source is a non-authoritative placeholder; it is never exported and never appears in the catalogue.

| Token                   | Real CSS value | Edit     | CSS export | DTCG portability |
| ----------------------- | -------------- | -------- | ---------- | ---------------- |
| `carousel.slide-size`   | `100%`         | css-only | supported  | none             |
| `carousel.aspect-ratio` | `16 / 9`       | css-only | supported  | none             |
| `code-block.height`     | `auto`         | css-only | supported  | none             |
| `spinner.indicator`     | `currentColor` | css-only | supported  | none             |

The expected value in every one of the six contexts is recorded in [`css-only.tokens.json`](../scripts/tokens/fixtures/theme-builder/css-only.tokens.json) and compared with the catalogue, the generated CSS, and the resolved-context JSON.

## Unsupported-profile behavior

Everything above is supported. The following are accepted as valid DTCG but are not supported end to end, and the tooling says so rather than guessing.

| Case | Behavior | Evidence |
| --- | --- | --- |
| `strokeStyle`, `border`, `transition`, `gradient`, or `typography` token without a `cssRecipe` | Validates, resolves, and exports as DTCG. CSS generation refuses to invent a serialization and fails with `No direct CSS serialization implemented for token type "<type>" at "<path>". Add a cssRecipe extension in the corpus, or extend serializeTypedValue.` | `authoring-fixtures.test.ts` |
| Color `alpha: "none"` | Rejected. The 2025.10 Color module allows `none` only in `components`, and the vendored schema types `alpha` as a number from 0 to 1. | [color-alpha-none](../scripts/tokens/fixtures/theme-builder/negative/color-alpha-none.tokens.json) |
| `strokeStyle` values `none` and `hidden` | Rejected. They are CSS border-style keywords but not members of the DTCG string-value set. | [invalid-stroke-style](../scripts/tokens/fixtures/theme-builder/negative/invalid-stroke-style.tokens.json) |
| Public token no usage-profile rule covers | Catalogue generation fails, naming the token. | `authoring-profiles.test.ts` |
| Palette family and anchor | Not declared anywhere in source, so the catalogue reports `unknown` for both on every color token. They are never inferred from a name. | `authoring-catalogue.test.ts` |
