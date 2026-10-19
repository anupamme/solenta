"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { render } = require("../../scripts/build-llms.js");

const SITE = path.join(__dirname, "..", "..", "site");
const read = (name) => fs.readFileSync(path.join(SITE, name), "utf8");

test("llms-full.txt matches docs.html (run node scripts/build-llms.js)", () => {
  assert.equal(read("llms-full.txt"), render(read("docs.html")));
});

test("llms-full.txt keeps every docs section and leaves no markup behind", () => {
  const full = read("llms-full.txt");
  for (const [, title] of read("docs.html").matchAll(/<h2 id="[^"]+">([^<]+)<\/h2>/g)) {
    assert.ok(full.includes(`\n## ${title.replace(/&amp;/g, "&")}\n`), title);
  }
  assert.doesNotMatch(full, /<\/?(p|li|strong|code|a|td)\b/);
});

test("llms.txt is a valid index whose site links resolve to files", () => {
  const index = read("llms.txt");
  assert.match(index, /^# Solenta\n\n> \S/);
  for (const [, file] of index.matchAll(/\]\(https:\/\/solenta\.app\/([^)#]+)\)/g)) {
    assert.ok(fs.existsSync(path.join(SITE, file)), file);
  }
});
