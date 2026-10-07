import { useEffect, useId, useRef, useState } from "react";
import type { ConflictChange } from "@along-the-way/contracts/private-trips";
import { Button } from "@/components/ui/button";
import { ApiRequestError } from "./api-error";
import { useI18n } from "./i18n";

export interface EditSnapshot<T> { input: T; version: number }
export interface VersionConflict<T> {
  base: EditSnapshot<T>;
  current: EditSnapshot<T> | null;
  attempted: T;
  latestChange: ConflictChange | null;
}

export function useVersionConflict<T>() {
  const [conflict, setConflict] = useState<VersionConflict<T> | null>(null);
  const [conflictBaseVersion, setConflictBaseVersion] = useState<number>();
  async function capture(reason: unknown, base: EditSnapshot<T>, attempted: T, load: () => Promise<EditSnapshot<T> | null>) {
    if (!(reason instanceof ApiRequestError) || reason.code !== "conflict" || reason.currentVersion === undefined) return false;
    const current = await load();
    setConflict({ base, current, attempted, latestChange: reason.latestChange ?? null });
    setConflictBaseVersion(base.version);
    return true;
  }
  return {
    conflict, conflictBaseVersion, capture,
    resume: () => setConflict(null),
    clear: () => { setConflict(null); setConflictBaseVersion(undefined); },
  };
}

function flatten(value: unknown, prefix = "", result: Record<string, unknown> = {}) {
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    if (!entries.length) result[prefix] = null;
    for (const [key, entry] of entries) flatten(entry, prefix ? `${prefix}.${key}` : key, result);
  } else result[prefix] = value;
  return result;
}

// These paths are enums in the mutation contracts; all other values are member text.
const enumField = /^(?:type|decision|endpoints\.\d+\.role|constraints\.\d+\.(?:type|status))$/;

export function ConflictPanel<T>({ conflict, busy, onAccept, onReapply, onEdit, formatValue }: {
  conflict: VersionConflict<T>;
  busy: boolean;
  onAccept(): void;
  onReapply(): void;
  onEdit(): void;
  formatValue?(path: string, value: unknown): string | undefined;
}) {
  const { t: { collaboration: t }, locale } = useI18n();
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, [conflict]);
  const values = [flatten(conflict.base.input), flatten(conflict.current?.input ?? {}), flatten(conflict.attempted)];
  const fields = [...new Set(values.flatMap((value) => Object.keys(value)))];
  const differingFields = fields.filter((path) => values.some((value) => value[path] !== values[0]![path]));
  const identicalCount = fields.length - differingFields.length;
  function display(path: string, value: unknown) {
    const formatted = formatValue?.(path, value);
    if (formatted !== undefined) return formatted;
    if (value === null || value === undefined || value === "") return t.empty;
    const text = String(value);
    return enumField.test(path) ? t.values[text] ?? text : text;
  }
  return <section aria-labelledby={id} className="grid gap-4 rounded-xl border border-accent-strong/40 bg-surface-subtle p-4" data-conflict-panel>
    <h3 id={id} ref={heading} tabIndex={-1} className="font-semibold text-lg outline-none">{conflict.latestChange?.isOwn ? t.ownTitle : t.title}</h3>
    <p className="text-sm">{t.description}</p>
    <p className="text-sm [overflow-wrap:anywhere]">{conflict.latestChange ? t.changedBy(conflict.latestChange.actorDisplayName ?? conflict.latestChange.actorEmail, new Date(conflict.latestChange.changedAt).toLocaleString(locale)) : t.unknownChange}</p>
    {conflict.current ? <p className="text-sm">{t.version(conflict.current.version)}</p> : <p role="alert">{t.unavailable}</p>}
    <dl className="grid divide-y divide-ink/10">
      {differingFields.map((path) => <div key={path} className="py-3">
        <dt className="mb-2 font-semibold">{path.split(".").map((key) => /^\d+$/.test(key) ? t.entry(Number(key)) : t.fields[key] ?? t.savedChange).join(" · ")}</dt>
        <dd className="grid gap-3 sm:grid-cols-3">
          {[t.base, t.current, t.attempted].map((label, index) => <div key={label} className={index > 0 && values[index]![path] !== values[0]![path] ? "bg-accent/10 p-2" : "p-2"}>
            <strong className="block text-xs text-muted-foreground">{label}</strong>
            <p className="whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">{display(path, values[index]![path])}</p>
          </div>)}
        </dd>
      </div>)}
    </dl>
    {identicalCount > 0 ? <p className="text-sm text-muted-foreground">{t.identicalFields(identicalCount)}</p> : null}
    <div className="flex flex-wrap gap-2">
      <Button type="button" variant="outline" disabled={busy} onClick={onAccept}>{conflict.current ? t.accept : t.dismiss}</Button>
      <Button type="button" disabled={busy || !conflict.current} onClick={onReapply}>{busy ? t.saving : t.reapply}</Button>
      <Button type="button" variant="outline" disabled={busy || !conflict.current} onClick={onEdit}>{t.edit}</Button>
    </div>
  </section>;
}
