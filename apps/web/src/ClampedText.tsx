import { useId, useLayoutEffect, useState, type CSSProperties } from "react";

import "./clamped-text.css";

/**
 * Free text cut to `lines` lines, with a toggle shown only when the text really is longer.
 * Expansion is per mount; nothing is persisted.
 */
export function ClampedText({ text, lines, expandLabel, collapseLabel, className }: {
  text: string;
  lines: number;
  expandLabel: string;
  collapseLabel: string;
  className?: string;
}) {
  const id = useId();
  const [element, setElement] = useState<HTMLParagraphElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  useLayoutEffect(() => {
    // Only the clamped box can tell whether text is hidden; while expanded the toggle must stay
    // so the reader can collapse again, and collapsing re-measures.
    if (!element || expanded) return;
    const measure = () => setOverflowing(element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element, text, lines, expanded]);

  return <>
    <p
      ref={setElement}
      id={id}
      className={className ? `clamped-text ${className}` : "clamped-text"}
      data-expanded={expanded}
      data-overflowing={overflowing}
      style={{ "--clamped-text-lines": lines } as CSSProperties}
    >{text}</p>
    {overflowing ? <button
      type="button"
      className="clamped-text__toggle"
      aria-expanded={expanded}
      aria-controls={id}
      onClick={() => setExpanded((current) => !current)}
    >{expanded ? collapseLabel : expandLabel}</button> : null}
  </>;
}
