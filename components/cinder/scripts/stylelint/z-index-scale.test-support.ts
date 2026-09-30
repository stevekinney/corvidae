import { fileURLToPath } from 'node:url';

import stylelint from 'stylelint';

export const ruleName = 'cinder/z-index-scale';
export const pluginPath = fileURLToPath(new URL('./z-index-scale.mjs', import.meta.url));

export async function lint(css: string) {
  return stylelint.lint({
    code: css,
    config: {
      plugins: [pluginPath],
      rules: { [ruleName]: true },
    },
  });
}

export function warnings(result: Awaited<ReturnType<typeof stylelint.lint>>) {
  return result.results
    .flatMap((file) => file.warnings ?? [])
    .filter((warning) => {
      return warning.rule === ruleName;
    });
}
