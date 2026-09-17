import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { createLogger, preprocessCSS, resolveConfig } from 'vite';

test('source styles compile without discarded imports or other CSS warnings', async () => {
  const warnings: string[] = [];
  const logger = createLogger();
  logger.warn = (message) => warnings.push(message);
  logger.warnOnce = (message) => warnings.push(message);
  const configuration = await resolveConfig({ configFile: false, customLogger: logger }, 'build');
  const filename = fileURLToPath(
    new URL('../../../packages/weft-ui/src/styles/index.css', import.meta.url),
  );
  const result = await preprocessCSS(await Bun.file(filename).text(), filename, configuration);

  expect(result.code).toContain('.weft-workflow-list__header-actions');
  expect(warnings).toEqual([]);
});
