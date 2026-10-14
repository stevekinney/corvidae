/** A promise whose settlement a test controls, used as a barrier between two steps of a scenario. */
export type Deferred<Value> = {
  readonly promise: Promise<Value>;
  resolve(value: Value): void;
  reject(error: unknown): void;
};

export function createDeferred<Value = void>(): Deferred<Value> {
  let settleResolve!: (value: Value) => void;
  let settleReject!: (error: unknown) => void;
  const promise = new Promise<Value>((resolve, reject) => {
    settleResolve = resolve;
    settleReject = reject;
  });
  return { promise, resolve: settleResolve, reject: settleReject };
}
