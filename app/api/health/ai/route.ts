import { aiLivenessHandler } from "@/lib/ai/liveness";

export const dynamic = "force-dynamic";

/**
 * Can the configured AI provider answer RIGHT NOW?
 *
 *   GET /api/health/ai            free.
 *   GET /api/health/ai?probe=1    a real call. 200 or 503. Needs AI_PROBE_SECRET,
 *                                 via the `x-probe-secret` header or `?secret=`.
 *
 * Separate from /api/health on purpose: that route answers "is the app up and
 * is the schema sound" for deploy gates, and a dead provider key must never
 * fail it — a restart cannot fix a key. This one is the inverse, so a monitor
 * can page on a real AI outage without paging on every deploy.
 *
 * NO PATIENT DATA CROSSES THIS ROUTE. It asks a fixed, meaningless question
 * about the colour of the sky. Every clinical AI route is consent-gated and
 * carries a patient digest; this deliberately carries nothing, so it is safe to
 * run unattended and it still proves the transport and the credentials.
 *
 * It calls `aiChat`, so it reaches the operator-configured EU/CH endpoint that
 * lib/config/regulation.ts governs — never ai-kit's US-hosted default chain.
 */
export const GET = aiLivenessHandler;
