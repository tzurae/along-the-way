import { useCallback, useEffect, useState } from "react";

import {
  parseTripSummaryResponse,
  type TripSummaryDto,
} from "@along-the-way/contracts/trip-summary";

type PageState =
  | { status: "loading" }
  | { status: "loaded"; trip: TripSummaryDto }
  | { status: "error" };

interface TripSummaryPageProps {
  slug: string;
}

function displayDate(value: string) {
  const [year, month, day] = value.split("-").map(Number);

  if (!year || !month || !day) {
    return value;
  }

  return `${year}/${month}/${day}`;
}

const pageShellClassName =
  "mx-auto min-h-screen w-[calc(100%_-_1.25rem)] max-w-[60rem] pt-[1.125rem] pb-[4.5rem] trip-wide:w-[calc(100%_-_2rem)] trip-wide:pt-8";
const centeredPageShellClassName = `${pageShellClassName} grid place-items-center`;
const feedbackCardClassName =
  "w-full max-w-[35rem] rounded-[1.5rem] border border-ink/[14%] bg-surface/[86%] p-10 shadow-feedback";
const eyebrowClassName =
  "mb-4 text-[0.75rem] font-[760] tracking-[0.16em] text-accent-strong";
const headingClassName =
  "max-w-[14ch] font-display font-medium leading-[1.04] tracking-[-0.055em] text-ink-strong";
const factCellClassName = "bg-surface-subtle p-5";
const factLabelClassName =
  "mb-2 text-fact-label font-fact-label tracking-fact-label text-fact-label-ink";
const factValueClassName = "font-fact-value text-fact-value-ink";

export function TripSummaryPage({ slug }: TripSummaryPageProps) {
  const [state, setState] = useState<PageState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  useEffect(() => {
    const abortController = new AbortController();
    setState({ status: "loading" });

    void fetch(`/api/trips/${encodeURIComponent(slug)}/summary`, {
      headers: { Accept: "application/json" },
      signal: abortController.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Trip request failed with ${response.status}`);
        }

        return parseTripSummaryResponse(await response.json());
      })
      .then(({ trip }) => setState({ status: "loaded", trip }))
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
        setState({ status: "error" });
      });

    return () => abortController.abort();
  }, [attempt, slug]);

  if (state.status === "loading") {
    return (
      <main className={centeredPageShellClassName}>
        <p className={`${feedbackCardClassName} text-center text-muted`} role="status">
          正在整理旅程，讓你們一眼看懂下一步…
        </p>
      </main>
    );
  }

  if (state.status === "error") {
    return (
      <main className={centeredPageShellClassName}>
        <section className={feedbackCardClassName} role="alert">
          <p className={eyebrowClassName}>連線走散了一下</p>
          <h1 className={`${headingClassName} text-[clamp(2rem,7vw,3.6rem)]`}>
            暫時拿不到旅程資料
          </h1>
          <p className="mt-4 text-[#65746d] leading-[1.7]">
            已經排好的內容不會消失，等服務恢復後再接著走。
          </p>
          <button
            className="mt-7 cursor-pointer rounded-[0.75rem] bg-ink px-[1.125rem] py-3 font-bold text-on-dark hover:bg-accent-strong focus-visible:outline-[3px] focus-visible:outline-offset-[3px] focus-visible:outline-focus"
            type="button"
            onClick={retry}
          >
            再試一次
          </button>
        </section>
      </main>
    );
  }

  const { trip } = state;

  return (
    <main className={pageShellClassName}>
      <header className="mb-10 flex min-h-10 items-center gap-[0.625rem] text-[0.75rem] font-[750] tracking-[0.13em] text-ink trip-wide:mb-[clamp(3.5rem,10vw,7rem)]">
        <span
          className="grid size-7 place-items-center rounded-full bg-accent text-[1rem] text-on-dark"
          aria-hidden="true"
        >
          ↗
        </span>
        <span>ALONG THE WAY</span>
        <span className="ml-auto rounded-full border border-ink/[20%] px-[0.625rem] py-[0.4375rem] text-[0.68rem] tracking-[0.08em] text-muted">
          已同步
        </span>
      </header>

      <section
        className="relative overflow-hidden rounded-[1.375rem] border border-ink/[14%] bg-surface/[86%] p-[clamp(1.75rem,6vw,4.25rem)] shadow-card motion-safe:animate-arrive trip-wide:rounded-card"
        aria-labelledby="trip-title"
      >
        <span
          className="pointer-events-none absolute -top-[5.625rem] -right-[4.75rem] size-[13.75rem] rounded-full border-[2.125rem] border-accent/[13%]"
          aria-hidden="true"
        />
        <p className={eyebrowClassName}>你們正在一起完成的旅程</p>
        <h1
          className={`${headingClassName} text-[clamp(2.35rem,7vw,5.25rem)]`}
          id="trip-title"
        >
          {trip.title}
        </h1>
        <p className="mt-[1.125rem] text-[clamp(1rem,2.2vw,1.25rem)] text-[#5d6c65]">
          {trip.destination}
        </p>

        <dl className="mt-[clamp(2.625rem,8vw,4.5rem)] grid max-w-[38.75rem] grid-cols-1 gap-px overflow-hidden rounded-panel border border-ink/[16%] bg-ink/[16%] trip-wide:grid-cols-2">
          <div className={factCellClassName}>
            <dt className={factLabelClassName}>日期</dt>
            <dd className={factValueClassName}>
              {displayDate(trip.startDate)}－{displayDate(trip.endDate)}
            </dd>
          </div>
          <div className={factCellClassName}>
            <dt className={factLabelClassName}>同行</dt>
            <dd className={factValueClassName}>
              {trip.travelerCount} 位旅伴・{trip.dayCount} 天
            </dd>
          </div>
        </dl>

        {trip.nextDecision ? (
          <aside className="mt-[1.125rem] flex max-w-[38.75rem] flex-col items-start gap-2 rounded-panel bg-ink p-5 text-on-dark trip-wide:flex-row trip-wide:items-center trip-wide:gap-5">
            <span className="shrink-0 text-[0.72rem] font-bold tracking-[0.08em] text-[#e2b7a4]">
              下一個一起決定
            </span>
            <strong className="text-[1rem] font-[650]">
              {trip.nextDecision}
            </strong>
          </aside>
        ) : null}
      </section>
    </main>
  );
}
