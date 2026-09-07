/// <reference types="vitest/globals" />
/**
 * Middleware/route auth alignment — regression net.
 *
 * proxy.ts session-gates all of /api EXCEPT the prefixes listed in
 * PUBLIC_API_PREFIXES (lib/config/routes.ts). That split rots silently in
 * both directions:
 *
 *  1. A route that must be public (login callback, registration, webhook)
 *     but is NOT under a public prefix → the middleware 401s it and the
 *     feature dies in prod while every route test stays green (this exact
 *     bug shipped: /api/auth/* was gated, so nobody could log in).
 *  2. A route under a public prefix that reads private data WITHOUT its own
 *     requireSession/requireAdmin guard → open endpoint.
 *
 * This file pins the invariant: every route.ts under app/api either lives
 *  under a public prefix (and any session-bound handler in it self-guards)
 *  or imports a guard from lib/auth/guards.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { PUBLIC_API_PREFIXES } from "@/lib/config/routes";

const API_DIR = join(__dirname);

function collectRouteFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return collectRouteFiles(full);
    return entry === "route.ts" ? [full] : [];
  });
}

/** /home/…/app/api/admin/patients/[id]/route.ts → /api/admin/patients/[id] */
function routePath(file: string): string {
  const rel = relative(API_DIR, file).split(sep).slice(0, -1).join("/");
  return rel ? `/api/${rel}` : "/api";
}

const GUARD_IMPORT = /from ["']@\/lib\/auth\/guards["']/;

// Public routes with no guard import — each must authenticate or constrain
// itself by other means. Adding a file here is a deliberate act: say why.
const SELF_AUTHENTICATING = new Set<string>([
  "/api/auth/[...nextauth]", // NextAuth handler — its own CSRF/session machinery
  "/api/auth/forgot-password", // deliberately unauthenticated; no data returned
  "/api/auth/reset-password", // authenticates via single-use reset token
  "/api/account", // registration; Zod-validated, creates (never reads) a user
  "/api/assessment-leads", // anonymous funnel counter — no PII in or out
  "/api/health", // liveness probe — returns nothing sensitive
  // AI liveness probe. Authenticates itself with AI_PROBE_SECRET (constant-time
  // compare, in @bitbaum/ai-kit) rather than a session, because the callers are
  // uptime monitors and deploy scripts, which have no user to be. It reads no
  // patient data and sends none: the probe asks a fixed question about the
  // colour of the sky. Without the secret it is 401; with no secret configured
  // it is 501, so a deployment that forgets to set one cannot be made to spend
  // money by a stranger.
  "/api/health/ai",
  // Calendar subscription feed: clients send no cookies, so the URL is the
  // credential — an HMAC of the user id verified in the handler.
  "/api/calendar/[id]/[token]",
]);

const CRON_SECRET_CHECK = /CRON_SECRET/;

describe("middleware/route auth alignment", () => {
  const files = collectRouteFiles(API_DIR);

  it("finds the API surface (sanity)", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  for (const file of files) {
    const route = routePath(file);
    const src = readFileSync(file, "utf8");
    const isPublic = PUBLIC_API_PREFIXES.some((p) => route === p || route.startsWith(p + "/"));

    if (isPublic) {
      it(`${route} (public prefix) authenticates itself`, () => {
        const ok =
          GUARD_IMPORT.test(src) ||
          SELF_AUTHENTICATING.has(route) ||
          (route.startsWith("/api/cron") && CRON_SECRET_CHECK.test(src));
        expect(
          ok,
          `${route} is exempt from the middleware session gate but has no ` +
            `guard import, no CRON_SECRET check, and is not in the ` +
            `SELF_AUTHENTICATING allowlist`,
        ).toBe(true);
      });
    } else {
      it(`${route} (session-gated) still self-guards`, () => {
        // Defense in depth: the middleware 401s these without a session, but
        // authorization (whose data?) lives in the route — via guards.
        expect(
          GUARD_IMPORT.test(src),
          `${route} relies on the middleware alone — import requireSession/` +
            `requireAdmin from lib/auth/guards`,
        ).toBe(true);
      });
    }
  }
});
