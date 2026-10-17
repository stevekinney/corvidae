/**
 * Stylelint rule: text-entry controls draw with the control frame.
 *
 * Every control's fill, edge, and corner come from `--cinder-control-*`
 * (`background`, `border`, `border-hover`, `radius`). A control rule that
 * picks its own neutral surface, structural border tier, radius step, or a
 * literal color is how the family drifted apart: some fields sat on
 * `surface`, some on `surface-inset`, some used `radius-sm`, some rested on
 * the structural `border` tier instead of the 3:1 control tier.
 *
 * State colors are not part of the frame and stay allowed: status tones
 * (invalid, warning), the focus ring, the accent (a checked box), the
 * disabled fill, and the raised-surface hover/pressed washes.
 */
import stylelint from 'stylelint';
import { isCinderComponentSource, isFormControl } from './form-control-selectors.mjs';

const ruleName = 'cinder/control-frame';
const messages = stylelint.utils.ruleMessages(ruleName, {
  raw: (/** @type {string} */ property, /** @type {string} */ value) =>
    `Control \`${property}: ${value}\` must come from the control frame: use \`--cinder-control-background\`, \`--cinder-control-border\` / \`--cinder-control-border-hover\`, or \`--cinder-control-radius\` (or a state token).`,
});

const COLOR_PROPERTIES = new Set([
  'background',
  'background-color',
  'border-color',
  'border-block-color',
  'border-inline-color',
  'border-block-start-color',
  'border-block-end-color',
  'border-inline-start-color',
  'border-inline-end-color',
  'border-top-color',
  'border-bottom-color',
]);
const SHORTHAND_PROPERTIES = new Set([
  'border',
  'border-block',
  'border-inline',
  'border-block-start',
  'border-block-end',
  'border-inline-start',
  'border-inline-end',
  'border-top',
  'border-bottom',
]);
const RADIUS_PROPERTY = /^border(?:-(?:start|end|top|bottom)-(?:start|end|left|right))?-radius$/;

/** Custom properties a control may paint with: the frame itself and state colors. */
const ALLOWED_VARIABLE =
  /^--cinder-(?:control-|status-|ring-|accent-|fill-disabled|surface-raised-(?:hover|pressed)|danger|focus-|radius-(?:full|lg)|[a-z0-9-]+-(?:background|border|border-color|radius|fill)(?:-|$))/;
/**
 * Keywords that paint nothing, defer to something else, or are forced-colors
 * system colors (which a `@media (forced-colors: active)` block must use).
 */
const NEUTRAL_KEYWORD =
  /^(?:transparent|none|inherit|initial|unset|revert|currentcolor|0|0px|solid|dashed|dotted|hidden|canvas|canvastext|buttontext|buttonface|buttonborder|field|fieldtext|highlight|highlighttext|graytext|mark|marktext|linktext|accentcolor|accentcolortext|selecteditem|selecteditemtext)$/i;
/**
 * Neutral design tokens that bypass the frame. `--cinder-radius-lg` is not
 * here: a multi-line composer (Chat, review comments, the JSON schema editor)
 * is large enough that the field radius reads as a sharp corner.
 */
const FRAME_BYPASS =
  /^--cinder-(?:surface(?:-inset|-canvas)?|border(?:-muted|-strong|-faint|-control(?:-hover)?)?|radius-(?:xs|sm|md|control|surface))$/;
/** A status fill as an edge: an invalid control uses `--cinder-control-border-invalid`. */
const STATUS_FILL = /^--cinder-status-[a-z]+-solid(?:-[a-z]+)?$/;
/** A checkbox or radio box is not a text field; its radius is its own. */
const CHOICE_CONTROL = /checkbox|radio/i;

function variableNames(value) {
  return [...value.matchAll(/var\(\s*(--[\w-]+)/g)].map((match) => match[1]);
}

/** Whether a value is outside the frame. */
function violation(value, isEdge) {
  const trimmed = value.trim();
  const names = variableNames(trimmed);
  if (names.some((name) => FRAME_BYPASS.test(name))) return true;
  if (isEdge && names.some((name) => STATUS_FILL.test(name))) return true;
  if (names.some((name) => ALLOWED_VARIABLE.test(name))) return false;
  // Strip widths, styles, and keywords; anything left is a literal color or length.
  const remainder = trimmed
    .replace(/var\([^)]*\)/g, '')
    .split(/\s+/)
    .filter(
      (part) =>
        part !== '' && !NEUTRAL_KEYWORD.test(part) && !/^-?[\d.]+(?:px|rem|em)?$/.test(part),
    );
  return names.length === 0 && remainder.length > 0;
}

const plugin = stylelint.createPlugin(ruleName, (primary) => (root, result) => {
  if (!stylelint.utils.validateOptions(result, ruleName, { actual: primary, possible: [true] }))
    return;
  if (!isCinderComponentSource(root)) return;
  root.walkRules((rule) => {
    if (!isFormControl(rule.selector)) return;
    rule.each((decl) => {
      if (decl.type !== 'decl') return;
      const property = decl.prop.toLowerCase();
      const isRadius = RADIUS_PROPERTY.test(property);
      if (isRadius && CHOICE_CONTROL.test(rule.selector)) return;
      const relevant =
        COLOR_PROPERTIES.has(property) || SHORTHAND_PROPERTIES.has(property) || isRadius;
      const isEdge = property.startsWith('border') && !isRadius;
      if (!relevant || !violation(decl.value, isEdge)) return;
      stylelint.utils.report({
        ruleName,
        result,
        node: decl,
        message: messages.raw(decl.prop, decl.value.trim()),
      });
    });
  });
});

plugin.ruleName = ruleName;
plugin.messages = messages;
plugin.meta = { url: 'https://github.com/stevekinney/cinder/blob/main/docs/tokens.md' };

export default plugin;
