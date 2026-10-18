import { readFile } from "node:fs/promises";
import { sign } from "node:crypto";

import { Temporal } from "@js-temporal/polyfill";
import type {
  GoogleProjectUsageDto,
  GoogleQuotaUsageDto,
  GoogleServiceUsageDto,
  GoogleUsageDto,
} from "@along-the-way/contracts/admin";

import type { RateLimiter } from "../private-trips/postgres-rate-limiter";

const MONITORING_SCOPE = "https://www.googleapis.com/auth/monitoring.read";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const MONITORING_URL = "https://monitoring.googleapis.com/v3";
const GOOGLE_QUOTA_TIME_ZONE = "America/Los_Angeles";
const CLOUD_CACHE_MILLISECONDS = 10 * 60 * 1_000;
const HTTP_REQUEST_TIMEOUT_MILLISECONDS = 10_000;
const PROJECT_TIMEOUT_MILLISECONDS = 30_000;
const TARGET_SERVICES = [
  { service: "places.googleapis.com", displayName: "Places API" },
  { service: "maps-backend.googleapis.com", displayName: "Maps JavaScript API" },
] as const;

interface ServiceAccountCredentials {
  clientEmail: string;
  privateKey: string;
}

interface MonitoringPoint {
  interval?: { startTime?: unknown; endTime?: unknown };
  value?: { int64Value?: unknown; doubleValue?: unknown };
}

interface MonitoringTimeSeries {
  metric?: { labels?: Record<string, unknown> };
  resource?: { labels?: Record<string, unknown> };
  points?: MonitoringPoint[];
}

interface MonitoringListResponse {
  timeSeries?: MonitoringTimeSeries[];
  nextPageToken?: string;
}

interface ProjectConfiguration {
  projectId: string;
  label: string;
}

export interface GoogleUsageModule {
  get(): Promise<GoogleUsageDto>;
}

export interface GoogleUsageModuleOptions {
  credentialsFile?: string;
  projects?: string;
  environment?: string;
  rateLimiter: RateLimiter;
  fetch?: typeof fetch;
  now?: () => Date;
}

function encodeBase64Url(value: string | Uint8Array) {
  return Buffer.from(value).toString("base64url");
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function pointValue(point: MonitoringPoint) {
  const raw = point.value?.int64Value ?? point.value?.doubleValue;
  const value = typeof raw === "string" || typeof raw === "number" ? Number(raw) : Number.NaN;
  return Number.isFinite(value) ? value : null;
}

function pointTime(point: MonitoringPoint) {
  return typeof point.interval?.endTime === "string" ? point.interval.endTime : null;
}

function pointStartTime(point: MonitoringPoint) {
  return typeof point.interval?.startTime === "string" ? point.interval.startTime : null;
}

function labelValue(labels: Record<string, unknown> | undefined, name: string) {
  const value = labels?.[name];
  return typeof value === "string" ? value : null;
}

function laterTime(current: string | null, candidate: string | null) {
  if (candidate === null) return current;
  if (current === null) return candidate;
  return new Date(candidate).valueOf() > new Date(current).valueOf() ? candidate : current;
}

function parseProjects(value: string | undefined): ProjectConfiguration[] {
  const configured = value?.trim() || "test-along:正式站,along-the-way-dev:開發";
  return configured.split(",").flatMap((entry) => {
    const separator = entry.indexOf(":");
    const projectId = (separator < 0 ? entry : entry.slice(0, separator)).trim();
    const label = (separator < 0 ? entry : entry.slice(separator + 1)).trim();
    return projectId ? [{ projectId, label: label || projectId }] : [];
  });
}

function monitoringFilter(metricType: string, resourceType: string, projectId: string) {
  const services = TARGET_SERVICES.map(({ service }) => `"${service}"`).join(",");
  return `metric.type="${metricType}" AND resource.type="${resourceType}" `
    + `AND resource.labels.project_id="${projectId}" `
    + `AND resource.labels.service=one_of(${services})`;
}

function quotaIsPerDay(limitName: string) {
  return /day|daily/i.test(limitName);
}

class MonitoringClient {
  private token: { value: string; expiresAt: number } | null = null;
  private tokenLoad: Promise<string> | null = null;

  constructor(
    private readonly credentials: ServiceAccountCredentials,
    private readonly fetcher: typeof fetch,
    private readonly now: () => Date,
  ) {}

  async listTimeSeries(
    projectId: string,
    metricType: string,
    resourceType: string,
    startTime: string,
    endTime: string,
    projectSignal: AbortSignal,
  ) {
    const token = await this.accessToken(projectSignal);
    const series: MonitoringTimeSeries[] = [];
    let pageToken = "";
    do {
      const url = new URL(`${MONITORING_URL}/projects/${encodeURIComponent(projectId)}/timeSeries`);
      url.searchParams.set("filter", monitoringFilter(metricType, resourceType, projectId));
      url.searchParams.set("interval.startTime", startTime);
      url.searchParams.set("interval.endTime", endTime);
      url.searchParams.set("view", "FULL");
      url.searchParams.set("pageSize", "10000");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const response = await this.fetcher(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: this.requestSignal(projectSignal),
      });
      if (!response.ok) throw new Error(`Cloud Monitoring request failed (${response.status})`);
      const parsed = objectValue(await response.json());
      if (!parsed) throw new Error("Cloud Monitoring returned an invalid response");
      const body = parsed as MonitoringListResponse;
      if (Array.isArray(body.timeSeries)) series.push(...body.timeSeries);
      pageToken = typeof body.nextPageToken === "string" ? body.nextPageToken : "";
    } while (pageToken);
    return series;
  }

  private async accessToken(projectSignal: AbortSignal) {
    const now = this.now().valueOf();
    if (this.token && now < this.token.expiresAt - 60_000) return this.token.value;
    if (this.tokenLoad) return this.tokenLoad;
    this.tokenLoad = this.exchangeAccessToken(now, projectSignal);
    try {
      return await this.tokenLoad;
    } finally {
      this.tokenLoad = null;
    }
  }

  private requestSignal(projectSignal: AbortSignal) {
    return AbortSignal.any([
      projectSignal,
      AbortSignal.timeout(HTTP_REQUEST_TIMEOUT_MILLISECONDS),
    ]);
  }

  private async exchangeAccessToken(now: number, projectSignal: AbortSignal) {
    const issuedAt = Math.floor(now / 1_000);
    const header = encodeBase64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const payload = encodeBase64Url(JSON.stringify({
      iss: this.credentials.clientEmail,
      sub: this.credentials.clientEmail,
      scope: MONITORING_SCOPE,
      aud: TOKEN_URL,
      iat: issuedAt,
      exp: issuedAt + 3_600,
    }));
    const unsigned = `${header}.${payload}`;
    const signature = sign("RSA-SHA256", Buffer.from(unsigned), this.credentials.privateKey);
    const assertion = `${unsigned}.${encodeBase64Url(signature)}`;
    const response = await this.fetcher(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
      signal: this.requestSignal(projectSignal),
    });
    if (!response.ok) throw new Error(`Google authentication failed (${response.status})`);
    const body = objectValue(await response.json());
    const accessToken = body?.access_token;
    const expiresIn = Number(body?.expires_in);
    if (typeof accessToken !== "string" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
      throw new Error("Google authentication returned an invalid response");
    }
    this.token = { value: accessToken, expiresAt: now + expiresIn * 1_000 };
    return accessToken;
  }
}

export class DefaultGoogleUsageModule implements GoogleUsageModule {
  private readonly projects: ProjectConfiguration[];
  private readonly fetcher: typeof fetch;
  private readonly now: () => Date;
  private cloudCache: { expiresAt: number; value: GoogleUsageDto["cloud"] } | null = null;
  private cloudLoad: Promise<GoogleUsageDto["cloud"]> | null = null;
  private monitoringCredentials: ServiceAccountCredentials | null = null;
  private monitoringClient: MonitoringClient | null = null;

  constructor(private readonly options: GoogleUsageModuleOptions) {
    this.projects = parseProjects(options.projects);
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  async get(): Promise<GoogleUsageDto> {
    const [cloud, app] = await Promise.all([
      this.cloudUsage(),
      this.options.rateLimiter.appUsage(),
    ]);
    return {
      generatedAt: this.now().toISOString(),
      cloud,
      app: {
        environment: this.options.environment?.trim() || "development",
        ...app,
      },
    };
  }

  private async cloudUsage() {
    const now = this.now().valueOf();
    if (this.cloudCache && now < this.cloudCache.expiresAt) return this.cloudCache.value;
    if (this.cloudLoad) return this.cloudLoad;
    this.cloudLoad = this.loadCloudUsage();
    try {
      const value = await this.cloudLoad;
      this.cloudCache = { value, expiresAt: now + CLOUD_CACHE_MILLISECONDS };
      return value;
    } finally {
      this.cloudLoad = null;
    }
  }

  private async loadCloudUsage(): Promise<GoogleUsageDto["cloud"]> {
    const credentials = await this.credentials();
    if (!credentials) return { configured: false, projects: [] };
    if (!this.monitoringCredentials
      || this.monitoringCredentials.clientEmail !== credentials.clientEmail
      || this.monitoringCredentials.privateKey !== credentials.privateKey) {
      this.monitoringCredentials = credentials;
      this.monitoringClient = new MonitoringClient(credentials, this.fetcher, this.now);
    }
    const client = this.monitoringClient!;
    const projects = await Promise.all(this.projects.map(async (project) => {
      try {
        const projectSignal = AbortSignal.timeout(PROJECT_TIMEOUT_MILLISECONDS);
        return await this.projectUsage(client, project, projectSignal);
      } catch (error) {
        return {
          projectId: project.projectId,
          label: project.label,
          dataTime: null,
          error: error instanceof Error ? error.message : "Cloud Monitoring request failed",
          services: TARGET_SERVICES.map(({ service, displayName }) => ({
            service,
            displayName,
            today: null,
            last7Days: [],
          })),
          quotas: [],
        } satisfies GoogleProjectUsageDto;
      }
    }));
    return { configured: true, projects };
  }

  private async credentials(): Promise<ServiceAccountCredentials | null> {
    const path = this.options.credentialsFile?.trim();
    if (!path) return null;
    try {
      const raw = objectValue(JSON.parse(await readFile(path, "utf8")));
      const clientEmail = raw?.client_email;
      const privateKey = raw?.private_key;
      if (typeof clientEmail !== "string" || !clientEmail.trim()
        || typeof privateKey !== "string" || !privateKey.trim()) return null;
      return { clientEmail, privateKey };
    } catch {
      return null;
    }
  }

  private async projectUsage(
    client: MonitoringClient,
    project: ProjectConfiguration,
    projectSignal: AbortSignal,
  ) {
    const instant = Temporal.Instant.fromEpochMilliseconds(this.now().valueOf());
    const today = instant.toZonedDateTimeISO(GOOGLE_QUOTA_TIME_ZONE).startOfDay();
    const firstDay = today.subtract({ days: 6 });
    const dayNames = Array.from({ length: 7 }, (_, index) =>
      firstDay.add({ days: index }).toPlainDate().toString());
    const startTime = firstDay.toInstant().toString();
    const todayStartTime = today.toInstant().toString();
    const endTime = instant.toString();

    const mapsSeries = await client.listTimeSeries(
      project.projectId,
      "maps.googleapis.com/service/v2/request_count",
      "maps.googleapis.com/Api",
      startTime,
      endTime,
      projectSignal,
    );
    const servicesWithMapsData = new Set(mapsSeries.flatMap((series) => {
      const service = labelValue(series.resource?.labels, "service");
      return service && series.points?.some((point) => pointValue(point) !== null) ? [service] : [];
    }));
    const missingServices = TARGET_SERVICES
      .map(({ service }) => service)
      .filter((service) => !servicesWithMapsData.has(service));
    let requestSeries = mapsSeries;
    if (missingServices.length > 0) {
      const fallback = await client.listTimeSeries(
        project.projectId,
        "serviceruntime.googleapis.com/api/request_count",
        "consumed_api",
        startTime,
        endTime,
        projectSignal,
      );
      requestSeries = [
        ...mapsSeries,
        ...fallback.filter((series) => {
          const service = labelValue(series.resource?.labels, "service");
          return service !== null && missingServices.some((missing) => missing === service);
        }),
      ];
    }

    const requestCounts = new Map<string, Map<string, number>>();
    let dataTime: string | null = null;
    for (const series of requestSeries) {
      const service = labelValue(series.resource?.labels, "service");
      if (!service) continue;
      for (const point of series.points ?? []) {
        const count = pointValue(point);
        const start = pointStartTime(point);
        const end = pointTime(point);
        if (count === null || start === null || end === null) continue;
        const date = Temporal.Instant.from(start)
          .toZonedDateTimeISO(GOOGLE_QUOTA_TIME_ZONE)
          .toPlainDate()
          .toString();
        if (!dayNames.includes(date)) continue;
        const byDay = requestCounts.get(service) ?? new Map<string, number>();
        byDay.set(date, (byDay.get(date) ?? 0) + count);
        requestCounts.set(service, byDay);
        dataTime = laterTime(dataTime, end);
      }
    }
    const services: GoogleServiceUsageDto[] = TARGET_SERVICES.map(({ service, displayName }) => {
      const byDay = requestCounts.get(service);
      return {
        service,
        displayName,
        today: byDay?.get(dayNames[6]!) ?? null,
        last7Days: dayNames.map((date) => ({ date, count: byDay?.get(date) ?? null })),
      };
    });

    const [quotaUsageSeries, quotaLimitSeries] = await Promise.all([
      client.listTimeSeries(
        project.projectId,
        "serviceruntime.googleapis.com/quota/rate/net_usage",
        "consumer_quota",
        todayStartTime,
        endTime,
        projectSignal,
      ),
      client.listTimeSeries(
        project.projectId,
        "serviceruntime.googleapis.com/quota/limit",
        "consumer_quota",
        today.subtract({ days: 3 }).toInstant().toString(),
        endTime,
        projectSignal,
      ),
    ]);
    const usageByMetric = new Map<string, number>();
    for (const series of quotaUsageSeries) {
      const service = labelValue(series.resource?.labels, "service");
      const quotaMetric = labelValue(series.metric?.labels, "quota_metric");
      if (!service || !quotaMetric) continue;
      const key = `${service}\u0000${quotaMetric}`;
      for (const point of series.points ?? []) {
        const usage = pointValue(point);
        const time = pointTime(point);
        if (usage === null) continue;
        usageByMetric.set(key, (usageByMetric.get(key) ?? 0) + usage);
        dataTime = laterTime(dataTime, time);
      }
    }
    const limits = new Map<string, GoogleQuotaUsageDto>();
    for (const series of quotaLimitSeries) {
      const service = labelValue(series.resource?.labels, "service");
      const quotaMetric = labelValue(series.metric?.labels, "quota_metric");
      const limitName = labelValue(series.metric?.labels, "limit_name");
      if (!service || !quotaMetric || !limitName || !quotaIsPerDay(limitName)) continue;
      const latestPoint = (series.points ?? []).reduce<MonitoringPoint | null>((latest, point) => {
        const time = pointTime(point);
        if (pointValue(point) === null || time === null) return latest;
        return latest === null || new Date(time) > new Date(pointTime(latest)!) ? point : latest;
      }, null);
      if (!latestPoint) continue;
      const limit = pointValue(latestPoint);
      if (limit === null) continue;
      const key = `${service}\u0000${quotaMetric}\u0000${limitName}`;
      const existingLimit = limits.get(key)?.limit;
      limits.set(key, {
        service,
        quotaMetric,
        limitName,
        usageToday: usageByMetric.get(`${service}\u0000${quotaMetric}`) ?? null,
        limit: existingLimit === null || existingLimit === undefined
          ? limit
          : Math.max(existingLimit, limit),
      });
      dataTime = laterTime(dataTime, pointTime(latestPoint));
    }

    return {
      projectId: project.projectId,
      label: project.label,
      dataTime,
      error: null,
      services,
      quotas: [...limits.values()].sort((left, right) =>
        left.service.localeCompare(right.service) || left.limitName.localeCompare(right.limitName)),
    } satisfies GoogleProjectUsageDto;
  }
}
