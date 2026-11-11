import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

/**
 * The window's frame and the script that fills it have to agree.
 *
 * This is here because they once did not: the frame was redesigned and the
 * script kept reaching for ids that no longer existed, so the launcher rendered
 * nothing useful and nobody noticed until it was in someone's hands.
 */

const root = join(import.meta.dirname, "..");
const html = readFileSync(join(root, "index.html"), "utf8");
const script = readFileSync(join(root, "src", "main.ts"), "utf8");
const css = readFileSync(join(root, "src", "styles.css"), "utf8");
const rust = readFileSync(join(root, "src-tauri", "src", "lib.rs"), "utf8");

test("every element the script asks for is in the frame", () => {
  const asked = [...script.matchAll(/\bel(?:<[^>]*>)?\("([a-z0-9-]+)"\)/g)].map((m) => m[1]!);
  assert.ok(asked.length > 3, "expected the script to reach for several elements");
  const present = new Set([...html.matchAll(/id="([a-z0-9-]+)"/g)].map((m) => m[1]!));
  // Ids the script creates itself inside a page it just rendered.
  const made = new Set([...script.matchAll(/id="([a-z0-9-]+)"/g)].map((m) => m[1]!));
  for (const id of new Set(asked)) {
    assert.ok(present.has(id) || made.has(id), `the script uses el("${id}") but nothing has that id`);
  }
});

test("every command the script invokes exists on the Rust side", () => {
  const invoked = new Set([...script.matchAll(/invoke(?:<[^>]*>)?\("([a-z_]+)"/g)].map((m) => m[1]!));
  assert.ok(invoked.size > 5, "expected the script to invoke several commands");
  const handler = /generate_handler!\[([^\]]*)\]/s.exec(rust)?.[1] ?? "";
  const exposed = new Set(handler.split(",").map((name) => name.trim()).filter(Boolean));
  for (const name of invoked) {
    assert.ok(exposed.has(name), `the script invokes "${name}" but Rust does not expose it`);
  }
});

test("every event the script listens for is emitted somewhere", () => {
  const heard = new Set([...script.matchAll(/listen(?:<[^>]*>)?\("([a-z-]+)"/g)].map((m) => m[1]!));
  for (const name of heard) {
    assert.ok(rust.includes(`"${name}"`), `the script listens for "${name}" but nothing emits it`);
  }
});

test("the classes the script renders exist in the stylesheet", () => {
  const used = new Set(
    [...script.matchAll(/class="([a-z0-9 _-]+)"/g)]
      .flatMap((m) => m[1]!.split(/\s+/))
      .filter((name) => name && !name.startsWith("${")),
  );
  const defined = new Set([...css.matchAll(/\.([a-z][a-z0-9-]*)/g)].map((m) => m[1]!));
  const missing = [...used].filter((name) => !defined.has(name));
  assert.deepEqual(missing, [], `classes with no styles: ${missing.join(", ")}`);
});

test("no stray text has been pasted inside a tag", () => {
  // A continuation line inside a tag is one attribute: `aria-label="..."`.
  // A bare word in front of one — `challenge aria-label="..."` — is text pasted
  // in by accident, which the browser then treats as an attribute. It happened.
  // Only markup: the attribute after the bare word is hyphenated (aria-, data-)
  // or one of the plain HTML ones. That keeps ordinary code like
  // `let effort = "standard"` out of it.
  const ATTRIBUTE = /^(?:[a-z]+-[a-z-]+|class|href|style|id|type|role|title|value|src|alt|placeholder)$/;
  const lines = script.split("\n");
  for (const [index, line] of lines.entries()) {
    const stray = /^([a-z][a-z0-9-]*)\s+([a-z-]+)\s*=\s*["`$]/.exec(line.trim());
    if (!stray || !ATTRIBUTE.test(stray[2]!)) continue;
    assert.fail(`line ${index + 1} has a bare word inside a tag: ${line.trim().slice(0, 60)}`);
  }
});
