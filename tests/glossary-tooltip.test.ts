/**
 * Tests for the glossary tooltip placement math (`site/src/glossary-tooltip.ts`).
 *
 * `resolveTooltipPosition` is the pure decision that keeps the tooltip inside
 * the visible article area: prefer above the trigger, flip below when the top
 * would overflow, and clamp both axes so it is never cut off by the sidebar
 * or the viewport edges. The DOM glue in `createGlossaryTooltip` stays thin
 * and is not exercised here (no jsdom in this repo).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { resolveTooltipPosition, TOOLTIP_GAP_PX } from "../site/src/glossary-tooltip.js";

// A trigger roughly centered on a 1200px viewport with a 760px article.
const TRIGGER = { top: 400, left: 520, width: 90, height: 20 };
const TOOLTIP = { width: 300, height: 60 };
const BOUNDS = { top: 0, left: 220, width: 760, height: 800 };

describe("resolveTooltipPosition", () => {
  it("prefers floating above the trigger and centered", () => {
    const p = resolveTooltipPosition(TRIGGER, TOOLTIP.width, TOOLTIP.height, BOUNDS);
    assert.equal(p.above, true);
    const center = TRIGGER.left + TRIGGER.width / 2 - TOOLTIP.width / 2;
    assert.equal(p.left, center);
    assert.equal(p.top, TRIGGER.top - TOOLTIP_GAP_PX - TOOLTIP.height);
  });

  it("flips below when the above position would overflow the article top", () => {
    const nearTop = { ...TRIGGER, top: 30 };
    const p = resolveTooltipPosition(nearTop, TOOLTIP.width, TOOLTIP.height, BOUNDS);
    assert.equal(p.above, false);
    assert.equal(p.top, nearTop.top + nearTop.height + TOOLTIP_GAP_PX);
  });

  it("clamps toward the article left so it never crosses into the sidebar", () => {
    const nearLeft = { ...TRIGGER, left: BOUNDS.left + 40 };
    const p = resolveTooltipPosition(nearLeft, TOOLTIP.width, TOOLTIP.height, BOUNDS);
    assert.ok(p.left >= BOUNDS.left, `left ${p.left} should stay <= bounds`);
    assert.equal(p.left, BOUNDS.left, "centered box touching the edge clamps to article left");
  });

  it("clamps toward the article right edge", () => {
    const nearRight = { ...TRIGGER, left: BOUNDS.left + BOUNDS.width - 30 };
    const p = resolveTooltipPosition(nearRight, TOOLTIP.width, TOOLTIP.height, BOUNDS);
    assert.ok(p.left + TOOLTIP.width <= BOUNDS.left + BOUNDS.width);
  });

  it("keeps a below placement inside the article bottom", () => {
    const nearBottom = { ...TRIGGER, top: BOUNDS.height - 40 };
    const p = resolveTooltipPosition(nearBottom, TOOLTIP.width, TOOLTIP.height, BOUNDS);
    assert.ok(
      p.top + TOOLTIP.height <= BOUNDS.top + BOUNDS.height,
      `bottom edge ${p.top + TOOLTIP.height} should stay inside ${BOUNDS.top + BOUNDS.height}`,
    );
  });

  it("degrades gracefully when the tooltip is wider than the bounds", () => {
    const p = resolveTooltipPosition(TRIGGER, 2000, TOOLTIP.height, BOUNDS);
    assert.equal(typeof p.left, "number");
    assert.equal(typeof p.top, "number");
  });
});
