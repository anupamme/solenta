"use strict";

// The homepage ships static JSON-LD for search and answer engines (many AI
// crawlers do not run JS). Search engines penalise FAQ markup that differs
// from the visible page, so the FAQPage must mirror #faq word for word.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const html = fs.readFileSync(path.join(__dirname, "..", "..", "site", "index.html"), "utf8");
const { document } = new JSDOM(html).window;
const blocks = [...document.querySelectorAll('script[type="application/ld+json"]')].map((s) =>
  JSON.parse(s.textContent),
);
const byType = (t) => blocks.find((b) => b["@type"] === t);

test("homepage JSON-LD parses and describes a free SoftwareApplication", () => {
  const app = byType("SoftwareApplication");
  assert.ok(app, "SoftwareApplication block");
  assert.equal(app.name, "Solenta");
  assert.equal(app.offers.price, "0");
  assert.equal(app.description, document.querySelector('meta[name="description"]').content);
});

test("FAQPage JSON-LD mirrors the visible #faq entries", () => {
  const visible = [...document.querySelectorAll("#faq details")].map((d) => [
    d.querySelector("summary").textContent.trim(),
    d.querySelector("p").textContent.trim(),
  ]);
  const marked = byType("FAQPage").mainEntity.map((q) => [q.name, q.acceptedAnswer.text]);
  assert.deepEqual(marked, visible);
});
