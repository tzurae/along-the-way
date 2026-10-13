import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { Check, Pencil, Plus, Trash2 } from "lucide-react";

import {
  parseTripPlaceMustItemListResponse,
  parseTripPlaceMustItemResponse,
  type MustItemKind,
  type TripPlaceMustItemDto,
  type TripPlaceMustItemListResponse,
  type TripPlaceMustItemResponse,
} from "@along-the-way/contracts/trip-places";
import { ApiRequestError } from "./api-error";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./components/ui/dialog";

interface RequestOptions extends RequestInit {
  parse?: (value: unknown) => unknown;
}

interface PlaceMustItemsProps {
  tripId: string;
  tripPlaceId: string;
  request<T>(url: string, options?: RequestOptions): Promise<T>;
  editable?: boolean;
  revision?: number;
  onChanged?(): void;
  onDirtyChange?(dirty: boolean): void;
  wishlistHref?: string;
}

export interface PlaceMustItemsHandle {
  requestClose(onDiscard: () => void): boolean;
}

type EditorState = {
  mode: "create" | "edit";
  item: TripPlaceMustItemDto | null;
  kind: MustItemKind;
  label: string;
  dirty: boolean;
  deleting: boolean;
  conflictLatest: TripPlaceMustItemDto | null | undefined;
};

const kinds: MustItemKind[] = ["buy", "eat", "drink"];
const kindLabels: Record<MustItemKind, string> = {
  buy: "必買",
  eat: "必吃",
  drink: "必喝",
};

export const PlaceMustItems = forwardRef<PlaceMustItemsHandle, PlaceMustItemsProps>(function PlaceMustItems({
  tripId,
  tripPlaceId,
  request,
  editable = true,
  revision = 0,
  onChanged,
  onDirtyChange,
  wishlistHref,
}, ref) {
  const [items, setItems] = useState<TripPlaceMustItemDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const [discardOpen, setDiscardOpen] = useState(false);
  const discardAction = useRef<(() => void) | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<HTMLFormElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const editRefs = useRef(new Map<string, HTMLButtonElement>());
  const pendingFocus = useRef<"add" | { itemId: string } | null>(null);
  const loadGeneration = useRef(0);
  const retryKeys = useRef(new Map<string, { fingerprint: string; key: string }>());

  const endpoint = `/api/trips/${encodeURIComponent(tripId)}/trip-places/${encodeURIComponent(tripPlaceId)}/must-items`;

  const loadItems = useCallback(async () => {
    const generation = ++loadGeneration.current;
    try {
      const response = await request<TripPlaceMustItemListResponse>(endpoint, { parse: parseTripPlaceMustItemListResponse });
      if (generation !== loadGeneration.current) return null;
      const next = response.items;
      setItems(next);
      setLoadError(false);
      return next;
    } catch {
      if (generation === loadGeneration.current) setLoadError(true);
      return null;
    } finally {
      if (generation === loadGeneration.current) setLoading(false);
    }
  }, [endpoint, request]);

  useEffect(() => {
    setLoading(true);
    void loadItems();
  }, [loadItems, revision]);

  useEffect(() => {
    onDirtyChange?.(Boolean(editor?.dirty));
  }, [editor?.dirty, onDirtyChange]);

  useEffect(() => {
    if (!editor) return;
    const input = inputRef.current;
    input?.focus();
    let frame: number | null = null;
    const revealEditor = () => {
      const scroller = editorRef.current?.closest<HTMLElement>("[data-place-detail-scroll]");
      const actions = actionsRef.current;
      if (!scroller || !input || !actions) return;
      const scrollBox = scroller.getBoundingClientRect();
      const viewport = window.visualViewport;
      const viewportTop = viewport?.offsetTop ?? 0;
      const viewportBottom = viewport ? viewport.offsetTop + viewport.height : window.innerHeight;
      const footerTop = scroller.parentElement?.querySelector<HTMLElement>(".place-detail-sheet__footer")?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY;
      const visibleTop = Math.max(scrollBox.top, viewportTop) + 12;
      const visibleBottom = Math.min(scrollBox.bottom, viewportBottom, footerTop) - 12;
      const inputTop = input.getBoundingClientRect().top - scrollBox.top + scroller.scrollTop;
      const actionsBottom = actions.getBoundingClientRect().bottom - scrollBox.top + scroller.scrollTop;
      const minimumScroll = actionsBottom - (visibleBottom - scrollBox.top);
      const maximumScroll = inputTop - (visibleTop - scrollBox.top);
      const nextScroll = minimumScroll <= maximumScroll
        ? Math.min(Math.max(scroller.scrollTop, minimumScroll), maximumScroll)
        : minimumScroll;
      scroller.scrollTo({ top: Math.max(0, nextScroll), left: 0, behavior: "auto" });
    };
    const scheduleReveal = () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(revealEditor);
    };
    scheduleReveal();
    window.addEventListener("resize", scheduleReveal);
    window.visualViewport?.addEventListener("resize", scheduleReveal);
    window.visualViewport?.addEventListener("scroll", scheduleReveal);
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", scheduleReveal);
      window.visualViewport?.removeEventListener("resize", scheduleReveal);
      window.visualViewport?.removeEventListener("scroll", scheduleReveal);
    };
  }, [editor?.item?.id, editor?.mode]);

  useEffect(() => {
    const target = pendingFocus.current;
    if (!target) return;
    const element = target === "add" ? addRef.current : editRefs.current.get(target.itemId);
    if (!element) return;
    pendingFocus.current = null;
    element.focus();
  });

  useImperativeHandle(ref, () => ({
    requestClose(onDiscard) {
      if (!editor?.dirty) return true;
      discardAction.current = onDiscard;
      setDiscardOpen(true);
      return false;
    },
  }), [editor?.dirty]);

  function retryKey(operation: string, payload: unknown) {
    const fingerprint = JSON.stringify(payload);
    const current = retryKeys.current.get(operation);
    if (current?.fingerprint === fingerprint) return current.key;
    const key = crypto.randomUUID();
    retryKeys.current.set(operation, { fingerprint, key });
    return key;
  }

  function closeEditor(focus: "trigger" | "add" | { itemId: string }) {
    if (focus === "add" || (focus === "trigger" && editor?.mode === "create")) {
      pendingFocus.current = "add";
    } else if (focus === "trigger" && editor?.item) {
      pendingFocus.current = { itemId: editor.item.id };
    } else if (typeof focus === "object") {
      pendingFocus.current = focus;
    }
    setEditor(null);
    setError("");
  }

  function beginCreate() {
    if (!editable || items.length >= 24) return;
    setError("");
    setEditor({ mode: "create", item: null, kind: "buy", label: "", dirty: false, deleting: false, conflictLatest: undefined });
  }

  function beginEdit(item: TripPlaceMustItemDto) {
    if (!editable) return;
    setError("");
    setEditor({ mode: "edit", item, kind: item.kind, label: item.label, dirty: false, deleting: false, conflictLatest: undefined });
  }

  function changeDraft(change: Partial<Pick<EditorState, "kind" | "label">>) {
    setEditor((current) => current ? { ...current, ...change, dirty: true, deleting: false, conflictLatest: undefined } : null);
    setError("");
  }

  async function latestFor(itemId: string) {
    const latest = await loadItems();
    return latest?.find((item) => item.id === itemId) ?? null;
  }

  async function captureConflict(current: EditorState) {
    const latest = current.item ? await latestFor(current.item.id) : null;
    setEditor((value) => value ? { ...value, conflictLatest: latest } : value);
    setError("其他成員剛改過這個項目");
    setAnnouncement("其他成員剛改過這個項目");
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editor || busy) return;
    const label = editor.label.trim();
    if (!label) {
      setError("請輸入項目名稱");
      inputRef.current?.focus();
      return;
    }
    if (Array.from(label).length > 80) {
      setError("名稱最多 80 個字");
      inputRef.current?.focus();
      return;
    }
    setBusy(true);
    setError("");
    const payload = editor.mode === "create"
      ? { kind: editor.kind, label }
      : { kind: editor.kind, label, expectedVersion: editor.item!.version };
    const operation = editor.mode === "create" ? `create:${tripPlaceId}` : `update:${editor.item!.id}`;
    try {
      const response = await request<TripPlaceMustItemResponse>(
        editor.mode === "create" ? endpoint : `${endpoint}/${encodeURIComponent(editor.item!.id)}`,
        {
          method: editor.mode === "create" ? "POST" : "PATCH",
          headers: { "Idempotency-Key": retryKey(operation, payload) },
          body: JSON.stringify(payload),
          parse: parseTripPlaceMustItemResponse,
        },
      );
      retryKeys.current.delete(operation);
      const saved = response.item;
      setItems((current) => editor.mode === "create"
        ? [...current, saved]
        : current.map((item) => item.id === saved.id ? saved : item));
      setAnnouncement(editor.mode === "create" ? `已新增『${saved.label}』` : `已更新『${saved.label}』`);
      closeEditor({ itemId: saved.id });
      onChanged?.();
    } catch (reason) {
      if (reason instanceof ApiRequestError && reason.code === "must_item_duplicate") {
        setError("這個項目已經在清單裡了");
      } else if (reason instanceof ApiRequestError && reason.code === "must_item_limit") {
        setError("每個地點最多 24 項");
        await loadItems();
      } else if (reason instanceof ApiRequestError && reason.code === "validation_error" && Array.from(label).length > 80) {
        setError("名稱最多 80 個字");
      } else if (reason instanceof ApiRequestError && reason.code === "conflict" && editor.mode === "edit") {
        await captureConflict(editor);
      } else {
        setError("沒有儲存成功，請再試一次");
      }
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!editor?.item || busy) return;
    setBusy(true);
    setError("");
    const item = editor.item;
    const payload = { expectedVersion: item.version };
    const operation = `delete:${item.id}`;
    try {
      await request(`${endpoint}/${encodeURIComponent(item.id)}`, {
        method: "DELETE",
        headers: { "Idempotency-Key": retryKey(operation, payload) },
        body: JSON.stringify(payload),
      });
      retryKeys.current.delete(operation);
      setItems((current) => current.filter((candidate) => candidate.id !== item.id));
      setAnnouncement(`已移除『${item.label}』`);
      closeEditor("add");
      onChanged?.();
    } catch (reason) {
      if (reason instanceof ApiRequestError && reason.code === "conflict") await captureConflict(editor);
      else setError("沒有儲存成功，請再試一次");
    } finally {
      setBusy(false);
    }
  }

  function editorForm() {
    if (!editor) return null;
    return (
      <form ref={editorRef} className="must-items__editor" onSubmit={save} data-must-item-editor>
        <fieldset className="must-items__kinds">
          <legend>類別</legend>
          <div className="must-items__radio-group">
            {kinds.map((kind) => {
              const selected = editor.kind === kind;
              return (
                <label key={kind} className="must-items__radio" data-selected={selected || undefined}>
                  <input type="radio" name="must-item-kind" value={kind} checked={selected} onChange={() => changeDraft({ kind })} />
                  <Check aria-hidden="true" />
                  <span>{kindLabels[kind]}</span>
                </label>
              );
            })}
          </div>
        </fieldset>
        <label className="must-items__field">
          <span>項目名稱</span>
          <input ref={inputRef} value={editor.label} onChange={(event) => changeDraft({ label: event.target.value })} aria-describedby={error ? "must-item-error" : undefined} />
        </label>
        {error ? <p id="must-item-error" className="must-items__error" role="alert">{error}</p> : null}
        {editor.conflictLatest !== undefined ? (
          <div className="must-items__conflict">
            <button type="button" disabled={busy} onClick={() => {
              const latest = editor.conflictLatest;
              if (!latest) {
                setItems((current) => current.filter((item) => item.id !== editor.item?.id));
                setAnnouncement("這個項目已被其他成員移除");
                closeEditor("add");
                return;
              }
              setEditor({ mode: "edit", item: latest, kind: latest.kind, label: latest.label, dirty: false, deleting: false, conflictLatest: undefined });
              setError("");
              setAnnouncement("已載入最新內容");
            }}>載入最新內容</button>
            <button type="button" disabled={busy || !editor.conflictLatest} onClick={() => {
              setEditor((current) => current?.conflictLatest ? { ...current, item: current.conflictLatest, conflictLatest: undefined, dirty: true } : current);
              setError("");
              setAnnouncement("已保留你的修改");
            }}>保留我的修改</button>
          </div>
        ) : null}
        {editor.mode === "edit" ? (
          editor.deleting ? (
            <div className="must-items__delete-confirm" role="group" aria-label={`移除『${editor.item!.label}』`}>
              <p>要移除『{editor.item!.label}』嗎？</p>
              <button type="button" disabled={busy} onClick={() => setEditor({ ...editor, deleting: false })}>保留</button>
              <button type="button" className="must-items__danger" disabled={busy} onClick={() => void remove()}>{busy ? "移除中…" : "移除"}</button>
            </div>
          ) : <button type="button" className="must-items__delete" disabled={busy} onClick={() => setEditor({ ...editor, deleting: true })}><Trash2 aria-hidden="true" />移除項目</button>
        ) : null}
        <div ref={actionsRef} className="must-items__editor-actions">
          <button type="button" className="must-items__secondary" disabled={busy} onClick={() => closeEditor("trigger")}>取消</button>
          <button type="submit" className="must-items__primary" disabled={busy}>{busy ? "儲存中…" : "儲存"}</button>
        </div>
      </form>
    );
  }

  const full = items.length >= 24;
  return (
    <section className="pd-detail-section must-items" aria-labelledby={`must-items-title-${tripPlaceId}`}>
      <div className="must-items__heading">
        <h3 id={`must-items-title-${tripPlaceId}`}>必買／必吃／必喝</h3>
        {editable ? <button ref={addRef} type="button" className="must-items__add" disabled={full || Boolean(editor)} aria-describedby={full ? `must-items-limit-${tripPlaceId}` : undefined} onClick={beginCreate}><Plus aria-hidden="true" />新增</button> : null}
      </div>
      {full && editable ? <p id={`must-items-limit-${tripPlaceId}`} className="must-items__limit">每個地點最多 24 項</p> : null}
      {loading ? <p className="must-items__empty" role="status">正在載入項目…</p> : null}
      {!loading && loadError ? <div className="must-items__empty" role="alert"><p>目前無法載入項目，請再試一次</p><button type="button" onClick={() => { setLoading(true); void loadItems(); }}>重試</button></div> : null}
      {!loading && !loadError && items.length === 0 && !editor ? <p className="must-items__empty">{editable ? "還沒有項目；新增想買、想吃或想喝的東西" : "口袋名單裡還沒有項目"}</p> : null}
      {!loading && !loadError ? kinds.map((kind) => {
        const grouped = items.filter((item) => item.kind === kind);
        if (grouped.length === 0) return null;
        return (
          <div className="must-items__group" key={kind}>
            <h4>{kindLabels[kind]}</h4>
            <ul>
              {grouped.map((item) => (
                <li key={item.id}>
                  <span className="must-items__label">{item.label}</span>
                  {editable ? <button
                    ref={(element) => { if (element) editRefs.current.set(item.id, element); else editRefs.current.delete(item.id); }}
                    type="button"
                    className="must-items__edit"
                    disabled={Boolean(editor)}
                    aria-label={`編輯『${item.label}』`}
                    onClick={() => beginEdit(item)}
                  ><Pencil aria-hidden="true" /></button> : null}
                  {editor?.item?.id === item.id ? editorForm() : null}
                </li>
              ))}
            </ul>
          </div>
        );
      }) : null}
      {editor?.mode === "create" ? editorForm() : null}
      {wishlistHref ? <a className="must-items__wishlist-link" href={wishlistHref}>到口袋名單查看或新增</a> : null}
      <p className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</p>
      <Dialog open={discardOpen} onOpenChange={(open) => { if (!open) setDiscardOpen(false); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>要放棄還沒儲存的項目嗎？</DialogTitle>
            <DialogDescription>目前輸入的內容不會被保留。</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button type="button" className="must-items__secondary" onClick={() => setDiscardOpen(false)}>繼續編輯</button>
            <button type="button" className="must-items__danger" onClick={() => {
              setDiscardOpen(false);
              setEditor(null);
              setError("");
              const action = discardAction.current;
              discardAction.current = null;
              action?.();
            }}>放棄</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
});
