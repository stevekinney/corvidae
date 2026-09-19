import { basename } from 'node:path';
import type { Plugin } from 'vite';
import { readGrammarData, replaceGrammarData } from '../../../scripts/shiki-grammar-assets.ts';

/** Emit large language data as normal application assets instead of JavaScript strings. */
export function shikiGrammarAssets(): Plugin {
  return {
    name: 'vite-plugin-shiki-grammar-assets',
    apply: 'build',
    applyToEnvironment: (environment) => environment.config.consumer === 'client',
    transform: {
      filter: { id: /\/node_modules\/@shikijs\/langs\/dist\/[^/]+\.mjs$/ },
      handler(source, id) {
        const data = readGrammarData(source, id);
        if (!data) return null;
        const reference = this.emitFile({
          type: 'asset',
          name: `shiki-${basename(id, '.mjs')}.json`,
          source: data.json,
        });
        return {
          code: replaceGrammarData(source, data, `import.meta.ROLLUP_FILE_URL_${reference}`),
          map: null,
        };
      },
    },
  };
}
