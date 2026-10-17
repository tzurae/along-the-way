import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, TriangleAlert } from "lucide-react";

import "./schedule-flow.css";

type ToastTone = "success" | "error";
interface ToastPayload { id: number; tone: ToastTone; message: string }

const EVENT = "atw-toast";

/** Shows a success or error message as a toast, wherever the page is scrolled. */
export function notify(tone: ToastTone, message: string) {
  if (!message) return;
  window.dispatchEvent(new CustomEvent<Omit<ToastPayload, "id">>(EVENT, { detail: { tone, message } }));
}

/** Mounted once by the app shell; the newest message replaces the previous one. */
export function AppToaster() {
  const [payload, setPayload] = useState<ToastPayload | null>(null);
  const [visible, setVisible] = useState(false);
  const nextId = useRef(0);
  const timers = useRef<Array<ReturnType<typeof setTimeout>>>([]);

  const clearTimers = () => { timers.current.forEach(clearTimeout); timers.current = []; };
  // Fade out, then unmount so the hidden Close button and stale live region leave the tab order and accessibility tree.
  const hide = () => {
    clearTimers();
    setVisible(false);
    timers.current.push(setTimeout(() => setPayload(null), 500));
  };

  useEffect(() => {
    const show = (event: Event) => {
      const { tone, message } = (event as CustomEvent<Omit<ToastPayload, "id">>).detail;
      clearTimers();
      setVisible(false);
      setPayload({ id: ++nextId.current, tone, message });
      timers.current.push(setTimeout(() => setVisible(true), 20));
      // Errors stay longer: they usually need reading and acting on.
      timers.current.push(setTimeout(hide, tone === "error" ? 8000 : 4000));
    };
    window.addEventListener(EVENT, show);
    return () => { clearTimers(); window.removeEventListener(EVENT, show); };
  }, []);

  if (!payload) return null;
  // Portalled to <body> after any open dialog so it is drawn above the dialog and its backdrop.
  return createPortal(
    <div
      key={payload.id}
      className={`schedule-toast app-toast app-toast--${payload.tone}${visible ? " schedule-toast--visible" : ""}`}
      role={payload.tone === "error" ? "alert" : "status"}
      aria-live={payload.tone === "error" ? "assertive" : "polite"}
    >
      <span className="schedule-toast__badge" aria-hidden="true">
        {payload.tone === "error" ? <TriangleAlert size={18} strokeWidth={2.5} /> : <Check size={18} strokeWidth={3} />}
      </span>
      <span className="schedule-toast__message">{payload.message}</span>
      <button type="button" className="schedule-toast__action" onClick={hide}>關閉</button>
    </div>,
    document.body,
  );
}
