import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import ts from 'typescript';

const weftRoot = join(import.meta.dir, '..');
const backchannelRoot = join(weftRoot, '..', 'backchannel');

/** Weft's entries and the new package's, as `package.json` declares them. */
async function entriesOf(packageRoot: string): Promise<Record<string, string>> {
  const manifest = (await Bun.file(join(packageRoot, 'package.json')).json()) as {
    exports: Record<string, string>;
  };
  return Object.fromEntries(
    Object.entries(manifest.exports).map(([key, path]) => [key, join(packageRoot, path)]),
  );
}

describe('the export names of @lostgradient/weft and @lostgradient/backchannel', () => {
  it('overlap nowhere: Weft exports no value and no type the new package declares', async () => {
    const weftEntries = await entriesOf(weftRoot);
    const backchannelEntries = await entriesOf(backchannelRoot);

    const configuration = ts.readConfigFile(join(weftRoot, 'tsconfig.json'), ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(configuration.config, ts.sys, weftRoot);
    const program = ts.createProgram({
      rootNames: [...Object.values(weftEntries), ...Object.values(backchannelEntries)],
      options: { ...parsed.options, noEmit: true },
    });
    const checker = program.getTypeChecker();

    function namesOf(entries: Record<string, string>): Map<string, string> {
      const names = new Map<string, string>();
      for (const [key, path] of Object.entries(entries)) {
        const sourceFile = program.getSourceFile(path);
        const moduleSymbol = sourceFile ? checker.getSymbolAtLocation(sourceFile) : undefined;
        expect(moduleSymbol, `${path} is a module`).toBeDefined();
        for (const symbol of checker.getExportsOfModule(moduleSymbol!)) {
          if (!names.has(symbol.name)) names.set(symbol.name, key);
        }
      }
      return names;
    }

    const weftNames = namesOf(weftEntries);
    const backchannelNames = namesOf(backchannelEntries);
    expect(weftNames.size).toBeGreaterThan(100);
    expect(backchannelNames.size).toBeGreaterThan(100);

    const overlap = [...backchannelNames]
      .filter(([name]) => weftNames.has(name))
      .map(([name, entry]) => `${name} (backchannel ${entry}, weft ${weftNames.get(name)})`);
    expect(overlap).toEqual([]);
  });
});
