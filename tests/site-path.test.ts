import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { withBasePathFor } from "../site/src/lib/site-path.js";

describe("site deployment paths", () => {
  it("prefixes site-root routes and the site root", () => {
    assert.equal(withBasePathFor("/HooKit/", "/reference/events"), "/HooKit/reference/events");
    assert.equal(withBasePathFor("/HooKit/", "/"), "/HooKit/");
  });

  it("leaves already-prefixed and context-safe URLs unchanged", () => {
    assert.equal(withBasePathFor("/HooKit/", "/HooKit/reference/events"), "/HooKit/reference/events");
    assert.equal(withBasePathFor("/HooKit/", "#event"), "#event");
    assert.equal(withBasePathFor("/HooKit/", "https://example.com"), "https://example.com");
    assert.equal(withBasePathFor("/HooKit/", "//example.com"), "//example.com");
  });

  it("preserves root-hosted URLs when no project base is configured", () => {
    assert.equal(withBasePathFor("/", "/reference/events"), "/reference/events");
  });
});
