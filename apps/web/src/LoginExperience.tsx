import { useEffect, useRef, useState, type FormEvent, type InvalidEvent, type JSX } from "react";

import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { auth } from "./locales/zh-TW/auth";
import "./login-motion.css";

export type AuthProgressPhase = "restoring" | "consuming-link" | "loading-trips";

type ErrorKind = "address" | "form";

interface LoginError {
  kind: ErrorKind;
  message: string;
}

function ProgressMark(): JSX.Element {
  return (
    <svg className="auth-progress-mark" viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="7" />
    </svg>
  );
}

function RouteThread(): JSX.Element {
  return (
    <svg className="auth-route-icon" viewBox="0 0 88 52" aria-hidden="true">
      <path className="auth-route-thread" d="M3 35 C17 35 18 12 34 12 C43 12 43 28 53 28" />
      <path className="auth-route-mark" d="M53 18 H84 V42 H53 Z M53 19 L68.5 31 L84 19 M62 35 L67 40 L77 30" />
    </svg>
  );
}

function AuthFrame({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <main className="auth-page">
      <section className="auth-card" aria-labelledby="auth-title">
        <p className="auth-brand">{auth.brand}</p>
        {children}
      </section>
    </main>
  );
}

export function AuthProgress({ phase }: { phase: AuthProgressPhase }): JSX.Element {
  return (
    <AuthFrame>
      <div className="auth-progress-surface" role="status" aria-live="polite">
        <ProgressMark />
        <h1 id="auth-title" className="auth-title auth-progress-title">
          {auth.progress[phase]}
        </h1>
        <div className="auth-progress-lines" aria-hidden="true">
          <span />
          <span />
        </div>
      </div>
    </AuthFrame>
  );
}

export function LoginExperience(props: {
  initialError?: string | null;
  inviteToken?: string | null;
  requestLink: (email: string, inviteToken: string | null) => Promise<void>;
  describeError: (error: unknown) => string;
}): JSX.Element {
  const [email, setEmail] = useState("");
  const [submittedEmail, setSubmittedEmail] = useState("");
  const [screen, setScreen] = useState<"form" | "sent">("form");
  const [pending, setPending] = useState(false);
  const [resendDeadline, setResendDeadline] = useState<{ email: string; expiresAt: number } | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const [error, setError] = useState<LoginError | null>(() =>
    props.initialError ? { kind: "form", message: props.initialError } : null,
  );
  const emailRef = useRef<HTMLInputElement>(null);
  const errorHeadingRef = useRef<HTMLHeadingElement>(null);
  const sentHeadingRef = useRef<HTMLHeadingElement>(null);
  const focusEmailAfterEdit = useRef(false);

  useEffect(() => {
    if (error?.kind === "form") errorHeadingRef.current?.focus();
  }, [error]);

  useEffect(() => {
    if (screen === "sent") {
      sentHeadingRef.current?.focus();
    } else if (focusEmailAfterEdit.current) {
      focusEmailAfterEdit.current = false;
      emailRef.current?.focus();
    }
  }, [screen]);

  useEffect(() => {
    if (!resendDeadline) return;
    const updateCooldown = () => {
      const remaining = Math.max(0, Math.ceil((resendDeadline.expiresAt - Date.now()) / 1_000));
      setCooldown(remaining);
      if (remaining === 0) {
        setResendDeadline((current) => current === resendDeadline ? null : current);
      }
    };
    updateCooldown();
    const timer = window.setInterval(updateCooldown, 1_000);
    return () => window.clearInterval(timer);
  }, [resendDeadline]);

  async function sendLink(address: string) {
    if (pending) return;
    if (resendDeadline?.email === address && resendDeadline.expiresAt > Date.now()) {
      setCooldown(Math.ceil((resendDeadline.expiresAt - Date.now()) / 1_000));
      return;
    }
    setPending(true);
    setError(null);
    try {
      await props.requestLink(address, props.inviteToken ?? null);
      const expiresAt = Date.now() + 60_000;
      setSubmittedEmail(address);
      setResendDeadline({ email: address, expiresAt });
      setCooldown(60);
      setScreen("sent");
    } catch (requestError) {
      setError({ kind: "form", message: props.describeError(requestError) });
    } finally {
      setPending(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await sendLink(email);
  }

  function handleInvalid(event: InvalidEvent<HTMLInputElement>) {
    const message = event.currentTarget.validity.valueMissing
      ? auth.emailRequired
      : auth.emailInvalid;
    setError({ kind: "address", message });
  }

  function editEmail() {
    focusEmailAfterEdit.current = true;
    setScreen("form");
    setError(null);
  }

  const addressErrorId = error?.kind === "address" ? "auth-email-error" : undefined;
  const sameAddressCoolingDown = resendDeadline?.email === email && cooldown > 0;

  return (
    <AuthFrame>
      <h1 id="auth-title" className="auth-title">{auth.heading}</h1>
      <p className="auth-intro">{auth.intro}</p>
      <p className="auth-private-note">{auth.privateSpace}</p>

      <div className="auth-stage" data-screen={screen}>
        {screen === "form" ? (
          <form className="auth-form" onSubmit={submit} noValidate={false}>
            <Field data-invalid={error?.kind === "address" || undefined}>
              <FieldLabel htmlFor="auth-email">{auth.email}</FieldLabel>
              <Input
                ref={emailRef}
                id="auth-email"
                className="auth-email-input"
                type="email"
                required
                autoComplete="email"
                value={email}
                disabled={pending}
                aria-invalid={error?.kind === "address" || undefined}
                aria-describedby={addressErrorId}
                onInvalid={handleInvalid}
                onChange={(event) => {
                  setEmail(event.target.value);
                  if (error?.kind === "address") setError(null);
                }}
              />
              <FieldDescription className="sr-only">{auth.intro}</FieldDescription>
            </Field>

            <Button className="auth-submit" size="lg" type="submit" disabled={pending || sameAddressCoolingDown}>
              <span className="auth-button-content" key={pending ? "pending" : sameAddressCoolingDown ? cooldown : "idle"}>
                {pending ? <ProgressMark /> : null}
                {pending ? auth.requestingLink : sameAddressCoolingDown ? auth.resendAfter(cooldown) : auth.requestLink}
              </span>
            </Button>

            <div className="auth-outcome-slot">
              {error ? (
                <div
                  id={error.kind === "address" ? "auth-email-error" : "auth-form-error"}
                  className="auth-error"
                  role="alert"
                >
                  <h2 ref={errorHeadingRef} className="auth-outcome-heading" tabIndex={-1}>
                    {error.message}
                  </h2>
                </div>
              ) : null}
            </div>
          </form>
        ) : (
          <div className="auth-sent">
            <div className="auth-sent-outcome" role="status" aria-live="polite">
              <RouteThread />
              <h2 ref={sentHeadingRef} className="auth-sent-heading" tabIndex={-1}>
                {auth.sentHeading}
              </h2>
              <p className="auth-sent-message">{auth.sentMessage(submittedEmail)}</p>
              <p className="auth-private-note">{auth.invitedOnly}</p>
            </div>
            <div className="auth-sent-actions">
              <Button type="button" variant="link" onClick={editEmail} disabled={pending}>
                {auth.editEmail}
              </Button>
              <Button
                className="auth-resend"
                type="button"
                variant="outline"
                disabled={pending || cooldown > 0}
                onClick={() => void sendLink(submittedEmail)}
              >
                <span className="auth-button-content" key={pending ? "resending" : cooldown}>
                  {pending ? <ProgressMark /> : null}
                  {pending
                    ? auth.requestingLink
                    : cooldown > 0
                      ? auth.resendAfter(cooldown)
                      : auth.resend}
                </span>
              </Button>
            </div>
            <div className="auth-outcome-slot auth-sent-error-slot">
              {error ? (
                <div id="auth-form-error" className="auth-error" role="alert">
                  <h2 ref={errorHeadingRef} className="auth-outcome-heading" tabIndex={-1}>
                    {error.message}
                  </h2>
                </div>
              ) : null}
            </div>
          </div>
        )}
      </div>
    </AuthFrame>
  );
}
