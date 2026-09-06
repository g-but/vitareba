/**
 * AI provider — OpenAI-compatible chat completions, via the fleet engine.
 *
 * Health data leaves this server ONLY when all three env vars are set, which
 * is a deliberate operator act: the provider must be EU/CH-hosted and under a
 * signed data-processing agreement (GDPR Art. 28 / revFADP) — e.g. Mistral
 * (Paris), IONOS AI (Berlin), a self-hosted vLLM. US-hosted APIs without an
 * adequacy basis fail Schrems II — see lib/config/regulation.ts.
 *
 *   AI_BASE_URL  e.g. https://api.mistral.ai/v1
 *   AI_API_KEY   provider key
 *   AI_MODEL     e.g. mistral-large-latest (comma-separated for a fallback)
 *
 * ── Why this uses @bitbaum/ai-kit but NOT its default chain ──────────────────
 * The fleet's `freeChain()` is Groq then OpenRouter: both US-hosted, neither
 * under a DPA with this clinic. Pointing patient data at it would be a data
 * protection breach, so the provider stays exactly where the operator put it —
 * one endpoint, chosen deliberately, checked against regulation.ts.
 *
 * What the engine is used for is the REQUEST, which is where the defects were:
 *
 *   - NO DEADLINE. The previous `fetch` had no timeout at all, so a provider
 *     that accepted the connection and never answered held a clinician's
 *     request open indefinitely. `complete()` abandons a link after 30s.
 *   - 429 UNREAD. "AI provider error (429)" told a clinician nothing and the
 *     operator less. The three kinds of 429 share a status code and want
 *     opposite responses; only the body tells them apart, and the body was
 *     logged and thrown away. A daily quota that resets in four hours can now
 *     say so.
 *   - AN EMPTY 200 was already treated as a failure here, which is more than
 *     most of this fleet managed. That judgement is now the engine's, and it
 *     stays.
 *
 * AI_MODEL accepts a comma-separated list so a rotted model id has somewhere
 * to fall. Every entry is served by the SAME operator-configured endpoint, so
 * a longer list changes nothing about where the data goes.
 */

import { complete, ChainExhaustedError, rateLimitMessage, type Link } from "@bitbaum/ai-kit";

export function isAiConfigured(): boolean {
  return Boolean(process.env.AI_BASE_URL && process.env.AI_API_KEY && process.env.AI_MODEL);
}

/**
 * Set AI_DPA_SIGNED=true once the provider is EU/CH-hosted under a signed
 * data-processing agreement. Until then AI features still run — house rule —
 * but every response carries a legal warning the UI must show.
 */
export function isAiDpaSigned(): boolean {
  return process.env.AI_DPA_SIGNED === "true";
}

export type AiResult = { ok: true; text: string } | { ok: false; error: string };

/**
 * The one provider this deployment is allowed to talk to.
 *
 * Built per call, never at module scope: Next evaluates module-level code
 * during the BUILD, where these env vars are absent, and a chain frozen there
 * would stay permanently empty on a deployment whose configuration is fine.
 */
function configuredChain(): Link[] {
  const models = (process.env.AI_MODEL ?? "")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);

  if (models.length === 0) return [];

  const provider = {
    id: "clinic-ai",
    baseUrl: (process.env.AI_BASE_URL ?? "").replace(/\/+$/, ""),
    keyEnv: "AI_API_KEY",
    models,
    // Not a free tier with a published cap. This figure only feeds ai-kit's
    // rationing helpers, which this app does not call — stated at zero rather
    // than invented, because a generous guess produces the exact wall the
    // rationing exists to prevent.
    dailyTokens: 0,
  };

  return models.map((model) => ({ provider, model }));
}

export async function aiChat({
  system,
  user,
  maxTokens = 900,
}: {
  system: string;
  user: string;
  maxTokens?: number;
}): Promise<AiResult> {
  if (!isAiConfigured()) {
    return { ok: false, error: "AI provider not configured" };
  }

  const chain = configuredChain();
  if (chain.length === 0) {
    return { ok: false, error: "AI provider not configured" };
  }

  try {
    const result = await complete({
      chain,
      env: process.env,
      maxTokens,
      temperature: 0.3,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });
    return { ok: true, text: result.text.trim() };
  } catch (err) {
    if (err instanceof ChainExhaustedError) {
      // Every link's failure, not only the last — the detail belongs in the
      // log, where the person fixing it is already looking.
      console.error(
        "[ai] every configured model failed:",
        err.failures.map((f) => f.message).join(" | "),
      );

      // A rate limit is the one failure a clinician can act on — "try again
      // after lunch" is a different instruction from "this is broken" — so say
      // which kind it was instead of repeating a bare status code at them.
      const rateLimited = err.failures.find((f) => f.message.includes("429"));
      if (rateLimited) {
        return { ok: false, error: `AI unavailable — ${rateLimitMessage(rateLimited.message)}` };
      }
      return { ok: false, error: "AI provider error" };
    }

    console.error("[ai] request failed:", err);
    return { ok: false, error: "AI provider unreachable" };
  }
}
