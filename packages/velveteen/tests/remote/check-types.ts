import { runWithHangGuard } from "@lostgradient/testing/hang-guard";
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

async function checkRemoteTypes() {
  const parent = resolve(".velveteen/types");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "remotes-"));
  const definitions = `import {defineBatchQuery,defineRemote} from ${JSON.stringify(resolve("src/remote/server.ts"))};
    const number=(value:unknown)=>{if(typeof value!=='number')throw new Error();return value;};
    export const definitions={
      count:defineRemote({kind:'query',validate:number,handle:(value:number)=>({count:value+1})}),
      batch:defineBatchQuery({validate:number,handle:(inputs)=>{const counts=new Set(inputs);return (value)=>counts.has(value)?String(value):"missing";}}),
      command:defineRemote({kind:'command',validate:number,handle:(value)=>value}),
    };`;
  const imports = `import type {definitions} from './definitions.server.ts';import {createRemoteClient} from ${JSON.stringify(resolve("src/remote/client.ts"))};const client=createRemoteClient<typeof definitions>({baseURL:'http://test/',invalidate:async()=>{}});`;
  try {
    await Bun.write(join(root, "definitions.server.ts"), definitions);
    const configuration = join(root, "tsconfig.json");
    await Bun.write(
      configuration,
      JSON.stringify({
        extends: resolve("tsconfig.json"),
        include: ["*.ts"],
        exclude: [],
      }),
    );
    const run = async (source: string) => {
      await Bun.write(join(root, "consumer.ts"), imports + source);
      return runWithHangGuard([
        process.execPath,
        resolve("node_modules/typescript/bin/tsc"),
        "--project",
        configuration,
        "--pretty",
        "false",
      ]);
    };
    const positive = await run(
      "const value: {count:number}=await client.call('count',2);const count=await client.query('count',2).get();const batch=client.query('batch',2);const text:string=await batch.refresh();batch.subscribe(item=>item.toUpperCase());void [value,count,text];",
    );
    if (positive.exitCode !== 0)
      throw new Error(positive.stdout.toString() + positive.stderr.toString());
    for (const [source, diagnostic] of [
      ["await client.call('count','wrong');", "TS2345"],
      ["const value:string=await client.call('count',2);void value;", "TS2322"],
      ["await client.call('missing',2);", "TS2345"],
      ["client.query('command',2);", "TS2345"],
      ["client.query('batch','wrong');", "TS2345"],
      [
        "const value:number=await client.query('batch',2).get();void value;",
        "TS2322",
      ],
    ] as const) {
      const result = await run(source);
      assert.notEqual(result.exitCode, 0);
      const text = result.stdout.toString() + result.stderr.toString();
      assert.ok(text.includes(diagnostic), text);
      assert.equal(text.match(/error TS\d+:/g)?.length, 1, text);
    }
    assert.equal((await run("await client.call('count',2);")).exitCode, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
await checkRemoteTypes();
console.log(
  "G04/V remote consumers passed: 8 actual strict compiler executions, 6 causal negative controls",
);
