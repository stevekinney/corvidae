import { expect, test } from "bun:test";
import { rejectConflicts, sortRoutes } from "./route-order.ts";

// Selected literal cases from Kit create_manifest_data/index.spec.js and sort.js,
// pinned at a58e0a92c35dbeee161e96c733464dc7397e073a.
test("sortRoutes preserves pinned route precedence", () => {
  const expected = [
    "/",
    "/a",
    "/b",
    "/b/[required]",
    "/c",
    "/c/bar",
    "/c/b[x].json",
    "/c/b[x]",
    "/c/foo",
    "/d/e",
    "/d/e[...rest]",
    "/e/f",
    "/e/[...rest]/f",
    "/f/static[...rest]",
    "/f/[...rest]static",
    "/g/[[optional]]/static",
    "/g/[required]",
    "/g/[...rest]/[required]",
    "/h/a/b",
    "/h/a/[required]/b",
    "/h/a/[...rest]/b",
    "/x/[...rest]",
    "/[...rest]/x",
    "/[...rest]/x/[...deep_rest]/y",
    "/[...rest]/x/[...deep_rest]",
    "/[required=matcher]",
    "/[required]",
    "/[...rest]",
  ];
  const actual = sortRoutes(expected.map((id) => ({ id })).toReversed()).map(
    (route) => route.id,
  );
  expect(actual).toEqual(expected);
});

test("sortRoutes treats escaped bracket and group text as static", () => {
  const routes = [
    "/[value]",
    "/[x+5b]tag[x+5d]",
    "/[u+1f600]",
    "/[x+28]group[x+29]",
    "/a[x+5b][id]",
  ];
  const sorted = sortRoutes(routes.map((id) => ({ id })));
  expect(sorted[0].id).toBe("/[x+28]group[x+29]");
  expect(sorted.at(-1)?.id).toBe("/[value]");
  expect(
    sortRoutes([{ id: "/[x+5b]tag[x+5d]" }, { id: "/[u+005b]tag[u+005d]" }]),
  ).toHaveLength(2);
});

test("rejectConflicts preserves Kit optional permutations and group normalization", () => {
  rejectConflicts([{ id: "/foo/[[bar]]" }, { id: "/foo/[bar]" }]);
  rejectConflicts([{ id: "/foo/[[bar]]/baz" }, { id: "/foo/[bar]/qux" }]);
  expect(() =>
    rejectConflicts([{ id: "/foo/[[bar]]/baz" }, { id: "/foo/baz" }]),
  ).toThrow("Route conflict");
  expect(() =>
    rejectConflicts([{ id: "/(one)/foo" }, { id: "/(two)/foo" }]),
  ).toThrow("Route conflict");
});

test("rejectConflicts keeps required and rest declarations distinct", () => {
  rejectConflicts([{ id: "/[required]" }, { id: "/[...rest]" }]);
});

test("rejectConflicts keeps escaped bracket literals static", () => {
  rejectConflicts([{ id: "/[x+5b]tag[x+5d]" }, { id: "/[value]" }]);
  rejectConflicts([{ id: "/[x+3c][x+2a][x+3e]" }, { id: "/[value]" }]);
  expect(() =>
    rejectConflicts([
      { id: "/[x+5b]tag[x+5d]" },
      { id: "/[u+005b]tag[u+005d]" },
    ]),
  ).toThrow("Route conflict");
});
