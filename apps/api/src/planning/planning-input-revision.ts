import { createHash } from "node:crypto";

/** Raw normalized member/database inputs only; never include cached AI publications. */
export interface PlanningRevisionInput {
  policyVersion: string;
  entities: Record<string, unknown>;
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new Error("Planning revision inputs must contain only canonical JSON values");
}

export function planningInputRevision(input: PlanningRevisionInput): string {
  return createHash("sha256").update(canonicalJson(input)).digest("hex");
}

export function changedPlanningEntityIds(
  previous: PlanningRevisionInput,
  current: PlanningRevisionInput,
  tripId: string,
): string[] {
  const ids = new Set([...Object.keys(previous.entities), ...Object.keys(current.entities)]);
  const changed = [...ids].filter((id) => {
    if (!(id in previous.entities) || !(id in current.entities)) return true;
    return canonicalJson(previous.entities[id]) !== canonicalJson(current.entities[id]);
  });
  if (previous.policyVersion !== current.policyVersion && !changed.includes(tripId)) changed.push(tripId);
  return changed.sort();
}
