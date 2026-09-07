import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Every AI route in this app is behind a session AND a patient-consent gate, so
 * "does the provider answer?" could only be checked by signing in and running a
 * real analysis over a real patient's data. This route answers it without
 * either — and, critically, without any patient data at all.
 *
 * ai-kit owns the gating, the caching and the never-cache-a-failure rule. What
 * is app-specific, and what these hold, is that the probe reaches the
 * OPERATOR-CONFIGURED endpoint (never a US-hosted fleet default) and that it
 * carries nothing personal.
 */

/**
 * Each test loads the module FRESH: the handler is a module-level singleton
 * (the probe's cache lives in it) and a success is cached ten minutes, so a
 * shared instance would let the first success answer every later case.
 */
async function loadHandler() {
  vi.resetModules();
  return (await import("./liveness")).aiLivenessHandler;
}

const ORIGINAL_ENV = { ...process.env };

/** Built PER CALL: one Response body can be read only once. */
function completion(content: string) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  process.env.AI_BASE_URL = "https://api.mistral.ai/v1";
  process.env.AI_API_KEY = "clinic-key";
  process.env.AI_MODEL = "mistral-large-latest";
  delete process.env.AI_PROBE_SECRET;
  fetchMock = vi.fn(async () => completion("blue"));
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  process.env = { ...ORIGINAL_ENV };
});

describe("GET /api/health/ai", () => {
  it("an ordinary poll costs nothing", async () => {
    const handler = await loadHandler();
    const res = await handler(new Request("https://v.test/api/health/ai"));

    expect(res.status).toBe(200);
    expect((await res.json()).probed).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses to probe without the secret, and spends nothing while refusing", async () => {
    process.env.AI_PROBE_SECRET = "right";
    const handler = await loadHandler();

    expect((await handler(new Request("https://v.test/api/health/ai?probe=1"))).status).toBe(401);
    expect(
      (await handler(new Request("https://v.test/api/health/ai?probe=1&secret=nope"))).status,
    ).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("with AI_PROBE_SECRET unset, probing is OFF (501) rather than open", async () => {
    const handler = await loadHandler();
    const res = await handler(new Request("https://v.test/api/health/ai?probe=1&secret=anything"));

    expect(res.status).toBe(501);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reaches ONLY the operator-configured endpoint", async () => {
    process.env.AI_PROBE_SECRET = "right";
    const handler = await loadHandler();

    const res = await handler(new Request("https://v.test/api/health/ai?probe=1&secret=right"));

    expect(res.status).toBe(200);
    // ai-kit's default chain is Groq then OpenRouter, both US-hosted and
    // neither under a DPA with this clinic. A probe that reached them would be
    // a data protection problem even though it carries no patient data — the
    // point is that this app talks to one endpoint, chosen deliberately.
    for (const [url] of fetchMock.mock.calls) {
      expect(String(url)).toContain("api.mistral.ai");
    }
  });

  it("carries NO patient data — only a fixed, meaningless question", async () => {
    process.env.AI_PROBE_SECRET = "right";
    const handler = await loadHandler();

    await handler(new Request("https://v.test/api/health/ai?probe=1&secret=right"));

    const [, init] = fetchMock.mock.calls[0];
    const body = String(init.body);
    // It runs unattended on a schedule. Anything patient-shaped in here would
    // be sent to a third party on a timer, with nobody watching.
    expect(body).toContain("clear midday sky");
    expect(body).not.toMatch(/patient|digest|checkin|assessment|goal|medication/i);
  });

  it("an unconfigured provider is 503 and says so, rather than looking healthy", async () => {
    process.env.AI_PROBE_SECRET = "right";
    delete process.env.AI_API_KEY;
    const handler = await loadHandler();

    const res = await handler(new Request("https://v.test/api/health/ai?probe=1&secret=right"));

    expect(res.status).toBe(503);
    // "not configured" and "the vendor refused" want different fixes.
    expect(JSON.stringify(await res.json())).toMatch(/not configured/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a refusing provider is 503", async () => {
    process.env.AI_PROBE_SECRET = "right";
    fetchMock.mockImplementation(async () => new Response("upstream exploded", { status: 500 }));
    const handler = await loadHandler();

    const res = await handler(new Request("https://v.test/api/health/ai?probe=1&secret=right"));

    expect(res.status).toBe(503);
  });

  it("an EMPTY 200 is a failure, never an empty brief reported as health", async () => {
    process.env.AI_PROBE_SECRET = "right";
    fetchMock.mockImplementation(async () => completion("   "));
    const handler = await loadHandler();

    const res = await handler(new Request("https://v.test/api/health/ai?probe=1&secret=right"));

    expect(res.status).toBe(503);
  });
});
