# Hydrogen/Oxygen Deployment Authentication — Complete Knowledge Base

> Internal reference for understanding all auth options for sharing Hydrogen deployments with Shopify staff and external stakeholders.
>
> See also: [API request/response traces](./preview-deployment-auth-api-responses.md)

---

## Table of Contents

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

### Key Insight

The Shopify GitHub bot **always posts a shareable link** in PR comments (when `pullRequestCommentsEnabled: true`). This means even when `pullRequestPreviewPublicUrl: false` (staff auth enabled), the PR comment includes a `?_auth=` token that bypasses auth for anyone with the link. The `pullRequestPreviewPublicUrl` toggle controls whether the **base URL without the token** requires auth, not whether the bot generates a shareable link.

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

### Important Nuance

Even when `pullRequestPreviewPublicUrl: false` (auth enabled), the **GitHub bot still posts shareable links** with `?_auth=` tokens in PR comments. So PR reviewers with the link can always access the preview — the toggle only controls whether the **base URL** (without `?_auth=`) requires login.

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

The preview link **always includes a `?_auth=` shareable link token**, regardless of the `pullRequestPreviewPublicUrl` setting.

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

### Auth Flow for Private Previews

When `pullRequestPreviewPublicUrl: false` (default):

1. User visits `https://{hash}.myshopify.dev` (no `?_auth=`)
2. **Gateway Worker** intercepts, checks for staff auth cookie
3. No cookie → redirects to Shopify login
4. User authenticates as store staff
5. Redirect back to preview URL with session cookie
6. Gateway Worker validates cookie **on every subsequent route navigation**

### Auth Flow with Shareable Link

1. User visits `https://{hash}.myshopify.dev?_auth=<JWT>`
2. **Gateway Worker** sees `?_auth=` query parameter
3. Validates JWT signature (HS256) and `sub` claim (deployment GID)
4. JWT has `kind: USER_SHARED` — shareable link, no expiry check needed
5. Grants access without staff login
6. Likely sets a session cookie for subsequent navigations

### Auth Flow with Auth Bypass Token

1. CI/E2E tool sends request with header `oxygen-auth-bypass-token: <token>`
2. **Gateway Worker** validates the bypass token
3. Checks token expiry (1-12 hours from deployment time)
4. Grants access if valid

### Key Insight: Shareable Links vs pullRequestPreviewPublicUrl

These are **two independent mechanisms**:

| Setting | Base URL (no token) | URL with `?_auth=` | Bot posts link? |
|---------|--------------------|--------------------|----------------|
| `pullRequestPreviewPublicUrl: true` | Public (no auth) | N/A (already public) | Yes |
| `pullRequestPreviewPublicUrl: false` | Requires staff login | Bypasses auth | Yes |

The bot **always** posts a shareable link. So the `pullRequestPreviewPublicUrl` toggle matters for:
- Direct URL sharing (without the `?_auth=` token)
- Bookmarked URLs
- Search engine access (though `robots.txt` blocks indexing)

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
13. **The Shopify GitHub bot always posts shareable links** in PR comments, even when staff auth is enabled. The `pullRequestPreviewPublicUrl` toggle only controls the base URL access.
14. **GitHub Deployments API is not used** — Oxygen deployments are not registered as GitHub deployment objects. Tracked entirely within Shopify's platform.
15. **Oxygen does not support proxies** in front of deployments due to bot mitigation conflicts.

### Unknowns / Needs Investigation

1. **Is `pullRequestPreviewPublicUrl` plan-gated?** No documentation found.
2. **Can shareable links be created programmatically?** No public API found. Only Admin UI + GitHub bot auto-generation.
3. **What is the exact Oxygen auth flow for staff login?** Gateway Worker redirects to Shopify login, but the cookie/session specifics are undocumented.
4. **Is there a rate limit on `SourceCodeProviderUpdate` mutations?** Uses internal Admin API proxy.
5. **Can `pullRequestPreviewPublicUrl` be toggled via the Shopify CLI?** No flag exists currently.
6. **Do shareable link tokens interact with `pullRequestPreviewPublicUrl`?** Based on PR #1, the bot posts tokens regardless of the setting.
7. **Do auth bypass tokens work on public deployments?** Likely a no-op, unconfirmed.
8. **Can the Gateway Worker auth check be inspected or debugged?** No tooling documented.
9. **Is the shareable link JWT signature key rotatable?** Not documented.

### Key Insights from Source Code

1. **The Hydrogen CLI is just an orchestrator** — all deployment logic lives in closed-source `@shopify/oxygen-cli`.
2. **The deployment token is base64 JSON, not JWT** — contains `accessToken`, `namespace`, `expiresAt`, etc.
3. **Shareable link tokens ARE JWTs** (HS256) — contain `sub` (deployment GID), `kind` (`USER_SHARED`), `iat`, but NO `exp`.
4. **The Gateway Worker is the auth layer** — validates authorization before routing to the Storefront Worker via Dynamic Dispatch.
5. **Environment ordering in interactive prompt**: Preview → Custom → Production (ordered by "safety").
6. **`UNSAFE_SHOPIFY_HYDROGEN_DEPLOYMENT_URL`** can override the Oxygen service URL for internal testing.
7. **Oxygen uses Cloudflare Workers for Platforms** — each merchant's storefront runs in a dispatch namespace with V8 isolate isolation in untrusted mode.
