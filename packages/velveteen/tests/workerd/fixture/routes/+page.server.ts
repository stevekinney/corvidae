type CounterNamespace = {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
};

export const load = async ({
  cookies,
  platform,
}: {
  cookies: {
    get(name: string): string | undefined;
    set(name: string, value: string, options: { path: string }): void;
  };
  platform: { COUNTER: CounterNamespace };
}) => {
  const visitor = cookies.get("visitor") ?? "anonymous";
  if (visitor === "anonymous")
    cookies.set("visitor", "authenticated", { path: "/" });
  const counter = platform.COUNTER.get(
    platform.COUNTER.idFromName("velveteen"),
  );
  const durableCount = await (
    await counter.fetch(new Request("https://fixture.test/count"))
  ).text();
  return { visitor, durableCount };
};
