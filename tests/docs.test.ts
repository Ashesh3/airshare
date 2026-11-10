import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config";

const source = await Bun.file(new URL("../src/config.ts", import.meta.url)).text();
const readme = await Bun.file(new URL("../README.md", import.meta.url)).text();
const compose = await Bun.file(new URL("../compose.yaml", import.meta.url)).text();

// Every variable loadConfig reads, with the config key that holds its value.
const variables = new Map<string, string | undefined>();
for (const [, key, name] of source.matchAll(/(\w+): (?:integer|toggle)\("([A-Z_]+)"/g)) variables.set(name!, key);
for (const [, key, name] of source.matchAll(/(\w+): env\.([A-Z_]+)/g)) variables.set(name!, key);
for (const [, name] of source.matchAll(/env\.([A-Z_]+)/g)) if (!variables.has(name!)) variables.set(name!, undefined);
const defaults = loadConfig({}) as Record<string, unknown>;
function written(value: unknown) {
  return typeof value === "boolean" ? (value ? "on" : "off") : value === undefined ? "" : String(value);
}

const section = readme.slice(
  readme.indexOf("\n## Configuration\n"),
  readme.indexOf("\n## ", readme.indexOf("\n## Configuration\n") + 1),
);
const rows = [...section.matchAll(/^\| `([A-Z_]+)` \| ([^|]+) \|/gm)];
const documented = new Map(rows.map(([, name, value]) => [name!, value!.trim()]));

describe("documentation matches the configuration", () => {
  test("loadConfig reads the expected set of variables", () => {
    expect(variables.size).toBeGreaterThan(30);
    expect(variables.has("LIVENESS_HINTS") && variables.has("PUBLIC_URL") && variables.has("TRUSTED_PROXIES")).toBe(
      true,
    );
  });

  test("the README configuration table lists every variable once, with its default, and nothing else", () => {
    expect(rows).toHaveLength(documented.size);
    expect([...documented.keys()].sort()).toEqual([...variables.keys()].sort());
    for (const [name, key] of variables) {
      const value = key ? defaults[key] : undefined;
      const cell = documented.get(name)!;
      if (value === undefined) continue;
      if (value === "") expect(cell, name).toBe("Empty");
      else expect(cell, name).toBe(`\`${written(value)}\``);
    }
  });

  test("compose.yaml passes every variable the image does not fix, with the same default", () => {
    for (const [name, key] of variables) {
      if (["HOST", "PORT", "DATA_DIR"].includes(name)) continue;
      expect(compose, name).toContain(`${name}: \${${name}:-${written(key ? defaults[key] : undefined)}}`);
    }
  });
});

const parityPath = fileURLToPath(new URL("../docs/PARITY.md", import.meta.url));
const browserTests = fileURLToPath(new URL("./e2e/", import.meta.url));
describe("docs/PARITY.md", () => {
  // The Docker test image leaves out docs/ and the browser tests; checkouts (and CI's bun test) have both.
  test.skipIf(!existsSync(parityPath) || !existsSync(browserTests))(
    "every test it cites as evidence exists",
    async () => {
      const tests = fileURLToPath(new URL("./", import.meta.url));
      const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const titles: Array<string | RegExp> = [];
      for (const path of new Bun.Glob("**/*.ts").scanSync(tests)) {
        const source = await Bun.file(join(tests, path)).text();
        for (const [, quote, raw] of source.matchAll(
          /\b(?:test|it|describe)(?:\.\w+)*\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/g,
        )) {
          const title = raw!.replace(/\\(.)/g, "$1");
          // A title built in a loop, such as `… the tab is ${mode}`, stands for every value it takes.
          titles.push(
            quote === "`" && title.includes("${")
              ? new RegExp(
                  `^${title
                    .split(/\$\{[^}]*\}/)
                    .map(escape)
                    .join(".+")}$`,
                )
              : title,
          );
        }
      }
      const parity = await Bun.file(parityPath).text();
      // The evidence column is each table row's last cell; "\|" is a pipe inside a cell.
      const evidence = parity
        .split("\n")
        .filter((line) => line.startsWith("| "))
        .map((line) => line.split(/(?<!\\)\|/).at(-2)!);
      const cited = evidence.flatMap((cell) =>
        [...cell.matchAll(/"([^"]+)"/g)].map(([, name]) => name!.replaceAll("\\|", "|")),
      );
      expect(cited.length).toBeGreaterThan(40);
      expect(
        cited.filter(
          (name) => !titles.some((title) => (typeof title === "string" ? title === name : title.test(name))),
        ),
      ).toEqual([]);
    },
  );
});
