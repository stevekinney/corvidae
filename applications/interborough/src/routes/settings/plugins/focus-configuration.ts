/**
 * Moves the keyboard to the first field of a plugin's configuration, which is where a setting the
 * host refused is fixed. Does nothing when that plugin's detail is not on the page or takes no
 * configuration.
 */
export function focusConfiguration(pluginName: string): void {
  const detail = `[data-plugin-detail="${CSS.escape(pluginName)}"]`;
  const field = document.querySelector(`${detail} input, ${detail} select`);
  if (field instanceof HTMLElement) field.focus();
}
