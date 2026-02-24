# Oxygen + Sanity Environment Auth — Technical Brief

> Companion to [oxygen-sanity-auth-proposal.md](oxygen-sanity-auth-proposal.md) (exec summary).
> Previous investigation docs: `oxygen-sanity-auth-options.md` (v1), `custom-auth-architecture.md` (v2).

---

## 1. Problem Statement

Oxygen's environment protection has four constraints that prevent it from supporting Sanity
Studio's Presentation tool on staging and dev environments:

### Constraint 1: Tokens Are Deployment-Scoped

Each token is bound to the deployment that generated it. A token from preview deployment A
is rejected by the stable staging environment URL (a different deployment).

**Evidence**: Preview deploy token (`gid://oxygen-hub/Deployment/4060612`) tested against
stable staging URL. Result: HTTP 302 redirect to Shopify OAuth.

### Constraint 2: 12-Hour Maximum TTL

`--auth-bypass-token-duration` accepts a maximum of 12 hours. The token kind is
`TESTING_AUTOMATION`. Studio Presentation sessions that span a workday break when the token
expires.

**Evidence**: `h2_deploy_log.json` from a staging deploy:

```json
{
  "url": "https://01khr8j2rx17z8c32e85yh6czr-f47de06af4f98b573090.myshopify.dev",
  "authBypassToken": "eyJhbGciOiJIUzI1NiJ9..."
}
```

JWT payload: `"kind": "TESTING_AUTOMATION"`, `"exp": 1771457758` (12h from `iat`).

### Constraint 3: No Programmatic Long-Lived Token API

| Kind                 | TTL       | Source                                                | Automated?      |
| -------------------- | --------- | ----------------------------------------------------- | --------------- |
| `TESTING_AUTOMATION` | 12h max   | `h2_deploy_log.json` (CLI)                            | Yes             |
| `USER_SHARED`        | No expiry | shopify[bot] PR comment, Admin dashboard Share button | PR deploys only |

`shopify[bot]` only comments on PR preview deploys — not staging or dev branch deploys.
No public API generates `USER_SHARED` tokens.

### Constraint 4: Third-Party Cookies Blocked in Iframes

Studio embeds the storefront in a cross-origin iframe. Oxygen's gateway sets an
`auth_bypass_token` cookie, but browsers block it:

- Safari ITP: Blocks by default
- Brave: Blocks by default
- Chrome 127+: Phasing out third-party cookies

**Evidence**: Oxygen's gateway cookie is not stored when the storefront loads inside Studio's
iframe.

---

## 2. Prior Art: Vercel + Sanity Protection Bypass

Vercel and Sanity built a deployment protection bypass system for exactly this problem.

### How It Works

1. Admin generates a 32-character bypass secret in the Vercel dashboard
2. Vercel exposes it as `VERCEL_AUTOMATION_BYPASS_SECRET` on all deployments
3. Admin stores the secret in a Sanity document via `@sanity/vercel-protection-bypass` plugin
4. Presentation tool reads the secret and appends it to the iframe URL:
   `?x-vercel-protection-bypass=SECRET&x-vercel-set-bypass-cookie=samesitenone`
5. Vercel's edge validates the secret, responds with 302 + `Set-Cookie` (`SameSite=None`)
6. All subsequent iframe requests carry the cookie

Key properties:

- Secret persists across deployments
- Cookie-based session after initial validation
- `SameSite=None` cookie works in cross-origin iframes
- Presentation tool has native, hardcoded support for Vercel bypass params

---

## 3. Proposed Architecture

### Core Change

**Set Oxygen staging and dev environments to Public.** Replace Oxygen's authentication with
Hydrogen server middleware that:

1. Checks for a valid session cookie (`SameSite=None; Secure; HttpOnly`)
2. If no cookie, checks for a bypass secret in the URL query parameter
3. If valid, sets the session cookie and redirects to a clean URL
4. If invalid or missing, returns HTTP 401

### Why Public Is Safe

The middleware runs in `server.ts`, the entry point for all requests to the Oxygen worker.
This includes page loads, React Router `.data` requests (client-side navigation), and static
assets. No request reaches the application without passing through the middleware.

Production remains Public with no middleware (env vars not set, middleware auto-skips).

### Cookie Behavior in Cross-Origin Iframes

Oxygen's gateway sets cookies without explicit `SameSite` attributes, which browsers block
in cross-origin iframes. Our middleware sets cookies with `SameSite=None; Secure` — the same
approach Vercel uses. The browser sends these cookies on all subsequent requests, including
`.data` fetches and iframe navigations. This replaces the client-side fetch interceptor
workaround that was necessary with Oxygen's gateway cookies.

**Validation needed**: Mirrors Vercel's pattern. Needs confirmation on Oxygen infrastructure
before implementation.

### How Our Approach Generally Could Mirror Vercel (Option 1)

| Vercel                                                 | Our Approach                                                 |
| ------------------------------------------------------ | ------------------------------------------------------------ |
| Secret generated in Vercel dashboard                   | Secret generated via `openssl rand -hex 16`                  |
| `VERCEL_AUTOMATION_BYPASS_SECRET` env var              | `STAGING_BYPASS_SECRET` / `DEV_BYPASS_SECRET` Oxygen env var |
| Stored in Sanity doc (`sanity.vercelProtectionBypass`) | Stored in Sanity doc (per environment)                       |
| Validated at Vercel's CDN edge                         | Validated in Hydrogen server middleware                      |
| 302 redirect + `SameSite=None` cookie                  | 302 redirect + `SameSite=None` cookie                        |
| Native Presentation tool support                       | Custom `previewMode` resolver reads Sanity doc               |

One architectural difference: Vercel validates at the CDN edge; we validate at the
application level. The cookie mechanism is identical.

---

## 4. Environment Architecture

### Environments

| Environment | Custom Domain    | Oxygen Setting | Auth Layer        | Sanity Dataset |
| ----------- | ---------------- | -------------- | ----------------- | -------------- |
| Production  | acme.com         | Public         | None              | `production`   |
| Staging     | staging.acme.com | Public         | Custom middleware | `staging`      |
| Dev         | dev.acme.com     | Public         | Custom middleware | `dev`          |
| Preview     | (per-deploy URL) | Private        | Oxygen 12h token  | configurable   |

### Studio Workspaces

| Workspace  | Custom Domain (Enterprise) | Dataset      | Presentation Target |
| ---------- | -------------------------- | ------------ | ------------------- |
| Production | cms.acme.com               | `production` | acme.com            |
| Staging    | cms-staging.acme.com       | `staging`    | staging.acme.com    |
| Dev        | cms-dev.acme.com           | `dev`        | dev.acme.com        |

1:1 mapping: workspace → dataset → environment → domain.

### User Types

| User Type             | Production             | Staging                                | Dev                                    | Preview          |
| --------------------- | ---------------------- | -------------------------------------- | -------------------------------------- | ---------------- |
| Public visitors       | Direct access          | —                                      | —                                      | —                |
| Editors (Studio)      | Presentation (no auth) | Presentation (middleware, transparent) | Presentation (middleware, transparent) | —                |
| Developers            | —                      | Middleware auth (link)                 | Middleware auth (link)                 | Oxygen 12h token |
| Stakeholders (QA/UAT) | —                      | Middleware auth (link or form)         | Middleware auth (link or form)         | —                |

### Oxygen Env Var Pattern

Oxygen does not allow the same env var name to have different values per environment. Each
environment gets its own named variable:

| Variable                 | Scoped To | Purpose                |
| ------------------------ | --------- | ---------------------- |
| `STAGING_BYPASS_SECRET`  | Staging   | Middleware auth secret |
| `DEV_BYPASS_SECRET`      | Dev       | Middleware auth secret |
| `SANITY_DATASET_STAGING` | Staging   | Sanity dataset name    |
| `SANITY_DATASET_DEV`     | Dev       | Sanity dataset name    |

At runtime, only the variable scoped to the current environment is defined.

---

## 5. Option Comparison

### Option A: Shared Secret

One static secret per environment. Middleware compares the string.

**Auth flow:**

```
First request:  ?bypass=SECRET → validate → 302 + Set-Cookie → clean URL
Subsequent:     Cookie present → pass through
Studio:         previewMode reads secret from Sanity doc → appends to iframe URL
Stakeholder:    Link with ?bypass=SECRET or passphrase in form
```

**Env vars**: 1 per environment
**Sanity docs**: 1 per environment
**Dependencies**: None
**Rotation**: Change secret in env var + Sanity doc. Redeploy. Share new link.

**Strengths**: Simplest implementation. Zero dependencies. Works in any JS runtime.
**Weaknesses**: No token expiry (manual rotation). No audit trail. Secret in URL on first request (stripped after redirect).

### Option B: Self-Issued JWT

One HMAC-SHA256 signed JWT per environment. Middleware verifies the signature.

**Auth flow:**

```
First request:  ?bypass=JWT → verify HMAC → 302 + Set-Cookie → clean URL
Subsequent:     Cookie present → pass through
Studio:         previewMode reads JWT from Sanity doc → appends to iframe URL
Stakeholder:    Link with ?bypass=JWT
```

**Env vars**: 1 per environment (HMAC signing key)
**Sanity docs**: 1 per environment (pre-generated JWT)
**Dependencies**: Web Crypto API (`crypto.subtle`, available in Oxygen)
**Rotation**: Generate new secret + JWT. Update env var + Sanity doc. Redeploy.

**Strengths**: Supports token expiry via `exp` claim. Tamper-proof (HMAC signature).
**Weaknesses**: Adds HMAC verification overhead. JWT generation is a manual step.

### Option C: TOTP + Session

Shared TOTP seed per environment. Middleware validates 30-second rotating codes and issues
session cookies.

**Auth flow:**

```
First request:  ?totp=123456 → validate TOTP → 302 + Set-Cookie → clean URL
Subsequent:     Cookie present → pass through
Studio:         previewMode reads seed → generates TOTP → appends to iframe URL
Stakeholder:    Visits site → TOTP form → enters code from authenticator app
```

**Env vars**: 2 per environment (TOTP seed + session signing secret)
**Sanity docs**: 1 per environment (TOTP seed)
**Dependencies**: TOTP library (runtime compatibility with Cloudflare Workers TBD)
**Rotation**: Generate new seed. Update env var + Sanity doc. Redistribute QR code.

**Strengths**: Active authentication required. Codes expire in 30s (URL sharing not a risk). Partial audit trail.
**Weaknesses**: Most complex. TOTP library runtime compatibility unverified. Stakeholders must install authenticator app. Cannot share a link for quick QA.

### Comparison Matrix

| Factor                 | A: Shared Secret         | B: JWT                | C: TOTP                         |
| ---------------------- | ------------------------ | --------------------- | ------------------------------- |
| Middleware complexity  | ~25 lines                | ~50 lines             | ~80 lines                       |
| External dependencies  | None                     | None (Web Crypto)     | TOTP library                    |
| Oxygen runtime compat  | Guaranteed               | Guaranteed            | Unverified                      |
| Token expiry           | No (manual rotation)     | Yes (exp claim)       | Yes (30s codes + session TTL)   |
| Stakeholder onboarding | Share URL or passphrase  | Share URL             | Install auth app + scan QR      |
| Audit trail            | None                     | None                  | Partial                         |
| Link sharing risk      | Secret in URL (one-time) | JWT in URL (one-time) | Not possible (code expires)     |
| Rotation effort        | 1 string change          | Generate secret + JWT | Generate seed + redistribute QR |

---

## 6. Open Items

### For Stakeholder Decision

1. **Compliance**: Does staging/dev access need audit trails or individual authentication?
   If yes, Option C. If not, A or B.
2. **Stakeholder UX**: Link-based access (A, B) or authenticator app (C)?
3. **Enterprise Sanity plan**: Custom Studio domains (cms.acme.com) require Enterprise plan.
   Confirm availability.

### For Technical Validation

1. **SameSite=None on Oxygen**: Validate `SameSite=None; Secure` cookies set by Hydrogen
   middleware persist in cross-origin iframes on Oxygen. Mirrors Vercel's pattern. Needs
   Oxygen-specific confirmation.
2. **TOTP library runtime**: If Option C, validate `otplib` or alternative works in
   Oxygen's Cloudflare Workers runtime.
3. **Crawler exposure**: Public Oxygen environments are accessible to crawlers. Middleware
   returns 401 (no content exposed). Add `X-Robots-Tag: noindex` header as defense-in-depth.

---

## Appendix A: Middleware Implementation (Option A)

```typescript
// app/lib/staging-auth.server.ts

const BYPASS_COOKIE = '_oxygen_bypass';
const BYPASS_PARAM = 'x-oxygen-protection-bypass';
const COOKIE_TTL = 60 * 60 * 24 * 30; // 30 days

export function validateProtectionBypass(
  request: Request,
  env: Env,
): Response | null {
  const secret = env.STAGING_BYPASS_SECRET || env.DEV_BYPASS_SECRET;
  if (!secret) return null; // production or preview — no custom auth

  // Check session cookie
  const cookieHeader = request.headers.get('Cookie') || '';
  const cookies = Object.fromEntries(
    cookieHeader
      .split('; ')
      .filter(Boolean)
      .map((c) => {
        const [k, ...v] = c.split('=');
        return [k, v.join('=')];
      }),
  );
  if (cookies[BYPASS_COOKIE] === secret) return null;

  // Check bypass query param
  const url = new URL(request.url);
  if (url.searchParams.get(BYPASS_PARAM) === secret) {
    const clean = new URL(url);
    clean.searchParams.delete(BYPASS_PARAM);
    return new Response(null, {
      status: 302,
      headers: {
        Location: clean.toString(),
        'Set-Cookie': [
          `${BYPASS_COOKIE}=${secret}`,
          'Path=/',
          'HttpOnly',
          'Secure',
          'SameSite=None',
          `Max-Age=${COOKIE_TTL}`,
        ].join('; '),
        'X-Robots-Tag': 'noindex',
      },
    });
  }

  return new Response('Unauthorized', {
    status: 401,
    headers: {'X-Robots-Tag': 'noindex'},
  });
}
```

### Wiring into server.ts

```typescript
// server.ts
import {validateProtectionBypass} from '~/lib/staging-auth.server';

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    // Auth check runs before all other handling
    const authResponse = validateProtectionBypass(request, env);
    if (authResponse) return authResponse;

    const hydrogenContext = await createHydrogenRouterContext(
      request,
      env,
      ctx,
    );
    // ... normal request handling
  },
};
```

---

## Appendix B: Studio previewMode Integration

Studio's `previewMode` reads the bypass secret from a Sanity document and appends it to
the iframe URL. Authentication is transparent to editors.

```typescript
// sanity.config.ts — per workspace
presentationTool({
  previewUrl: {
    initial: 'https://staging.acme.com',
    previewMode: {
      enable: '/api/preview-mode/enable',
    },
  },
});
```

The async `previewMode` function in the Hydrogen app reads the secret and constructs the
enable URL. The `environment` parameter varies per workspace configuration.

```typescript
async function resolvePreviewMode({client, targetOrigin}) {
  const doc = await client.fetch(
    `*[_type == "oxygenProtectionBypass" && environment == $env][0]{secret}`,
    {env: currentEnvironment}, // set per workspace
  );

  const base = `${targetOrigin}/api/preview-mode/enable`;
  return doc?.secret
    ? `${base}?x-oxygen-protection-bypass=${doc.secret}`
    : base;
}
```

---

## Appendix C: Secret Generation and Storage

### Generate (One-Time Per Environment)

```bash
# 32-character hex string (mirrors Vercel's format)
openssl rand -hex 16
# Example: a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6
```

### Store in Oxygen Env Vars

Each var scoped to its environment via Shopify Admin or CLI:

- `STAGING_BYPASS_SECRET` → Staging environment
- `DEV_BYPASS_SECRET` → Dev environment

### Store in Sanity Document

One document per environment. Studio reads this at runtime.

```json
{
  "_type": "oxygenProtectionBypass",
  "_id": "oxygenProtectionBypass.staging",
  "environment": "staging",
  "secret": "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"
}
```

### Rotation

1. Generate new secret: `openssl rand -hex 16`
2. Update Oxygen env var → redeploy
3. Update Sanity document
4. Distribute new link to stakeholders
5. Old session cookies invalidated immediately

---

## Appendix D: Preview Deployments (Developer-Only)

Preview deployments stay on Oxygen's native Private auth with 12h tokens. No custom
middleware. No Studio Presentation tool support.

Optional: CI stores per-PR deployment metadata in Sanity for URL discovery:

```json
{
  "_type": "previewDeployment",
  "_id": "previewDeployment.pr-13",
  "prNumber": 13,
  "headBranch": "feat/new-feature",
  "baseBranch": "staging",
  "deploymentUrl": "https://...",
  "tokenExpiresAt": "2026-02-19T22:00:00Z"
}
```

CI cleanup workflow deletes the doc when the PR closes or merges.

---

## Appendix E: Evidence Log

| Claim                                  | Method                                                                   | Date       |
| -------------------------------------- | ------------------------------------------------------------------------ | ---------- |
| Tokens are deployment-scoped           | Preview deploy token tested against stable staging URL → 302             | 2026-02-18 |
| 12h max TTL                            | `h2_deploy_log.json` JWT payload inspection                              | 2026-02-18 |
| No USER_SHARED API                     | shopify[bot] behavior observation + Shopify docs review                  | 2026-02-18 |
| Third-party cookies blocked            | Oxygen gateway cookie inspection in cross-origin iframe (Safari, Chrome) | 2026-02-16 |
| previewMode can query Sanity           | E2E test: async function receives `{client, targetOrigin}`               | 2026-02-17 |
| server.ts intercepts .data requests    | React Router 7 architecture analysis + server.ts entry point trace       | 2026-02-19 |
| Datasets need public ACL for CDN       | Private dataset CDN query returned null; public returned document        | 2026-02-18 |
| Stable env URLs persist across deploys | Multiple deploys observed same `{env}-{hash}.o2.myshopify.dev` URL       | 2026-02-16 |
| Custom domains per Oxygen env          | Shopify Oxygen environment settings confirmation                         | 2026-02-19 |
