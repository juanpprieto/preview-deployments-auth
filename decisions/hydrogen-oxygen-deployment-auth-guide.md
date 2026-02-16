# Hydrogen/Oxygen Deployment Authentication — Complete Knowledge Base

> Internal reference for understanding all auth options for sharing Hydrogen deployments with Shopify staff and external stakeholders.
>
> See also: [API request/response traces](./preview-deployment-auth-api-responses.md)

---

## Table of Contents

- [Validated Findings — Live Testing (Feb 16, 2026)](#validated-findings--live-testing-feb-16-2026)

1. [Oxygen Architecture Overview](#1-oxygen-architecture-overview)
2. [Environment Types](#2-environment-types)
3. [Default Access Control (Private by Default)](#3-default-access-control-private-by-default)
4. [All Methods to Share Deployments](#4-all-methods-to-share-deployments)
5. [Auth Bypass Tokens (CLI)](#5-auth-bypass-tokens-cli)
6. [Shareable Links (Admin UI + GitHub Bot)](#6-shareable-links-admin-ui--github-bot)
7. [Public Environments](#7-public-environments)
8. [The `pullRequestPreviewPublicUrl` Toggle](#8-the-pullrequestpreviewpublicurl-toggle)
9. [Deployment Token — Structure and Lifecycle](#9-deployment-token--structure-and-lifecycle)
10. [Worker Runtime Authentication (Storefront API)](#10-worker-runtime-authentication-storefront-api)
11. [CLI Deploy Command — Full Reference](#11-cli-deploy-command--full-reference)
12. [CLI Source Code Architecture](#12-cli-source-code-architecture)
13. [Deployment Type Resolution Logic](#13-deployment-type-resolution-logic)
14. [Default Shopify CI Workflow (GitHub Actions)](#14-default-shopify-ci-workflow-github-actions)
15. [Preview URL Auth — How It Actually Works](#15-preview-url-auth--how-it-actually-works)
16. [Plan-Based Limitations](#16-plan-based-limitations)
17. [Performance Implications](#17-performance-implications)
18. [Worker Specs and Limits](#18-worker-specs-and-limits)
19. [Data Retention](#19-data-retention)
20. [Caveats, Gotchas, and Unknowns](#20-caveats-gotchas-and-unknowns)
21. [Next Steps — Admin Validations Checklist](#21-next-steps--admin-validations-checklist)

---

## Validated Findings — Live Testing (Feb 16, 2026)

> Tested using Chrome DevTools MCP against live Oxygen deployments from PRs #1 and #2 on `juanpprieto/preview-deployments-auth`.

### Test Environment

| Item | Value |
|------|-------|
| PR #1 deployment | `01khjyg0n4tgszfjzbt9pa9x77-e0cbf6cbca25f889f5d7.myshopify.dev` |
| PR #2 deployment | `01khk3v03za7ecg5ezjcc0bcfp-e0cbf6cbca25f889f5d7.myshopify.dev` |
| Shared store hash | `e0cbf6cbca25f889f5d7` |
| x-shopid | `60187836438` |

### Test Results

#### 1. Bare Preview URL → Shopify OAuth Redirect (CONFIRMED)

Navigating to PR #2's bare URL triggers a **4-hop redirect chain**:

```
GET {deployment}.myshopify.dev/
  → 302 to accounts.shopify.com/oauth/authorize?...&client_id=b453446d-e0fe-4cfc-ac90-a129d3114660&redirect_uri=https://cf-auth-worker.myshopify.dev/oauth/callback&prompt=select_account
    → 302 to accounts.shopify.com/select?rid=...
      → 302 to accounts.shopify.com/lookup?rid=...&verify=...
        → 200 Shopify Login page ("Log in — Continue to Oxygen")
```

**Key details from initial 302 (Gateway Worker):**
- `powered-by: Shopify, Oxygen` header confirms Gateway Worker
- Clears existing cookies: `set-cookie: user_session_id=; Max-Age=0` and `mac=; Max-Age=0`
- OAuth scope: `openid email`
- OAuth `prompt=select_account` forces account selection
- `cf-auth-worker.myshopify.dev` is the Cloudflare Auth Worker handling OAuth callback

#### 2. Shareable Link (`?_auth=` JWT) → Direct 200 (CONFIRMED)

Navigating to PR #1's shareable link returns **200 OK immediately** — no redirect chain.

**Response headers:**
- `powered-by: Shopify, Oxygen, Hydrogen` (note: includes "Hydrogen" — different from auth redirect which only has "Shopify, Oxygen")
- `set-cookie: auth_bypass_token=<JWT>; Max-Age=3600; Domain=myshopify.dev; Path=/; HttpOnly; Secure`
- `oxygen-full-page-cache: uncacheable`
- `x-robots-tag: none`

**Critical finding: The `?_auth=` JWT is copied verbatim into the `auth_bypass_token` cookie.**
The cookie value is byte-for-byte identical to the `?_auth=` query parameter value.

#### 3. Cookie Persistence (CONFIRMED)

After visiting the shareable link (which sets the `auth_bypass_token` cookie), subsequent navigations to the **same deployment** work **without** the `?_auth=` parameter.

- Navigated to `/collections/all` on PR #1's deployment → **200 OK**
- Request sent `cookie: auth_bypass_token=<JWT>` automatically
- Cookie `Domain=myshopify.dev` means it's sent to ALL `*.myshopify.dev` subdomains

**Cookie TTL: 1 hour** (`Max-Age=3600`)

#### 4. Cross-Deployment JWT Isolation (CONFIRMED)

The `auth_bypass_token` cookie is sent to all `*.myshopify.dev` subdomains (due to `Domain=myshopify.dev`), but the **Gateway Worker validates the JWT `sub` claim** against the target deployment's GID.

- Navigated to PR #2's deployment with PR #1's cookie still set → **302 to Shopify OAuth**
- The cookie was sent (visible in request headers) but the Gateway Worker rejected it
- JWT `sub: "gid://oxygen-hub/Deployment/4042382"` only matches PR #1's deployment

This means: **cookies travel across subdomains, but auth is deployment-scoped via JWT validation.**

#### 5. JWT Token Analysis (CONFIRMED)

```json
{
  "header": { "alg": "HS256" },
  "payload": {
    "sub": "gid://oxygen-hub/Deployment/4042382",
    "kind": "USER_SHARED",
    "iat": 1771236256
  }
}
```

| Property | Value | Significance |
|----------|-------|--------------|
| Algorithm | HS256 | Symmetric key — Shopify signs and validates |
| `sub` | Deployment GID | Scopes token to ONE deployment |
| `kind` | `USER_SHARED` | Distinguishes from auth bypass tokens |
| `iat` | 2026-02-16T10:04:16Z | Issue time (matches deployment) |
| `exp` | **ABSENT** | Token never expires intrinsically |

#### 6. GitHub Bot Behavior: Shareable Link vs Bare URL

| PR | Bot posted | `?_auth=` included? | Bare URL behavior |
|----|-----------|---------------------|-------------------|
| PR #1 | Shareable link | Yes | Not tested bare (cookie present) |
| PR #2 | Bare URL | **No** | 302 → Shopify OAuth |

**Hypothesis**: `pullRequestPreviewPublicUrl` was toggled between PR #1 and PR #2 deployments. When `true`, bot posts bare URL; when `false`, bot includes `?_auth=` token. However, the Gateway Worker may enforce auth independently of this setting, or the setting was toggled back before testing.

#### 7. Response Header Differences: Auth vs Authenticated

| Header | Auth redirect (302) | Authenticated (200) |
|--------|-------------------|--------------------|
| `powered-by` | `Shopify, Oxygen` | `Shopify, Oxygen, Hydrogen` |
| `oxygen-full-page-cache` | (absent) | `uncacheable` |
| `x-robots-tag` | (absent) | `none` |
| `set-cookie` | Clears `user_session_id`, `mac` | Sets `auth_bypass_token`, `_shopify_essential` |

The `powered-by` header is a reliable indicator: if it includes "Hydrogen", the request reached the Storefront Worker. If it only says "Shopify, Oxygen", the Gateway Worker intercepted and redirected.

---

## 1. Oxygen Architecture Overview

Source: [How We Built Oxygen (Shopify Engineering)](https://shopify.engineering/how-we-built-oxygen)

### Request Flow

```
Buyer request → Cloudflare Edge (global) → Gateway Worker → Storefront Worker (V8 isolate) → Response
                                              ↓
                                        Trace Worker → Grafana/Cortex/Loki/Tempo
```

1. Request hits **Cloudflare's edge network** (thousands of machines, hundreds of locations)
2. **Gateway Worker** (Shopify's dispatch worker) validates authorization: checks the accessor has authorization to the shop AND the specific storefront version
3. Gateway Worker uses Cloudflare's **Dynamic Dispatch API** (`env.DISPATCHER.get()` via Workers for Platforms) to route to the correct Storefront Worker
4. **Storefront Worker** (merchant's Hydrogen app) executes in a V8 isolate in **untrusted mode**
5. **Trace Worker** captures logs/metrics and forwards to observability stack

### Key Technology Decisions

- **Runtime**: Cloudflare's open-source `workerd` library running Google Chrome's **V8 engine**
- **Isolation**: V8 isolates in untrusted mode — no shared caches, no `request.cf`, memory completely isolated between tenants
- **Dispatch**: Cloudflare Workers for Platforms Dynamic Dispatch API (dispatch namespaces)
- **Observability**: Grafana + Cortex (metrics) + Loki (logs) + Tempo (tracing)

### Security Model (Multi-Layer)

| Layer | Protection |
|-------|-----------|
| V8 Isolates | Memory isolation between workers; each runs in its own isolate |
| Process sandboxing | Linux namespaces, seccomp (all filesystem syscalls blocked) |
| Network isolation | Only local UNIX domain sockets; no direct network access |
| Cordons | Trust-level separation (free-tier never shares with Enterprise) |
| API restrictions | `eval()` and `new Function()` disabled; `Date.now()` frozen to last I/O |
| Untrusted mode | `request.cf` inaccessible; isolated cache per worker |

### Injected Request Headers (by Oxygen)

Every request to the Storefront Worker gets these headers injected by Oxygen:

```
oxygen-buyer-ip
oxygen-buyer-country, oxygen-buyer-city, oxygen-buyer-region, oxygen-buyer-region-code
oxygen-buyer-latitude, oxygen-buyer-longitude
oxygen-buyer-timezone, oxygen-buyer-postal-code, oxygen-buyer-metro-code
oxygen-buyer-is-eu-country
oxygen-buyer-continent
oxygen-buyer-deployment-id    (undocumented)
oxygen-buyer-shop-id          (undocumented)
oxygen-buyer-storefront-id    (undocumented)
```

The undocumented headers (`deployment-id`, `shop-id`, `storefront-id`) are how Oxygen identifies which deployment and shop a request belongs to.

---

## 2. Environment Types

| Type | Branch Mapping | Deletable | Rollback | Redeploy |
|------|---------------|-----------|----------|----------|
| **Production** | Default branch (configurable) | No | Yes | Yes |
| **Custom** | Any specific branch | Yes | Yes | Yes |
| **Preview** | All unassigned branches | No | No | No |

- Every deployment gets a **unique preview URL** regardless of environment.
- Each environment has an **auto-generated environment URL** that always points to the most recent deployment.
- Deployments are **immutable snapshots** — env vars are baked in at deploy time.

---

## 3. Default Access Control (Private by Default)

**All deployments are private by default.** Accessing any deployment URL requires Shopify staff login (store account authentication).

This means:
- External stakeholders (clients, agencies, QA contractors) **cannot** view deployments without one of the sharing mechanisms below.
- Staff auth is checked **on every route navigation**, which adds latency to private deployments.
- The **Gateway Worker** validates authorization before routing to the Storefront Worker.

---

## 4. All Methods to Share Deployments

There are exactly **4 ways** to make a deployment accessible to non-staff:

| Method | Scope | Duration | Audience | How | Token Format |
|--------|-------|----------|----------|-----|--------------|
| **Auth Bypass Token** | Single deployment | 1-12 hours | CI/E2E test runners | CLI `--auth-bypass-token` flag | Via header `oxygen-auth-bypass-token` |
| **Shareable Link** | Single deployment | Until revoked | Trusted stakeholders | Admin UI or auto-generated by GitHub bot | `?_auth=<JWT>` query param |
| **Public Environment** | All deployments in env | Permanent (until toggled) | Anyone with the URL | Admin UI → Environment settings | N/A (no auth required) |
| **`pullRequestPreviewPublicUrl`** | All PR preview deployments | Permanent (until toggled) | Anyone with preview URL | Admin UI → Oxygen Deployment settings | N/A (no auth required) |

### Decision Matrix: Which to Use

| Scenario | Recommended Method |
|----------|-------------------|
| CI/CD E2E tests against preview | Auth Bypass Token |
| Client review of a specific deployment | Shareable Link |
| Staging environment always accessible | Public Environment |
| All PR previews accessible to external reviewers | `pullRequestPreviewPublicUrl` toggle |
| One-off demo to a prospect | Shareable Link |

---

## 5. Auth Bypass Tokens (CLI)

Generated during deployment via the CLI. Designed for **automated E2E testing**, not human sharing.

### How to Generate

```bash
# Default: 2-hour token
npx shopify hydrogen deploy --auth-bypass-token

# Custom duration (max 12 hours)
npx shopify hydrogen deploy --auth-bypass-token --auth-bypass-token-duration 12
```

Or via environment variables:
```bash
AUTH_BYPASS_TOKEN=true
AUTH_BYPASS_TOKEN_DURATION=12
```

### Where the 12-Hour Limit Is Enforced

| Layer | Enforced? | How |
|-------|-----------|-----|
| Hydrogen CLI flag definition | **NO** | Only description text mentions "up to 12 hours"; `Flags.string()` with no validation |
| Hydrogen CLI `runDeploy` | **NO** | Pure passthrough to config, zero validation |
| `@shopify/oxygen-cli` `authBypassTokenDurationParse()` | **YES** | `duration > 12 \|\| duration < 1` → `AbortError` |
| Oxygen API (server-side) | **Likely YES** | But CLI catches it before the GraphQL request |

The validation function in `@shopify/oxygen-cli@6.0.0`:

```javascript
function authBypassTokenDurationParse(authBypassTokenDurationFlag) {
  const duration = Number(authBypassTokenDurationFlag);
  if (isNaN(duration)) {
    throw new AbortError("Invalid duration format...");
  }
  if (duration > 12 || duration < 1) {
    throw new AbortError("Invalid duration length. Please specify the duration (in hours) between 1 to 12 hours.");
  }
  return duration;
}
```

**The 12-hour limit is a hard limit in `@shopify/oxygen-cli`, not just documentation.** Values like `12.5` or `0.5` fail. `12` exactly is allowed.

### Token Generation Flow

```
CLI flags → DeploymentConfig → oxygen-cli validates duration →
GraphQL DeploymentComplete mutation → Oxygen API generates token server-side →
Returns authBypassToken in response → CLI outputs to terminal / h2_deploy_log.json
```

The actual GraphQL mutation:

```graphql
mutation DeploymentComplete(
  $deploymentId: ID!,
  $generateAuthBypassToken: Boolean,
  $authBypassTokenDuration: Int,
  $environmentVariables: [EnvironmentVariableInput!]
) {
  deploymentComplete(
    id: $deploymentId,
    generateAuthBypassToken: $generateAuthBypassToken,
    authBypassTokenDuration: $authBypassTokenDuration,
    environmentVariables: $environmentVariables
  ) {
    deployment { id, url }
    authBypassToken
    userErrors { message }
  }
}
```

### Characteristics

- **Duration**: Default 2 hours, max 12 hours. Auto-expires. Min 1 hour.
- **Scope**: Tied to the specific deployment.
- **Output**: Returned in `completedDeployment.authBypassToken`. In CI, written to `h2_deploy_log.json`.
- **Usage**: Passed via HTTP header `oxygen-auth-bypass-token: <token>`.
- **Generation**: Server-side in Oxygen API. The CLI never creates the token itself.

### Limitations

- **Hard max 12 hours** — enforced by `@shopify/oxygen-cli`, not just docs.
- **No admin UI** to create these — CLI only.
- **No revocation** — they simply expire.
- **No public API** to extend or refresh.

---

## 6. Shareable Links (Admin UI + GitHub Bot)

Token-based URLs that bypass staff auth using a JWT `?_auth=` query parameter.

### Two Sources of Shareable Links

#### 1. Manual (Admin UI)

1. Open deployment details in Shopify Admin
2. Click **Share** → **"Anyone with the link"**
3. Copy the generated URL

#### 2. Automatic (Shopify GitHub Bot)

When the Shopify GitHub App is connected and `pullRequestCommentsEnabled: true`, the bot **automatically posts a PR comment** with a shareable link for every preview deployment.

**Observed in PR #1** ([juanpprieto/preview-deployments-auth#1](https://github.com/juanpprieto/preview-deployments-auth/pull/1)):

```
https://01khjyg0n4tgszfjzbt9pa9x77-e0cbf6cbca25f889f5d7.myshopify.dev?_auth=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJnaWQ6Ly9veHlnZW4taHViL0RlcGxveW1lbnQvNDA0MjM4MiIsImtpbmQiOiJVU0VSX1NIQVJFRCIsImlhdCI6MTc3MTIzNjI1Nn0.JiSGGUjaFvk8R_NftKL2DhI_SmEojGKQPBFxZ8Pt1nU
```

### JWT Token Structure

The `?_auth=` token is a **HS256-signed JWT** (not the same as the deployment token, which is base64 JSON).

**Decoded payload:**

```json
{
  "sub": "gid://oxygen-hub/Deployment/4042382",
  "kind": "USER_SHARED",
  "iat": 1771236256
}
```

| Field | Value | Meaning |
|-------|-------|---------|
| `sub` | `gid://oxygen-hub/Deployment/4042382` | Scoped to a specific deployment |
| `kind` | `USER_SHARED` | This is a shareable link (not auth bypass) |
| `iat` | `1771236256` | Issued at (Feb 16, 2026 ~10:04 UTC) |
| `exp` | **ABSENT** | No expiration claim — persists until manually revoked |

### Characteristics

- **Duration**: **Indefinite** — JWT has no `exp` claim. Persists until revoked via Admin UI.
- **Scope**: Per-deployment (`sub` references a specific deployment GID).
- **Revocation**: Reset (new token, old dies) or remove (back to staff-only) via Admin UI.
- **Activation delay**: Changes take **up to 30 seconds** to propagate.
- **SEO protection**: Oxygen adds `disallow` to `robots.txt` on shared deployments.
- **Plan requirement**: Basic plan and above.
- **Auto-generation**: Shopify GitHub bot auto-creates and posts shareable links in PR comments.

### Key Insight (CORRECTED after live testing)

The Shopify GitHub bot **conditionally posts shareable links** based on `pullRequestPreviewPublicUrl`:
- When `false` (auth enabled): bot posts URL **with** `?_auth=<JWT>` — anyone with the link can access
- When `true` (auth disabled): bot posts **bare URL** without token

This was validated by comparing PR #1 (bot posted `?_auth=` link) vs PR #2 (bot posted bare URL), indicating the toggle was changed between deployments.

### Limitations

- **No public API** to create shareable links programmatically.
- **Per-deployment** — must be created individually (except via GitHub bot auto-generation).
- **30-second propagation delay** for changes.
- **Trust-based** — anyone with the link can view. No IP restriction, no password.
- **No expiry** — must be manually revoked.

---

## 7. Public Environments

Makes an entire environment's URL accessible to anyone — no auth required.

### How to Configure

Admin UI → Storefront Settings → Environments and Variables → select environment → toggle public/private visibility.

### Characteristics

- **Scope**: Environment-wide — all deployments in the environment become public.
- **Performance**: Faster page loads (no per-route auth check).
- **Plan-gated**: Limited number of public environments per plan.

### Limitations

- **Plan limits are strict** — see [section 16](#16-plan-based-limitations).
- **No granularity** — can't make some deployments in an env public and others private.
- **Preview environment** visibility is controlled separately via `pullRequestPreviewPublicUrl`.
- **Cannot be applied to Preview environment** through the standard environment settings UI.

---

## 8. The `pullRequestPreviewPublicUrl` Toggle

Controls whether **all PR-triggered preview deployments** require Shopify staff auth on the base URL.

### How to Toggle

Admin UI → Hydrogen Storefront → Settings → Oxygen Deployments section.

### API Details

- **Mutation**: `SourceCodeProviderUpdate` (persisted query hash: `70530823...`)
- **Key field**: `pullRequestPreviewPublicUrl`
  - `true` = staff auth **disabled** (base preview URLs are public)
  - `false` = staff auth **enabled** (base preview URLs require login)
- **NOT a public API** — internal Admin UI proxy, cookie-based auth only.

See [API traces doc](./preview-deployment-auth-api-responses.md) for full request/response details.

### Important Nuance (CORRECTED after live testing)

The bot's PR comment format **changes based on this setting**:
- `false` (auth enabled): bot posts URL with `?_auth=<JWT>` token — PR reviewers can access via the link
- `true` (auth disabled): bot posts bare URL without token — implies anyone can access directly

**Open question**: PR #2 bare URL still required OAuth login despite the bot posting a bare URL. This suggests either the setting was toggled back to `false` after the deployment, there's a propagation delay, or storefront-level password protection overrides this setting.

### Characteristics

- **Scope**: ALL preview deployments for the storefront.
- **Paired with `pullRequestCommentsEnabled`** — same mutation.

### Limitations

- **No public API or CLI flag** to toggle this.
- **Binary** — all previews public or all private. No per-branch granularity.
- **Only affects preview deployments** — not production or custom environments.

---

## 9. Deployment Token — Structure and Lifecycle

The **deployment token** (`SHOPIFY_HYDROGEN_DEPLOYMENT_TOKEN`) is what authenticates the CLI/CI with the Oxygen deployment service. It is completely separate from auth bypass tokens and shareable link tokens.

### Token Format

**Base64-encoded JSON** (NOT a JWT):

```javascript
// How it's parsed (from @shopify/oxygen-cli)
function parseToken(inputToken) {
  const decodedToken = Buffer.from(inputToken, "base64").toString("utf-8");
  const rawToken = JSON.parse(decodedToken);
  return convertKeysToCamelCase(rawToken);
}
```

### Token Structure

```typescript
interface DeploymentToken {
  accessToken: string;     // Bearer token for Oxygen API calls
  allowedResource: string; // Scoped resource (e.g. "gid://oxygen-hub/Namespace/1")
  appId: string;           // Shopify application ID
  client: string;          // Client identifier
  expiresAt: string;       // ISO 8601 timestamp — 1 year from creation
  namespace: string;       // Storefront handle (e.g. "my-store")
  namespaceId: string;     // Numeric namespace ID
}
```

### How It's Used During Deployment

```javascript
// Every Oxygen API call sends:
// 1. accessToken as Authorization bearer token
// 2. namespace as custom header
const response = await graphqlRequest({
  url: `${deploymentUrl}/api/v2/admin/graphql`,  // https://oxygen.shopifyapps.com/api/v2/admin/graphql
  token: config.deploymentToken.accessToken,
  addedHeaders: {
    'X-Oxygen-Namespace-Handle': config.deploymentToken.namespace
  }
});
```

### Lifecycle

| Aspect | Detail |
|--------|--------|
| **Creation** | Auto-created when Hydrogen storefront is created; additional tokens via Admin UI |
| **Expiry** | **1 year** from creation (`expiresAt` field) |
| **Multiple tokens** | Yes — recommended to create separate tokens per CI/CD service |
| **Rotation** | Default token: rotate via Admin UI (old immediately invalidated). Custom tokens: delete old, create new |
| **Retrieval** | Via Admin GraphQL: `hydrogenStorefront(id).oxygenDeploymentToken` |
| **Storage** | GitHub Actions secret (e.g. `OXYGEN_DEPLOYMENT_TOKEN_1000099369`) |

### How the CLI Gets the Token

**In CI**: Must be explicitly provided via `--token` flag or `SHOPIFY_HYDROGEN_DEPLOYMENT_TOKEN` env var.

**Locally**: CLI authenticates with Shopify Admin via OAuth (`ensureAuthenticatedAdmin`), queries the `hydrogenStorefront` GraphQL endpoint, and extracts `oxygenDeploymentToken`.

```
login(root) → ensureAuthenticatedBusinessPlatform() → ensureAuthenticatedAdmin(shop)
  → adminRequest(GetDeploymentDataQuery) → returns { oxygenDeploymentToken, environments }
```

---

## 10. Worker Runtime Authentication (Storefront API)

The deployed Hydrogen worker authenticates with Shopify APIs using tokens injected as workerd bindings (environment variables).

### Storefront API — Two Token Types

| Token | Header | Context | Exposure |
|-------|--------|---------|----------|
| `PRIVATE_STOREFRONT_API_TOKEN` | `Shopify-Storefront-Private-Token` | Server-side only | Must NEVER be exposed to browser |
| `PUBLIC_STOREFRONT_API_TOKEN` | `X-Shopify-Storefront-Access-Token` | Client-side safe | Safe in browser bundles |

**Automatic selection** in `createStorefrontClient`:

```typescript
const getHeaders = clientOptions.privateStorefrontToken
  ? getPrivateTokenHeaders   // Uses Shopify-Storefront-Private-Token
  : getPublicTokenHeaders;   // Uses X-Shopify-Storefront-Access-Token
```

On Oxygen, `PRIVATE_STOREFRONT_API_TOKEN` is always available, so server-side queries use the private token by default.

### Additional Headers Sent with Every Storefront API Request

```
Custom-Storefront-Request-Group-ID   // Correlates subrequests
X-SDK-Variant: hydrogen-react
X-SDK-Variant-Source: react
X-SDK-Version: <api-version>
X-Shopify-Client-IP: <buyer-ip>      // From oxygen-buyer-ip header
X-Shopify-Client-IP-Sig: <sig>       // IP signature for verification
```

### Environment Variable Injection

**Production (Oxygen)**: Env vars injected as **workerd bindings** at deploy time. Immutable — changing vars requires redeployment.

**Local dev (MiniOxygen)**: Merges remote vars (pulled via GraphQL) + local `.env` file, passes as workerd bindings:

```typescript
bindings: { ...remoteSecrets, ...remoteVariables, ...localVariables }
```

### Required Auto-Generated Variables

| Variable | Purpose | Editable |
|----------|---------|----------|
| `PRIVATE_STOREFRONT_API_TOKEN` | Server-side Storefront API | Rotatable only |
| `PUBLIC_STOREFRONT_API_TOKEN` | Client-side Storefront API | Read-only |
| `PUBLIC_STORE_DOMAIN` | Store domain | Read-only |
| `PUBLIC_STOREFRONT_ID` | Storefront numeric ID | Read-only |
| `PUBLIC_CUSTOMER_ACCOUNT_API_CLIENT_ID` | Customer Account API | Read-only |
| `PUBLIC_CUSTOMER_ACCOUNT_API_URL` | Customer Account API endpoint | Read-only |
| `SESSION_SECRET` | React Router session signing | Editable |

---

## 11. CLI Deploy Command — Full Reference

```bash
npx shopify hydrogen deploy [flags]
```

### All Flags

| Flag | Alias | Env Var | Default | Description |
|------|-------|---------|---------|-------------|
| `--token` | `-t` | `SHOPIFY_HYDROGEN_DEPLOYMENT_TOKEN` | linked storefront token | Oxygen deployment token |
| `--preview` | | | `false` | Deploy to Preview environment |
| `--env <handle>` | | | | Target environment by handle |
| `--env-branch <branch>` | | `SHOPIFY_HYDROGEN_ENVIRONMENT_BRANCH` | | Target environment by branch |
| `--env-file <path>` | | | | Override env vars from file |
| `--auth-bypass-token` | | `AUTH_BYPASS_TOKEN` | `false` | Generate auth bypass token |
| `--auth-bypass-token-duration` | | `AUTH_BYPASS_TOKEN_DURATION` | `2` | Bypass token duration (hours, 1-12) |
| `--force` | `-f` | `SHOPIFY_HYDROGEN_FLAG_FORCE` | `false` | Deploy with uncommitted changes |
| `--no-verify` | | | `false` | Skip routability check |
| `--build-command <cmd>` | | | `shopify hydrogen build` | Custom build command |
| `--entry <path>` | | `SHOPIFY_HYDROGEN_FLAG_ENTRY` | `./server` | Worker entry file |
| `--json-output` | | | `true` in CI | Write deployment JSON |
| `--metadata-description` | | `SHOPIFY_HYDROGEN_FLAG_METADATA_DESCRIPTION` | commit message | Deployment description |
| `--metadata-user` | | `SHOPIFY_HYDROGEN_FLAG_METADATA_USER` | | Who deployed |
| `--force-client-sourcemap` | | `SHOPIFY_HYDROGEN_FLAG_FORCE_CLIENT_SOURCEMAP` | `false` | Enable client sourcemaps |
| `--lockfile-check` | | `SHOPIFY_HYDROGEN_FLAG_LOCKFILE_CHECK` | `true` | Validate lockfile |
| `--path <dir>` | | `SHOPIFY_HYDROGEN_FLAG_PATH` | cwd | Storefront directory |
| `--shop` | `-s` | `SHOPIFY_SHOP` | | Shop URL |

### Hidden Flags

| Flag | Env Var | Purpose |
|------|---------|---------|
| `--metadata-url` | `SHOPIFY_HYDROGEN_FLAG_METADATA_URL` | Deployment URL metadata |
| `--metadata-version` | `SHOPIFY_HYDROGEN_FLAG_METADATA_VERSION` | Version metadata |

### Internal Environment Variable

```
UNSAFE_SHOPIFY_HYDROGEN_DEPLOYMENT_URL
```
Overrides the Oxygen deployment service URL (default: `https://oxygen.shopifyapps.com`). Warning displayed when used.

---

## 12. CLI Source Code Architecture

The Hydrogen CLI deploy command is a **thin wrapper** around two systems:

### 1. Shopify Admin GraphQL API (setup data)

```graphql
query GetDeploymentToken($id: ID!) {
  hydrogenStorefront(id: $id) {
    oxygenDeploymentToken
    environments { name, handle, branch, type }
  }
}
```

Auth via OAuth session (`ensureAuthenticatedAdmin`).

### 2. `@shopify/oxygen-cli/deploy` (actual deployment)

Closed-source package (v6.0.0). The CLI calls `createDeploy({config, hooks, logger})` which handles:
- Build execution
- Asset/worker upload to `https://oxygen.shopifyapps.com/api/v2/admin/graphql`
- `DeploymentInitiate` mutation (starts deployment)
- `DeploymentComplete` mutation (finalizes, generates auth bypass token)
- Deployment verification + routability check
- Returns `CompletedDeployment` with `url` and optional `authBypassToken`

### Key Files (Hydrogen repo)

| File | Purpose |
|------|---------|
| `packages/cli/src/commands/hydrogen/deploy.ts` | Main command, flag parsing, orchestration |
| `packages/cli/src/lib/get-oxygen-deployment-data.ts` | Login + fetch deployment token/environments |
| `packages/cli/src/lib/graphql/admin/get-oxygen-data.ts` | GraphQL query for deployment data |
| `packages/cli/src/lib/common.ts` | Environment ordering, lookup, display helpers |
| `packages/cli/src/lib/auth.ts` | Shopify OAuth login flow |
| `packages/cli/src/lib/environment-variables.ts` | Remote + local env var merging |
| `packages/mini-oxygen/src/common/headers.ts` | Oxygen injected headers map |
| `packages/mini-oxygen/src/worker/handler.ts` | MiniOxygen routing worker (mirrors production) |

### Key Files (oxygen-cli package, closed-source)

| File | Purpose |
|------|---------|
| `dist/utils/utils.js` | `parseToken()`, `authBypassTokenDurationParse()` |
| `dist/deploy/index.js` | `createDeploy()` orchestration |
| `dist/deploy/deployment-initiate.js` | `DeploymentInitiate` GraphQL mutation |
| `dist/deploy/deployment-complete.js` | `DeploymentComplete` GraphQL mutation + auth bypass token |
| `dist/deploy/types.d.ts` | `DeploymentConfig`, `DeploymentToken`, `CompletedDeployment` |

---

## 13. Deployment Type Resolution Logic

The CLI determines the target environment through a cascading priority:

```
1. --preview flag                    → Preview (defaultEnvironment: true)
2. --env <handle> resolves to Preview → Preview (branch: null → isPreview: true)
3. --env <handle> resolves to env    → That environment's branch
4. --env-branch <branch>             → That branch
5. Interactive prompt selection       → User's choice (sentinel 'shopify-preview-environment.' → Preview)
6. Current git branch                → Fallback environmentTag
```

### Preview Detection

Preview is identified by `type: 'PREVIEW'` and `branch: null` in the GraphQL response. The sentinel string `'shopify-preview-environment.'` (ending in period = invalid git branch name) is used in the interactive prompt to avoid branch collisions.

### CI vs Local

| Behavior | CI | Local |
|----------|-----|-------|
| `--env <handle>` | **ERROR** — not allowed | Works |
| `--env-branch` | Used directly as tag | Looked up against environments |
| Token | Must be explicit | Falls back to linked storefront token |
| Interactive prompt | Never shown | Shown when multiple envs, no flag |

---

## 14. Default Shopify CI Workflow (GitHub Actions)

When connecting a GitHub repo to a Hydrogen storefront, Shopify auto-generates a workflow file via a PR from `shopify[bot]`.

### Generated Workflow

File: `.github/workflows/oxygen-deployment-{storefrontId}.yml`

```yaml
name: Storefront 1000099369
on: [push]

permissions:
  contents: read
  deployments: write

jobs:
  deploy:
    name: Deploy to Oxygen
    timeout-minutes: 30
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Setup node.js
        uses: actions/setup-node@v4
        with:
          node-version: "lts/*"
          check-latest: true
      - name: Cache node modules
        id: cache-npm
        uses: actions/cache@v4
        env:
          cache-name: cache-node-modules
        with:
          path: ~/.npm
          key: ${{ runner.os }}-build-${{ env.cache-name }}-${{ hashFiles('**/package-lock.json') }}
          restore-keys: |
            ${{ runner.os }}-build-${{ env.cache-name }}-
            ${{ runner.os }}-build-
            ${{ runner.os }}-
      - name: Install dependencies
        run: npm ci
      - name: Build and Publish to Oxygen
        run: npx shopify hydrogen deploy
        env:
          SHOPIFY_HYDROGEN_DEPLOYMENT_TOKEN: ${{ secrets.OXYGEN_DEPLOYMENT_TOKEN_1000099369 }}
```

### Key Observations

1. **Triggers on ALL pushes** (`on: [push]`) — no branch filtering. Every push to any branch deploys.
2. **No `--preview` flag** — the CLI auto-detects: `main` = production, other branches = preview.
3. **No `--auth-bypass-token`** — the default workflow does NOT generate bypass tokens.
4. **Bare deploy command** — just `npx shopify hydrogen deploy` with token env var.
5. **Token stored as GitHub secret** — `OXYGEN_DEPLOYMENT_TOKEN_1000099369` (storefront ID in name).
6. **Shopify bot posts PR comment** with preview URL + shareable link after deployment.

### What the Bot Posts

After a successful preview deployment, `shopify[bot]` posts a PR comment:

> Oxygen deployed a preview of your `branch-name` branch.

| Column | Content |
|--------|---------|
| Storefront | Store name |
| Status | Successful |
| Preview link | `https://{hash}.myshopify.dev?_auth=<JWT>` |
| Deployment details | Link to Admin deployment page |
| Last update | Timestamp |

The preview link includes a `?_auth=` shareable link token **when `pullRequestPreviewPublicUrl: false`** (auth enabled). When `true`, the bot posts a bare URL without the token.

---

## 15. Preview URL Auth — How It Actually Works

### URL Format

```
https://{deployment-hash}-{storefront-hash}.myshopify.dev
```

Production gets a named URL:
```
https://{storefront-name}-{hash}.o2.myshopify.dev
```

### Auth Flow for Private Previews (VALIDATED)

When a preview requires auth (no valid `?_auth=` param or `auth_bypass_token` cookie):

```
1. GET {deployment}.myshopify.dev/
2. Gateway Worker checks for:
   a. Valid auth_bypass_token cookie (JWT with matching deployment GID in sub claim)
   b. Valid ?_auth= query parameter
   c. Valid user_session_id cookie (from prior Shopify OAuth login)
3. None found → 302 redirect chain:
   a. → accounts.shopify.com/oauth/authorize (client_id=b453446d..., redirect_uri=cf-auth-worker.myshopify.dev/oauth/callback)
   b. → accounts.shopify.com/select (account selection)
   c. → accounts.shopify.com/lookup (credential entry — "Continue to Oxygen")
4. User authenticates as Shopify staff
5. OAuth callback to cf-auth-worker.myshopify.dev → sets session cookies
6. Redirect back to deployment URL
```

**Key validated details:**
- Gateway Worker clears stale cookies on redirect: `user_session_id=; Max-Age=0` and `mac=; Max-Age=0`
- OAuth scope is `openid email` — minimal profile access
- `prompt=select_account` forces account picker every time
- Auth worker lives at `cf-auth-worker.myshopify.dev` (Cloudflare Worker)
- `powered-by: Shopify, Oxygen` header (no "Hydrogen") confirms Gateway Worker intercepted before reaching Storefront Worker

### Auth Flow with Shareable Link (VALIDATED)

```
1. GET {deployment}.myshopify.dev/?_auth=<JWT>
2. Gateway Worker validates JWT:
   a. Verifies HS256 signature
   b. Checks sub claim matches target deployment GID
   c. Checks kind is USER_SHARED
   d. No exp claim → no expiry check
3. Sets cookie: auth_bypass_token=<JWT>; Max-Age=3600; Domain=myshopify.dev; Path=/; HttpOnly; Secure
4. Forwards request to Storefront Worker
5. Returns 200 with powered-by: Shopify, Oxygen, Hydrogen
```

**Critical validated finding:** The `?_auth=` JWT value is copied **verbatim** into the `auth_bypass_token` cookie. This cookie then authenticates all subsequent requests to the same deployment for 1 hour without needing `?_auth=` in the URL.

**Cookie properties:**
| Property | Value | Implication |
|----------|-------|-------------|
| `Max-Age` | `3600` (1 hour) | Cookie expires after 1 hour, requiring re-auth |
| `Domain` | `myshopify.dev` | Sent to ALL `*.myshopify.dev` subdomains |
| `HttpOnly` | `true` | Cannot be read by JavaScript |
| `Secure` | `true` | Only sent over HTTPS |
| `Path` | `/` | Covers all paths |
| `SameSite` | (not set) | Defaults to `Lax` in modern browsers |

**Cross-deployment isolation:** The cookie is SENT to all deployments (due to `Domain=myshopify.dev`) but the Gateway Worker REJECTS it for non-matching deployments by validating the JWT `sub` claim against the target deployment's GID.

### Auth Flow with Auth Bypass Token

1. CI/E2E tool sends request with header `oxygen-auth-bypass-token: <token>`
2. **Gateway Worker** validates the bypass token
3. Checks token expiry (1-12 hours from deployment time)
4. Grants access if valid

### Key Insight: Shareable Links vs pullRequestPreviewPublicUrl

These are **two independent mechanisms**:

| Setting | Base URL (no token) | URL with `?_auth=` | Bot posts `?_auth=`? |
|---------|--------------------|--------------------|---------------------|
| `pullRequestPreviewPublicUrl: true` | Public (no auth) — **NEEDS VERIFICATION** | Works (bypasses auth) | **No** — bare URL only |
| `pullRequestPreviewPublicUrl: false` | Requires staff login (302 → OAuth) | Bypasses auth | **Yes** — includes JWT |

The `pullRequestPreviewPublicUrl` toggle controls BOTH:
1. Whether the base URL requires auth (Gateway Worker enforcement)
2. Whether the bot includes `?_auth=` token in PR comments

---

## 16. Plan-Based Limitations

### Public Environment Limits

| Plan | Public Environments Allowed |
|------|----------------------------|
| Pause and Build | 0 |
| Basic | 1 |
| Shopify | 1 |
| Advanced | 1 |
| Shopify Plus | 25 |
| Plus Partner Sandbox | 1 |

### Oxygen Availability

**NOT available** on Starter plans or development stores.

### Shareable Links

- Available on **Basic plan and above**.

### Auth Bypass Tokens

- No documented plan restrictions.

### `pullRequestPreviewPublicUrl`

- No documented plan restrictions. Unclear if gated.

---

## 17. Performance Implications

| Access Mode | Performance Impact |
|-------------|-------------------|
| Private (staff auth) | **Slower** — Gateway Worker validates auth on every route navigation |
| Public environment | **Faster** — Gateway Worker skips auth check |
| Shareable link (`?_auth=`) | **Likely faster after first load** — JWT validated once, session cookie set |
| Auth bypass token (header) | **Likely faster** — token validated per-request but no redirect flow |

---

## 18. Worker Specs and Limits

| Resource | Limit |
|----------|-------|
| Max worker size | 10 MB |
| Startup time | 400 ms max |
| CPU time per request | 30 seconds max |
| Memory | 128 MB max |
| Custom env vars | 110 per environment |
| Outbound request timeout | 2 minutes |
| Static images/files | 20 MB max |
| Video | 1 GB max |
| 3D models | 500 MB max |

### Restrictions

- `eval()` disabled
- `new Function()` disabled
- `Date.now()` frozen to last I/O operation (Spectre mitigation)
- No filesystem access
- No raw network access (only `fetch()`)
- No multi-threading
- Oxygen does NOT support proxies in front of deployments

---

## 19. Data Retention

| Resource | Retention |
|----------|-----------|
| Deployments (code + preview URLs) | Minimum 6 months |
| Last 10 deployments per environment | Always retained |
| Runtime logs | 1 month |
| Log drains | Configurable for extended retention |

---

## 20. Caveats, Gotchas, and Unknowns

### Confirmed Caveats

1. **Shareable links take up to 30 seconds** to activate/deactivate.
2. **Rollback deployments may have outdated env vars** — immutable snapshots.
3. **Env var changes require redeployment** — changing vars in Admin doesn't affect existing deployments.
4. **Redeployments are not available for Preview** — only Production and Custom.
5. **Client sourcemaps expose backend code** — disabled by default.
6. **Auth bypass tokens cannot be revoked** — they only expire (max 12 hours).
7. **The `--env` flag is forbidden in CI** — must use `--env-branch` or omit.
8. **All `--env-file` variables are marked as secrets** — `isSecret: true` is hardcoded.
9. **Max 110 environment variables per environment**.
10. **Rotating `PRIVATE_STOREFRONT_API_TOKEN` does NOT auto-redeploy** — must push a new commit.
11. **Deployment tokens expire after 1 year** — must manually delete and recreate.
12. **The 12-hour bypass token limit is a hard limit** in `@shopify/oxygen-cli`, not just documentation.
13. ~~**The Shopify GitHub bot always posts shareable links**~~ **CORRECTED** — The bot posts `?_auth=` shareable links when `pullRequestPreviewPublicUrl: false` (auth enabled), but posts **bare URLs** when `pullRequestPreviewPublicUrl: true` (auth disabled). Validated via PR #1 (got `?_auth=`) vs PR #2 (got bare URL).
14. **GitHub Deployments API is not used** — Oxygen deployments are not registered as GitHub deployment objects. Tracked entirely within Shopify's platform.
15. **Oxygen does not support proxies** in front of deployments due to bot mitigation conflicts.

### Unknowns / Needs Investigation

1. **Is `pullRequestPreviewPublicUrl` plan-gated?** No documentation found.
2. **Can shareable links be created programmatically?** No public API found. Only Admin UI + GitHub bot auto-generation.
3. ~~**What is the exact Oxygen auth flow for staff login?**~~ **RESOLVED** — See [Validated Findings](#validated-findings--live-testing-feb-16-2026). Full 4-hop redirect chain documented: Gateway Worker → OAuth authorize → account select → lookup → login page.
4. **Is there a rate limit on `SourceCodeProviderUpdate` mutations?** Uses internal Admin API proxy.
5. **Can `pullRequestPreviewPublicUrl` be toggled via the Shopify CLI?** No flag exists currently.
6. ~~**Do shareable link tokens interact with `pullRequestPreviewPublicUrl`?**~~ **PARTIALLY RESOLVED** — Bot posts `?_auth=` when setting is `false`, bare URL when `true`. But the `?_auth=` token always works regardless of the setting. The toggle only controls bot comment format and base URL access.
7. **Do auth bypass tokens work on public deployments?** Likely a no-op, unconfirmed.
8. ~~**Can the Gateway Worker auth check be inspected or debugged?**~~ **PARTIALLY RESOLVED** — The `powered-by` header reliably indicates whether the request reached the Storefront Worker (`Shopify, Oxygen, Hydrogen`) or was intercepted by the Gateway Worker (`Shopify, Oxygen`).
9. **Is the shareable link JWT signature key rotatable?** Not documented.
10. **Does `pullRequestPreviewPublicUrl: true` actually make deployments public?** PR #2 bot posted bare URL (suggesting `true`) but the URL still required OAuth. Need to verify via Shopify Admin whether the setting is currently `true` or was toggled back.
11. **What is the relationship between storefront password protection and Oxygen preview auth?** These may be separate layers.

### Key Insights from Source Code

1. **The Hydrogen CLI is just an orchestrator** — all deployment logic lives in closed-source `@shopify/oxygen-cli`.
2. **The deployment token is base64 JSON, not JWT** — contains `accessToken`, `namespace`, `expiresAt`, etc.
3. **Shareable link tokens ARE JWTs** (HS256) — contain `sub` (deployment GID), `kind` (`USER_SHARED`), `iat`, but NO `exp`.
4. **The Gateway Worker is the auth layer** — validates authorization before routing to the Storefront Worker via Dynamic Dispatch.
5. **Environment ordering in interactive prompt**: Preview → Custom → Production (ordered by "safety").
6. **`UNSAFE_SHOPIFY_HYDROGEN_DEPLOYMENT_URL`** can override the Oxygen service URL for internal testing.
7. **Oxygen uses Cloudflare Workers for Platforms** — each merchant's storefront runs in a dispatch namespace with V8 isolate isolation in untrusted mode.

---

## 21. Next Steps — Admin Validations Checklist

> Explorations and validations to perform via Shopify Admin UI to resolve remaining unknowns and fully map the auth configuration surface.

### A. Storefront-Level Settings

Navigate to: **Shopify Admin → Hydrogen → [Storefront] → Settings**

#### A1. Oxygen Deployments Section

- [ ] **Verify current `pullRequestPreviewPublicUrl` state** — Is the "Public preview URLs" toggle ON or OFF?
- [ ] **Toggle OFF → push commit → check bot comment** — Does bot include `?_auth=` token? Does bare URL require auth?
- [ ] **Toggle ON → push commit → check bot comment** — Does bot post bare URL? Does bare URL work without auth?
- [ ] **Toggle ON → wait 5 min → test existing deployment bare URL** — Does the toggle retroactively affect already-deployed previews, or only new deployments?
- [ ] **Verify `pullRequestCommentsEnabled` state** — Is the "PR comments" toggle ON?
- [ ] **Check if any propagation delay** — Toggle setting and immediately test bare URL. Document time-to-effect.

#### A2. Environment Settings

Navigate to: **Shopify Admin → Hydrogen → [Storefront] → Settings → Environments and Variables**

For **each environment** (Production, Preview, any Custom environments):

- [ ] **Document environment name, handle, branch mapping, and type** (Production/Preview/Custom)
- [ ] **Check public/private visibility toggle** — Is the environment public or private?
- [ ] **Toggle environment to Public → test bare URL** — Does the environment URL work without auth?
- [ ] **Toggle environment back to Private → verify auth returns**
- [ ] **Check environment variables** — List injected variables (auto-generated vs custom)
- [ ] **Check if Preview environment has a separate visibility toggle** or if it's solely controlled by `pullRequestPreviewPublicUrl`

#### A3. Storefront Password Protection

Navigate to: **Shopify Admin → Online Store → Preferences** (or Storefront settings)

- [ ] **Is storefront password protection enabled?** — This is a separate layer from Oxygen deployment auth
- [ ] **Does storefront password affect Oxygen previews?** — Test by disabling storefront password and re-testing bare preview URLs
- [ ] **Check if Hydrogen storefronts have a separate password gate** from the Liquid storefront password

### B. Deployment-Level Validations

Navigate to: **Shopify Admin → Hydrogen → [Storefront] → Deployments**

#### B1. Individual Deployment Inspection

For PR #1 and PR #2 deployments:

- [ ] **Open deployment details** — Document deployment ID, status, environment, timestamp
- [ ] **Check "Share" options** — What sharing options are available? (Anyone with link / Staff only)
- [ ] **Create a manual shareable link** via Admin UI for PR #2 — Does this generate a new JWT?
- [ ] **Compare manual shareable link JWT** with bot-generated JWT — Same `kind`? Same structure?
- [ ] **Revoke the shareable link** — Does the old `?_auth=` JWT immediately stop working?
- [ ] **Test the 30-second propagation delay** — Time between revocation and actual invalidation

#### B2. Deployment Token Management

Navigate to: **Shopify Admin → Hydrogen → [Storefront] → Settings → Storefront API access**

- [ ] **List all deployment tokens** — How many exist? Which is the default?
- [ ] **Check token expiry dates** — When do current tokens expire?
- [ ] **Create a new token** — Verify it can deploy independently
- [ ] **Rotate the default token** — Does this invalidate CI deployments immediately?

### C. GitHub Integration Settings

Navigate to: **Shopify Admin → Hydrogen → [Storefront] → Settings → GitHub**

- [ ] **Verify connected repository** — `juanpprieto/preview-deployments-auth`
- [ ] **Check GitHub App permissions** — Which accounts have the Shopify GitHub App installed?
- [ ] **Verify PR comment toggle** — Is it enabled? Can it be toggled without affecting deployment auth?
- [ ] **Check if there's a branch filter** — Can specific branches be excluded from deployments?

### D. Cross-Cutting Auth Experiments

These experiments test interactions between different auth layers:

#### D1. pullRequestPreviewPublicUrl + Storefront Password

| Test | pullRequestPreviewPublicUrl | Storefront Password | Expected Result |
|------|---------------------------|--------------------|-----------------|
| 1 | `true` (public) | Disabled | Bare URL should work |
| 2 | `true` (public) | Enabled | **UNKNOWN** — does password override Oxygen public setting? |
| 3 | `false` (auth) | Disabled | Bare URL requires Shopify staff login |
| 4 | `false` (auth) | Enabled | Bare URL requires Shopify staff login |

#### D2. Public Environment + Preview Auth

- [ ] **Make Preview environment public** (if possible) — Does this override `pullRequestPreviewPublicUrl`?
- [ ] **Make a Custom environment public** — Verify bare URL access works
- [ ] **Test shareable link on a public environment** — Does `?_auth=` still work? (Should be a no-op)

#### D3. Auth Bypass Token Experiments

- [ ] **Deploy with `--auth-bypass-token`** — Capture the token from CI output or `h2_deploy_log.json`
- [ ] **Test auth bypass token via header** — `curl -H "oxygen-auth-bypass-token: <token>" <url>`
- [ ] **Test auth bypass token after expiry** — Wait for duration to expire, retry
- [ ] **Test auth bypass token on wrong deployment** — Should fail (deployment-scoped)
- [ ] **Compare auth bypass JWT structure** with shareable link JWT — Different `kind`? Has `exp`?

#### D4. OAuth Flow Completion

- [ ] **Complete the Shopify OAuth login flow** in browser — Document what cookies are set after successful login
- [ ] **Test session cookie persistence** — How long does the staff session last?
- [ ] **Test session cookie cross-deployment** — Does a staff login session work across all deployments for the same store?
- [ ] **Test session cookie cross-store** — Does it work across different stores?

### E. Network-Level Deep Dive

These require browser DevTools Network panel on a logged-in Shopify Admin session:

- [ ] **Capture the full `SourceCodeProviderUpdate` request** — Toggle `pullRequestPreviewPublicUrl` and capture the exact GraphQL mutation body
- [ ] **Query current `pullRequestPreviewPublicUrl` value** — Is there a read-only query, or is it only visible in the UI?
- [ ] **Inspect the `cf-auth-worker.myshopify.dev/oauth/callback`** response — What cookies does it set after successful OAuth?
- [ ] **Check for `user_session_id` and `mac` cookies** after successful OAuth login — These are the staff session cookies the Gateway Worker checks

### F. Edge Cases to Document

- [ ] **What happens when deployment token expires mid-CI?** — Does the deployment fail gracefully?
- [ ] **What happens when a PR is closed?** — Is the preview deployment retained? For how long?
- [ ] **What happens when multiple PRs update the same branch?** — Is the old preview replaced?
- [ ] **What happens when `pullRequestPreviewPublicUrl` is toggled while a deployment is in progress?**
- [ ] **Can a non-staff Shopify user (e.g., customer) complete the OAuth flow?** — The scope is `openid email`, not merchant-specific
