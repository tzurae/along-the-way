import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import {
  parseCreatePhotoFeedbackResponse,
  type CreatePhotoFeedbackInput,
  type CreatePhotoFeedbackResponse,
  type PhotoFeedbackReason,
} from "@along-the-way/contracts/admin";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { ApiRequestError } from "./api-error";
import { useI18n } from "./i18n";
import "./feedback-dialog.css";

interface RequestOptions extends RequestInit {
  parse?: (value: unknown) => unknown;
}

interface PhotoFeedbackDialogProps {
  open: boolean;
  tripId: string;
  tripPlaceId: string;
  onOpenChange(open: boolean): void;
  request<T>(url: string, options?: RequestOptions): Promise<T>;
}

const reasons: PhotoFeedbackReason[] = ["wrong_place", "poor_quality", "other"];


export function PhotoFeedbackDialog({
  open,
  tripId,
  tripPlaceId,
  onOpenChange,
  request,
}: PhotoFeedbackDialogProps) {
  const { t } = useI18n();
  const reasonErrorId = useId();
  const submitErrorId = useId();
  const submissionSequence = useRef(0);
  const [reason, setReason] = useState<PhotoFeedbackReason | null>(null);
  const [note, setNote] = useState("");
  const [reasonError, setReasonError] = useState("");
  const [submitError, setSubmitError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const noteLength = Array.from(note).length;

  useEffect(() => {
    submissionSequence.current += 1;
    if (!open) return;
    setReason(null);
    setNote("");
    setReasonError("");
    setSubmitError("");
    setSubmitting(false);
    setSubmitted(false);
  }, [open, tripPlaceId]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    if (!reason) {
      setReasonError(t.feedback.photo.reasonRequired);
      return;
    }
    const sequence = ++submissionSequence.current;
    setSubmitting(true);
    setSubmitError("");
    const input = {
      reason,
      note: note.trim() || null,
    } satisfies CreatePhotoFeedbackInput;
    try {
      await request<CreatePhotoFeedbackResponse>(
        `/api/trips/${encodeURIComponent(tripId)}/trip-places/${encodeURIComponent(tripPlaceId)}/photo-feedback`,
        {
          method: "POST",
          body: JSON.stringify(input),
          parse: parseCreatePhotoFeedbackResponse,
        },
      );
      if (sequence === submissionSequence.current) setSubmitted(true);
    } catch (error) {
      if (sequence !== submissionSequence.current) return;
      setSubmitError(
        error instanceof ApiRequestError && (error.status === 429 || error.code === "rate_limited")
          ? t.feedback.photo.rateLimited
          : t.feedback.photo.submitError,
      );
    } finally {
      if (sequence === submissionSequence.current) setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent placement="sheet" className="feedback-dialog photo-feedback-dialog">
        <DialogHeader className="feedback-dialog__header">
          <DialogTitle>{t.feedback.photo.title}</DialogTitle>
          <DialogDescription>{t.feedback.photo.description}</DialogDescription>
        </DialogHeader>

        {submitted ? (
          <div className="feedback-success" role="status" aria-live="polite">
            <strong>{t.feedback.photo.success}</strong>
            <Button type="button" onClick={() => onOpenChange(false)}>{t.feedback.photo.close}</Button>
          </div>
        ) : (
          <form className="feedback-form" onSubmit={(event) => void submit(event)} noValidate>
            <fieldset className="feedback-fieldset" aria-describedby={reasonError ? reasonErrorId : undefined}>
              <legend>{t.feedback.photo.reason}</legend>
              <div className="feedback-type-options">
                {reasons.map((value) => (
                  <label key={value} className={reason === value ? "is-selected" : undefined}>
                    <input
                      type="radio"
                      name="photo-feedback-reason"
                      value={value}
                      checked={reason === value}
                      onChange={() => {
                        setReason(value);
                        setReasonError("");
                        setSubmitError("");
                      }}
                    />
                    <span>{t.feedback.photo.reasons[value]}</span>
                  </label>
                ))}
              </div>
              {reasonError ? <span id={reasonErrorId} className="feedback-field-error" role="alert">{reasonError}</span> : null}
            </fieldset>

            <label className="feedback-field" htmlFor="photo-feedback-note">
              <span className="feedback-label-row">
                <strong>{t.feedback.photo.note}</strong>
                <span>{t.feedback.photo.noteCount(noteLength)}</span>
              </span>
              <Textarea
                id="photo-feedback-note"
                rows={5}
                value={note}
                placeholder={t.feedback.photo.notePlaceholder}
                onChange={(event) => {
                  setNote(Array.from(event.target.value).slice(0, 500).join(""));
                  setSubmitError("");
                }}
              />
            </label>

            {submitError ? <p id={submitErrorId} className="feedback-submit-error" role="alert">{submitError}</p> : null}

            <div className="feedback-actions">
              <Button type="submit" size="lg" disabled={submitting} aria-describedby={submitError ? submitErrorId : undefined}>
                {submitting ? t.feedback.photo.submitting : t.feedback.photo.submit}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
