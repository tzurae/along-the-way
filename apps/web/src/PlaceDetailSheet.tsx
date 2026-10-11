import { useCallback, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { X } from "lucide-react";

import { Dialog, DialogContent, DialogTitle } from "./components/ui/dialog";
import { useI18n } from "./i18n";
import "./place-detail.css";

export interface PlaceDetailSheetProps {
  open: boolean;
  title: ReactNode;
  description?: ReactNode;
  onClose(): void;
  titleRef?: RefObject<HTMLHeadingElement | null>;
  children: ReactNode;
  footer?: ReactNode;
  /** Surface variant hook; both variants share the approved responsive sheet shell. */
  appearance?: "photo" | "workspace";
}

export function PlaceDetailSheet({ open, title, description, onClose, titleRef, children, footer, appearance = "photo" }: PlaceDetailSheetProps) {
  const internalTitleRef = useRef<HTMLHeadingElement | null>(null);
  const headingRef = titleRef ?? internalTitleRef;
  const { t } = useI18n();
  const [headingElement, setHeadingElement] = useState<HTMLHeadingElement | null>(null);
  const [titleClamped, setTitleClamped] = useState(false);
  const titleReference = useCallback((heading: HTMLHeadingElement | null) => {
    headingRef.current = heading;
    setHeadingElement(heading);
  }, [headingRef]);
  useLayoutEffect(() => {
    if (!open || !headingElement) return;
    const measure = () => setTitleClamped(headingElement.scrollHeight > headingElement.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(headingElement);
    return () => observer.disconnect();
  }, [open, title, headingElement]);

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }}>
      <DialogContent className="place-detail-sheet translate-x-0 translate-y-0" data-appearance={appearance} initialFocus={headingRef} showCloseButton={false}>
        <div className="place-detail-sheet__grab" aria-hidden="true" />
        <header className="place-detail-sheet__head" data-has-description={description != null}>
          <div className="place-detail-sheet__heading">
            <DialogTitle ref={titleReference} tabIndex={-1} className="place-detail-sheet__title">{title}</DialogTitle>
            {description != null ? <div className="place-detail-sheet__description">{description}</div> : null}
          </div>
          <button type="button" className="place-detail-sheet__close" aria-label={t.app.close} onClick={onClose}>
            <X aria-hidden="true" className="size-5" />
          </button>
        </header>
        <div className="place-detail-sheet__body" data-place-detail-scroll>
          {titleClamped ? <p className="place-detail-sheet__full-title">{title}</p> : null}
          {children}
        </div>
        {footer ? <footer className="place-detail-sheet__footer">{footer}</footer> : null}
      </DialogContent>
    </Dialog>
  );
}
