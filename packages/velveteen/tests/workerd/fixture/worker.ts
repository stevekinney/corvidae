import {
  createApplication,
  fetchAssetSource,
} from "@lostgradient/velveteen/server";
import { manifest } from "./velveteen-manifest.js";
import { registry } from "./velveteen-registry.js";

type DurableObjectState = {
  storage: {
    get(key: string): Promise<unknown>;
    put(key: string, value: unknown): Promise<void>;
  };
};

type Environment = {
  ASSETS: { fetch(request: Request): Promise<Response> };
  COUNTER: {
    idFromName(name: string): unknown;
    get(id: unknown): { fetch(request: Request): Promise<Response> };
  };
};

export class Counter {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(): Promise<Response> {
    const value = Number((await this.state.storage.get("count")) ?? 0) + 1;
    await this.state.storage.put("count", value);
    return new Response(String(value));
  }
}

let application: ReturnType<typeof createApplication> | undefined;

const getApplication = (environment: Environment) =>
  (application ??= createApplication({
    generation: { directory: "", manifest },
    registry,
    assets: fetchAssetSource(environment.ASSETS),
    platform: environment,
    mounts: {
      "/mounted": () => () => new Response("mounted Fetch service"),
    },
  }));

export default {
  async fetch(request: Request, environment: Environment): Promise<Response> {
    return (await getApplication(environment)).fetch(request);
  },
};
