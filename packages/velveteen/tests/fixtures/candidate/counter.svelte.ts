export function createCounter() {
  let value: number = $state(0);
  return {
    get value() {
      return value;
    },
    increment() {
      value += 1;
    },
  };
}
