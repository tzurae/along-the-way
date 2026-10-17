import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../apps/api/src/app";

function dependencyStub() {
  return {} as never;
}

describe("request failure logging", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("records the error class without logging its message", async () => {
    const logged: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line) => {
      logged.push(String(line));
    });
    const identityAccess = {
      authenticate() {
        throw new TypeError("private trip title must never reach logs");
      },
    };
    const app = createApp({
      collaboration: dependencyStub(),
      dayPlans: dependencyStub(),
      discovery: dependencyStub(),
      identityAccess: identityAccess as never,
      placeDetails: dependencyStub(),
      rateLimiter: dependencyStub(),
      readiness: dependencyStub(),
      siteAddress: "https://app.example.test",
      tripWorkspace: dependencyStub(),
      tripSkeleton: dependencyStub(),
      tripPlaces: dependencyStub(),
    });

    const response = await app.request("/api/session");

    expect(response.status).toBe(500);
    expect(logged).toHaveLength(1);
    const entry = JSON.parse(logged[0]!) as Record<string, unknown>;
    expect(entry).toMatchObject({
      event: "request_failed",
      errorClass: "TypeError",
      result: "failed",
    });
    expect(logged[0]).not.toContain("private trip title");
  });
});
