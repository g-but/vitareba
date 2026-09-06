import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * aiChat — the request is the fleet engine's now; the PROVIDER is still the
 * operator's.
 *
 * Two separate things are locked here, and the second matters more than the
 * first. One is the set of judgements that came with `complete()`. The other
 * is that adopting a shared AI package did NOT quietly widen where patient
 * data may go: this clinic's provider is chosen against regulation.ts, and the
 * fleet's default chain is US-hosted.
 */

const ORIGINAL_ENV = { ...process.env };

async function loadAiChat() {
  vi.resetModules();
  return (await import("./index")).aiChat;
}

function completion(content: string) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const ASK = { system: "Du bist Arzt.", user: "Zusammenfassung?" };

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => completion("Befund."));
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "error").mockImplementation(() => {});
  process.env.AI_BASE_URL = "https://api.mistral.ai/v1";
  process.env.AI_API_KEY = "clinic-key";
  process.env.AI_MODEL = "mistral-large-latest";
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  process.env = { ...ORIGINAL_ENV };
});

describe("aiChat data residency", () => {
  it("only ever calls the operator-configured endpoint", async () => {
    const aiChat = await loadAiChat();
    await aiChat(ASK);

    // The fleet's freeChain() is Groq then OpenRouter, both US-hosted and
    // neither under a DPA with this clinic. Adopting the shared engine must
    // never widen where health data goes; if this assertion ever fails, the
    // failure is a data protection breach, not a test needing an update.
    for (const [url] of fetchMock.mock.calls) {
      expect(String(url)).toContain("api.mistral.ai");
    }
    expect(fetchMock).toHaveBeenCalled();
  });

  it("sends nothing at all when the provider is not configured", async () => {
    delete process.env.AI_API_KEY;
    const aiChat = await loadAiChat();

    const res = await aiChat(ASK);

    expect(res).toEqual({ ok: false, error: "AI provider not configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads AI_BASE_URL at call time, so a build with no env cannot freeze a dead client", async () => {
    // Next evaluates module-level code during the build, where these vars are
    // absent. Loading the module with nothing set and configuring afterwards
    // is exactly that sequence.
    process.env.AI_BASE_URL = "";
    process.env.AI_API_KEY = "";
    process.env.AI_MODEL = "";
    const aiChat = await loadAiChat();

    process.env.AI_BASE_URL = "https://ai.ionos.de/v1";
    process.env.AI_API_KEY = "k";
    process.env.AI_MODEL = "llama-eu";

    const res = await aiChat(ASK);

    expect(res.ok).toBe(true);
    expect(String(fetchMock.mock.calls[0][0])).toContain("ai.ionos.de");
  });
});

describe("aiChat request handling", () => {
  it("returns the model's text", async () => {
    const aiChat = await loadAiChat();
    await expect(aiChat(ASK)).resolves.toEqual({ ok: true, text: "Befund." });
  });

  it("an empty 200 is a failure, never an empty brief handed to a clinician", async () => {
    fetchMock.mockResolvedValue(completion("   "));
    const aiChat = await loadAiChat();

    const res = await aiChat(ASK);

    expect(res.ok).toBe(false);
  });

  it("a second AI_MODEL rescues a rotted model id, at the SAME endpoint", async () => {
    process.env.AI_MODEL = "mistral-retired, mistral-large-latest";
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      const model = JSON.parse(String(init.body)).model;
      if (model === "mistral-retired") {
        return new Response(JSON.stringify({ error: "unknown model" }), { status: 404 });
      }
      return completion("Zweites Modell antwortet.");
    });
    const aiChat = await loadAiChat();

    const res = await aiChat(ASK);

    expect(res).toEqual({ ok: true, text: "Zweites Modell antwortet." });
    for (const [url] of fetchMock.mock.calls) {
      expect(String(url)).toContain("api.mistral.ai");
    }
  });

  it("a daily 429 tells the clinician WHICH kind of limit, not a status code", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { message: "Rate limit reached for requests per day. Limit 1000, used 1000." },
        }),
        { status: 429 },
      ),
    );
    const aiChat = await loadAiChat();

    const res = await aiChat(ASK);

    expect(res.ok).toBe(false);
    // "AI provider error (429)" told a clinician nothing. "Try again tomorrow"
    // and "try again in a minute" are different instructions, and only the
    // response body distinguishes them.
    expect(res.ok === false && res.error).toMatch(/daily/i);
  });

  it("a transport failure is reported as unreachable, not as an empty answer", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    const aiChat = await loadAiChat();

    const res = await aiChat(ASK);

    expect(res.ok).toBe(false);
  });

  it("gives each attempt a deadline — a hung provider must not hold a clinician's request open", async () => {
    let sawSignal = false;
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      sawSignal = Boolean(init.signal);
      return completion("Befund.");
    });
    const aiChat = await loadAiChat();

    await aiChat(ASK);

    // The previous implementation passed no signal at all, so a provider that
    // accepted the connection and never answered was waited on forever.
    expect(sawSignal).toBe(true);
  });
});
