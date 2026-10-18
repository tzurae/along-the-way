import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import {
  parseCreateFeedbackResponse,
  type CreateFeedbackInput,
  type CreateFeedbackResponse,
} from "@along-the-way/contracts/admin";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ApiRequestError } from "./api-error";
import { useI18n } from "./i18n";
import "./feedback-dialog.css";


interface RequestOptions extends RequestInit {
  parse?: (value: unknown) => unknown;
}

interface FeedbackDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  prefilledPage: string;
  tripId: string | null;
  request<T>(url: string, options?: RequestOptions): Promise<T>;
}
function unicodeLength(value: string) {
  return Array.from(value).length;
}

function limitUnicodeLength(value: string, maximum: number) {
  return Array.from(value).slice(0, maximum).join("");
}


export function FeedbackDialog({
  open,
  onOpenChange,
  prefilledPage,
  tripId,
  request,
}: FeedbackDialogProps) {
  const { t } = useI18n();
  const bodyHelpId = useId();
  const pageHelpId = useId();
  const formErrorId = useId();
  const submissionSequence = useRef(0);
  const [type, setType] = useState<CreateFeedbackInput["type"]>("bug");
  const [body, setBody] = useState("");
  const [page, setPage] = useState("");
  const [contactAllowed, setContactAllowed] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [bodyError, setBodyError] = useState("");
  const [pageError, setPageError] = useState("");
  const [submitError, setSubmitError] = useState("");
  const bodyLength = unicodeLength(body);

  useEffect(() => {
    if (!open) {
      submissionSequence.current += 1;
      return;
    }
    setType("bug");
    setBody("");
    setPage(limitUnicodeLength(prefilledPage, 200));
    setContactAllowed(true);
    setSubmitting(false);
    setSubmitted(false);
    setBodyError("");
    setPageError("");
    setSubmitError("");
  }, [open, prefilledPage]);

  function validate() {
    const trimmedBodyLength = unicodeLength(body.trim());
    const nextBodyError = trimmedBodyLength < 10
      ? t.feedback.bodyTooShort
      : trimmedBodyLength > 2_000
        ? t.feedback.bodyTooLong
        : "";
    const nextPageError = unicodeLength(page) > 200 ? t.feedback.pageTooLong : "";
    setBodyError(nextBodyError);
    setPageError(nextPageError);
    return !nextBodyError && !nextPageError;
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setSubmitError("");
    if (!validate()) {
      setSubmitError(t.feedback.validationFailed);
      return;
    }
    const sequence = ++submissionSequence.current;

    setSubmitting(true);
    try {
      const input = {
        type,
        body: body.trim(),
        page: page.trim() || null,
        tripId,
        contactAllowed,
        viewport: `${window.innerWidth}×${window.innerHeight}`,
      } satisfies CreateFeedbackInput;
      await request<CreateFeedbackResponse>("/api/feedback", {
        method: "POST",
        body: JSON.stringify(input),
        parse: parseCreateFeedbackResponse,
      });
      if (sequence === submissionSequence.current) setSubmitted(true);
    } catch (error) {
      if (sequence !== submissionSequence.current) return;
      const validationError = error instanceof ApiRequestError
        && (error.status === 400 || error.code === "validation_error");
      if (validationError) setBodyError(t.feedback.validationFailed);
      setSubmitError(
        error instanceof ApiRequestError && (error.status === 429 || error.code === "rate_limited")
          ? t.feedback.rateLimited
          : validationError
            ? t.feedback.validationFailed
            : error instanceof Error
              ? error.message
              : t.errors.unknown,
      );
    } finally {
      if (sequence === submissionSequence.current) setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent placement="sheet" className="feedback-dialog">
        <DialogHeader className="feedback-dialog__header">
          <DialogTitle>{t.feedback.title}</DialogTitle>
          <DialogDescription>{t.feedback.description}</DialogDescription>
        </DialogHeader>

        {submitted ? (
          <div className="feedback-success" role="status" aria-live="polite">
            <strong>{t.feedback.success}</strong>
            <Button type="button" onClick={() => onOpenChange(false)}>{t.feedback.close}</Button>
          </div>
        ) : (
          <form className="feedback-form" onSubmit={(event) => void submit(event)} noValidate>
            <fieldset className="feedback-fieldset">
              <legend>{t.feedback.type}</legend>
              <div className="feedback-type-options">
                {(["bug", "idea", "other"] as const).map((value) => (
                  <label key={value} className={type === value ? "is-selected" : undefined}>
                    <input
                      type="radio"
                      name="feedback-type"
                      value={value}
                      checked={type === value}
                      onChange={() => setType(value)}
                    />
                    <span>{t.feedback.types[value]}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            <label className="feedback-field" htmlFor="feedback-body">
              <span className="feedback-label-row">
                <strong>{t.feedback.body}</strong>
                <span>{t.feedback.bodyCount(bodyLength)}</span>
              </span>
              <Textarea
                id="feedback-body"
                rows={7}
                value={body}
                placeholder={t.feedback.bodyPlaceholder}
                aria-invalid={bodyError ? true : undefined}
                aria-describedby={bodyError ? bodyHelpId : undefined}
                onChange={(event) => {
                  setBody(limitUnicodeLength(event.target.value, 2_000));
                  if (bodyError) setBodyError("");
                  if (submitError) setSubmitError("");
                }}
              />
              {bodyError ? <span id={bodyHelpId} className="feedback-field-error">{bodyError}</span> : null}
            </label>

            <label className="feedback-field" htmlFor="feedback-page">
              <strong>{t.feedback.page}</strong>
              <Input
                id="feedback-page"
                value={page}
                aria-invalid={pageError ? true : undefined}
                aria-describedby={pageError ? pageHelpId : `${pageHelpId}-default`}
                onChange={(event) => {
                  setPage(limitUnicodeLength(event.target.value, 200));
                  if (pageError) setPageError("");
                  if (submitError) setSubmitError("");
                }}
              />
              {pageError
                ? <span id={pageHelpId} className="feedback-field-error">{pageError}</span>
                : <span id={`${pageHelpId}-default`} className="feedback-field-help">{t.feedback.pageHelp}</span>}
            </label>

            <label className="feedback-contact">
              <input
                type="checkbox"
                checked={contactAllowed}
                onChange={(event) => setContactAllowed(event.target.checked)}
              />
              <span>{t.feedback.contactAllowed}</span>
            </label>

            {submitError ? <p id={formErrorId} className="feedback-submit-error" role="alert">{submitError}</p> : null}

            <div className="feedback-actions">
              <Button type="submit" size="lg" disabled={submitting} aria-describedby={submitError ? formErrorId : undefined}>
                {submitting ? t.feedback.submitting : t.feedback.submit}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
