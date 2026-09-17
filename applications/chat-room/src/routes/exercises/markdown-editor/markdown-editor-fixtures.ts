import type { MilkdownPlugin } from '@milkdown/ctx';
import * as milkdownUtilities from '@milkdown/kit/utils';
import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';

// ---------------------------------------------------------------------------
// Document + the two coordinate spaces
// ---------------------------------------------------------------------------

// Headings and paragraphs only, no lists — the same rule (and the same fixture)
// `review-imperative` uses. ProseMirror positions inside a list depend on how
// tightly the markdown parser nests `list_item > paragraph`, and every number
// below is asserted exactly.
const HEADING = 'Release Plan';
const PARAGRAPH_ONE = 'The first release includes a dashboard, export actions, and inline review.';
const PARAGRAPH_TWO =
  'Reviewers should verify that the export dialog copy matches the product brief before we ship.';
const PARAGRAPH_THREE = 'Timeline risk: the migration script is untested.';

// `###`, not `#`. Each editor renders its document's first heading at the
// authored level, so a `#` fixture would put an extra `h1` on a page that
// already has one — an outline of sibling `h1`s nested inside `h2` sections,
// visible only after hydration because the editor server-renders a skeleton.
// Safe for the arithmetic: a ProseMirror heading node costs 1 on each side
// regardless of its level, so content still starts at 1.
const INITIAL = `### ${HEADING}\n\n${PARAGRAPH_ONE}\n\n${PARAGRAPH_TWO}\n\n${PARAGRAPH_THREE}`;

// TWO COORDINATE SPACES, worked out here rather than read back from the
// component, so the assertions are arithmetic claims and not readouts of a
// number the component computed for itself.
//
// ProseMirror positions (each block node costs 1 on each side):
//   heading  node 0..14    content 1..13
//   para 1   node 14..90   content 15..89
//   para 2   node 90..185  content 91..184
//   para 3   node 185..235 content 186..234    → doc.content.size = 235
//
// doc.textBetween() offsets (blocks joined by a single "\n"):
//   heading 0..12   para 1 13..87   para 2 88..181   para 3 182..230
//
// 'dashboard' sits at index 29 of paragraph one, so its ProseMirror range is
// 15+29=44 .. 44+9=53 and its textBetween offset is 13+29=42. Two different
// numbers for one selection — which is the whole point, and why the heading
// alone (1..13 against 0..12) would be a weak demonstration.
const MARKER = 'dashboard';
const QUOTE_FROM = 44;
const QUOTE_TO = 53;
const HEADING_FROM = 1;
const HEADING_TO = 13;

const MAIN_ID = 'markdown-editor-main';
const READONLY_ID = 'markdown-editor-readonly';

// A document with a different shape AND a different heading level, so the AST
// assertions after `setMarkdown` cannot be satisfied by the initial document.
const REPLACEMENT = '# Replaced Plan\n\nOnly one paragraph now.';

// A different heading text from the main editor's on purpose: both editors slug
// their document's first heading into an `id`, and two `id="release-plan"` nodes
// on one page make in-document anchors resolve to whichever came first.
const READONLY_INITIAL = `### Published Reference\n\n${PARAGRAPH_TWO}`;

// ---------------------------------------------------------------------------
// The plugin seam
// ---------------------------------------------------------------------------

// `plugins?: MilkdownPlugin[]` is the entire seam — not a context, not a Ctx
// callback. The array is applied LAST, after commonmark, gfm, the link input
// rule, clipboard, history, the keymap, the listener, and the placeholder
// plugin, via `builder.use(plugins)`.
//
// The probe decorates every occurrence of a marker word rather than a fixed
// range, so it demonstrates that the plugin sees the LIVE document (it survives
// edits and re-runs on every state) instead of a range that happens to be right
// once. `decorations` is a prop rather than plugin state deliberately: it is
// recomputed from `state.doc` on every render, so there is no mapping code of
// our own that could mask a plugin that never loaded.
const PROBE_A = 'me-probe-a';
const PROBE_B = 'me-probe-b';

function probeDecorationPlugin(className: string): MilkdownPlugin {
  return milkdownUtilities.$prose(
    () =>
      new Plugin({
        key: new PluginKey(`markdown-editor-probe-${className}`),
        props: {
          decorations(state) {
            const decorations: Decoration[] = [];
            state.doc.descendants((node, position) => {
              const text = node.isText ? node.text : undefined;
              if (!text) return;
              // `position` is the position BEFORE a text node, and text
              // offsets add to it directly — the one place in ProseMirror
              // where a character index and a document position line up.
              let index = text.indexOf(MARKER);
              while (index !== -1) {
                decorations.push(
                  Decoration.inline(position + index, position + index + MARKER.length, {
                    class: className,
                  }),
                );
                index = text.indexOf(MARKER, index + MARKER.length);
              }
            });
            return DecorationSet.create(state.doc, decorations);
          },
        },
      }),
  );
}

export {
  HEADING,
  HEADING_FROM,
  HEADING_TO,
  INITIAL,
  MAIN_ID,
  MARKER,
  PARAGRAPH_ONE,
  PARAGRAPH_THREE,
  PARAGRAPH_TWO,
  PROBE_A,
  PROBE_B,
  probeDecorationPlugin,
  QUOTE_FROM,
  QUOTE_TO,
  READONLY_ID,
  READONLY_INITIAL,
  REPLACEMENT,
};
