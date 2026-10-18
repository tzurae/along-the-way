import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  parseFeedbackAdminListResponse,
  parseFeedbackAdminResponse,
  parseGoogleUsageResponse,
  type FeedbackAdminDto,
  type FeedbackStatus,
  type FeedbackType,
  type GoogleProjectUsageDto,
  type GoogleQuotaUsageDto,
  type GoogleServiceUsageDto,
  type GoogleUsageDto,
  type UpdateFeedbackAdminInput,
} from "@along-the-way/contracts/admin";
import { AlertTriangle, BarChart3, MessageSquareText } from "lucide-react";

import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { ApiRequestError } from "./api-error";
import { useI18n } from "./i18n";
import "./admin.css";

interface RequestOptions extends RequestInit {
  parse?: (value: unknown) => unknown;
}

interface AdminViewProps {
  routeError?: string;
  request<T>(url: string, options?: RequestOptions): Promise<T>;
  onPhotoRemoved(): void;
}

type AdminTab = "feedback" | "google-usage";
type FilterStatus = "all" | FeedbackStatus;
type FilterType = "all" | FeedbackType;

const feedbackStatuses: FeedbackStatus[] = ["new", "in_progress", "done", "wont_do"];
const feedbackTypes: FeedbackType[] = ["bug", "idea", "other", "photo"];
const dateTimeFormatter = new Intl.DateTimeFormat("zh-TW", {
  dateStyle: "medium",
  timeStyle: "short",
});
const numberFormatter = new Intl.NumberFormat("zh-TW");
const quotaDayFormatter = new Intl.DateTimeFormat("zh-TW", {
  month: "numeric",
  day: "numeric",
  weekday: "short",
  timeZone: "UTC",
});

function formatDateTime(value: string) {
  return dateTimeFormatter.format(new Date(value));
}


function FeedbackCard({
  item,
  photoRemoved,
  onUpdated,
  onPhotoRemoved,
  onRefresh,
  request,
}: {
  item: FeedbackAdminDto;
  photoRemoved: boolean;
  onUpdated(item: FeedbackAdminDto): void;
  onPhotoRemoved(): void;
  onRefresh(): void;
  request: AdminViewProps["request"];
}) {
  const { t } = useI18n();
  const [status, setStatus] = useState(item.status);
  const [adminNote, setAdminNote] = useState(item.adminNote ?? "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [confirmingPhotoRemoval, setConfirmingPhotoRemoval] = useState(false);
  const [removingPhoto, setRemovingPhoto] = useState(false);
  const [photoError, setPhotoError] = useState("");
  const noteTooLong = adminNote.length > 2_000;
  const changed = status !== item.status || adminNote !== (item.adminNote ?? "");

  useEffect(() => {
    setStatus(item.status);
    setAdminNote(item.adminNote ?? "");
    setError("");
  }, [item]);

  async function save() {
    if (saving || !changed || noteTooLong) return;
    setSaving(true);
    setSaved(false);
    setError("");
    const input: UpdateFeedbackAdminInput = {
      status,
      adminNote: adminNote.trim() || null,
    };
    try {
      const updated = await request<FeedbackAdminDto>(`/api/admin/feedback/${item.id}`, {
        method: "PATCH",
        body: JSON.stringify(input),
        parse: parseFeedbackAdminResponse,
      });
      setStatus(updated.status);
      setAdminNote(updated.adminNote ?? "");
      setSaved(true);
      onUpdated(updated);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t.errors.unknown);
    } finally {
      setSaving(false);
    }
  }

  async function removePhoto() {
    if (item.type !== "photo" || removingPhoto) return;
    setRemovingPhoto(true);
    setPhotoError("");
    try {
      const updated = await request<FeedbackAdminDto>(`/api/admin/feedback/${encodeURIComponent(item.id)}/remove-photo`, {
        method: "POST",
        parse: parseFeedbackAdminResponse,
      });
      setStatus(updated.status);
      setAdminNote(updated.adminNote ?? "");
      onUpdated(updated);
      setConfirmingPhotoRemoval(false);
      onPhotoRemoved();
      onRefresh();
    } catch (error) {
      setPhotoError(
        error instanceof ApiRequestError && error.code === "photo_feedback_place_gone"
          ? t.admin.photoFeedback.placeGone
          : t.admin.photoFeedback.removeError,
      );
    } finally {
      setRemovingPhoto(false);
    }
  }

  return (
    <article className="admin-feedback-card">
      <div className="admin-feedback-card__heading">
        <div className="admin-feedback-card__badges">
          <span className={`admin-feedback-type admin-feedback-type--${item.type}`}>{t.admin.feedbackTypes[item.type]}</span>
          <span className={`admin-feedback-status admin-feedback-status--${item.status}`}>{t.admin.statuses[item.status]}</span>
        </div>
        <time dateTime={item.createdAt}><span className="sr-only">{t.admin.submittedAt}：</span>{formatDateTime(item.createdAt)}</time>
      </div>

      <p className="admin-feedback-card__body">{item.body}</p>

      <dl className="admin-feedback-facts">
        <div><dt>{t.admin.page}</dt><dd>{item.page ?? "—"}</dd></div>
        <div><dt>{t.admin.trip}</dt><dd>{item.tripName ?? "—"}</dd></div>
        {item.type === "photo" ? (
          <>
            <div><dt>{t.admin.photoFeedback.place}</dt><dd>{item.placeName ?? "—"}</dd></div>
            <div><dt>{t.admin.photoFeedback.reason}</dt><dd>{item.photoReason ? t.admin.photoReasons[item.photoReason] : "—"}</dd></div>
            <div><dt>{t.admin.photoFeedback.wikidataId}</dt><dd>{item.photoWikidataId
              ? <a href={`https://www.wikidata.org/wiki/${encodeURIComponent(item.photoWikidataId)}`} target="_blank" rel="noreferrer">{item.photoWikidataId}</a>
              : "—"}</dd></div>
          </>
        ) : null}
        <div><dt>{t.admin.contact}</dt><dd>{item.submitterEmail ?? t.admin.contactNotAllowed}</dd></div>
        <div><dt>{t.admin.appVersion}</dt><dd>{item.appVersion}</dd></div>
        <div><dt>{t.admin.viewport}</dt><dd>{item.viewport ?? "—"}</dd></div>
        <div><dt>{t.admin.updatedAt}</dt><dd><time dateTime={item.updatedAt}>{formatDateTime(item.updatedAt)}</time></dd></div>
        <div className="admin-feedback-facts__wide"><dt>{t.admin.userAgent}</dt><dd>{item.userAgent ?? "—"}</dd></div>
      </dl>

      {item.type === "photo" ? (
        <div className="admin-photo-action">
          {photoRemoved ? (
            <p className="admin-photo-action__success" role="status">{t.admin.photoFeedback.removed}</p>
          ) : confirmingPhotoRemoval ? (
            <div className="admin-photo-action__confirm">
              <p>{t.admin.photoFeedback.confirm}</p>
              <div>
                <Button type="button" variant="outline" disabled={removingPhoto} onClick={() => setConfirmingPhotoRemoval(false)}>
                  {t.admin.photoFeedback.cancel}
                </Button>
                <Button type="button" disabled={removingPhoto} onClick={() => void removePhoto()}>
                  {removingPhoto ? t.admin.photoFeedback.removing : t.admin.photoFeedback.confirmAction}
                </Button>
              </div>
            </div>
          ) : (
            <Button type="button" variant="outline" onClick={() => {
              setPhotoError("");
              setConfirmingPhotoRemoval(true);
            }}>{t.admin.photoFeedback.remove}</Button>
          )}
          {photoError ? <p className="admin-inline-error" role="alert">{photoError}</p> : null}
        </div>
      ) : null}
      <div className="admin-feedback-editor">
        <label>
          <span>{t.admin.filters.status}</span>
          <NativeSelect
            value={status}
            disabled={saving}
            onChange={(event) => {
              setStatus(event.target.value as FeedbackStatus);
              setSaved(false);
            }}
          >
            {feedbackStatuses.map((value) => <option key={value} value={value}>{t.admin.statuses[value]}</option>)}
          </NativeSelect>
        </label>
        <label>
          <span className="admin-feedback-note-label">
            <span>{t.admin.adminNote}</span>
            <span>{adminNote.length} / 2,000</span>
          </span>
          <Textarea
            rows={4}
            maxLength={2_000}
            value={adminNote}
            disabled={saving}
            placeholder={t.admin.adminNotePlaceholder}
            aria-invalid={noteTooLong || undefined}
            onChange={(event) => {
              setAdminNote(event.target.value);
              setSaved(false);
            }}
          />
        </label>
        {noteTooLong ? <p className="admin-inline-error" role="alert">{t.admin.noteTooLong}</p> : null}
        {error ? <p className="admin-inline-error" role="alert">{error}</p> : null}
        <div className="admin-feedback-editor__actions">
          {saved && !changed ? <span role="status">{t.admin.saved}</span> : null}
          <Button type="button" disabled={saving || !changed || noteTooLong} onClick={() => void save()}>
            {saving ? t.admin.saving : t.admin.save}
          </Button>
        </div>
      </div>
    </article>
  );
}

function FeedbackAdminPanel({ request, onPhotoRemoved }: AdminViewProps) {
  const { t } = useI18n();
  const [status, setStatus] = useState<FilterStatus>("all");
  const [type, setType] = useState<FilterType>("all");
  const [feedback, setFeedback] = useState<FeedbackAdminDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [removedPhotoFeedbackIds, setRemovedPhotoFeedbackIds] = useState<Set<string>>(() => new Set());
  const filterGeneration = useRef(0);

  useEffect(() => {
    let active = true;
    const generation = filterGeneration.current;
    const search = new URLSearchParams();
    if (status !== "all") search.set("status", status);
    if (type !== "all") search.set("type", type);
    const serialized = search.toString();
    const query = serialized ? `?${serialized}` : "";
    setLoading(true);
    setError("");
    void request<{ feedback: FeedbackAdminDto[] }>(`/api/admin/feedback${query}`, {
      parse: parseFeedbackAdminListResponse,
    }).then((response) => {
      if (active && generation === filterGeneration.current) setFeedback(response.feedback);
    }).catch((reason: unknown) => {
      if (active && generation === filterGeneration.current) {
        setError(reason instanceof Error ? reason.message : t.admin.feedbackLoadError);
      }
    }).finally(() => {
      if (active && generation === filterGeneration.current) setLoading(false);
    });
    return () => { active = false; };
  }, [request, revision, status, t.admin.feedbackLoadError, type]);
  const renderGeneration = filterGeneration.current;

  return (
    <section id="admin-panel-feedback" role="tabpanel" aria-labelledby="admin-tab-feedback" className="admin-panel">
      <div className="admin-feedback-toolbar" aria-label={`${t.admin.filters.status}、${t.admin.filters.type}`}>
        <label>
          <span>{t.admin.filters.status}</span>
          <NativeSelect value={status} onChange={(event) => {
            filterGeneration.current += 1;
            setLoading(true);
            setStatus(event.target.value as FilterStatus);
          }}>
            <option value="all">{t.admin.filters.allStatuses}</option>
            {feedbackStatuses.map((value) => <option key={value} value={value}>{t.admin.statuses[value]}</option>)}
          </NativeSelect>
        </label>
        <label>
          <span>{t.admin.filters.type}</span>
          <NativeSelect value={type} onChange={(event) => {
            filterGeneration.current += 1;
            setLoading(true);
            setType(event.target.value as FilterType);
          }}>
            <option value="all">{t.admin.filters.allTypes}</option>
            {feedbackTypes.map((value) => <option key={value} value={value}>{t.admin.feedbackTypes[value]}</option>)}
          </NativeSelect>
        </label>
      </div>

      {loading ? (
        <div className="admin-feedback-loading" role="status" aria-live="polite">
          <span className="admin-skeleton" />
          <span className="admin-skeleton" />
          <span className="sr-only">{t.admin.loadingFeedback}</span>
        </div>
      ) : error ? (
        <div className="admin-state admin-state--error" role="alert">
          <AlertTriangle aria-hidden="true" />
          <p>{error}</p>
          <Button type="button" variant="outline" onClick={() => {
            filterGeneration.current += 1;
            setLoading(true);
            setRevision((value) => value + 1);
          }}>{t.admin.retry}</Button>
        </div>
      ) : feedback.length === 0 ? (
        <p className="admin-state">{t.admin.noFeedback}</p>
      ) : (
        <div className="admin-feedback-list">
          {feedback.map((item) => (
            <FeedbackCard
              key={item.id}
              item={item}
              photoRemoved={removedPhotoFeedbackIds.has(item.id)}
              onPhotoRemoved={() => {
                setRemovedPhotoFeedbackIds((current) => new Set(current).add(item.id));
                onPhotoRemoved();
              }}
              request={request}
              onRefresh={() => {
                filterGeneration.current += 1;
                setLoading(true);
                setRevision((value) => value + 1);
              }}
              onUpdated={(updated) => setFeedback((current) => {
                if (filterGeneration.current !== renderGeneration) return current;
                return status !== "all" && updated.status !== status
                  ? current.filter((entry) => entry.id !== updated.id)
                  : current.map((entry) => entry.id === updated.id ? updated : entry);
              })}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function UsageBar({ value, limit, label }: { value: number | null; limit: number | null; label: string }) {
  const { t } = useI18n();
  const percentage = value === null || limit === null || limit <= 0 ? null : (value / limit) * 100;
  const tone = percentage === null ? "unknown" : percentage >= 100 ? "error" : percentage >= 80 ? "warning" : "normal";
  const width = percentage === null ? 0 : Math.min(percentage, 100);

  return (
    <div className={`usage-meter usage-meter--${tone}`}>
      <div className="usage-meter__label">
        <span>{label}</span>
        <strong>
          {value === null ? t.admin.google.noData : numberFormatter.format(value)}
          {limit === null ? " / —" : ` / ${numberFormatter.format(limit)}`}
          {percentage === null ? "" : `（${Math.round(percentage)}%）`}
        </strong>
      </div>
      {percentage === null ? null : (
        <div
          className="usage-meter__track"
          role="progressbar"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={limit ?? undefined}
          aria-valuenow={value ?? undefined}
        >
          <span style={{ "--usage-width": `${width}%` } as CSSProperties} />
        </div>
      )}
    </div>
  );
}

function ServiceUsage({ service, projectId }: { service: GoogleServiceUsageDto; projectId: string }) {
  const { t } = useI18n();
  const maximum = service.last7Days.reduce(
    (current, day) => day.count === null ? current : Math.max(current, day.count),
    1,
  );

  return (
    <section className="usage-service" aria-labelledby={`usage-service-${projectId}-${service.service}`}>
      <div className="usage-service__heading">
        <h4 id={`usage-service-${projectId}-${service.service}`}>{service.displayName}</h4>
        <div><span>{t.admin.google.today}</span><strong>{service.today === null ? t.admin.google.noData : numberFormatter.format(service.today)}</strong></div>
      </div>
      <div className="usage-week" aria-label={`${service.displayName} ${t.admin.google.last7Days}`}>
        {service.last7Days.map((day) => (
          <div className="usage-day" key={day.date}>
            <span className="usage-day__value">{day.count === null ? t.admin.google.noData : numberFormatter.format(day.count)}</span>
            <span className="usage-day__track" aria-hidden="true">
              {day.count === null ? null : (
                <span style={{ "--usage-height": day.count === 0 ? "0%" : `${Math.max(4, (day.count / maximum) * 100)}%` } as CSSProperties} />
              )}
            </span>
            <time dateTime={day.date}>{quotaDayFormatter.format(new Date(`${day.date}T12:00:00Z`))}</time>
          </div>
        ))}
      </div>
    </section>
  );
}

function QuotaUsage({ quota, project }: { quota: GoogleQuotaUsageDto; project: GoogleProjectUsageDto }) {
  const label = project.services.find((service) => service.service === quota.service)?.displayName ?? quota.service;
  return (
    <div className="usage-quota">
      <UsageBar value={quota.usageToday} limit={quota.limit} label={label} />
      <span className="usage-quota__technical" title={`${quota.quotaMetric} · ${quota.limitName}`}>{quota.quotaMetric}</span>
    </div>
  );
}

function GoogleUsagePanel({ request }: AdminViewProps) {
  const { t } = useI18n();
  const [usage, setUsage] = useState<GoogleUsageDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    void request<GoogleUsageDto>("/api/admin/google-usage", {
      parse: parseGoogleUsageResponse,
    }).then((response) => {
      if (active) setUsage(response);
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : t.admin.google.loadError);
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [request, revision, t.admin.google.loadError]);


  if (loading) {
    return (
      <section id="admin-panel-google-usage" role="tabpanel" aria-labelledby="admin-tab-google-usage" className="admin-panel">
        <div className="admin-usage-loading" role="status" aria-live="polite">
          <span className="admin-skeleton" />
          <span className="admin-skeleton" />
          <span className="sr-only">{t.admin.google.loading}</span>
        </div>
      </section>
    );
  }

  if (error || !usage) {
    return (
      <section id="admin-panel-google-usage" role="tabpanel" aria-labelledby="admin-tab-google-usage" className="admin-panel">
        <div className="admin-state admin-state--error" role="alert">
          <AlertTriangle aria-hidden="true" />
          <p>{error || t.admin.google.loadError}</p>
          <Button type="button" variant="outline" onClick={() => setRevision((value) => value + 1)}>{t.admin.retry}</Button>
        </div>
      </section>
    );
  }

  return (
    <section id="admin-panel-google-usage" role="tabpanel" aria-labelledby="admin-tab-google-usage" className="admin-panel admin-usage-panel">
      <div className="admin-usage-context">
        <p>{t.admin.google.quotaDay}</p>
        <p>{t.admin.google.freshness}</p>
      </div>

      {!usage.cloud.configured ? (
        <div className="admin-state admin-state--notice">
          <BarChart3 aria-hidden="true" />
          <strong>{t.admin.google.notConfiguredTitle}</strong>
          <p>{t.admin.google.notConfiguredDescription}</p>
        </div>
      ) : (
        <div className="usage-projects">
          {usage.cloud.projects.map((project) => (
            <article className="usage-project" key={project.projectId}>
              <header className="usage-project__header">
                <div>
                  <h3>{project.label}</h3>
                  <span>{project.projectId}</span>
                </div>
                <p>{project.dataTime ? t.admin.google.dataTime(formatDateTime(project.dataTime)) : t.admin.google.noDataTime}</p>
              </header>
              {project.error ? (
                <div className="admin-state admin-state--error" role="alert">
                  <AlertTriangle aria-hidden="true" />
                  <strong>{t.admin.google.projectError}</strong>
                  <p>{project.error}</p>
                </div>
              ) : (
                <>
                  <div className="usage-services">
                    {project.services.length > 0
                      ? project.services.map((service) => <ServiceUsage key={service.service} service={service} projectId={project.projectId} />)
                      : <p className="admin-state">{t.admin.google.noData}</p>}
                  </div>
                  <section className="usage-quotas" aria-label={t.admin.google.quota}>
                    <h4>{t.admin.google.quota}</h4>
                    {project.quotas.length > 0
                      ? project.quotas.map((quota) => <QuotaUsage key={`${quota.service}-${quota.quotaMetric}-${quota.limitName}`} quota={quota} project={project} />)
                      : <p>{t.admin.google.quotaUnknown}</p>}
                  </section>
                </>
              )}
            </article>
          ))}
        </div>
      )}

      <section className="app-counters" aria-labelledby="app-counters-title">
        <div className="app-counters__heading">
          <div>
            <h3 id="app-counters-title">{t.admin.google.appCounters}</h3>
            <p>{t.admin.google.appCountersDescription}</p>
          </div>
          <span>{t.admin.google.environment(usage.app.environment)}</span>
        </div>
        <div className="app-counters__list">
          <UsageBar value={usage.app.googlePlacesToday} limit={usage.app.googlePlacesLimit} label={t.admin.google.places} />
          <UsageBar value={usage.app.googleMapsJsToday} limit={usage.app.googleMapsJsLimit} label={t.admin.google.mapsJs} />
          <UsageBar value={usage.app.photoMetadataThisHour} limit={usage.app.photoMetadataLimit} label={t.admin.google.photoMetadata} />
        </div>
      </section>
    </section>
  );
}

export function AdminView({ request, routeError, onPhotoRemoved }: AdminViewProps) {
  const { t } = useI18n();
  const [tab, setTab] = useState<AdminTab>("feedback");
  const tabItems = [
    { value: "feedback" as const, label: t.admin.tabs.feedback, icon: MessageSquareText },
    { value: "google-usage" as const, label: t.admin.tabs.googleUsage, icon: BarChart3 },
  ];

  return (
    <div className="admin-view">
      <header className="admin-page-heading">
        <div>
          <h1>{t.admin.title}</h1>
          <p>{t.admin.description}</p>
        </div>
      </header>
      {routeError ? (
        <div className="admin-route-error" role="alert">
          <AlertTriangle aria-hidden="true" />
          <span>{routeError}</span>
        </div>
      ) : null}
      <div className="admin-tabs" role="tablist" aria-label={t.admin.title}>
        {tabItems.map(({ value, label, icon: Icon }) => (
          <button
            key={value}
            id={`admin-tab-${value}`}
            type="button"
            role="tab"
            aria-selected={tab === value}
            aria-controls={`admin-panel-${value}`}
            className={tab === value ? "is-active" : undefined}
            onClick={() => setTab(value)}
          >
            <Icon aria-hidden="true" />
            <span>{label}</span>
          </button>
        ))}
      </div>
      {tab === "feedback" ? <FeedbackAdminPanel request={request} onPhotoRemoved={onPhotoRemoved} /> : <GoogleUsagePanel request={request} onPhotoRemoved={onPhotoRemoved} />}
    </div>
  );
}
