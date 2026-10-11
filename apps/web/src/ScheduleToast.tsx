import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Check } from "lucide-react";

import "./schedule-flow.css";

interface ToastPayload {
  id: number;
  message: string;
  action?: { label: string; href: string };
}

export function useScheduleToast(): {
  toast: ReactNode;
  show(message: string, action?: { label: string; href: string }): void;
} {
  const [payload, setPayload] = useState<ToastPayload | null>(null);
  const [visible, setVisible] = useState(false);
  const nextId = useRef(0);
  const frame = useRef<number | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const removeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimers = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    clearTimeout(hideTimer.current ?? undefined);
    clearTimeout(removeTimer.current ?? undefined);
    frame.current = null;
    hideTimer.current = null;
    removeTimer.current = null;
  }, []);

  useEffect(() => clearTimers, [clearTimers]);

  const show = useCallback((message: string, action?: { label: string; href: string }) => {
    clearTimers();
    setVisible(false);
    const id = ++nextId.current;
    setPayload(action ? { id, message, action } : { id, message });
    frame.current = requestAnimationFrame(() => {
      frame.current = requestAnimationFrame(() => {
        setVisible(true);
        hideTimer.current = setTimeout(() => {
          setVisible(false);
          removeTimer.current = setTimeout(() => setPayload(null), 500);
        }, 4800);
      });
    });
  }, [clearTimers]);

  const toast = payload ? (
    <div
      key={payload.id}
      className={`schedule-toast${visible ? " schedule-toast--visible" : ""}`}
      role="status"
      aria-live="polite"
    >
      <span className="schedule-toast__badge" aria-hidden="true">
        <Check size={18} strokeWidth={3} />
      </span>
      <span className="schedule-toast__message">{payload.message}</span>
      {payload.action ? (
        <a
          className="schedule-toast__action"
          href={payload.action.href}
          tabIndex={visible ? undefined : -1}
        >
          {payload.action.label}
        </a>
      ) : null}
    </div>
  ) : null;

  return { toast, show };
}
