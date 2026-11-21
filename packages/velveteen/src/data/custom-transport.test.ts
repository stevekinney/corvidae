import { expect, test } from "bun:test";
import { parse, stringify } from "devalue";
import {
  transportReducers,
  transportRevivers,
  transportTag,
} from "./custom-transport.ts";

class Token {
  constructor(readonly value: string) {}
}

test("namespaces application transport tags and preserves false unmatched values", () => {
  const transport = {
    Date: {
      encode: (value: unknown) =>
        value instanceof Token ? [value.value] : false,
      decode: ([value]: [string]) => new Token(value),
    },
  };
  const encoded = stringify(
    { token: new Token("x"), date: new Date("2026-01-01") },
    transportReducers(transport),
  );
  const decoded = parse(encoded, transportRevivers(transport)) as {
    token: Token;
    date: Date;
  };
  expect(transportTag("Date")).toBe("velveteen:transport:Date");
  expect(decoded.token).toBeInstanceOf(Token);
  expect(decoded.token.value).toBe("x");
  expect(decoded.date).toBeInstanceOf(Date);
});

test("rejects empty transport names", () => {
  expect(() => transportTag("")).toThrow("Invalid transport name");
});

test("escapes application transport names in the data frame", () => {
  const transport = {
    'quote"\n': {
      encode: (value: unknown) =>
        value instanceof Token ? [value.value] : false,
      decode: ([value]: [string]) => new Token(value),
    },
  };
  const encoded = stringify(new Token("escaped"), transportReducers(transport));
  expect(parse(encoded, transportRevivers(transport))).toEqual(
    new Token("escaped"),
  );
});

test("round-trips falsy encoded values other than the unmatched signal", () => {
  type Fields = 0 | "" | null | undefined;
  class Value {
    constructor(readonly field: Fields) {}
  }
  const transport = {
    Value: {
      encode: (value: unknown) =>
        value instanceof Value ? value.field : false,
      decode: (field: Fields) => new Value(field),
    },
  };
  const reducers = transportReducers(transport);
  const revivers = transportRevivers(transport);
  for (const field of [0, "", null, undefined] as const) {
    expect(parse(stringify(new Value(field), reducers), revivers)).toEqual(
      new Value(field),
    );
  }
});
