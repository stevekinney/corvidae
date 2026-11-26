import { expect, test } from "bun:test";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { buildProduction } from "../../src/build/index.ts";

type WorkerOptions = {
  entry: string;
  assets: string;
  durableObjects: Record<string, string>;
};
type WorkerBindings = {
  dispatchFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response>;
};
type WithWorker = <T>(
  options: WorkerOptions,
  callback: (bindings: WorkerBindings) => Promise<T>,
) => Promise<T>;

const { withWorker } = (await import(
  new URL("../../../../testing/workerd/src/index.ts", import.meta.url).href
)) as { withWorker: WithWorker };

const fixture = join(import.meta.dir, "fixture");

const cookieValue = (response: Response): string => {
  const cookie = response.headers.getSetCookie()[0];
  if (!cookie) throw new Error("fixture response did not set a cookie");
  return cookie.split(";", 1)[0];
};

test("serves a production Velveteen application through workerd", async () => {
  const project = await mkdtemp(join(import.meta.dir, ".workerd-"));
  try {
    await cp(fixture, project, { recursive: true });
    const generation = await buildProduction({
      projectDirectory: project,
      routesDirectory: join(project, "routes"),
      staticDirectory: join(project, "static"),
      outputDirectory: join(project, "output"),
    });
    const entry = join(generation.directory, "worker.ts");
    await cp(join(project, "worker.ts"), entry);
    await withWorker(
      {
        entry,
        assets: join(generation.directory, "static"),
        durableObjects: { COUNTER: "Counter" },
      },
      async ({ dispatchFetch }) => {
        const first = await dispatchFetch("https://fixture.test/");
        expect(first.status).toBe(200);
        expect(await first.text()).toContain("visitor: anonymous");
        expect(
          await dispatchFetch("https://fixture.test/mounted").then((response) =>
            response.text(),
          ),
        ).toBe("mounted Fetch service");

        const asset = await dispatchFetch(
          "https://fixture.test/worker-asset.txt",
        );
        expect(asset.status).toBe(200);
        expect(await asset.text()).toBe("asset bytes from workerd\n");

        const authenticated = await dispatchFetch("https://fixture.test/", {
          headers: { cookie: cookieValue(first) },
        });
        expect(await authenticated.text()).toContain("visitor: authenticated");
        expect(
          await dispatchFetch("https://fixture.test/").then((response) =>
            response.text(),
          ),
        ).toContain("durable count: 3");
      },
    );
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});
