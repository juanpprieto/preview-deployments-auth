# Oxygen + Sanity Environment Auth Proposal

## Problem

Shopify Oxygen's built-in environment protection breaks persistent authentication for
Sanity Studio's Presentation tool on staging and dev environments.

**Validated constraints:**

| Constraint | Impact | Evidence |
|---|---|---|
| Tokens are deployment-scoped | Token from deploy A rejected by deploy B's stable URL | Preview deploy token → 302 on stable staging URL |
| CLI tokens max 12h TTL | Studio Presentation sessions break mid-day | `--auth-bypass-token-duration 12` is the hard max |
| No public API for long-lived tokens | Cannot automate token generation for stable environments | shopify[bot] only comments on PR deploys, not branch deploys |
| Third-party cookies blocked in iframes | Oxygen's gateway cookie rejected inside Studio's iframe | Validated in Safari, Brave, Chrome 127+ |

Editors need stable, uninterrupted access to staging and dev through Studio. Oxygen auth
cannot provide this.

## Proposed Architecture

**Set Oxygen staging and dev environments to Public.** Replace Oxygen's authentication with
server middleware in the Hydrogen application. The middleware validates a shared secret and
sets a `SameSite=None; Secure` cookie that works in cross-origin iframes.

- **Production**: Public, no middleware (public-facing site)
- **Staging / Dev**: Public, protected by custom middleware
- **Preview**: Private, Oxygen 12h tokens (developer-only, ephemeral)

This pattern mirrors how Vercel and Sanity built their deployment protection bypass — a
system already shipping in production across the Vercel + Sanity ecosystem.

## Options

| Factor | A: Shared Secret | B: Self-Issued JWT | C: TOTP + Session |
|---|---|---|---|
| **How it works** | Static secret per env; string comparison | Signed token per env; HMAC verification | Time-rotating 6-digit code; validates and issues session |
| **Complexity** | Minimal | Medium — Web Crypto API | High — TOTP library + session signing |
| **Dependencies** | None | None (platform Web Crypto) | TOTP library (runtime compat TBD) |
| **Studio editors** | Transparent — Studio reads secret from Sanity doc automatically | Transparent — Studio reads JWT from Sanity doc automatically | Transparent — Studio generates TOTP code from seed automatically |
| **First-time setup** | Share a pre-built URL or passphrase | Share a pre-built URL | Distribute QR code; each person installs authenticator app |
| **Repeat access** | Cookie persists (30 days); no re-auth needed | Cookie persists (30 days); no re-auth needed | Cookie persists (30 days); re-auth only after expiry via authenticator app |
| **Audit / identity** | None | None | Partial (active auth required) |
| **Rotation** | Change 1 string | Regenerate secret + token | Regenerate seed + redistribute QR |
| **Survives redeployment** | Yes | Yes | Yes |
| **Compliance** | Content protection | Content protection | Stronger for audit / active auth needs |

## What Favors Each Option

- **Choose A** if the goal is simplest protection for unreleased content with minimal operations.
- **Choose B** if you want token expiry (configurable TTL) without external dependencies.
- **Choose C** if compliance or audit requirements demand active authentication or individual revocability.

## Open Items

1. **Compliance requirements**: Does staging/dev access need audit trails or individual identity?
   If yes, Option C. If no, Option A.
2. **Stakeholder UX**: Link-based access (A, B) vs authenticator app (C). Team size and
   technical comfort matter.
3. **SameSite=None cookie validation**: All options set `SameSite=None; Secure` cookies for
   cross-origin iframe support. Mirrors Vercel's pattern. Needs validation on Oxygen before
   implementation.

## Prior Art: Vercel + Sanity

Vercel and Sanity built a deployment protection bypass system native to the Presentation
tool. A shared secret is stored in a Sanity document, appended to the iframe URL, validated
at the edge, then exchanged for a `SameSite=None` cookie. Our approach replicates this at
the application middleware level. Full comparison in the [technical brief](oxygen-sanity-auth-brief.md).

## Environments

| Environment | Domain | Auth | Studio Workspace |
|---|---|---|---|
| Production | acme.com | None | cms.acme.com |
| Staging | staging.acme.com | Middleware | cms-staging.acme.com |
| Dev | dev.acme.com | Middleware | cms-dev.acme.com |
| Preview | (per-deploy URL) | Oxygen 12h token | (none) |
