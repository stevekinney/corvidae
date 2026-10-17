/**
 * What counts as a form control in component CSS, shared by
 * `no-surface-on-form-control` and `control-frame` so the two rules agree.
 */

export function variableFunctions(value) {
  const functions = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!value.startsWith('var(', index)) continue;
    let depth = 1;
    let end = index + 4;
    for (; end < value.length && depth > 0; end += 1) {
      if (value[end] === '(') depth += 1;
      if (value[end] === ')') depth -= 1;
    }
    if (depth !== 0) continue;
    const body = value.slice(index + 4, end - 1);
    const comma = body.indexOf(',');
    functions.push({
      name: (comma < 0 ? body : body.slice(0, comma)).trim(),
      fallback: comma < 0 ? '' : body.slice(comma + 1).trim(),
    });
    index = end - 1;
  }
  return functions;
}

export function resolvesToSurface(value, variables, seen = new Set()) {
  if (/var\(\s*--cinder-surface\s*(?:[,)]|$)/.test(value)) return true;
  return variableFunctions(value).some(({ name, fallback }) => {
    if (seen.has(name)) return false;
    const replacement = variables.get(name) ?? fallback;
    return (
      replacement !== '' && resolvesToSurface(replacement, variables, new Set([...seen, name]))
    );
  });
}

export function isCinderComponentSource(root) {
  const file = root.source?.input?.file;
  return (
    file === undefined ||
    file.startsWith('<') ||
    /components[\\/](?:cinder[\\/]src[\\/](?:components|styles[\\/]components)|(?:chat|editor)[\\/]src[\\/])/.test(
      file,
    )
  );
}

export function isFormControl(selector) {
  // The `\.[\w-]*-(?:textarea|input|select)` branch catches hand-rolled
  // controls that end their class name in `-textarea`/`-input`/`-select`
  // (chat-message-edit-textarea, comment-composer-textarea,
  // comment-edit-textarea, …) without needing an entry per component —
  // these keep recurring because Chat and Editor don't follow the BEM
  // `__textarea` convention the other branch below relies on.
  return /(?:^|[\s,>+~(])(?:input|textarea|select|\.[\w-]*-(?:textarea|input|select)|\.cinder-(?:input|textarea|select|checkbox|radio)|\.cinder-_input-frame|\.cinder-(?:pin-input__segment|phone-input__(?:country|national)|invocation-rule-builder__(?:rule-label-input|condition-(?:select|value)|action-select)))(?=[.#:[\s,)]|$)|\[role\s*=\s*["'](?:textbox|combobox|spinbutton)["']\]|(?:__input|__textarea|__select)(?:\b|[-_:])/i.test(
    selector,
  );
}
