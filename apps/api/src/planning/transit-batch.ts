import type { TransitNotice } from "@along-the-way/contracts/day-plans";

export class TransitError extends Error {
  constructor(readonly code: TransitNotice) {
    super(code);
  }
}

/** Four workers and a 20-second deadline; unfinished shapes keep their null defaults. */
export async function mapTransitLegs<T, R>(
  legs: readonly T[],
  work: (leg: T, signal: AbortSignal) => Promise<R>,
  unfinished?: (leg: T) => R,
): Promise<R[]> {
  const results: R[] = unfinished ? legs.map(unfinished) : new Array(legs.length);
  const controller = new AbortController();
  let timer: NodeJS.Timeout;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve();
    }, 20_000);
  });
  let index = 0;
  let failure: unknown;
  let failed = false;
  const workers = Promise.all(Array.from({ length: Math.min(4, legs.length) }, async () => {
    while (!failed && !controller.signal.aborted && index < legs.length) {
      const current = index++;
      try {
        const result = await work(legs[current]!, controller.signal);
        if (!controller.signal.aborted) results[current] = result;
      } catch (error) {
        failed = true;
        // An already-observed quota refusal takes precedence over a later timeout.
        if (!(failure instanceof TransitError && failure.code.endsWith("_quota"))) failure = error;
      }
    }
  }));
  await Promise.race([workers, deadline]);
  clearTimeout(timer!);
  if (failed) throw failure;
  if (controller.signal.aborted && !unfinished) throw new TransitError("transit_unavailable");
  return results;
}
