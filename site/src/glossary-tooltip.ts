/**
 * Hover/focus tooltip for auto-linked glossary Terms (stamped by
 * `rehypeGlossaryTooltips` in `glossary-link.ts`).
 *
 * The tooltip is a single `position: fixed` element appended to `<body>`, so
 * no ancestor `overflow` can clip it — it is positioned explicitly and
 * clamped to the visible article area (`resolveTooltipPosition`), which keeps
 * it inside the article column (never over the sidebar) and within the
 * viewport top/bottom. The card is always fully opaque (`opacity: 1`, solid
 * `--color-fd-popover`); it appears with a 300ms hover/focus dwell and hides
 * immediately.
 *
 * The placement math is pure and unit-testable in isolation
 * (`resolveTooltipPosition`); the DOM glue in `createGlossaryTooltip` stays
 * deliberately thin.
 */

/** Dwell before the tooltip appears (ms). */
export const TOOLTIP_DELAY_MS = 300;

/** Gap between the trigger link and the tooltip (px). */
export const TOOLTIP_GAP_PX = 8;

export interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface TooltipPlacement {
  /** `left` for a `position: fixed` element (viewport px). */
  left: number;
  /** `top` for a `position: fixed` element (viewport px). */
  top: number;
  /** Whether the tooltip sits above the trigger (else below). */
  above: boolean;
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

/**
 * Place a `tooltipWidth × tooltipHeight` tooltip for `trigger` inside
 * `bounds` (pixel boxes, viewport-relative). Prefers floating above the
 * trigger; flips below when the above position would overflow `bounds.top`.
 * Horizontal centering (and both axes) are clamped into `bounds` so the
 * tooltip stays fully on-screen.
 */
export function resolveTooltipPosition(
  trigger: Box,
  tooltipWidth: number,
  tooltipHeight: number,
  bounds: Box,
  gap = TOOLTIP_GAP_PX,
): TooltipPlacement {
  const above = trigger.top - gap - tooltipHeight >= bounds.top;
  const left = clamp(
    trigger.left + trigger.width / 2 - tooltipWidth / 2,
    bounds.left,
    bounds.left + Math.max(0, bounds.width - tooltipWidth),
  );
  const top = clamp(
    above ? trigger.top - gap - tooltipHeight : trigger.top + trigger.height + gap,
    bounds.top,
    bounds.top + Math.max(0, bounds.height - tooltipHeight),
  );
  return { left, top, above };
}

function boxOf(rect: { top: number; left: number; width: number; height: number }): Box {
  return { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
}

function intersect(a: Box, b: Box): Box {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.left + a.width, b.left + b.width);
  const bottom = Math.min(a.top + a.height, b.top + b.height);
  return {
    left,
    top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

export interface GlossaryTooltipResult {
  /** Remove the DOM element and all listeners. */
  destroy(): void;
}

/**
 * Wire up tooltip behavior. Creates one `<div class="glossary-tooltip">` on
 * `doc.body`, then shows it (after `TOOLTIP_DELAY_MS`) for
 * `a[data-glossary-term]` links on pointer hover, and immediately on
 * keyboard focus; hides on leave, scroll (capture), and resize. Uses event
 * delegation so it keeps working as pages change.
 */
export function createGlossaryTooltip(
  doc: Document = document,
  win: Window = window,
): GlossaryTooltipResult {
  const el = doc.createElement("div");
  el.className = "glossary-tooltip";
  el.setAttribute("role", "tooltip");
  (doc.body ?? doc.documentElement).appendChild(el);

  let timer: ReturnType<typeof win.setTimeout> | undefined;
  let shown: Element | null = null;

  const visibleBounds = (): Box => {
    const viewport: Box = {
      top: 0,
      left: 0,
      width: win.innerWidth,
      height: win.innerHeight,
    };
    const article = doc.querySelector(".prose") ?? doc.querySelector("main");
    if (!article) return viewport;
    return intersect(boxOf(article.getBoundingClientRect()), viewport);
  };

  const render = (link: Element): void => {
    const term = link.getAttribute("data-glossary-term") ?? "";
    const def = link.getAttribute("data-glossary-def") ?? "";
    el.textContent = def ? `${term} — ${def}` : term;
    const width = el.offsetWidth;
    const height = el.offsetHeight;
    const placement = resolveTooltipPosition(
      boxOf(link.getBoundingClientRect()),
      width,
      height,
      visibleBounds(),
    );
    el.style.left = `${placement.left}px`;
    el.style.top = `${placement.top}px`;
    el.classList.add("glossary-tooltip--visible");
    shown = link;
  };

  const hide = (): void => {
    if (timer !== undefined) {
      win.clearTimeout(timer);
      timer = undefined;
    }
    el.classList.remove("glossary-tooltip--visible");
    shown = null;
  };

  const arm = (link: Element): void => {
    if (timer !== undefined) win.clearTimeout(timer);
    if (shown === link) return;
    timer = win.setTimeout(() => {
      timer = undefined;
      render(link);
    }, TOOLTIP_DELAY_MS);
  };

  const onPointerOver = (event: Event): void => {
    const target = event.target as Element | null;
    const link = target?.closest("a[data-glossary-term]") ?? null;
    if (link) {
      arm(link);
    } else {
      hide();
    }
  };
  const onPointerOut = (event: Event): void => {
    const next = event.relatedTarget as Element | null;
    if (!next?.closest("a[data-glossary-term]")) hide();
  };
  const onFocusIn = (event: Event): void => {
    const link = (event.target as Element | null)?.closest("a[data-glossary-term]") ?? null;
    if (!link) return;
    if (timer !== undefined) win.clearTimeout(timer);
    render(link);
  };
  const onFocusOut = (event: Event): void => {
    const next = event.relatedTarget as Element | null;
    if (!next?.closest("a[data-glossary-term]")) hide();
  };
  const onScrollOrResize = (): void => hide();

  doc.addEventListener("pointerover", onPointerOver, true);
  doc.addEventListener("pointerout", onPointerOut, true);
  doc.addEventListener("focusin", onFocusIn);
  doc.addEventListener("focusout", onFocusOut);
  win.addEventListener("scroll", onScrollOrResize, true);
  win.addEventListener("resize", onScrollOrResize);

  return {
    destroy(): void {
      doc.removeEventListener("pointerover", onPointerOver, true);
      doc.removeEventListener("pointerout", onPointerOut, true);
      doc.removeEventListener("focusin", onFocusIn);
      doc.removeEventListener("focusout", onFocusOut);
      win.removeEventListener("scroll", onScrollOrResize, true);
      win.removeEventListener("resize", onScrollOrResize);
      if (timer !== undefined) win.clearTimeout(timer);
      el.remove();
    },
  };
}
