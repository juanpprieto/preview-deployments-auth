# Custom Auth Architecture for Oxygen + Sanity Presentation

> Supersedes `oxygen-sanity-auth-options.md` (v1). That doc remains as historical reference for
> why Oxygen-native auth was rejected.

## Context

Shopify Oxygen's built-in auth (Private environments) is unworkable for multi-environment
Sanity Presentation tool integration:

1. **Tokens are deployment-scoped** — die on redeploy, stable env URL rejects other deployments' tokens
2. **12h max TTL** for CLI-generated tokens (`TESTING_AUTOMATION`)
3. **No automated `USER_SHARED` tokens** for branch deploys — only shopify[bot] PR comments and Admin dashboard
4. **Last-writer-wins** when multiple PRs sync to a shared bypass doc

**Solution**: Set Oxygen environments to **Public**. Replace Oxygen auth with a Hydrogen
middleware that validates self-issued credentials. Middleware IS the auth layer.

---

## Scope

### Environments

| Environment | Oxygen URL | Custom Domain | Oxygen Setting | Dataset | Auth |
|---|---|---|---|---|---|
| **Production** | `*.o2.myshopify.dev` | `acme.com` | Public | `production` | None (public site) |
| **Staging** | `*.o2.myshopify.dev` | `staging.acme.com` | Public | `staging` | Custom middleware |
| **Dev** | `*.o2.myshopify.dev` | `dev.acme.com` | Public | `dev` | Custom middleware |
| **Preview** | per-deploy URL | (none) | Private (Oxygen) | configurable | Oxygen 12h token |

### Studio Workspaces

| Workspace | Studio Domain (Enterprise) | Dataset | Presentation Tool Target |
|---|---|---|---|
| **Production** | `cms.acme.com` | `production` | `acme.com` |
| **Staging** | `cms-staging.acme.com` | `staging` | `staging.acme.com` |
| **Dev** | `cms-dev.acme.com` | `dev` | `dev.acme.com` |

Each workspace has its own Presentation tool pointing at the stable custom domain for that
environment. 1:1 mapping: workspace → dataset → environment → domain.

### User Types × Environments

| User Type | Production | Staging | Dev | Preview |
|---|---|---|---|---|
| **Public visitors** | Direct access | — | — | — |
| **Editors (Studio)** | Presentation tool (no auth) | Presentation tool (middleware auth) | Presentation tool (middleware auth) | — |
| **Developers** | — | Middleware auth (link/token) | Middleware auth (link/token) | Oxygen 12h token |
| **Stakeholders (QA/UAT)** | — | Middleware auth (TBD: link or TOTP) | Middleware auth (TBD: link or TOTP) | — |

---

## Comparison Matrix

| Criteria | Oxygen Auth (Rejected) | Option 1: Static JWT | Option 2: Auto-TOTP | Option 3: Passphrase | **Option 4: Vercel-Style** |
|---|---|---|---|---|---|
| **Session TTL** | 12h max / deploy-scoped | Unlimited (configurable exp) | Session JWT: configurable | Cookie: 30d (configurable) | **Cookie: 30d (configurable)** |
| **Survives redeploy** | No (tokens die) | Yes | Yes | Yes | **Yes** |
| **Works with stable URL** | No (deployment-scoped) | Yes | Yes | Yes | **Yes** |
| **CI automation needed** | Complex (shopify[bot]) | **None** | **None** | **None** | **None** |
| **Studio Presentation** | Fragile | previewMode reads JWT | previewMode generates TOTP | previewMode reads passphrase | **previewMode reads secret (existing schema!)** |
| **Stakeholder access** | `?_auth=TOKEN` | `?_preview=JWT` | TOTP form | `?_pass=` or form | **`?x-oxygen-protection-bypass=` or 401** |
| **Identity/audit** | None | None | Partial | None | **None** |
| **External dependencies** | Shopify (bot, Admin) | None | `otplib` | None | **None** |
| **Oxygen env setting** | Private | Public | Public | Public | **Public** |
| **Implementation** | Built (broken) | ~50 lines + crypto | ~80 lines + TOTP lib | ~30 lines | **~25 lines** |
| **Crypto required** | N/A | `crypto.subtle` | TOTP lib | None or HMAC | **None** |
| **Secrets per env** | N/A | 1 HMAC secret | 2 (seed + session) | 1 passphrase | **1 bypass secret** |
| **Iframe cookie** | Broken (3rd-party) | Needs fetch interceptor | Needs fetch interceptor | Needs fetch interceptor | **SameSite=None (native, like Vercel!)** |
| **Existing infra** | Schema + CI built | New schema needed | New schema needed | New schema needed | **Reuses existing schema + docs** |
| **Proven pattern** | Shopify-specific | Custom | Custom | Custom | **Vercel + Sanity battle-tested** |
| **Failure mode** | Silent 302 | 401 | TOTP form or 401 | Password form or 401 | **401** |

---

## Option 1: Static Self-Issued JWT

### Overview

One long-lived JWT per environment, signed with an HMAC secret stored as an Oxygen env var.
The JWT is generated once (manually or via script), stored in a Sanity document, and read by
Studio's `previewMode` function to authenticate the Presentation tool iframe.

No CI token generation. No per-deploy sync. The JWT is valid until the HMAC secret is rotated.

### Architecture

```
                   ┌─ Oxygen (Public) ─────────────────────────────┐
                   │                                               │
Request ──────────►│  Hydrogen Middleware (server.ts)               │
                   │  ├── env.STAGING_AUTH_SECRET set?              │
                   │  │   ├── No  → skip auth (production)         │
                   │  │   └── Yes → validate JWT from:             │
                   │  │       ├── ?_preview= query param           │
                   │  │       ├── x-preview-token header           │
                   │  │       └── _preview cookie                  │
                   │  ├── Valid JWT? → set cookie, continue to app │
                   │  └── Invalid/missing? → 401                   │
                   │                                               │
                   │  React Router 7 App                           │
                   │  └── Normal rendering                         │
                   └───────────────────────────────────────────────┘
```

### Middleware

```typescript
// app/lib/staging-auth.server.ts

const COOKIE_NAME = '_preview_session';
const COOKIE_TTL = 60 * 60 * 24 * 30; // 30 days

export function validateStagingAuth(request: Request, env: Env): Response | null {
  const secret = env.STAGING_AUTH_SECRET || env.DEV_AUTH_SECRET;
  if (!secret) return null; // production — no auth

  const url = new URL(request.url);

  // Check query param first (initial load from Studio or shared link)
  const token = url.searchParams.get('_preview');
  if (token && verifyJwt(token, secret)) {
    // Set cookie so subsequent navigations don't need the param
    const clean = new URL(url);
    clean.searchParams.delete('_preview');
    return new Response(null, {
      status: 302,
      headers: {
        Location: clean.toString(),
        'Set-Cookie': `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=${COOKIE_TTL}`,
      },
    });
  }

  // Check cookie (subsequent requests)
  const cookie = parseCookie(request.headers.get('Cookie') || '')[COOKIE_NAME];
  if (cookie && verifyJwt(cookie, secret)) return null; // authenticated

  return new Response('Unauthorized', {status: 401});
}

function verifyJwt(token: string, secret: string): boolean {
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [header, payload, signature] = parts;

  // HMAC-SHA256 verification (Web Crypto API — works in Oxygen workers)
  // Implementation uses crypto.subtle.importKey + crypto.subtle.sign
  // ... (full implementation uses async, shown simplified here)

  const data = JSON.parse(atob(payload));
  if (data.exp && data.exp < Math.floor(Date.now() / 1000)) return false;
  return true; // signature verification omitted for brevity
}
```

> **Note**: Oxygen workers run on Cloudflare Workers runtime. Use `crypto.subtle` (Web Crypto API),
> not `node:crypto`. The `createHmac` import from v1 doc won't work in Oxygen.

### Token Generation (One-Time)

```bash
# Generate once per environment. Store the output JWT.
SECRET="$(openssl rand -hex 32)"  # This becomes STAGING_AUTH_SECRET

HEADER=$(echo -n '{"alg":"HS256","typ":"JWT"}' | base64 | tr '+/' '-_' | tr -d '=')
PAYLOAD=$(echo -n "{\"env\":\"staging\",\"iat\":$(date +%s)}" | base64 | tr '+/' '-_' | tr -d '=')
SIGNATURE=$(echo -n "${HEADER}.${PAYLOAD}" \
  | openssl dgst -sha256 -hmac "$SECRET" -binary \
  | base64 | tr '+/' '-_' | tr -d '=')

echo "JWT: ${HEADER}.${PAYLOAD}.${SIGNATURE}"
echo "Secret: $SECRET"

# No expiry claim → valid until secret is rotated.
# Add "exp" to payload if you want auto-expiry.
```

### Env Vars (Per-Environment)

| Variable | Oxygen Scope | Value |
|---|---|---|
| `STAGING_AUTH_SECRET` | Staging | Random 256-bit hex |
| `DEV_AUTH_SECRET` | Dev | Different random 256-bit hex |
| (neither set) | Production, Preview | Middleware auto-skips |

### Sanity Documents (One Per Stable Environment)

```
_type: "environmentAuth"
_id:   "environmentAuth.staging"
───────────────────────────────
environment: "staging"
domain: "staging.acme.com"
token: "eyJhbGciOiJIUzI1NiJ9..."  // the static JWT
updatedAt: "2026-02-19T..."

_type: "environmentAuth"
_id:   "environmentAuth.dev"
───────────────────────────────
environment: "dev"
domain: "dev.acme.com"
token: "eyJhbGciOiJIUzI1NiJ9..."  // different static JWT
updatedAt: "2026-02-19T..."
```

### Studio Editor Flow

```
1. Editor opens Staging workspace → Presentation tool
2. Presentation tool calls previewMode.enable (async):
   → Reads Sanity doc: *[_id == "environmentAuth.staging"][0]{token}
   → Constructs: /api/preview-mode/enable?_preview=${token}&sanity-preview-secret=xxx
3. Hydrogen middleware validates JWT → sets cookie → redirects
4. Iframe renders staging site with visual editing overlays
5. Fetch interceptor appends _preview cookie to all subsequent requests
   (handles cross-origin iframe cookie blocking)
6. No branch picker needed — each workspace has exactly one target
```

### Stakeholder Flow (Link-Based)

```
1. Internal team generates shareable link:
   staging.acme.com?_preview=eyJhbGciOiJIUzI1NiJ9...
2. Stakeholder clicks link → middleware validates JWT → sets 30-day cookie → redirects
3. Subsequent visits: cookie is valid, no token in URL needed
4. Works across all pages, all deploys, indefinitely (until secret rotation)
```

### Token Rotation

```
1. Generate new secret + JWT
2. Update Oxygen env var (STAGING_AUTH_SECRET)
3. Deploy (new middleware reads new secret)
4. Update Sanity doc (environmentAuth.staging) with new JWT
5. Old cookies and links stop working immediately
6. Share new link with stakeholders
```

---

## Option 2: Auto-TOTP + Session JWT

### Overview

Hydrogen middleware validates TOTP codes (RFC 6238) and issues session JWTs. A shared TOTP
seed is stored in Oxygen env vars and in a Sanity document. Studio's `previewMode` function
reads the seed, generates a TOTP code, and passes it to the iframe — zero friction for editors.
Stakeholders use an authenticator app (Google Auth, Cisco Duo, etc.).

### Architecture

```
                   ┌─ Oxygen (Public) ──────────────────────────────┐
                   │                                                │
Request ──────────►│  Hydrogen Middleware (server.ts)                │
                   │  ├── Has valid session cookie? → continue      │
                   │  ├── Has ?_totp= param?                        │
                   │  │   ├── Valid code → issue session JWT cookie  │
                   │  │   │   → redirect (strip _totp from URL)     │
                   │  │   └── Invalid → 401 with TOTP entry form    │
                   │  └── No auth → 401 with TOTP entry form        │
                   │                                                │
                   │  React Router 7 App                            │
                   │  └── Normal rendering                          │
                   └────────────────────────────────────────────────┘
```

### Middleware

```typescript
// app/lib/staging-auth.server.ts
import { authenticator } from 'otplib';

const SESSION_COOKIE = '_staging_session';
const SESSION_TTL = 60 * 60 * 24 * 30; // 30 days

export function validateStagingAuth(request: Request, env: Env): Response | null {
  const seed = env.STAGING_TOTP_SEED || env.DEV_TOTP_SEED;
  const sessionSecret = env.STAGING_SESSION_SECRET || env.DEV_SESSION_SECRET;
  if (!seed || !sessionSecret) return null; // production — no auth

  const url = new URL(request.url);

  // 1. Check existing session
  const sessionToken = parseCookie(request.headers.get('Cookie') || '')[SESSION_COOKIE];
  if (sessionToken && verifySessionJwt(sessionToken, sessionSecret)) {
    return null; // authenticated
  }

  // 2. Check TOTP code (from Studio previewMode or form submission)
  const totpCode = url.searchParams.get('_totp');
  if (totpCode && authenticator.verify({ token: totpCode, secret: seed })) {
    const jwt = createSessionJwt(sessionSecret, SESSION_TTL);
    const clean = new URL(url);
    clean.searchParams.delete('_totp');
    return new Response(null, {
      status: 302,
      headers: {
        Location: clean.toString(),
        'Set-Cookie': `${SESSION_COOKIE}=${jwt}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=${SESSION_TTL}`,
      },
    });
  }

  // 3. No valid auth → TOTP entry form
  return new Response(renderTotpForm(url), {
    status: 401,
    headers: { 'Content-Type': 'text/html' },
  });
}
```

> **Note**: `otplib` uses `node:crypto` internally. Verify it works in Oxygen's Cloudflare Workers
> runtime, or use a Web Crypto-compatible TOTP library like `@noble/hashes` with manual RFC 6238.

### Env Vars (Per-Environment)

| Variable | Oxygen Scope | Value |
|---|---|---|
| `STAGING_TOTP_SEED` | Staging | Base32-encoded TOTP secret |
| `STAGING_SESSION_SECRET` | Staging | Random 256-bit hex (signs session JWTs) |
| `DEV_TOTP_SEED` | Dev | Different Base32-encoded TOTP secret |
| `DEV_SESSION_SECRET` | Dev | Different random 256-bit hex |
| (none set) | Production, Preview | Middleware auto-skips |

### Sanity Documents

```
_type: "environmentAuth"
_id:   "environmentAuth.staging"
───────────────────────────────
environment: "staging"
domain: "staging.acme.com"
totpSeed: "JBSWY3DPEHPK3PXP"  // same seed as Oxygen env var
updatedAt: "2026-02-19T..."

_type: "environmentAuth"
_id:   "environmentAuth.dev"
───────────────────────────────
environment: "dev"
domain: "dev.acme.com"
totpSeed: "K4XW6Y3VMFZGI33O"  // different seed
updatedAt: "2026-02-19T..."
```

### Studio Editor Flow (Zero Friction)

```
1. Editor opens Staging workspace → Presentation tool
2. Presentation tool calls previewMode.enable (async):
   → Reads Sanity doc: *[_id == "environmentAuth.staging"][0]{totpSeed}
   → Generates current TOTP code using otplib
   → Constructs: /api/preview-mode/enable?_totp=${code}&sanity-preview-secret=xxx
3. Middleware validates TOTP → issues session JWT cookie → redirects
4. Iframe renders staging site with visual editing overlays
5. Fetch interceptor appends session cookie to all subsequent requests
6. Session valid for 30 days — no re-auth on page navigation
```

### Stakeholder Flow (Authenticator App)

```
1. Stakeholder visits staging.acme.com
2. Middleware returns TOTP entry form (styled, branded)
3. Stakeholder opens authenticator app (Google Auth, Cisco Duo, Microsoft Auth)
4. Enters 6-digit code
5. Middleware validates → issues 30-day session cookie → redirects
6. Subsequent visits: session cookie valid, no re-auth
```

### TOTP Seed Distribution

```
1. Generate seed:    npx -y otplib-cli generate-secret
2. Oxygen env var:   STAGING_TOTP_SEED=JBSWY3DPEHPK3PXP
3. Sanity doc:       environmentAuth.staging { totpSeed: "..." }
4. QR code:          Share via internal channel (Slack, Teams)
5. Team scans:       Each stakeholder adds to their authenticator app
6. Codes rotate:     Every 30 seconds — standard RFC 6238
```

### Seed Rotation

```
1. Generate new seed
2. Update Oxygen env var + deploy
3. Update Sanity doc
4. Share new QR code with team
5. Old authenticator entries stop working
6. Existing session cookies remain valid until their TTL expires
```

---

## Option 3: Shared Passphrase + Session Cookie

### Overview

The simplest possible auth: one passphrase per environment stored as an Oxygen env var and
in a Sanity document. Middleware compares the passphrase, sets a session cookie, done.
No JWT signing, no TOTP libraries, no crypto dependencies. Modern `.htpasswd` equivalent.

### Architecture

```
                   ┌─ Oxygen (Public) ──────────────────────────────┐
                   │                                                │
Request ──────────►│  Hydrogen Middleware (server.ts)                │
                   │  ├── Has valid session cookie? → continue      │
                   │  ├── Has ?_pass= matching passphrase?          │
                   │  │   └── Yes → set session cookie, redirect    │
                   │  └── No auth → password form (HTML)            │
                   │                                                │
                   │  React Router 7 App                            │
                   │  └── Normal rendering                          │
                   └────────────────────────────────────────────────┘
```

### Session Cookie Strategy

> **TL;DR**: Use `btoa` for simplicity. Upgrade to HMAC if threat model changes.

Two variants for session cookie value:

| Variant | Session cookie value | Crypto needed | Security |
|---|---|---|---|
| **A: btoa** | `btoa(passphrase).slice(0, 32)` | None | Reversible — if cookie leaks, passphrase is recoverable |
| **B: HMAC** | `HMAC-SHA256(passphrase, "session-key")` | `crypto.subtle` | One-way — cookie leak doesn't expose passphrase |

For staging/dev protection (threat model = "prevent random visitors from seeing unreleased
content"), Variant A is sufficient. Both variants support Cloudflare Workers / Oxygen runtime.

### Middleware (~30 Lines, Variant A)

```typescript
// app/lib/staging-auth.server.ts
// Zero imports. Zero dependencies. Works in any JS runtime.

const COOKIE_NAME = '_staging_session';
const COOKIE_TTL = 60 * 60 * 24 * 30; // 30 days

export function validateStagingAuth(request: Request, env: Env): Response | null {
  const passphrase = env.STAGING_PASSPHRASE || env.DEV_PASSPHRASE;
  if (!passphrase) return null; // production — no auth

  const url = new URL(request.url);
  const cookies = parseCookies(request.headers.get('Cookie') || '');
  const expectedSession = btoa(passphrase).slice(0, 32);

  // 1. Check session cookie
  if (cookies[COOKIE_NAME] === expectedSession) return null; // authenticated

  // 2. Check passphrase in URL (from Studio previewMode or shared link)
  if (url.searchParams.get('_pass') === passphrase) {
    const clean = new URL(url);
    clean.searchParams.delete('_pass');
    return new Response(null, {
      status: 302,
      headers: {
        Location: clean.toString(),
        'Set-Cookie': `${COOKIE_NAME}=${expectedSession}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=${COOKIE_TTL}`,
      },
    });
  }

  // 3. Check form POST submission
  if (request.method === 'POST') {
    const form = await request.formData();
    if (form.get('passphrase') === passphrase) {
      return new Response(null, {
        status: 302,
        headers: {
          Location: url.pathname,
          'Set-Cookie': `${COOKIE_NAME}=${expectedSession}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=${COOKIE_TTL}`,
        },
      });
    }
  }

  // 4. No valid auth → password form
  return new Response(renderPasswordForm(url), {
    status: 401,
    headers: { 'Content-Type': 'text/html' },
  });
}

function parseCookies(header: string): Record<string, string> {
  return Object.fromEntries(header.split('; ').filter(Boolean).map(c => {
    const [k, ...v] = c.split('=');
    return [k, v.join('=')];
  }));
}

function renderPasswordForm(url: URL): string {
  return `<!DOCTYPE html>
<html><head><title>Access Required</title>
<style>body{font-family:system-ui;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f5f5f5}
form{background:white;padding:2rem;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.1);max-width:320px;width:100%}
input{width:100%;padding:.5rem;margin:.5rem 0;border:1px solid #ddd;border-radius:4px;box-sizing:border-box}
button{width:100%;padding:.5rem;background:#000;color:white;border:none;border-radius:4px;cursor:pointer}</style></head>
<body><form method="POST" action="${url.pathname}">
<h2>Access Required</h2><p>Enter the environment passphrase to continue.</p>
<input type="password" name="passphrase" placeholder="Passphrase" autofocus required>
<button type="submit">Continue</button></form></body></html>`;
}
```

### Middleware (Variant B — HMAC Session)

```typescript
// Only the session hash computation changes. Everything else identical.
async function computeSession(passphrase: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('session-key'));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).slice(0, 43);
}
// Use: const expectedSession = await computeSession(passphrase);
// Note: makes middleware async. Negligible perf impact.
```

### Env Vars (Per-Environment)

| Variable | Oxygen Scope | Value |
|---|---|---|
| `STAGING_PASSPHRASE` | Staging | Human-readable passphrase (e.g. `correct-horse-battery-staple`) |
| `DEV_PASSPHRASE` | Dev | Different passphrase |
| (neither set) | Production, Preview | Middleware auto-skips |

### Sanity Documents

```
_type: "environmentAuth"
_id:   "environmentAuth.staging"
───────────────────────────────
environment: "staging"
domain: "staging.acme.com"
passphrase: "correct-horse-battery-staple"
updatedAt: "2026-02-19T..."

_type: "environmentAuth"
_id:   "environmentAuth.dev"
───────────────────────────────
environment: "dev"
domain: "dev.acme.com"
passphrase: "different-passphrase-here"
updatedAt: "2026-02-19T..."
```

### Studio Editor Flow

```
1. Editor opens Staging workspace → Presentation tool
2. Presentation tool calls previewMode.enable (async):
   → Reads Sanity doc: *[_id == "environmentAuth.staging"][0]{passphrase}
   → Constructs: /api/preview-mode/enable?_pass=${passphrase}&sanity-preview-secret=xxx
3. Middleware validates passphrase → sets session cookie → redirects
4. Iframe renders staging site with visual editing overlays
5. Fetch interceptor appends session cookie to all subsequent requests
```

### Stakeholder Flow (Two Options)

**Link-based** (zero friction):
```
1. Share link: staging.acme.com?_pass=correct-horse-battery-staple
2. Click → cookie set → redirect → site renders
3. 30-day session, no re-auth
```

**Form-based** (more secure):
```
1. Share passphrase via Slack/email: "correct-horse-battery-staple"
2. Stakeholder visits staging.acme.com → sees password form
3. Enters passphrase → cookie set → redirect → site renders
4. 30-day session, no re-auth
```

### Rotation

```
1. Change passphrase string
2. Update Oxygen env var + deploy
3. Update Sanity doc
4. Share new passphrase with team
5. All old session cookies become invalid immediately
```

---

## Option 4: Vercel-Style Protection Bypass (Recommended)

### Overview

Replicate Vercel's proven deployment protection bypass pattern with custom Hydrogen middleware.
Vercel's system is battle-tested and Sanity's Presentation tool has native support for it —
we mirror the architecture but swap Vercel's edge validation for our own middleware.

**Why model after Vercel**: Vercel + Sanity jointly designed this flow. Sanity's Presentation
tool has hardcoded `x-vercel-protection-bypass` support in `Preview.tsx`. By mirroring the
naming convention (`x-oxygen-protection-bypass`), we position for potential native Sanity
support and leverage a proven security/UX pattern.

### How Vercel's System Works (Reference)

```
1. Admin generates bypass secret in Vercel dashboard (32-char string)
2. Vercel auto-sets VERCEL_AUTOMATION_BYPASS_SECRET env var on all deploys
3. Admin pastes secret into Sanity Studio tool → stored as Sanity doc
4. Presentation tool reads secret from Sanity → appends to iframe URL:
   ?x-vercel-protection-bypass=SECRET&x-vercel-set-bypass-cookie=samesitenone
5. Vercel edge validates → 302 redirect + Set-Cookie (SameSite=None) → clean URL
6. All subsequent iframe requests carry cookie automatically
```

Key properties: secret persists across deploys, validation at gateway, cookie-based session,
no application code involved in auth.

### Our Replication

| Vercel Component | Our Equivalent |
|---|---|
| `VERCEL_AUTOMATION_BYPASS_SECRET` | `STAGING_BYPASS_SECRET` / `DEV_BYPASS_SECRET` (Oxygen env var) |
| Vercel edge validation | Hydrogen middleware in `server.ts` |
| `x-vercel-protection-bypass` param | `x-oxygen-protection-bypass` param |
| `x-vercel-set-bypass-cookie` | Middleware handles cookie setting directly |
| `sanity.vercelProtectionBypass` doc | `sanity.oxygenProtectionBypass` doc (already exists!) |
| `@sanity/vercel-protection-bypass` plugin | Our existing schema + custom `previewMode` resolver |
| Vercel dashboard UI | One-time `openssl rand -hex 16` (32 chars) |

### Architecture

```
                   ┌─ Oxygen (Public) ──────────────────────────────────┐
                   │                                                    │
Request ──────────►│  Hydrogen Middleware (server.ts)                    │
                   │  ├── env.STAGING_BYPASS_SECRET set?                │
                   │  │   ├── No  → skip (production)                   │
                   │  │   └── Yes → check auth:                         │
                   │  │       ├── Cookie `_oxygen_bypass` valid? → pass │
                   │  │       ├── ?x-oxygen-protection-bypass=SECRET?   │
                   │  │       │   └── Match → 302 + Set-Cookie + strip  │
                   │  │       └── No auth → 401                         │
                   │  └── Continue to React Router                      │
                   │                                                    │
                   │  React Router 7 App                                │
                   │  └── Normal rendering                              │
                   └────────────────────────────────────────────────────┘
```

### Middleware

```typescript
// app/lib/oxygen-protection-bypass.server.ts
// Mirrors Vercel's protection bypass flow exactly.
// Zero external dependencies. Works in Cloudflare Workers / Oxygen runtime.

const COOKIE_NAME = '_oxygen_bypass';
const PARAM_NAME = 'x-oxygen-protection-bypass';
const COOKIE_TTL = 60 * 60 * 24 * 30; // 30 days

export function validateOxygenProtectionBypass(
  request: Request,
  env: Env,
): Response | null {
  const secret = env.STAGING_BYPASS_SECRET || env.DEV_BYPASS_SECRET;
  if (!secret) return null; // production — no protection

  // 1. Check bypass cookie (subsequent requests)
  const cookies = parseCookies(request.headers.get('Cookie') || '');
  if (cookies[COOKIE_NAME] === secret) return null; // authenticated

  // 2. Check bypass query param (initial request from Studio or shared link)
  const url = new URL(request.url);
  const bypassParam = url.searchParams.get(PARAM_NAME);

  if (bypassParam === secret) {
    // Mirror Vercel: redirect to clean URL + set SameSite=None cookie
    const clean = new URL(url);
    clean.searchParams.delete(PARAM_NAME);
    return new Response(null, {
      status: 302,
      headers: {
        Location: clean.toString(),
        'Set-Cookie': `${COOKIE_NAME}=${secret}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=${COOKIE_TTL}`,
      },
    });
  }

  // 3. No valid auth
  return new Response('Unauthorized', { status: 401 });
}

function parseCookies(header: string): Record<string, string> {
  return Object.fromEntries(
    header.split('; ').filter(Boolean).map(c => {
      const [k, ...v] = c.split('=');
      return [k, v.join('=')];
    }),
  );
}
```

> **Note**: Cookie value = raw secret (same as Vercel's pattern). Vercel does this because
> the cookie is `HttpOnly; Secure; SameSite=None` — it can't be read by client JS.
> If you want defense-in-depth, HMAC the secret (see Option 3 Variant B).

### Secret Generation (One-Time Per Environment)

```bash
# Generate a 32-character hex secret (mirrors Vercel's 32-char format)
openssl rand -hex 16
# Output: a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6

# Store as Oxygen env var (scoped to environment)
# Store in Sanity doc (for Studio to read)
```

### Env Vars (Per-Environment)

| Variable | Oxygen Scope | Value |
|---|---|---|
| `STAGING_BYPASS_SECRET` | Staging | 32-char hex string |
| `DEV_BYPASS_SECRET` | Dev | Different 32-char hex string |
| (neither set) | Production, Preview | Middleware auto-skips |

### Sanity Documents (Already Built!)

We already have the `sanity.oxygenProtectionBypass` schema type. Reuse it:

```
_type: "sanity.oxygenProtectionBypass"
_id:   "oxygen-bypass.staging"
──────────────────────────────────
environment: "staging"
deploymentUrl: "https://staging.acme.com"
authToken: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"  // the bypass secret

_type: "sanity.oxygenProtectionBypass"
_id:   "oxygen-bypass.dev"
──────────────────────────────────
environment: "dev"
deploymentUrl: "https://dev.acme.com"
authToken: "f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3"  // different secret
```

### Studio Editor Flow

```
1. Editor opens Staging workspace → Presentation tool
2. previewMode.enable (async):
   → Reads Sanity doc: *[_type == "sanity.oxygenProtectionBypass"
                          && environment == "staging"][0]{authToken}
   → Constructs: /api/preview-mode/enable
       ?x-oxygen-protection-bypass=${authToken}
       &sanity-preview-secret=xxx
       &sanity-preview-pathname=/
3. Middleware validates bypass secret → 302 redirect + SameSite=None cookie
4. Redirected to /api/preview-mode/enable?sanity-preview-secret=xxx...
   (bypass cookie now attached, middleware passes through)
5. Preview mode enable route validates Sanity secret → enables draft mode → redirects to /
6. Iframe renders staging site with visual editing overlays
7. All subsequent requests carry _oxygen_bypass cookie — no fetch interceptor needed!
```

**Key advantage over Options 1-3**: The `SameSite=None` cookie set by our middleware works
the same way Vercel's does. In cross-origin iframes (Studio embedding the storefront), the
cookie persists across navigations. This potentially **eliminates the need for the
`entry.client.tsx` fetch interceptor hack** — the cookie handles it natively, just like Vercel.

### Stakeholder Flow

```
1. Share link: staging.acme.com?x-oxygen-protection-bypass=a1b2c3d4...
2. Click → middleware validates → 302 redirect + cookie → site renders
3. Clean URL in browser (secret stripped), cookie persists for 30 days
4. Return visits: cookie valid, no auth needed
```

### Secret Rotation

```
1. Generate new 32-char secret: openssl rand -hex 16
2. Update Oxygen env var (STAGING_BYPASS_SECRET) + deploy
3. Update Sanity doc (oxygen-bypass.staging) authToken field
4. Old cookies stop working (secret changed)
5. Share new link with stakeholders
```

### Why This Is the Best Option

1. **Proven pattern**: Vercel + Sanity designed and battle-tested this exact flow
2. **Already partially built**: `sanity.oxygenProtectionBypass` schema + docs exist
3. **SameSite=None cookie**: Eliminates `entry.client.tsx` fetch interceptor (the biggest hack in our current system)
4. **Forward-compatible**: If Sanity adds generic bypass param support (beyond Vercel), our naming convention is ready
5. **Zero dependencies**: No JWT, no TOTP, no crypto libs. Pure string comparison + cookie
6. **~25 lines of middleware**: Simplest implementation of all options
7. **Same security as Vercel**: `HttpOnly; Secure; SameSite=None` cookie. Secret never exposed to client JS.

---

## Stakeholder Auth: Link vs TOTP vs Passphrase

> **Decision deferred.** All approaches documented. Choose during implementation.

| Criteria | Option 1: JWT Link | Option 2: TOTP Form | Option 3: Passphrase | **Option 4: Vercel-Style** |
|---|---|---|---|---|
| **Friction** | Zero — click link | Low — enter code | Low — enter phrase or click link | **Zero — click link** |
| **Requires app** | No | Yes (authenticator) | No | **No** |
| **Shareability** | URL forwardable (risk) | Code expires 30s | Passphrase shareable | **URL forwardable (risk)** |
| **Revocation** | Rotate HMAC secret | Change seed | Change passphrase | **Change bypass secret** |
| **Audit trail** | None | Partial | None | **None** |
| **Enterprise fit** | Quick QA | Compliance-heavy | Internal teams | **Quick QA + proven pattern** |
| **Implementation** | ~50 lines + crypto | ~80 lines + TOTP lib | ~30 lines | **~25 lines, zero deps** |
| **Iframe cookie** | Needs interceptor | Needs interceptor | Needs interceptor | **SameSite=None native** |
| **Onboarding** | Share URL | Share QR + install app | Share passphrase | **Share URL** |

**Hybrid option**: Middleware can check multiple auth methods in sequence. For example,
Option 4 + Option 3 form fallback: bypass param → cookie → password form for manual access.

---

## Preview Deployments (Dev-Only)

### Scope

Preview deployments are **ephemeral, developer-facing only**. They use Oxygen's native
Private environment auth with 12h `TESTING_AUTOMATION` tokens. No custom middleware.
No Studio Presentation tool support.

### Per-PR Sanity Documents

CI creates a Sanity doc per PR with deployment metadata. Developers can see active
preview URLs in a list (Studio dashboard or custom component). Not for Presentation tool —
just for URL discovery and linking back to GitHub context.

```
_type: "previewDeployment"
_id:   "previewDeployment.pr-13"
───────────────────────────────
prNumber: 13
headBranch: "feat/new-feature"
baseBranch: "staging"
deploymentUrl: "https://01khr8j2rx17z8c32e85yh6czr-f47de06af4f98b573090.myshopify.dev"
authToken: "eyJhbGciOiJIUzI1NiJ9..."  // 12h TESTING_AUTOMATION token
tokenExpiresAt: "2026-02-19T22:00:00Z"
createdAt: "2026-02-19T10:00:00Z"
updatedAt: "2026-02-19T10:00:00Z"

_type: "previewDeployment"
_id:   "previewDeployment.pr-14"
───────────────────────────────
prNumber: 14
headBranch: "feat/another-thing"
baseBranch: "dev"
deploymentUrl: "https://..."
authToken: "eyJ..."
tokenExpiresAt: "..."
```

### CI Workflows

**On PR deploy** (`issue_comment` from `shopify[bot]`):

```yaml
# Creates/updates per-PR doc with deployment URL + 12h token
- name: Sync to Sanity
  run: |
    PR_NUMBER=${{ github.event.issue.number }}
    # Extract from shopify[bot] comment
    DEPLOY_URL="..."
    AUTH_TOKEN="..."

    curl -s -X POST \
      "https://$SANITY_PROJECT_ID.api.sanity.io/v2021-06-07/data/mutate/$DATASET" \
      -H "Authorization: Bearer $SANITY_API_TOKEN" \
      -H "Content-Type: application/json" \
      -d '{
        "mutations": [{
          "createOrReplace": {
            "_id": "previewDeployment.pr-'"$PR_NUMBER"'",
            "_type": "previewDeployment",
            "prNumber": '"$PR_NUMBER"',
            "headBranch": "'"$HEAD_BRANCH"'",
            "baseBranch": "'"$BASE_BRANCH"'",
            "deploymentUrl": "'"$DEPLOY_URL"'",
            "authToken": "'"$AUTH_TOKEN"'",
            "updatedAt": "'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'"
          }
        }]
      }'
```

**On PR close/merge**:

```yaml
on:
  pull_request:
    types: [closed]

jobs:
  cleanup:
    runs-on: ubuntu-latest
    steps:
      - name: Delete preview doc from Sanity
        run: |
          curl -s -X POST \
            "https://$SANITY_PROJECT_ID.api.sanity.io/v2021-06-07/data/mutate/$DATASET" \
            -H "Authorization: Bearer $SANITY_API_TOKEN" \
            -d '{"mutations": [{"delete": {"id": "previewDeployment.pr-${{ github.event.pull_request.number }}"}}]}'
```

### Developer Workflow

```
1. Dev pushes branch → PR created → Oxygen deploys preview
2. shopify[bot] comments with preview URL + auth token
3. CI syncs to Sanity: previewDeployment.pr-{N}
4. Dev accesses preview: deploymentUrl?_auth=TOKEN (Oxygen native)
5. Token expires in 12h — acceptable for dev testing
6. PR merged/closed → cleanup workflow deletes Sanity doc
```

### Limitations

- **No Studio Presentation support** — preview URLs are ephemeral, tokens are 12h
- **Token expiry** — dev must re-deploy or get new token after 12h
- **No custom domain** — preview deployments use Oxygen per-deploy URLs only

---

## Plan B: 12h Rolling Token via Cron

> Documented for completeness. **Not recommended.**

- Keep Oxygen auth (Private environments) for staging/dev
- CI cron re-deploys every 11 hours → fresh 12h TESTING_AUTOMATION token
- Sync token to Sanity for Studio to read
- Downsides: 11 unnecessary deploys/day, fragile, wasteful, token still dies mid-session

---

## Decision Status

**Status**: Options documented. **Option 4 recommended.**

Pending decisions:
1. **Confirm Option 4** — or choose alternative/hybrid
2. **Stakeholder 401 page** — bare 401 vs password form fallback (Option 3+4 hybrid)

**Decided**:
- Oxygen environments: Public for staging/dev, Private for preview
- Per-environment secrets (not shared)
- Static tokens (no CI-generated tokens per deploy)
- Multi-workspace Studio: 1 workspace → 1 dataset → 1 stable environment
- No per-PR Studio Presentation support
- Per-PR Sanity docs for preview URL discovery (dev-only)

**Next steps**:
1. Confirm Option 4 (or choose alternative)
2. Implement Hydrogen middleware (`app/lib/staging-auth.server.ts`)
3. Add `environmentAuth` schema type to Studio
4. Seed Sanity docs for staging + dev
5. Wire middleware into `server.ts`
6. Update Studio `previewMode` to read auth from Sanity doc
7. Test E2E: Studio Presentation → middleware → iframe renders
8. Add `previewDeployment` schema + CI workflows for per-PR docs
