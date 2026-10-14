import { Children, isValidElement, useLayoutEffect, useRef, type ReactNode } from "react";

interface FlipListProps {
  className: string;
  ariaLabel: string;
  /** Keyed rows; each child must render exactly one DOM element. */
  children: ReactNode;
}

const EASE_OUT_EXPO = "cubic-bezier(0.16, 1, 0.3, 1)";

/**
 * List container that slides rows from their old to their new position when the row order
 * changes (FLIP: measure before, render, invert with a transform, play to zero). Reduced motion
 * replaces the slide with a short fade on moved rows so the reorder is still noticeable.
 */
export function FlipList({ className, ariaLabel, children }: FlipListProps) {
  const container = useRef<HTMLDivElement>(null);
  const positions = useRef(new Map<string, number>());
  const keys = Children.toArray(children).map((child) => (isValidElement(child) ? String(child.key) : ""));
  const orderKey = keys.join("|");
  const previousOrderKey = useRef(orderKey);

  // Runs after every render so positions stay current when heights change without a reorder
  // (photos loading, text wrapping); only an order change animates.
  useLayoutEffect(() => {
    const root = container.current;
    if (!root) return;
    const rows = [...root.children] as HTMLElement[];
    if (rows.length !== keys.length) {
      positions.current = new Map();
      previousOrderKey.current = orderKey;
      return;
    }
    const reorder = previousOrderKey.current !== orderKey;
    const reduced = reorder && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const next = new Map<string, number>();
    rows.forEach((row, index) => {
      const key = keys[index]!;
      // offsetTop is relative to the list, so page scroll between renders is not mistaken for movement.
      const top = row.offsetTop;
      next.set(key, top);
      const previous = positions.current.get(key);
      if (!reorder || previous === undefined || Math.abs(previous - top) < 1 || typeof row.animate !== "function") return;
      row.animate(
        reduced
          ? [{ opacity: 0.5 }, { opacity: 1 }]
          : [{ transform: `translateY(${previous - top}px)` }, { transform: "translateY(0)" }],
        { duration: reduced ? 200 : 420, easing: EASE_OUT_EXPO },
      );
    });
    positions.current = next;
    previousOrderKey.current = orderKey;
  });

  return <div ref={container} className={className} aria-label={ariaLabel}>{children}</div>;
}
