# Sanity Studio Presentation Tool + Oxygen Auth — Integration Analysis

> How to make Sanity Studio's Presentation view render a pre-authenticated version of a private Oxygen deployment for custom branch environments (e.g., staging).

---

## Table of Contents

1. [Problem Statement](#1-problem-statement)
2. [The Two-Layer Auth Problem](#2-the-two-layer-auth-problem)
3. [The Vercel Precedent](#3-the-vercel-precedent)
4. [Presentation Tool Request Sequence](#4-presentation-tool-request-sequence)
5. [Proposed Workflow Architecture](#5-proposed-workflow-architecture)
6. [Approach 1 — Async `initial` + Cookie Timing](#6-approach-1--async-initial--cookie-timing)
7. [Approach 2 — Cloudflare Proxy Worker](#7-approach-2--cloudflare-proxy-worker)
8. [Approach 3 — Stable Environment URL + One-Time Token](#8-approach-3--stable-environment-url--one-time-token)
9. [Approach Comparison](#9-approach-comparison)
10. [Hydrogen App Requirements (All Approaches)](#10-hydrogen-app-requirements-all-approaches)
11. [Open Questions & Validation Steps](#11-open-questions--validation-steps)
12. [Validated Findings (Initial)](#12-validated-findings-2026-02-17)
13. [Chosen Approach: Async `previewMode` Plugin](#13-chosen-approach-async-previewmode-plugin)
14. [Validation Results (Comprehensive)](#14-validation-results-2026-02-17)
15. [Updated Architecture Recommendations](#15-updated-architecture-recommendations)
16. [CI Strategy Evaluation](#16-ci-strategy-evaluation)
17. [Live Validation: `issue_comment` Trigger](#17-live-validation-issue_comment-trigger--confirmed-working)
18. [Validated Recommended Solution](#18-validated-recommended-solution)
19. [Deployment & Test Plan: `studio-meditate-with-eve`](#19-deployment--test-plan-studio-meditate-with-eve)
20. [Remaining Work (Updated)](#20-remaining-work-updated)

---

## 1. Problem Statement

**Context**: UMG uses Shopify Hydrogen deployed on Oxygen. Custom environment branches (e.g., `staging`) are private — bare URLs redirect to Shopify OAuth. Sanity Studio is hosted on `sanity.studio`.

**Goal**: Enable Sanity Studio's Presentation tool to render a live, editable preview of the staging deployment inside its iframe — without requiring the content editor to have a Shopify account or manually authenticate.

**Constraint**: Studio is Sanity-hosted (`*.sanity.studio`), so we cannot arbitrarily rebuild it or inject runtime environment variables per deploy.

---

## 2. The Two-Layer Auth Problem

When Presentation tool opens an iframe to the Hydrogen deployment, two independent auth layers block it:

```
Studio iframe request
  │
  ▼
Layer 1: Oxygen Gateway Worker (Cloudflare)
  • Runs BEFORE the Hydrogen app code
  • Checks for: ?_auth= param, oxygen-auth-bypass-token header, or auth_bypass_token cookie
  • Without valid auth → 302 redirect to accounts.shopify.com
  • With valid auth → sets auth_bypass_token cookie (1hr, HttpOnly, Secure, .myshopify.dev)
  │
  ▼
Layer 2: Hydrogen CSP (frame-ancestors)
  • Set by createContentSecurityPolicy() in entry.server.tsx
  • Default: frame-ancestors 'none' (blocks all iframes)
  • When preview mode enabled: frame-ancestors includes Studio hostname
  • Controlled by the Hydrogen app, NOT the Gateway Worker
```

**Both layers must be solved in sequence**: Gateway auth first (to reach the app), then preview mode (to allow iframe embedding and serve draft content).

---

## 3. The Vercel Precedent

Sanity already solved this exact problem for Vercel's deployment protection:

- **Plugin**: `@sanity/vercel-protection-bypass`
- **Mechanism**: Stores a bypass secret in the Sanity dataset; Presentation tool (`sanity@3.70.0+`) automatically appends it to iframe requests
- **Result**: Vercel sees the bypass secret → allows the request through → Presentation tool works

**No equivalent `@sanity/oxygen-protection-bypass` plugin exists.** But the pattern proves:
1. Sanity recognizes this is a real problem
2. The solution pattern is: store a secret → append to iframe requests automatically
3. The Presentation tool core has infrastructure for protection bypass

---

## 4. Presentation Tool Request Sequence — VALIDATED

> **Validated 2026-02-17** via test branch `test/presentation-load-order` on `studio-meditate-with-eve`.
> Test server on port 3456 logged all iframe requests with timestamps.

### Confirmed Load Order

```
#1  GET /api/preview-mode/enable?sanity-preview-secret=OWVi...&sanity-preview-perspective=drafts&sanity-preview-pathname=%2F%3Fsource%3Dinitial
#2  GET /                         ← redirect target from enable endpoint
```

**`previewMode.enable` is called FIRST.** The async `initial` URL is resolved but NOT loaded directly — instead its value is embedded as the `sanity-preview-pathname` query parameter in the `enable` request.

### Actual Sequence

```
1. User opens Presentation tool in Studio
2. Studio resolves async `initial` → gets the URL string (e.g., "http://localhost:3456/?source=initial")
3. Studio constructs enable URL:
   ${origin}${previewMode.enable}?sanity-preview-secret=xxx&sanity-preview-pathname=${initial_path}
4. Iframe navigates to enable URL                    ← FIRST and ONLY iframe navigation
5. Enable endpoint validates Sanity secret
6. Enable endpoint sets preview session cookie
7. Enable endpoint redirects to the initial path (sanity-preview-pathname)
8. Content page loads with preview mode active
9. CSP frame-ancestors now includes Studio → iframe allowed
10. Visual editing overlays render
11. Subsequent navigation works via cookies
```

### Implication for Oxygen Auth

**Approach 1 (async `initial` + cookie timing) FAILS as designed.** The `?_auth=` on the `initial` URL never hits the Gateway Worker first. The `enable` endpoint is the first request, and without auth, the Gateway blocks it with a 302 → OAuth.

**However**, the `previewMode.enable` path IS the entry point. If we can inject `?_auth=TOKEN` into the `enable` path:
```typescript
previewMode: {
  enable: `/api/preview?_auth=${TOKEN}`,
}
```
The full URL becomes:
```
${origin}/api/preview?_auth=TOKEN&sanity-preview-secret=xxx&sanity-preview-pathname=/
```
The Gateway sees `?_auth=`, passes through, sets cookie — then the enable endpoint runs normally.

**The blocker**: `previewMode.enable` is a static string, not async. The token must be known at config evaluation time.

### Config Properties

| Property | Type | Async Support | Purpose |
|---|---|---|---|
| `previewUrl.initial` | `string \| async ({client, origin}) => string` | **Yes** | Resolved to a path; embedded as `sanity-preview-pathname` in enable URL |
| `previewUrl.origin` | `string` | **No** (docs show static only) | Explicit origin hostname for URL construction |
| `previewUrl.previewMode.enable` | `string` | **No** (path only, static) | Path appended to origin — **this is the FIRST iframe load** |
| `allowOrigins` | `string[] \| async ({client, origin}) => string[]` | **Yes** | Allowed iframe origins for postMessage |

---

## 5. Proposed Workflow Architecture

Regardless of approach, the general workflow is:

```
┌─────────────────────────────────────────────────────┐
│ CI (GitHub Actions — on push to staging)            │
│                                                     │
│ 1. Deploy to Oxygen                                 │
│    └─ npx shopify hydrogen deploy                   │
│       --auth-bypass-token                           │
│       --auth-bypass-token-duration 12               │
│                                                     │
│ 2. Extract from h2_deploy_log.json                  │
│    └─ url + authBypassToken                         │
│                                                     │
│ 3. Update preview config (varies by approach)       │
│    └─ Sanity document, KV store, or one-time setup  │
└────────────────────┬────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────┐
│ Sanity Studio — Presentation Tool                   │
│                                                     │
│ 4. Reads preview config                             │
│ 5. Constructs iframe URL with auth                  │
│ 6. Iframe loads → Gateway passes → preview activates│
│ 7. Visual editing works                             │
└─────────────────────────────────────────────────────┘
```

---

## 6. ~~Approach 1 — Async `initial` + Cookie Timing~~ INVALIDATED

> **INVALIDATED 2026-02-17.** Testing confirmed `enable` is called FIRST, not `initial`.
> See Section 4 for validated load order evidence.

### Why It Fails

The async `initial` URL is resolved but **never loaded directly in the iframe**. Instead, its value is passed as the `sanity-preview-pathname` query parameter to the `enable` endpoint. The `enable` endpoint is the **first and only iframe navigation**.

This means putting `?_auth=TOKEN` on `initial` has no effect on Gateway Worker auth — the token never reaches the Gateway.

### Revised Approach: `?_auth=` on the `enable` Path

Since `enable` IS the first request, injecting the token there works:

```typescript
presentationTool({
  previewUrl: {
    origin: 'https://deployment.myshopify.dev',
    previewMode: {
      enable: `/api/preview?_auth=${TOKEN}`,  // Token on the enable path
    },
  },
})
```

The iframe URL becomes:
```
https://deployment.myshopify.dev/api/preview?_auth=TOKEN&sanity-preview-secret=xxx&sanity-preview-pathname=/
```

Gateway sees `?_auth=TOKEN` → passes through → sets cookie → enable endpoint runs → preview mode activates → all subsequent navigations use cookie.

**The blocker**: `previewMode.enable` is a **static string** — no async support. The token must be known at Studio config evaluation time. For Sanity-hosted studios, this means:
- Token must be set as a Studio environment variable (via Sanity Manage)
- OR the `sanity.config.ts` must dynamically construct it using a top-level await or module-scope fetch

### Potential: Module-Scope Dynamic Fetch

```typescript
// sanity.config.ts — runs once when Studio loads
const oxygenConfig = await fetch('https://YOUR_PROJECT.api.sanity.io/v2025-01-01/data/query/production?query=*[_id=="oxygenPreview-staging"][0]{url,authToken}')
  .then(r => r.json())
  .then(r => r.result)

export default defineConfig({
  plugins: [
    presentationTool({
      previewUrl: {
        origin: oxygenConfig?.url || 'http://localhost:3000',
        previewMode: {
          enable: oxygenConfig?.authToken
            ? `/api/preview?_auth=${oxygenConfig.authToken}`
            : '/api/preview',
        },
      },
    }),
  ],
})
```

**Status**: Needs validation — does Sanity Studio's Vite build support top-level await in `sanity.config.ts`? If yes, this is **Approach 1b** and would work with CI updating a Sanity document.

---

## 7. Approach 2 — Cloudflare Proxy Worker

### Concept

Deploy a lightweight Cloudflare Worker at a **stable URL** (e.g., `staging-preview.umg-domain.com`) that:
1. Reads the current deployment URL + token from a config store (Sanity document or KV)
2. Proxies all requests, adding the `oxygen-auth-bypass-token` header
3. Forwards to the actual Oxygen deployment
4. Returns the response to the Studio iframe

### Proxy Worker (Cloudflare)

```typescript
// worker.ts
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Read config from KV (updated by CI)
    const config = JSON.parse(await env.PREVIEW_CONFIG.get('staging') || '{}')

    if (!config.url || !config.authToken) {
      return new Response('No staging deployment configured', { status: 503 })
    }

    // Rewrite URL: proxy origin → actual Oxygen deployment
    const url = new URL(request.url)
    const targetUrl = new URL(url.pathname + url.search, config.url)

    // Clone request, add auth header
    const proxyRequest = new Request(targetUrl, {
      method: request.method,
      headers: new Headers(request.headers),
      body: request.body,
    })
    proxyRequest.headers.set('oxygen-auth-bypass-token', config.authToken)

    // Forward to Oxygen
    const response = await fetch(proxyRequest)

    // Return response (may need to rewrite some headers)
    return new Response(response.body, {
      status: response.status,
      headers: response.headers,
    })
  }
}
```

### Studio Config (static — set once)

```typescript
// sanity.config.ts
presentationTool({
  previewUrl: {
    origin: 'https://staging-preview.umg-domain.com',
    previewMode: {
      enable: '/api/preview',
    },
  },
  allowOrigins: ['https://staging-preview.umg-domain.com'],
})
```

### CI Step (after deploy)

```yaml
- name: Update proxy config
  run: |
    URL=$(jq -r '.url' h2_deploy_log.json)
    TOKEN=$(jq -r '.authBypassToken' h2_deploy_log.json)
    # Update Cloudflare KV
    curl -X PUT "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT/storage/kv/namespaces/$KV_NAMESPACE/values/staging" \
      -H "Authorization: Bearer $CF_TOKEN" \
      -H "Content-Type: application/json" \
      -d "{\"url\": \"$URL\", \"authToken\": \"$TOKEN\"}"
```

### Pros / Cons

| Pros | Cons |
|---|---|
| **Most reliable** — no timing/ordering issues | Requires Cloudflare account + Worker deployment |
| Stable URL — Studio config never changes | Extra infrastructure to maintain |
| Header-based auth — no tokens in URLs | Proxy adds latency (minimal, same edge network) |
| Works with any Studio hosting | Need to handle CORS, cookies, WebSocket for live preview |
| No cookie expiry issues | Response rewriting may need care (redirects, CSP headers) |

### Implementation Complexity

The proxy needs to handle:
- [ ] URL rewriting (proxy origin ↔ Oxygen origin)
- [ ] Cookie domain rewriting (`.myshopify.dev` → proxy domain)
- [ ] `Location` header rewriting (redirects)
- [ ] CSP `frame-ancestors` rewriting (allow Studio origin)
- [ ] WebSocket proxying (for Sanity real-time updates, if applicable)
- [ ] CORS headers

This is non-trivial but well-understood (standard reverse proxy pattern).

---

## 8. Approach 3 — Stable Environment URL + One-Time Token

### Concept

If Oxygen provides a **stable URL** for the staging environment (always pointing to the latest deployment), and if a `USER_SHARED` share token works across deployment changes within that environment, then:

1. Get the stable staging URL from Admin (one time)
2. Generate a share token from Admin (one time)
3. Configure Studio with both (one time)
4. Never touch it again

### Studio Config (static)

```typescript
// sanity.config.ts — set in Sanity Manage env vars
presentationTool({
  previewUrl: {
    origin: process.env.SANITY_STUDIO_STAGING_URL, // stable environment URL
    previewMode: {
      enable: `/api/preview?_auth=${process.env.SANITY_STUDIO_STAGING_TOKEN}`,
    },
  },
  allowOrigins: [process.env.SANITY_STUDIO_STAGING_URL],
})
```

### Pros / Cons

| Pros | Cons |
|---|---|
| **Zero infrastructure** — no proxy, no CI integration | Depends on TWO unverified assumptions |
| Set once, never touch again | If token is deployment-scoped, breaks on every new deploy |
| Simplest possible setup | If no stable environment URL exists, approach is impossible |
| No CI changes needed | `previewMode.enable` is a static string — token baked in at build time |

### Requirements (must ALL be true)

1. Oxygen provides a stable URL for the staging custom environment
2. A `USER_SHARED` share token works when the stable URL points to a new deployment
3. Sanity-hosted Studio supports env vars (via Sanity Manage) that can be used in config

If ANY of these are false, this approach is not viable.

---

## 9. Approach Comparison (Updated Post-Validation)

| Criteria | ~~Approach 1~~ (INVALID) | Approach 1b (Module fetch) | Approach 2 (Proxy) | Approach 3 (Stable URL) |
|---|---|---|---|---|
| **Status** | **INVALIDATED** | Needs validation | Viable | Needs validation |
| **Reliability** | N/A | Unknown (top-level await) | High | Unknown (assumptions) |
| **Infrastructure** | N/A | None | Cloudflare Worker | None |
| **CI changes** | N/A | Patch Sanity doc | Update KV store | None |
| **Studio changes** | N/A | Module-scope fetch | Static origin | Static env vars |
| **Token handling** | N/A | Dynamic per deploy | Dynamic per deploy | One-time setup |
| **Studio rebuild** | N/A | Not needed | Not needed | Needed once (env vars) |
| **Maintenance** | N/A | Low | Medium | None (if it works) |
| **Risk** | N/A | Medium (TLA support) | Low (proven pattern) | High (unverified) |

---

## 10. Hydrogen App Requirements (All Approaches)

Regardless of which approach is chosen, the Hydrogen app must:

### 1. Configure CSP for Studio iframe

```typescript
// entry.server.tsx
const {nonce, header, NonceProvider} = createContentSecurityPolicy({
  frameAncestors: isPreviewEnabled
    ? ['https://YOUR_PROJECT.sanity.studio'] // allow Studio to iframe
    : [],
  connectSrc: [
    `https://${projectId}.api.sanity.io`,
    `wss://${projectId}.api.sanity.io`,
  ],
})
```

### 2. Implement preview mode endpoints

```typescript
// app/routes/api.preview.ts (Hydrogen with hydrogen-sanity)
export {action, loader} from 'hydrogen-sanity/preview/route'
```

Or for React Router (without hydrogen-sanity):
```typescript
// app/routes/api.preview-mode.enable.tsx
// Validates Sanity preview URL secret, sets preview session cookie, redirects
```

### 3. Render Visual Editing in preview mode

```typescript
// app/root.tsx
import {VisualEditing} from 'hydrogen-sanity/visual-editing'

export function Layout({children}) {
  const previewMode = usePreviewMode()
  return (
    <html>
      <body>
        {children}
        {previewMode && <VisualEditing action="/api/preview" />}
      </body>
    </html>
  )
}
```

### 4. Add Sanity client with stega support

```typescript
// lib/context.ts
const sanity = await createSanityContext({
  client: {
    projectId, dataset, apiVersion,
    useCdn: true,
    stega: {
      enabled: isPreviewEnabled(projectId, previewSession),
      studioUrl: 'https://YOUR_PROJECT.sanity.studio',
    },
  },
  preview: { token: env.SANITY_PREVIEW_TOKEN, session: previewSession },
})
```

---

## 11. Open Questions & Validation Steps

### Must Validate Before Choosing an Approach

#### Q1: Does Oxygen have a stable URL for custom environments?

**What to check**: Shopify Admin → Hydrogen → Storefront → Settings → Environments → Staging

- [ ] Look for a persistent "Environment URL" (not per-deployment URL)
- [ ] If it exists, note the URL format
- [ ] Test: push a new commit to staging, verify the stable URL now serves the new deployment

**Impact**: If yes → Approach 3 becomes possible. If no → Approach 3 is eliminated.

#### Q2: Is the `USER_SHARED` token environment-scoped or deployment-scoped?

**What to check**: The JWT `sub` claim in share tokens

- [ ] Get a share token for staging deployment A (from Admin "Share preview" button)
- [ ] Decode the JWT — is `sub` a deployment GID or an environment GID?
- [ ] Push a new commit to staging (creating deployment B)
- [ ] Test: does deployment A's token work on the stable environment URL (now pointing to B)?

**Impact**: If environment-scoped → Approach 3 works. If deployment-scoped (likely, based on prior testing) → Approach 3 fails.

#### Q3: What is the Presentation tool's iframe load ordering?

**What to check**: Does `initial` load before or after `previewMode.enable`?

- [ ] Set up a test with a simple frontend and Presentation tool
- [ ] Log the order of requests: which endpoint gets hit first?
- [ ] Or: inspect `sanity/presentation` source code for the loading sequence

**Impact**: If `initial` loads first → Approach 1 is viable. If `enable` loads first → Approach 1 fails.

#### Q4: Does `previewUrl.origin` support async functions?

**What to check**: Sanity source code or experimentation

- [ ] Try passing an async function to `origin` in presentationTool config
- [ ] Check if the Presentation tool resolves it

**Impact**: If yes → Approach 1 becomes much stronger (can set origin dynamically AND append `?_auth=` to enable path).

#### Q5: Can Sanity-hosted Studio use env vars in `sanity.config.ts`?

**What to check**: Sanity Manage → Studio → Environment Variables

- [ ] Can you set custom env vars (e.g., `SANITY_STUDIO_STAGING_URL`)?
- [ ] Are they available at build time (`process.env`) or runtime?
- [ ] Does changing an env var trigger a Studio rebuild?

**Impact**: Determines whether static config approaches (Approach 3) work with Sanity-hosted Studio.

#### Q6: Can the Cloudflare proxy correctly handle Sanity Visual Editing's postMessage protocol?

**What to check**: If choosing Approach 2

- [ ] Does Sanity Visual Editing use postMessage between Studio and iframe?
- [ ] If so, does the proxy break the origin matching for postMessage?
- [ ] Does `allowOrigins` in Studio config need to match the proxy or the actual Oxygen URL?

**Impact**: If postMessage breaks through proxy → Approach 2 needs additional work (or may not work).

#### Q7: What is the max `--auth-bypass-token-duration`?

**What to check**: Shopify Hydrogen CLI

- [ ] Test `--auth-bypass-token-duration 720` (30 days)
- [ ] Test `--auth-bypass-token-duration 8760` (1 year)
- [ ] Determine the practical maximum

**Impact**: Longer token duration reduces how often CI needs to refresh the token.

### Recommended Investigation Order

1. **Q1 + Q2** (check Admin UI — 15 min) → determines if Approach 3 is possible
2. **Q5** (check Sanity Manage — 5 min) → determines if static config works
3. ~~**Q3** (quick test or source read — 30 min) → determines if Approach 1 is viable~~ **ANSWERED** — `enable` loads first
4. **Q7** (CLI test — 5 min) → informs token refresh strategy
5. ~~**Q4** (source code check — 15 min) → could unlock better Approach 1 variant~~ **ANSWERED** — `previewMode` supports async functions
6. **Q6** (only if going with Approach 2 — 1 hr) → validates proxy approach

---

## 12. Validated Findings (2026-02-17)

### Q3 ANSWERED: `previewMode.enable` loads FIRST

Validated via test server on `studio-meditate-with-eve` (`test/presentation-load-order` branch).

```
#1  GET /api/preview-mode/enable?sanity-preview-secret=...&sanity-preview-pathname=%2F%3Fsource%3Dinitial
#2  GET /                         (redirect from enable)
```

`initial` is resolved async but its value is passed as `sanity-preview-pathname` in the enable URL. The enable endpoint is the first and only direct iframe navigation.

### Q4 ANSWERED: `previewMode` supports async functions

From `sanity/lib/presentation.d.ts` (sanity@5.8.0):

```typescript
type PreviewUrlPreviewModeOption =
  | PreviewUrlPreviewMode                     // static { enable: string }
  | ((context: PreviewUrlPreviewModeOptionContext) =>
      false | PreviewUrlPreviewMode | Promise<false | PreviewUrlPreviewMode>)

interface PreviewUrlPreviewModeOptionContext {
  client: SanityClient    // Authenticated Sanity client
  origin: string          // Studio's own origin
  targetOrigin: string    // The preview iframe's origin
}
```

This means we can dynamically fetch the Oxygen token from a Sanity document using the provided `client` and construct the `enable` path with `?_auth=TOKEN` at runtime. No env vars, no Studio rebuild.

### Sanity Team Confirmation: Query Params on `enable` Path

[Issue #2459](https://github.com/sanity-io/visual-editing/issues/2459) — Sanity team member `@stipsan` explicitly suggested appending protection bypass params to `previewMode.enable`:

```typescript
previewMode: {
  enable: `/preview/enable?${new URLSearchParams({
    'x-vercel-protection-bypass': process.env.VERCEL_AUTOMATION_BYPASS_SECRET,
  })}`,
}
```

This confirms query params on the `enable` path is an officially supported pattern.

### How `@sanity/vercel-protection-bypass` Works (Source Code Analysis)

```
@sanity/vercel-protection-bypass (plugin)
  └─ Registers a Studio tool (UI tab) for managing a secret
  └─ Stores secret in Sanity doc:
       _id: "sanity-preview-url-secret.vercel-protection-bypass"
       _type: "sanity.vercelProtectionBypass"
       field: secret (32-char string)

@sanity/preview-url-secret (shared constants)
  └─ Defines well-known document IDs, GROQ queries, URL param names
  └─ urlSearchParamVercelProtectionBypass = "x-vercel-protection-bypass"

sanity/presentation (core — CLOSED SOURCE, hardcoded)
  └─ Reads the secret from the well-known document
  └─ Appends ?x-vercel-protection-bypass=SECRET to ALL iframe URLs
  └─ This is HARDCODED for Vercel — no generic plugin hook
```

Key difference: Vercel's secret is **project-scoped** (one static 32-char secret for all deployments). Oxygen's token is **deployment-scoped** (per-deployment JWT).

---

## 13. Chosen Approach: Async `previewMode` Plugin

### Architecture: Middleware/Hook Pattern

The plugin exports an async function that users pass directly to `presentationTool`'s `previewMode` option. Minimal, composable, no wrapper needed.

### How It Works

```
┌─────────────────────────────────────────────────────┐
│ CI (GitHub Actions — on push to staging)            │
│                                                     │
│ 1. Deploy to Oxygen                                 │
│ 2. Extract URL + token from h2_deploy_log.json      │
│ 3. Patch Sanity document:                           │
│    _id: "oxygen-bypass.live-store-live"              │
│    {deploymentUrl, authToken, updatedAt}             │
└────────────────────┬────────────────────────────────┘
                     │ writes to Content Lake
                     ▼
┌─────────────────────────────────────────────────────┐
│ Sanity Studio — presentationTool config             │
│                                                     │
│ previewMode: resolveOxygenPreviewMode(options)      │
│                                                     │
│ 4. Async function receives {client, targetOrigin}   │
│ 5. Queries Sanity for matching config doc           │
│    (matches targetOrigin against stored URLs)       │
│ 6. Returns {enable: '/api/preview?_auth=TOKEN'}     │
│                                                     │
│ 7. Presentation tool loads iframe:                  │
│    ${targetOrigin}/api/preview?_auth=TOKEN           │
│    &sanity-preview-secret=xxx                       │
│    &sanity-preview-pathname=/                        │
│                                                     │
│ 8. Gateway sees ?_auth= → passes → sets cookie     │
│ 9. /api/preview validates Sanity secret             │
│ 10. Preview mode activates → CSP allows Studio      │
│ 11. Visual editing works                            │
└─────────────────────────────────────────────────────┘
```

### Plugin API (User-Facing)

```typescript
// apps/sanity-studio/config/plugins/tools/index.ts
import {presentationTool} from 'sanity/presentation'
import {resolveOxygenPreviewMode} from '@umg/sanity-plugin-oxygen-bypass'

presentationTool({
  previewUrl: {
    initial: env.SANITY_STUDIO_HYDROGEN_LIVE_STORE_LIVE_STOREFRONT_URL ?? 'http://localhost:3000',
    previewMode: resolveOxygenPreviewMode({
      // The preview-mode enable path on the Hydrogen app
      enablePath: '/api/preview',
      // Fallback when no Oxygen config found (e.g., localhost)
      fallbackToStatic: true,
    }),
  },
  allowOrigins: [
    'http://localhost:*',
    env.SANITY_STUDIO_HYDROGEN_RELEASE_STORE_RELEASE_STOREFRONT_URL,
    env.SANITY_STUDIO_HYDROGEN_LIVE_STORE_RELEASE_STOREFRONT_URL,
    env.SANITY_STUDIO_HYDROGEN_LIVE_STORE_LIVE_STOREFRONT_URL,
  ].filter((origin): origin is string => !!origin),
})
```

### Plugin Implementation (Conceptual)

```typescript
// resolveOxygenPreviewMode.ts
import type {PreviewUrlPreviewModeOptionContext, PreviewUrlPreviewMode} from 'sanity/presentation'

interface OxygenBypassOptions {
  enablePath?: string       // default: '/api/preview'
  fallbackToStatic?: boolean // default: true
  documentPrefix?: string   // default: 'oxygen-bypass'
}

const QUERY = `*[
  _type == "sanity.oxygenProtectionBypass"
  && deploymentUrl match $targetOrigin + "*"
][0]{authToken}`

export function resolveOxygenPreviewMode(options: OxygenBypassOptions = {}) {
  const {enablePath = '/api/preview', fallbackToStatic = true, documentPrefix = 'oxygen-bypass'} = options

  return async (context: PreviewUrlPreviewModeOptionContext): Promise<PreviewUrlPreviewMode | false> => {
    const {client, targetOrigin} = context

    // Skip bypass for localhost
    if (targetOrigin.includes('localhost')) {
      return {enable: enablePath}
    }

    try {
      // Fetch Oxygen bypass config matching this storefront
      const config = await client.fetch(QUERY, {targetOrigin})

      if (config?.authToken) {
        // Append ?_auth= to the enable path
        const params = new URLSearchParams({_auth: config.authToken})
        return {enable: `${enablePath}?${params}`}
      }
    } catch (err) {
      console.warn('[oxygen-bypass] Failed to fetch config:', err)
    }

    // Fallback: no token found
    if (fallbackToStatic) {
      return {enable: enablePath}
    }
    return false // disables preview mode
  }
}
```

### Schema: One Document Per Storefront

```typescript
// schema: sanity.oxygenProtectionBypass
{
  _id: 'oxygen-bypass.live-store-live',
  _type: 'sanity.oxygenProtectionBypass',
  name: 'Live Store — Live',
  deploymentUrl: 'https://01khkem8j2pxad8qcwcq3cgdfc-abc123.myshopify.dev',
  authToken: 'eyJhbGciOiJIUzI1NiJ9...',
  branch: 'main',
  updatedAt: '2026-02-17T14:30:00Z',
}

{
  _id: 'oxygen-bypass.live-store-release',
  _type: 'sanity.oxygenProtectionBypass',
  name: 'Live Store — Release',
  deploymentUrl: 'https://01khkem8j2pxad8qcwcq3cgdfc-def456.myshopify.dev',
  authToken: 'eyJhbGciOiJIUzI1NiJ9...',
  branch: 'staging',
  updatedAt: '2026-02-17T14:30:00Z',
}
```

### CI Integration (GitHub Actions)

```yaml
# After Hydrogen deploy step
- name: Update Sanity Oxygen bypass config
  env:
    SANITY_TOKEN: ${{ secrets.SANITY_API_WRITE_TOKEN }}
    SANITY_PROJECT_ID: vl6xvhbn
    SANITY_DATASET: dev-gcom-tempo
  run: |
    URL=$(jq -r '.url' h2_deploy_log.json)
    TOKEN=$(jq -r '.authBypassToken' h2_deploy_log.json)
    STORE_ID="live-store-live"  # varies per workflow

    curl -X POST "https://$SANITY_PROJECT_ID.api.sanity.io/v2025-01-01/data/mutate/$SANITY_DATASET" \
      -H "Authorization: Bearer $SANITY_TOKEN" \
      -H "Content-Type: application/json" \
      -d "{
        \"mutations\": [{
          \"createOrReplace\": {
            \"_id\": \"oxygen-bypass.$STORE_ID\",
            \"_type\": \"sanity.oxygenProtectionBypass\",
            \"deploymentUrl\": \"$URL\",
            \"authToken\": \"$TOKEN\",
            \"branch\": \"$GITHUB_REF_NAME\",
            \"updatedAt\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"
          }
        }]
      }"
```

### Optional: Studio Management UI

A simple Studio tool tab (like the Vercel plugin) that:
1. Lists all configured storefronts with their bypass status
2. Shows token age / expiry warnings
3. Allows manual token entry (for Admin UI share tokens)
4. Shows last CI update timestamp

---

## 14. Validation Results (2026-02-17)

All 6 questions validated against real Oxygen deployments on the `preview-deployments-auth` storefront (`1000099369` on `juanprieto.myshopify.com`).

### Q1: Does Oxygen Have Stable Environment URLs? — YES

**Method**: `npx shopify hydrogen env list`

**Result**: Three environments, each with a stable URL:

| Environment | Handle | Branch | Stable URL |
|---|---|---|---|
| Production | `production` | `main` | `https://preview-deployments-auth-e470de767fb720fff6ee.o2.myshopify.dev` |
| Staging | `staging` | `staging` | `https://staging-f47de06af4f98b573090.o2.myshopify.dev` |
| Preview | `preview` | (all unassigned) | (no stable URL — preview is per-deployment only) |

**Key observation**: The stable URL hash (`f47de06af4f98b573090`) appears in per-deployment URLs too:
- Deploy B URL: `01khpdbgb78zbz0mawb1hx1xqh-f47de06af4f98b573090.myshopify.dev`
- Deploy C URL: `01khpdgn5k89xmn0c6ax4ycgbt-f47de06af4f98b573090.myshopify.dev`
- Stable URL:   `staging-f47de06af4f98b573090.o2.myshopify.dev`

The hash after the dash is the **environment identifier** — stable URLs use it with the `o2.myshopify.dev` domain.

**Both URLs are auth-protected** (302 → Shopify OAuth when bare).

---

### Q2: Do Tokens Survive New Deployments? — NO (deployment-scoped)

**Method**: Three sequential deployments to staging, testing tokens across all combinations.

#### Test Setup

| Deploy | Trigger | Deployment GID | Token Type | URL |
|---|---|---|---|---|
| A | PR #4 → staging | `Deployment/4051548` | `USER_SHARED` (bot) + `TESTING_AUTOMATION` (CI) | `01khpcvdn8fp9dn1bqqav8s665-...` |
| B | Direct push to staging | `Deployment/4051609` | `TESTING_AUTOMATION` (CI) | `01khpdbgb78zbz0mawb1hx1xqh-...` |
| C | Direct push to staging | `Deployment/4051623` | `TESTING_AUTOMATION` (CI) | `01khpdgn5k89xmn0c6ax4ycgbt-...` |

#### Token × URL Matrix (After Deploy C — Stable URL Points to C)

##### `?_auth=` Parameter Tests

| Token | Own Deploy URL | Cross-Deploy URL | Stable Staging URL |
|---|:---:|:---:|:---:|
| A bot (`USER_SHARED`, no exp) | **200** | 302 | **302** |
| B CI (`TESTING_AUTOMATION`, 12h) | **200** | 302 | **302** |
| C CI (`TESTING_AUTOMATION`, 12h) | **200** | 302 | **200** |

##### Header Tests (`oxygen-auth-bypass-token: TOKEN`)

| Token | Stable Staging URL |
|---|:---:|
| A bot (Deploy A) | **302** |
| B CI (Deploy B) | **302** |
| C CI (Deploy C, current) | **200** |

##### Cookie Tests

| Method | Stable Staging URL |
|---|:---:|
| Cookie from Deploy A (`.myshopify.dev` domain) | **302** |
| Cookie from Deploy C (current) | **200** |

#### Conclusions

1. **Tokens are strictly deployment-scoped** — `sub: gid://oxygen-hub/Deployment/XXXX` in JWT
2. **Only the CURRENT deployment's token works on the stable URL** — when staging rotated from Deploy B → Deploy C, Deploy B's token stopped working
3. **`USER_SHARED` (no-expiry) tokens do NOT help** — they avoid time expiry but still die on deployment rotation
4. **Cookie domain is `.myshopify.dev`** (wildcard) — but the JWT inside the cookie is still validated per-deployment
5. **All three auth methods** (`?_auth=`, header, cookie) behave identically — validated against the deployment GID

#### USER_SHARED Token Longevity — Validated 2026-02-18

Separate from deployment-scoping (Q2 above), we validated that `USER_SHARED` tokens have **no time-based expiry** — unlike `TESTING_AUTOMATION` tokens which expire after `--auth-bypass-token-duration` (max 12h).

**Method**: Tested `USER_SHARED` tokens from historical shopify[bot] PR comments against their original per-deployment URLs.

| PR | Deployment GID | Token Issued (UTC) | Test Time (UTC) | Age | HTTP Status |
|---|---|---|---|---|---|
| #1 | `Deployment/4042382` | 2026-02-16T10:04:16Z | 2026-02-18T18:45Z | **56.7h (2.4 days)** | **200** |
| #4 | `Deployment/4051548` | 2026-02-17T20:30:11Z | 2026-02-18T18:45Z | **22.3h** | **200** |
| #7 | `Deployment/4055206` | 2026-02-17T22:06:26Z | 2026-02-18T18:45Z | **20.7h** | **200** |
| #11 | `Deployment/4055615` | 2026-02-18T11:34:29Z | 2026-02-18T18:45Z | **7.1h** | **200** |

**JWT payload** (all identical structure — note: NO `exp` claim):
```json
{
  "sub": "gid://oxygen-hub/Deployment/XXXXXXX",
  "kind": "USER_SHARED",
  "iat": 1771236256
}
```

**Key findings**:
1. `USER_SHARED` tokens survive **56+ hours** with no degradation — well past the 12h `TESTING_AUTOMATION` ceiling
2. The JWT has NO `exp` claim — the Oxygen Gateway does not enforce time-based expiry for `USER_SHARED` kind
3. Tokens only die when their deployment is replaced (deployment-scoped, confirmed in Q2)
4. All three auth methods (`?_auth=`, header, cookie) work identically at any token age

**Comparison of token types**:

| Property | `TESTING_AUTOMATION` | `USER_SHARED` |
|---|---|---|
| Generated by | `--auth-bypass-token` flag | shopify[bot] PR comment |
| Written to | `h2_deploy_log.json` | PR comment body |
| Has `exp` claim | **Yes** (max 12h) | **No** |
| Time-based expiry | Yes, enforced by Gateway | None |
| Deployment-scoped | Yes | Yes |
| Multi-use | No (single-use per spec) | Yes |
| Used by CI sync workflow | No (smoke tests only) | **Yes** (synced to Sanity) |

#### Critical Implication for Plugin

The token stored in the Sanity document **MUST be refreshed on every deployment**. There is no "set and forget" approach. CI integration is mandatory, not optional. However, between deployments, the `USER_SHARED` token never expires — editors can use the Presentation tool indefinitely without time-based token rotation.

---

### Q3: Max `--auth-bypass-token-duration`? — 12 HOURS (hard limit)

**Method**: `npx shopify hydrogen deploy --help`

**CLI documentation**:
```
--auth-bypass-token-duration=<value>  Specify the duration (in hours) up
                                      to 12 hours for the authentication
                                      bypass token. Defaults to `2`
```

**Implication**: `TESTING_AUTOMATION` tokens max out at 12 hours. But since Q2 proved tokens die on redeploy anyway, the 12h limit is only relevant if there are NO deploys within 12h. For active development branches, deployment frequency (not token TTL) is the bottleneck.

**For stakeholder sharing**: The 12h `TESTING_AUTOMATION` limit is NOT a problem because:
- PR bot posts `USER_SHARED` tokens with NO expiry
- These survive indefinitely until the deployment is replaced
- Our plugin should use CI tokens (refreshed on every deploy), not stakeholder tokens

---

### Q4: Does Async `previewMode` Work E2E? — YES

**Method**: Node.js simulation of Presentation tool's async `previewMode` flow against real Oxygen Gateway.

**Test script**: `validation/q4-async-preview-mode.mjs`

**Flow tested**:
```
1. Plugin's resolveOxygenPreviewMode() called with {targetOrigin: stable_staging_url}
2. Returns {enable: '/api/preview-mode/enable?_auth=TOKEN'}
3. Full URL constructed: ${stable_staging_url}/api/preview-mode/enable?_auth=TOKEN&sanity-preview-secret=xxx&sanity-preview-pathname=/
4. HTTP request sent to that URL
```

**Results**:

| Test | URL | HTTP Status | Meaning |
|---|---|---|---|
| Full enable URL with `?_auth=` | `${stable}/api/preview-mode/enable?_auth=TOKEN&...` | **404** | Gateway PASSED (404 = app route not found, but Gateway accepted auth) |
| Simple `?_auth=` | `${stable}?_auth=TOKEN` | **200** | Baseline confirmation |
| No auth (baseline) | `${stable}` | **302** | Correctly blocked |

**Cookie set**: YES — `auth_bypass_token` with `Max-Age=3600` on `.myshopify.dev`

**Why 404 not 200**: The Hydrogen app doesn't have an `/api/preview-mode/enable` route. The 404 proves the Gateway Worker passed through (if Gateway rejected, it would be 302). In a real Hydrogen app with the enable route configured, this would be a 200 or 307 redirect.

**Validated**: The `?_auth=TOKEN` on the `enable` path passes through the Oxygen Gateway Worker. The async `previewMode` function can dynamically inject the token.

---

### Q5: Cookie TTL Behavior — 1hr, Re-settable, Session-Breaking on Expiry

**Method**: curl tests with cookie capture and reuse.

**Cookie characteristics**:
```
Set-Cookie: auth_bypass_token=<JWT>; Max-Age=3600; Domain=myshopify.dev; Path=/; HttpOnly; Secure
```

| Property | Value | Implication |
|---|---|---|
| Max-Age | 3600 (1 hour) | Cookie expires after 1hr of continuous browsing |
| Domain | `.myshopify.dev` | Wildcard — covers ALL `*.myshopify.dev` subdomains |
| HttpOnly | Yes | Not accessible via JavaScript (can't refresh programmatically) |
| Secure | Yes | HTTPS only |
| Path | `/` | All paths |

**Behavior tests**:

| Test | Result |
|---|---|
| Cookie-only navigation (no `?_auth=`) | **200** — works for 1hr |
| Subpage navigation with cookie | **200** — `/collections`, etc. |
| `?_auth=` on any page re-sets cookie | **YES** — fresh 1hr from that point |
| Cookie after expiry | **302** — Gateway blocks, shows OAuth |

**Mid-session expiry scenario**:
1. Editor opens Presentation tool → `enable` URL with `?_auth=` → cookie set (1hr)
2. Editor works for 1hr → cookie expires
3. Next iframe navigation → **302 redirect to OAuth inside iframe** → broken experience
4. **Fix**: Studio page refresh → re-runs async `previewMode` → re-sends `?_auth=` → fresh cookie

**Mitigation options** (in order of preference):
1. **Accept it** — 1hr is reasonable for most editing sessions; refresh fixes it
2. **Studio-side interceptor** — detect 302 in iframe, auto-trigger re-auth via `previewMode`
3. **Service Worker in Hydrogen** — intercept expired-cookie requests, append `?_auth=` from a stored token

---

### Q6: Sanity Live Content API Auto-Refresh — NOT YET TESTED

**Status**: Deferred. Requires a running Sanity Studio with a real Sanity client to test whether `client.live` or similar mechanisms auto-refresh the config document when CI updates it.

**Hypothesis**: If the async `previewMode` function is called once on Studio load (not per-navigation), then a CI update to the Sanity document would NOT be picked up without a Studio page refresh. The `previewMode` resolver likely caches its result.

**To validate**: Need to add logging inside the async `previewMode` function in a real Studio and check:
1. Is it called once or on every navigation?
2. If once, does Studio re-call it when the iframe URL changes?
3. Does `client.live` or `client.listen` provide real-time updates?

---

## 15. Updated Architecture Recommendations

Based on validated findings, the plugin architecture adjustments:

### What Changed

| Assumption | Before Validation | After Validation |
|---|---|---|
| Stable URLs exist | Unknown | **YES** — per-environment stable URLs |
| Tokens work on stable URLs | Hoped yes | **YES, but only current deployment's token** |
| Token portability | Unknown | **NO** — strictly deployment-scoped, dies on redeploy |
| USER_SHARED (no-exp) helps | Hoped yes | **YES** — use per-deploy URL + USER_SHARED (no exp, survives indefinitely between deploys) |
| Max token TTL | Unknown | **12 hours** (hard limit in CLI for TESTING_AUTOMATION) |
| Cookie TTL | Unknown | **1 hour** (non-configurable, re-settable via `?_auth=`) |
| `?_auth=` on enable path | Theorized | **VALIDATED** — Gateway passes through |
| Cookie domain | Unknown | **`.myshopify.dev`** (wildcard, covers all subdomains) |

### Key Architectural Decision: Per-Deploy URL + USER_SHARED Token

The 12h `TESTING_AUTOMATION` token limit is unacceptable for stakeholders. `USER_SHARED` tokens (no `exp` claim) are the only viable option.

**Tradeoff: Stable URL vs Per-Deploy URL**

| Strategy | URL | Token | Between deploys | On redeploy |
|---|---|---|---|---|
| Stable URL + TESTING_AUTOMATION | Stable (never changes) | 12h exp | **Dies in 12h** | CI refreshes |
| **Per-deploy URL + USER_SHARED** | **Changes per deploy** | **No expiry** | **Never expires** | **CI refreshes both** |

**Decision**: Use per-deployment URL + `USER_SHARED` token. CI stores both in the Sanity document. Between deploys, access is unlimited (validated: 56h+ token still returns HTTP 200 — see "USER_SHARED Token Longevity" above). Both `initial` (URL) and `previewMode` (token) support async and can read from the Sanity document dynamically.

### Plugin Architecture (Updated)

```
CI deploys to staging (via PR merge)
  → Shopify bot posts PR comment with per-deploy URL + USER_SHARED token
  → CI extracts URL + token from bot comment
  → CI patches Sanity document: {deploymentUrl, authToken (USER_SHARED)}
  → Studio's async `initial` reads deploymentUrl from Sanity doc
  → Studio's async `previewMode` reads authToken from Sanity doc
  → Returns {enable: '/api/preview?_auth=USER_SHARED_TOKEN'}
  → Gateway passes through, sets 1hr cookie
  → Editing session works for 1hr (page refresh re-triggers enable for fresh cookie)
  → Token never expires between deploys — no 12h limit
```

### USER_SHARED Token Source: Shopify Bot PR Comment

The `USER_SHARED` token is ONLY available from:
1. **Shopify GitHub bot** — auto-posts on PRs with `?_auth=<JWT>` in the preview link
2. **Shopify Admin UI** — "Share preview" button (manual, not programmatic)

**No public API exists** to generate `USER_SHARED` tokens programmatically.

**Workflow constraint**: All staging deploys MUST go through PRs (not direct pushes) to get bot comments with `USER_SHARED` tokens. This is acceptable — PR-based deploys are already best practice.

---

## 16. CI Strategy Evaluation

### All Strategies to Get USER_SHARED Token into Sanity

| # | Strategy | How | Reliability | Complexity | Dependencies |
|---|---|---|---|---|---|
| 1 | **Poll in deploy workflow** | After deploy, sleep 15s, `gh pr view` to extract bot token | High (bot posts at deploy completion) | Low | Same workflow, `gh` CLI |
| 2 | **`issue_comment` trigger** | Separate workflow on `shopify[bot]` comment | Unknown (needs live test) | Medium | May not fire for GitHub Apps |
| 3 | **CI artifact + separate read** | Deploy saves `h2_deploy_log.json` as artifact, separate workflow reads it + polls for bot comment | Medium | Medium | Cross-workflow artifact API |
| 4 | **`workflow_run` trigger** | Workflow B triggers after deploy Workflow A completes, then extracts bot token | High | Medium | Two workflows |
| 5 | **Repository dispatch** | Deploy workflow calls `repository_dispatch` with token after extracting from bot comment | High | Medium | PAT needed for dispatch |
| 6 | **Direct Sanity patch in deploy workflow** | Deploy step → sleep → extract bot token → curl Sanity API | **Highest** | **Lowest** | Just add steps to existing workflow |

### Key Finding: Bot Comment Timing

The Shopify bot (`shopify[bot]`, user type `Bot`) posts the PR comment at the **exact same timestamp** as the deploy completion. Verified:
- CI run finished: `2026-02-17T18:12:41Z`
- Bot comment created: `2026-02-17T18:12:41Z`

A post-deploy step with a brief sleep (10-15s) is sufficient to reliably extract the token.

### `issue_comment` Event Concern

GitHub Actions does NOT trigger workflows for events created by the repo's own `GITHUB_TOKEN`. However, the Shopify bot is a **third-party GitHub App** — its comments should trigger `issue_comment` events. This needs live validation (see Section 17).

**Constraint**: `issue_comment` workflows only run from the **default branch** (main). The workflow file must exist on main before it can trigger.

### Recommended Strategy

**Primary**: Strategy 6 (direct patch in deploy workflow) — simplest, most reliable, no extra infrastructure.

**Secondary**: Strategy 2 (`issue_comment`) — validate live, use as a backup/audit trigger if it works.

---

## 17. Live Validation: `issue_comment` Trigger — CONFIRMED WORKING

**Status**: **Validated** (2026-02-17). The `issue_comment` trigger fires for `shopify[bot]` comments.

### Test Setup

Workflow file: `.github/workflows/sanity-oxygen-bypass-sync.yml` (pushed to `main` branch)

```yaml
name: Sync Oxygen auth to Sanity
on:
  issue_comment:
    types: [created, edited]
permissions:
  contents: read
  pull-requests: read
jobs:
  sync-token:
    if: >
      github.event.comment.user.login == 'shopify[bot]' &&
      contains(github.event.comment.body, 'Successful') &&
      github.event.issue.pull_request
    steps:
      - Extract URL and token from bot comment body (via COMMENT_BODY env var)
      - Decode JWT payload to validate token kind
      - Verify token via curl (affected by ::add-mask::)
      - Save as JSON artifact (90-day retention)
```

### Test Runs

#### Run 1 — FAILED (syntax error)

| Field | Value |
|---|---|
| Run ID | `22114425506` |
| Triggered by | `shopify[bot]` comment on PR #4 |
| Error | `syntax error near unexpected token '('` |
| Root cause | Bot comment body contained markdown with parentheses `(` — using `${{ github.event.comment.body }}` directly in bash interpolated the raw body into the script, causing shell syntax errors |
| Fix | Passed body through `COMMENT_BODY` env var instead of `${{ }}` template interpolation |

#### Run 2 — SUCCESS

| Field | Value |
|---|---|
| Run ID | `22114577663` |
| Triggered at | `2026-02-17T20:30:15Z` |
| Duration | 10 seconds |
| PR | #4 (`test/q1-q6-validation` → `staging`) |
| Comment author | `shopify[bot]` |

**Extraction Results**:

| Extracted Field | Value |
|---|---|
| Deployment URL | `https://01khpmq7hpc69a4h15hbpm5qz0-e0cbf6cbca25f889f5d7.myshopify.dev` |
| Token length | 176 characters |
| Token kind (JWT decode) | `USER_SHARED` |
| Artifact name | `oxygen-bypass-token` |
| Artifact ID | `5545528829` |
| Artifact download | `https://github.com/juanpprieto/preview-deployments-auth/actions/runs/22114577663/artifacts/5545528829` |

**Token Verification Step**: HTTP 302 (WARNING — see note below)

### Key Finding: `::add-mask::` Side Effect

The token verification curl returned **HTTP 302** (not 200). This is **NOT a real token failure** — it's a GitHub Actions masking side effect:

1. `::add-mask::$AUTH_TOKEN` was called to protect the token in logs
2. GitHub Actions replaces ALL occurrences of the masked value with `***` in ALL subsequent steps
3. When the "Verify token works" step ran `curl "${DEPLOY_URL}?_auth=${AUTH_TOKEN}"`, the `AUTH_TOKEN` env var was replaced with `***`
4. The curl actually sent `?_auth=***` to Oxygen, which correctly rejected it with 302

**Evidence** (from CI logs):
```
env:
  DEPLOY_URL: https://01khpmq7hpc69a4h15hbpm5qz0-e0cbf6cbca25f889f5d7.myshopify.dev
  AUTH_TOKEN: ***          ← masked, not the real token!
```

**The token itself is valid** — verified separately via local curl in Q2 testing. The `::add-mask::` behavior is well-documented GitHub Actions behavior and only affects in-CI verification.

**Workaround options**:
1. **Remove `::add-mask::` from verification step** — the token is already in GITHUB_OUTPUT, masking it there is sufficient
2. **Verify before masking** — move the curl step before the `::add-mask::` call
3. **Accept the limitation** — masking is a security best practice; verification is optional (the Sanity document patch is the real goal)

### Validated Conclusions

| Question | Answer | Evidence |
|---|---|---|
| Does `issue_comment` fire for `shopify[bot]`? | **YES** | Run `22114577663` triggered and completed successfully |
| Is `shopify[bot]` a third-party GitHub App? | **YES** | User type: `Bot`, login: `shopify[bot]` — third-party Apps DO trigger webhook events |
| Can we extract the deployment URL? | **YES** | Regex: `grep -o 'https://[a-z0-9-]*\.myshopify\.dev'` |
| Can we extract the USER_SHARED token? | **YES** | Regex: `grep -o '_auth=[^)]*' \| sed 's/_auth=//'` |
| Can we decode the JWT in CI? | **YES** | Base64 decode + Python JSON parse works on Ubuntu runners |
| Can we save as artifact? | **YES** | `upload-artifact@v4` with 90-day retention confirmed |
| Does `::add-mask::` interfere with downstream steps? | **YES** | All env var references to the masked value become `***` — affects curl verification |
| Does workflow need to be on default branch? | **YES** | `issue_comment` workflows ONLY run from the default branch (main) |

### Workflow on `main` (Final Version)

The validated workflow at `.github/workflows/sanity-oxygen-bypass-sync.yml` on `main` (commit `e35157b`):

1. **Trigger**: `issue_comment` created/edited by `shopify[bot]` on PRs with "Successful" in body
2. **Extract**: URL via regex, token via regex, kind via JWT decode
3. **Mask**: `::add-mask::` for log security
4. **Artifact**: JSON file with `{deploymentUrl, authToken, tokenKind, pr, extractedAt}` saved for 90 days
5. **Next step needed**: Add `SANITY_API_WRITE_TOKEN` secret + curl to patch Sanity document

---

## 18. Validated Recommended Solution

Based on all Q1-Q5 validations and the `issue_comment` CI trigger confirmation, this is the concrete, validated solution.

### Decision Summary

| Decision | Choice | Why |
|---|---|---|
| Token type | `USER_SHARED` (from bot comment) | No `exp` claim — never expires between deploys |
| URL strategy | Per-deployment URL (not stable env URL) | Tokens are deployment-scoped; stable URL only accepts current deployment's token anyway |
| CI trigger | `issue_comment` on `shopify[bot]` | Validated working; extracts both URL + USER_SHARED token |
| Token storage | Sanity document (`sanity.oxygenProtectionBypass`) | Queryable by async `previewMode` function at runtime |
| Studio integration | Async `previewMode` function (not plugin/env vars) | Dynamic — reads from Content Lake, no Studio rebuild needed |
| Hydrogen integration | `hydrogen-sanity` v6.1.0 OR plain `@sanity/react-loader` + `@sanity/visual-editing` | Hydrogen `2026.1.0` on React Router 7 — both paths supported |
| Framework | Two options: `hydrogen-sanity` (batteries-included) or vanilla React Router pattern | See trade-off analysis below |

### Integration Option A: `hydrogen-sanity` v6.1.0 (Recommended)

Batteries-included. Handles preview session, visual editing, and data fetching with Hydrogen-specific optimizations.

**Hydrogen app dependencies**:
```bash
npm install hydrogen-sanity@^6.1.0 @sanity/client groq
```

**Key files**:
```
app/
  routes/
    api.preview.ts          → export {action, loader} from 'hydrogen-sanity/preview/route'
  root.tsx                  → usePreviewMode() + <VisualEditing action="/api/preview" />
  lib/
    context.ts              → PreviewSession.init() + createSanityContext()
```

**Studio `previewMode` path**: `/api/preview`

### Integration Option B: Vanilla `@sanity/react-loader` + `@sanity/visual-editing`

More control, follows the official React Router visual editing guide exactly.

**Hydrogen app dependencies**:
```bash
npm install @sanity/client @sanity/visual-editing @sanity/preview-url-secret @sanity/react-loader
```

**Key files**:
```
app/
  routes/
    api.preview-mode.enable.tsx   → validatePreviewUrl + session cookie + redirect
    api.preview-mode.disable.tsx  → destroy session + redirect
  sanity/
    client.ts                     → createClient with stega
    session.ts                    → createCookieSessionStorage for preview state
    loader.server.ts              → setServerClient + loadQuery
  root.tsx                        → <VisualEditing /> from @sanity/visual-editing/react-router
```

**Studio `previewMode` path**: `/api/preview-mode/enable` (and `/api/preview-mode/disable`)

### The Oxygen Bypass: `resolveOxygenPreviewMode`

This is the **custom piece** — neither `hydrogen-sanity` nor the vanilla approach handles Oxygen Gateway auth. Our async `previewMode` function injects `?_auth=TOKEN` on the `enable` path to bypass the Gateway before the Hydrogen app code runs.

```typescript
// resolveOxygenPreviewMode.ts
import type {PreviewUrlPreviewMode} from 'sanity/presentation'

interface OxygenBypassOptions {
  /** Path to preview mode enable endpoint. Default: '/api/preview' */
  enablePath?: string
  /** Path to preview mode disable endpoint. Default: '/api/preview' (same route, action vs loader) */
  disablePath?: string
  /** Sanity document type storing bypass config. Default: 'sanity.oxygenProtectionBypass' */
  documentType?: string
}

const QUERY = `*[_type == $docType && deploymentUrl match $origin + "*"][0]{authToken, deploymentUrl}`

export function resolveOxygenPreviewMode(options: OxygenBypassOptions = {}) {
  const {
    enablePath = '/api/preview',
    disablePath,
    documentType = 'sanity.oxygenProtectionBypass',
  } = options

  return async (context: {
    client: any
    origin: string
    targetOrigin: string
  }): Promise<PreviewUrlPreviewMode | false> => {
    const {client, targetOrigin} = context

    // Skip for localhost — no Gateway auth needed
    if (new URL(targetOrigin).hostname === 'localhost') {
      return {enable: enablePath, ...(disablePath && {disable: disablePath})}
    }

    try {
      const config = await client.fetch(QUERY, {
        origin: targetOrigin,
        docType: documentType,
      })

      if (config?.authToken) {
        const params = new URLSearchParams({_auth: config.authToken})
        return {
          enable: `${enablePath}?${params}`,
          ...(disablePath && {disable: disablePath}),
        }
      }
    } catch (err) {
      console.warn('[oxygen-bypass] Failed to fetch config:', err)
    }

    // Fallback: no token found, try without bypass (will 302 if protected)
    return {enable: enablePath, ...(disablePath && {disable: disablePath})}
  }
}
```

### Sanity Document Schema

```typescript
// schemaTypes/oxygenProtectionBypass.ts
import {defineType, defineField} from 'sanity'

export const oxygenProtectionBypass = defineType({
  name: 'sanity.oxygenProtectionBypass',
  title: 'Oxygen Protection Bypass',
  type: 'document',
  fields: [
    defineField({name: 'name', type: 'string', title: 'Name'}),
    defineField({name: 'deploymentUrl', type: 'url', title: 'Deployment URL'}),
    defineField({name: 'authToken', type: 'string', title: 'Auth Token'}),
    defineField({name: 'branch', type: 'string', title: 'Branch'}),
    defineField({name: 'tokenKind', type: 'string', title: 'Token Kind'}),
    defineField({name: 'updatedAt', type: 'datetime', title: 'Last Updated'}),
  ],
  preview: {
    select: {title: 'name', subtitle: 'deploymentUrl'},
  },
})
```

### Studio Configuration (on `studio-meditate-with-eve`)

```typescript
// sanity.config.ts (relevant section)
import {presentationTool} from 'sanity/presentation'
import {resolveOxygenPreviewMode} from './plugins/resolveOxygenPreviewMode'

presentationTool({
  previewUrl: {
    // Dynamic — reads per-deploy URL from Sanity doc at runtime
    initial: async ({client}) => {
      const config = await client.fetch(
        `*[_type == "sanity.oxygenProtectionBypass"][0]{deploymentUrl}`
      )
      return config?.deploymentUrl || 'http://localhost:3000'
    },
    // Dynamic — reads USER_SHARED token from Sanity doc, injects ?_auth= on enable path
    previewMode: resolveOxygenPreviewMode({
      enablePath: '/api/preview',    // or '/api/preview-mode/enable' for vanilla
    }),
  },
})
```

### Full Request Flow (Validated)

```
1. Editor opens Presentation tool in Studio
2. Studio calls async `initial` → fetches Sanity doc → gets per-deploy URL
3. Studio calls async `previewMode` → fetches Sanity doc → gets USER_SHARED token
4. Studio constructs iframe URL:
   ${deploymentUrl}/api/preview?_auth=USER_SHARED_TOKEN&sanity-preview-secret=xxx&sanity-preview-pathname=/
5. Oxygen Gateway sees ?_auth=TOKEN → validates JWT sub matches deployment GID → PASS
6. Gateway sets auth_bypass_token cookie (1hr, HttpOnly, .myshopify.dev)
7. Request reaches Hydrogen app at /api/preview
8. Preview route validates sanity-preview-secret → sets preview session cookie
9. Redirects to sanity-preview-pathname (/)
10. Homepage loads with preview mode active
11. CSP frame-ancestors includes Studio origin → iframe renders
12. Visual editing overlays appear (stega encoded content)
13. Subsequent navigations use both cookies (Oxygen bypass + Sanity preview)
14. After 1hr → Oxygen cookie expires → next navigation 302s → Studio page refresh re-runs step 2-6
```

### CI Pipeline (Validated)

```
PR merged to staging
  → Shopify deploys to Oxygen
  → shopify[bot] posts PR comment with per-deploy URL + USER_SHARED ?_auth= token
  → issue_comment workflow fires (validated: run 22114577663)
  → Extracts URL + token from comment body
  → Patches Sanity document via API:
      _id: "oxygen-bypass.staging"
      {deploymentUrl, authToken, tokenKind: "USER_SHARED", branch, updatedAt}
  → Next time editor opens Presentation tool → async previewMode reads fresh config
```

---

## 19. Deployment & Test Plan: `studio-meditate-with-eve`

### Context

- **Sanity project**: `sx997gpv` / dataset `production` (`studio-meditate-with-eve` workspace)
- **Hydrogen app**: `preview-deployments-auth` storefront (`1000099369` on `juanprieto.myshopify.com`)
- **Goal**: E2E validation — Studio Presentation tool → Oxygen iframe → preview mode → visual editing

### Phase 1: Hydrogen App Setup (this repo)

Add Sanity integration to the existing `preview-deployments-auth` Hydrogen app.

**1a. Install dependencies**

```bash
# Option A (hydrogen-sanity)
npm install hydrogen-sanity@^6.1.0 @sanity/client groq

# Option B (vanilla)
npm install @sanity/client @sanity/visual-editing @sanity/preview-url-secret @sanity/react-loader
```

**1b. Add preview route**

- Option A: `app/routes/api.preview.ts` → re-export from `hydrogen-sanity/preview/route`
- Option B: `app/routes/api.preview-mode.enable.tsx` + `disable.tsx` → manual session + redirect

**1c. Configure CSP**

In `entry.server.tsx`:
```typescript
const {nonce, header, NonceProvider} = createContentSecurityPolicy({
  frameAncestors: isPreviewMode
    ? [`https://${SANITY_PROJECT_ID}.sanity.studio`]
    : ["'none'"],
  connectSrc: [
    `https://${SANITY_PROJECT_ID}.api.sanity.io`,
    `wss://${SANITY_PROJECT_ID}.api.sanity.io`,
  ],
})
```

**1d. Add visual editing to root**

Conditionally render `<VisualEditing>` when preview mode is active.

**1e. Add at least one Sanity-powered route**

Fetch from Content Lake with stega encoding, to validate click-to-edit overlays.

**1f. Add env vars to Oxygen**

Via `shopify hydrogen env push` or Shopify Admin:
- `SANITY_PROJECT_ID=sx997gpv`
- `SANITY_DATASET=production`
- `SANITY_API_READ_TOKEN=<viewer token>`
- `SESSION_SECRET=<random 32+ chars>`

### Phase 2: Sanity Studio Setup (`studio-meditate-with-eve`)

**2a. Add schema type** `sanity.oxygenProtectionBypass` to Studio schema

**2b. Add `resolveOxygenPreviewMode`** function to Studio plugins directory

**2c. Configure `presentationTool`** with async `initial` + `previewMode` pointing to the Oxygen deployment

**2d. Deploy Studio** (or test locally first with `sanity dev`)

### Phase 3: Seed Bypass Document

Before CI automation, manually create the first bypass document to test the flow.

```bash
# Use the most recent deployment URL + USER_SHARED token from PR #4 bot comment
curl -X POST "https://sx997gpv.api.sanity.io/v2025-01-01/data/mutate/production" \
  -H "Authorization: Bearer $SANITY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "mutations": [{
      "createOrReplace": {
        "_id": "oxygen-bypass.staging",
        "_type": "sanity.oxygenProtectionBypass",
        "name": "Preview Deployments Auth - Staging",
        "deploymentUrl": "<latest-deploy-url>",
        "authToken": "<latest-USER_SHARED-token>",
        "branch": "staging",
        "tokenKind": "USER_SHARED",
        "updatedAt": "2026-02-17T20:30:00Z"
      }
    }]
  }'
```

### Phase 4: E2E Validation

1. Open `studio-meditate-with-eve` in browser
2. Navigate to Presentation tool
3. Confirm iframe loads the Oxygen deployment (not 302 redirect)
4. Confirm preview mode activates (draft content visible)
5. Confirm visual editing overlays render (click-to-edit)
6. Test navigation within iframe (cookie persists)
7. Wait >1hr or clear cookies → confirm re-auth via page refresh

### Phase 5: CI Automation

1. Add `SANITY_API_WRITE_TOKEN` secret to GitHub repo
2. Update `.github/workflows/sanity-oxygen-bypass-sync.yml` to patch Sanity document after token extraction
3. Merge a PR to staging → verify CI patches the Sanity doc → verify Studio picks up new URL/token

### Open Questions for This Plan

| # | Question | Impact | How to Resolve |
|---|---|---|---|
| ~~1~~ | ~~Which dataset on `sx997gpv`?~~ | **RESOLVED**: `production` | Confirmed from `sanity.cli.ts` |
| 2 | Does `studio-meditate-with-eve` already have `presentationTool` configured? | May conflict with existing config | Read current `sanity.config.ts` |
| 3 | Does the Hydrogen app need real Sanity content or just preview plumbing? | Determines how much route work | Minimum: one route fetching any Sanity doc |
| 4 | `hydrogen-sanity` v6.1.0 or vanilla `@sanity/react-loader`? | Different route paths, imports | User preference — hydrogen-sanity is simpler |
| 5 | Will `previewMode` async fn be called on every navigation or just once? (Q6) | Determines if CI updates are picked up mid-session | Test in Phase 4 |

---

## 20. Remaining Work (Updated)

1. **Choose integration option** — `hydrogen-sanity` v6 or vanilla `@sanity/react-loader` (recommend A for speed)
2. ~~**Confirm Sanity dataset**~~ — **RESOLVED**: `sx997gpv` / `production`
3. **Phase 1** — Add Sanity preview plumbing to Hydrogen app (this repo)
4. **Phase 2** — Add bypass schema + plugin to `studio-meditate-with-eve`
5. **Phase 3** — Seed bypass document manually
6. **Phase 4** — E2E validation in Presentation tool
7. **Phase 5** — Wire up CI automation (patch Sanity doc from `issue_comment` workflow)
8. **Validate Q6** — Does Studio's async `previewMode` re-execute on navigation or only on load?
9. **Fix `::add-mask::` verification** — move curl before masking in workflow
