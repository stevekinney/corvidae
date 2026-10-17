/** Stylelint rule: form controls do not use the page surface token. */
import stylelint from 'stylelint';
import {
  isCinderComponentSource,
  isFormControl,
  resolvesToSurface,
} from './form-control-selectors.mjs';

const ruleName = 'cinder/no-surface-on-form-control';
const messages = stylelint.utils.ruleMessages(ruleName, {
  surface: () =>
    'Form controls must not use `--cinder-surface` for their background; the default control fill is `--cinder-surface-raised`.',
});
const plugin = stylelint.createPlugin(ruleName, (primary) => (root, result) => {
  if (!stylelint.utils.validateOptions(result, ruleName, { actual: primary, possible: [true] }))
    return;
  if (!isCinderComponentSource(root)) return;
  const variables = new Map();
  root.walkDecls((decl) => {
    if (decl.prop.startsWith('--')) variables.set(decl.prop, decl.value.trim());
  });
  root.walkRules((rule) => {
    if (!isFormControl(rule.selector)) return;
    rule.walkDecls((decl) => {
      if (decl.prop !== 'background' && decl.prop !== 'background-color') return;
      if (
        decl.value.trim() === 'var(--cinder-surface)' ||
        resolvesToSurface(decl.value.trim(), variables)
      ) {
        stylelint.utils.report({ ruleName, result, node: decl, message: messages.surface() });
      }
    });
  });
});

plugin.ruleName = ruleName;
plugin.messages = messages;
plugin.meta = { url: 'https://github.com/stevekinney/cinder/blob/main/docs/tokens.md' };

export default plugin;
