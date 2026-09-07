/**
 * Can the clinic's AI provider answer RIGHT NOW?
 *
 * Every AI route here is behind a session AND a patient-consent gate — the
 * insight route, both admin briefs, the thread assistant. So "does the provider
 * answer?" could only be checked by signing in and running a real analysis over
 * a real patient's data. That is a bad way to test a deploy, and it means the
 * answer was usually "nobody knows".
 *
 * ── The probe carries NO patient data ────────────────────────────────────────
 * This matters more here than anywhere else in the fleet. It sends a fixed,
 * meaningless question about the colour of the sky — no digest, no profile, no
 * identifiers. It exercises the transport and the credentials, which is all a
 * liveness check should ever need, and it is safe to run unattended on a
 * schedule precisely because there is nothing personal in it.
 *
 * ── It probes THE configured provider, not a fleet default ───────────────────
 * `ask` calls `aiChat`, the same function the clinical routes use, so the probe
 * goes to whatever endpoint the operator configured in AI_BASE_URL — the one
 * chosen against lib/config/regulation.ts for EU/CH residency. A probe built on
 * ai-kit's default `freeChain()` would talk to Groq and OpenRouter, which is
 * exactly the thing this app must not do.
 *
 * ── Gating and caching are ai-kit's ──────────────────────────────────────────
 * Only on `?probe=1` WITH the secret, a success cached ten minutes, a failure
 * never cached, and 501 rather than an open endpoint when no secret is set.
 */

import { createAiHealthHandler } from "@bitbaum/ai-kit";

import { aiChat, isAiConfigured } from "./index";

/**
 * Built lazily. Next evaluates module-level code during the BUILD, where the
 * runtime's env is absent — an eagerly-built handler would capture it and
 * report a dead provider forever on a deployment that is fine.
 */
let handler: ((request: Request) => Promise<Response>) | null = null;

export function aiLivenessHandler(request: Request): Promise<Response> {
  handler ??= createAiHealthHandler({
    // A getter, not a value: the handler is built once and reused, so a plain
    // string would be whatever the environment held on the first request —
    // un-rotatable without a restart, and untestable.
    secret: () => process.env.AI_PROBE_SECRET,
    ask: async () => {
      if (!isAiConfigured()) {
        // Distinct from "the provider refused": nothing was ever going to be
        // called, and the fix is configuration rather than the vendor.
        throw new Error("AI provider not configured (AI_BASE_URL / AI_API_KEY / AI_MODEL)");
      }

      const result = await aiChat({
        system: "Answer with a single word, no punctuation.",
        user: "What colour is a clear midday sky? Answer in one word.",
        // Generous on purpose: a reasoning model spends this budget thinking
        // before emitting a visible token, and an empty completion is a
        // failure — a mean budget would make a healthy deployment look dead.
        maxTokens: 256,
      });

      if (!result.ok) throw new Error(result.error);
      return { text: result.text, id: process.env.AI_MODEL ?? "clinic-ai" };
    },
  });
  return handler(request);
}
