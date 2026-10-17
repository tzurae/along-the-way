import { type FormEvent, useEffect, useRef, useState } from "react";
import {
  parseRapidApiKeysResponse,
  type RapidApiKeysResponse,
} from "@along-the-way/contracts/rapidapi-keys";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ApiRequestError } from "./api-error";
import { useI18n } from "./i18n";

type JsonRequest = <T>(
  url: string,
  options?: RequestInit & { parse?: (value: unknown) => unknown },
) => Promise<T>;

interface RapidApiKeysDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  request: JsonRequest;
}

export function RapidApiKeysDialog({ open, onOpenChange, request }: RapidApiKeysDialogProps) {
  const { t } = useI18n();
  const [keys, setKeys] = useState<RapidApiKeysResponse["keys"] | null>(null);
  const [keyValue, setKeyValue] = useState("");
  const [busy, setBusy] = useState<"add" | number | null>(null);
  const [error, setError] = useState("");
  const dialogEpoch = useRef(0);

  useEffect(() => {
    const epoch = ++dialogEpoch.current;
    if (!open) {
      setKeyValue("");
      setBusy(null);
      return;
    }
    setKeys(null);
    setError("");
    void request<RapidApiKeysResponse>("/api/session/rapidapi-keys", {
      parse: parseRapidApiKeysResponse,
    }).then((response) => {
      if (dialogEpoch.current === epoch) setKeys(response.keys);
    }).catch((reason: unknown) => {
      if (dialogEpoch.current === epoch) {
        setError(reason instanceof Error ? reason.message : t.rapidApiKeys.loadError);
      }
    });
  }, [open, request, t.rapidApiKeys.loadError]);

  async function addKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy !== null || keys === null || keys.length >= 10) return;
    const epoch = dialogEpoch.current;
    setBusy("add");
    setError("");
    try {
      const response = await request<RapidApiKeysResponse>("/api/session/rapidapi-keys", {
        method: "POST",
        body: JSON.stringify({ key: keyValue }),
        parse: parseRapidApiKeysResponse,
      });
      setKeyValue("");
      if (dialogEpoch.current === epoch) setKeys(response.keys);
    } catch (reason) {
      if (dialogEpoch.current === epoch) {
        setError(reason instanceof ApiRequestError && reason.code === "validation_error"
          ? t.rapidApiKeys.invalidKey
          : reason instanceof Error ? reason.message : t.rapidApiKeys.addError);
      }
    } finally {
      if (dialogEpoch.current === epoch) setBusy(null);
    }
  }

  async function deleteKey(position: number, last4: string) {
    if (busy !== null || !window.confirm(t.rapidApiKeys.confirmDelete(position, last4))) return;
    const epoch = dialogEpoch.current;
    setBusy(position);
    setError("");
    try {
      const response = await request<RapidApiKeysResponse>(`/api/session/rapidapi-keys/${position}`, {
        method: "DELETE",
        parse: parseRapidApiKeysResponse,
      });
      if (dialogEpoch.current === epoch) setKeys(response.keys);
    } catch (reason) {
      if (dialogEpoch.current === epoch) {
        setError(reason instanceof ApiRequestError && reason.status === 404
          ? t.rapidApiKeys.missingKey
          : reason instanceof Error ? reason.message : t.rapidApiKeys.deleteError);
      }
    } finally {
      if (dialogEpoch.current === epoch) setBusy(null);
    }
  }

  const full = keys?.length === 10;

  return (
    <Dialog
      open={open}
      disablePointerDismissal={busy !== null}
      onOpenChange={(nextOpen) => { if (nextOpen || busy === null) onOpenChange(nextOpen); }}
    >
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl"
        showCloseButton={busy === null}
      >
        <DialogHeader className="pr-10">
          <DialogTitle>{t.rapidApiKeys.title}</DialogTitle>
          <DialogDescription>{t.rapidApiKeys.description}</DialogDescription>
        </DialogHeader>

        <section className="grid gap-3" aria-labelledby="rapidapi-saved-keys">
          <h3 id="rapidapi-saved-keys" className="font-bold">{t.rapidApiKeys.savedKeys}</h3>
          {keys === null ? (
            <p role="status" className="rounded-lg bg-surface-subtle px-3 py-2 text-muted-foreground">{t.rapidApiKeys.loading}</p>
          ) : keys.length === 0 ? (
            <p className="rounded-lg bg-surface-subtle px-3 py-2 text-muted-foreground">{t.rapidApiKeys.empty}</p>
          ) : (
            <ul className="grid gap-2">
              {keys.map((key) => (
                <li key={key.position} className="flex min-h-12 items-center justify-between gap-3 rounded-lg border border-ink/10 px-3 py-2">
                  <span className="font-medium tabular-nums">{t.rapidApiKeys.keyLabel(key.position, key.last4)}</span>
                  <Button
                    type="button"
                    variant="destructive"
                    className="min-h-11"
                    aria-label={t.rapidApiKeys.deleteLabel(key.position)}
                    disabled={busy !== null}
                    onClick={() => void deleteKey(key.position, key.last4)}
                  >
                    {busy === key.position ? `${t.rapidApiKeys.delete}…` : t.rapidApiKeys.delete}
                  </Button>
                </li>
              ))}
            </ul>
          )}

          <form className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end" onSubmit={(event) => void addKey(event)}>
            <Field>
              <FieldLabel htmlFor="rapidapi-key">{t.rapidApiKeys.newKey}</FieldLabel>
              <Input
                id="rapidapi-key"
                className="h-11"
                type="password"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                required
                minLength={20}
                maxLength={100}
                pattern="[A-Za-z0-9]{20,100}"
                value={keyValue}
                disabled={busy !== null || keys === null || full}
                onChange={(event) => {
                  setKeyValue(event.target.value);
                  setError("");
                }}
              />
            </Field>
            <Button type="submit" className="min-h-11 px-5" disabled={busy !== null || keys === null || full}>
              {busy === "add" ? t.rapidApiKeys.adding : t.rapidApiKeys.add}
            </Button>
          </form>
          {full ? <p className="text-sm text-muted-foreground">{t.rapidApiKeys.maxReached}</p> : null}
          {error ? <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-destructive">{error}</p> : null}
        </section>

        <section className="grid gap-3 border-t border-ink/10 pt-4" aria-labelledby="rapidapi-tutorial">
          <h3 id="rapidapi-tutorial" className="font-bold">{t.rapidApiKeys.tutorialTitle}</h3>
          <ol className="grid list-decimal gap-2 pl-5 leading-6">
            <li>
              {t.rapidApiKeys.tutorial.rapidApiBefore}
              <a className="font-medium underline underline-offset-4" href="https://rapidapi.com" target="_blank" rel="noreferrer">{t.rapidApiKeys.tutorial.rapidApiLink}</a>
              {t.rapidApiKeys.tutorial.rapidApiAfter}
            </li>
            <li>
              {t.rapidApiKeys.tutorial.pricingBefore}
              <a className="font-medium underline underline-offset-4" href="https://rapidapi.com/navitimejapan-navitimejapan/api/navitime-route-totalnavi/pricing" target="_blank" rel="noreferrer">{t.rapidApiKeys.tutorial.pricingLink}</a>
              {t.rapidApiKeys.tutorial.pricingAfter}
            </li>
            <li>
              {t.rapidApiKeys.tutorial.copyBefore}<code className="rounded bg-surface-subtle px-1 py-0.5">X-RapidAPI-Key</code>{t.rapidApiKeys.tutorial.copyAfter}
            </li>
            <li>{t.rapidApiKeys.tutorial.addStep}</li>
          </ol>
          <p className="rounded-lg bg-surface-subtle px-3 py-2 leading-6 text-muted-foreground">
            {t.rapidApiKeys.privacyNote}
          </p>
        </section>
      </DialogContent>
    </Dialog>
  );
}
