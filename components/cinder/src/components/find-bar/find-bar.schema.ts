import type { ComponentSchema } from '../../schema-types';

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    value: {
      type: 'string',
      description: "Current query text. Bindable. Defaults to `''`.",
      default: '',
    },
    activeIndex: {
      type: 'number',
      description:
        'Index of the active match within the host-provided results. Bindable,\nbut not input-only: the component resets it to `0` itself whenever the\nuser edits the query. Whenever `matchCount` is non-`null`, an effect\nalso clamps this value into `[0, matchCount - 1]` (normalizing to `0`\nat `matchCount === 0`, where that range is otherwise empty)—and\nbecause that effect reads `activeIndex` too, it clamps just as\nimmediately if a host assigns an out-of-range `activeIndex` on its\nown, not only when `matchCount` itself changes. `Infinity`/`-Infinity`\nare clamped normally (to the maximum/`0`); `NaN` is the one exception\nthe clamp (`Math.min(Math.max(…))`) passes through unchanged rather\nthan normalizing. A parent binding this prop should expect it to be\noverwritten in every case except an assigned `NaN`, not treat it as a\npreserved selection, and should not assign `NaN` itself. Defaults to\n`0`.',
      default: 0,
    },
    matchCount: {
      anyOf: [
        {
          type: 'number',
        },
        {
          type: 'null',
        },
      ],
      description:
        'Number of matches for the current query, or `null` when the host has\nnot searched yet. Bindable—the component resets it to `null` itself\nwhenever the user starts a new search, so bind it rather than mirror\n`onQueryChange` manually to stay in sync with that reset. Defaults to\n`null`.',
      default: null,
    },
    minQueryLength: {
      type: 'number',
      description:
        "Minimum trimmed query length before the host should search—eligibility\nis checked against `value.trim().length`, not `value.length`, so\nwhitespace-only or whitespace-padded input doesn't count toward it\n(e.g. `' a '` stays ineligible at `minQueryLength={3}`). Defaults to\n`3`.",
      default: 3,
    },
    debounceMs: {
      type: 'number',
      description:
        "Debounce interval, in milliseconds, before `onQueryChange` fires for\nan eligible query. Does not apply to the synchronous `''` notification\n`onQueryChange` sends when a previously eligible query shrinks below\n`minQueryLength`—see that prop. Defaults to `250`.",
      default: 250,
    },
    label: {
      type: 'string',
      description: "Accessible label for the find controls. Defaults to `'Find'`.",
      default: 'Find',
    },
    class: {
      type: 'string',
      description: "Additional class merged with the component's root class.",
    },
  },
  additionalProperties: false,
  metadata: {
    unsupportedProps: [
      {
        name: 'onDismiss',
        reason: 'function-or-snippet',
        description: 'Called when the user dismisses the find bar.',
      },
      {
        name: 'onNext',
        reason: 'function-or-snippet',
        description: 'Called when the user requests the next match.',
      },
      {
        name: 'onPrevious',
        reason: 'function-or-snippet',
        description: 'Called when the user requests the previous match.',
      },
      {
        name: 'onQueryChange',
        reason: 'function-or-snippet',
        description:
          "Called with the debounced query text once user typing (the `input`\nevent) reaches `minQueryLength`. Also called immediately with `''`,\nbypassing the debounce, the moment a previously eligible query shrinks\nbelow `minQueryLength`—handle the empty-string case as a synchronous\nreset, not just the debounced value. Only that ineligible-transition\ncase is notified when triggered externally: assigning an eligible\n`value` via `bind:value`, or lowering `minQueryLength` so the current\n`value` becomes eligible, does not itself call this callback—a host\nthat restores or sets `value` programmatically must trigger its own\nsearch rather than rely on this firing. Exception: if the user typed\nan ineligible query and a debounce timer is already pending when\n`minQueryLength` is lowered enough to make that in-flight query\neligible, the pending timer is not canceled or re-evaluated against\nthe new threshold at the moment it changes—it still fires against the\nlive `minQueryLength` when its debounce elapses, which can call this\nwith the query the user typed before the threshold changed.",
      },
    ],
  },
} satisfies ComponentSchema;

export default schema as ComponentSchema;
