import { fail } from "../../src/actions/server.ts";
import { error } from "../../src/data/errors.ts";
import { defineRemoteForm } from "../../src/remote/forms.ts";
import { defineBatchQuery, defineRemote } from "../../src/remote/server.ts";

const rows = new Map([
  ["one", "One"],
  ["two", "Two"],
]);

function key(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("Expected a row key");
  return value;
}

export const runtimeRemoteDefinitions = {
  row: defineBatchQuery({
    validate: key,
    handle(inputs) {
      if (new Set(inputs).size !== inputs.length)
        throw new Error("Query inputs were not deduplicated");
      return (input) => {
        const value = rows.get(input);
        if (value === undefined) error(404, "Not found");
        return value;
      };
    },
  }),
  change: defineRemote({
    kind: "command",
    validate: key,
    handle(input) {
      rows.set(input, "Updated");
      return true;
    },
    refresh: (input) => [{ name: "row", input }],
  }),
};

export const runtimeRemoteForms = {
  message: defineRemoteForm({
    validate(data) {
      return String(data.get("message") ?? "").trim();
    },
    handle(message) {
      if (!message) return fail(422, { issue: "Enter a message" });
      return { message };
    },
  }),
};
