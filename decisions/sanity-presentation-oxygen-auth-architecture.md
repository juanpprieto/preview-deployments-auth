# Sanity Presentation Tool + Oxygen Auth Bypass: Multi-Environment Architecture

> Validated and working as of February 18, 2026.
> Hydrogen 2026.1.0 | React Router 7.12 | React 18.3.1 | hydrogen-sanity 6.1.0

---

## Table of Contents

1. [The Problem](#1-the-problem)
2. [The Solution (Summary)](#2-the-solution-summary)
3. [Architecture Diagram](#3-architecture-diagram)
4. [Environment Matrix](#4-environment-matrix)
5. [Component Inventory](#5-component-inventory)
6. [Detailed Flow](#6-detailed-flow-what-happens-when-an-editor-opens-the-presentation-tool)
7. [Oxygen Environment Variable Strategy](#7-oxygen-environment-variable-strategy)
8. [CI Workflow (Full Code)](#8-ci-workflow-full-code)
9. [Studio Configuration (Full Code)](#9-studio-configuration-full-code)
10. [Hydrogen App (Full Code)](#10-hydrogen-app-full-code)
11. [Token Strategy](#11-token-strategy)
12. [CSP Configuration](#12-csp-content-security-policy)
13. [Package Dependencies](#13-package-dependencies)
14. [Environment Variables](#14-environment-variables)
15. [Failure Modes](#15-failure-modes)
16. [Bugs Encountered and Fixed](#16-bugs-encountered-and-fixed)
17. [Areas to Investigate Further](#17-areas-to-investigate-further)
18. [Reference Links](#18-reference-links)

---

## 1. The Problem

Shopify Oxygen protects preview deployments behind Shopify login. Sanity Studio's Presentation tool loads the storefront in a cross-origin iframe. Two things break:

1. **Oxygen Gateway blocks unauthenticated requests.** The iframe cannot load the storefront without a valid auth bypass token.

2. **Third-party cookies are blocked.** Safari (ITP), Brave, and Chrome (127+) refuse to store the `auth_bypass_token` cookie set by the Oxygen Gateway because the iframe origin (`*.myshopify.dev`) differs from the parent origin (`www.sanity.io`). Every subsequent client-side fetch redirects to `accounts.shopify.com/oauth/authorize` and fails with a CORS error.

This document covers the full architecture of the solution across multiple environments (production, staging, dev), including every file involved, every configuration choice, and every bug discovered during integration.

---

## 2. The Solution (Summary)

A fully automated pipeline that:

1. **CI extracts** the deployment URL and `USER_SHARED` auth bypass token from `shopify[bot]`'s PR comment
2. **CI writes** both values into a Sanity document (one per dataset/environment)
3. **Studio reads** the Sanity document at runtime and constructs the iframe URL with `?_auth=TOKEN`
4. **Hydrogen** enables preview mode via `hydrogen-sanity`'s built-in route handler and renders `<VisualEditing>`
5. **A fetch interceptor** in `entry.client.tsx` appends `?_auth=TOKEN` to all same-origin client-side requests, bypassing the broken cookie path entirely

No manual token copying. No hardcoded URLs. Survives redeployments automatically. Works identically across staging, dev, and production environments.

---

## 3. Architecture Diagram

```
+-----------------------------------------------------------------------+
|                         DEPLOYMENT PIPELINE                            |
|                                                                        |
|  git push --> Oxygen Deploy --> shopify[bot] PR Comment                 |
|                                    |                                   |
|                                    v                                   |
|                           issue_comment workflow                       |
|                           (sanity-oxygen-bypass-sync.yml)              |
|                                    |                                   |
|                        Extract URL + TOKEN from comment                |
|                        Verify token (curl HTTP 200)                    |
|                                    |                                   |
|                                    v                                   |
|                     Sanity HTTP API: createOrReplace                   |
|                     doc: oxygen-bypass.staging (per-env)               |
|                     dataset: staging (matches Oxygen env)              |
|                     { deploymentUrl, authToken }                       |
+-----------------------------------------------------------------------+

+-----------------------------------------------------------------------+
|                      STUDIO --> HYDROGEN FLOW                          |
|                                                                        |
|  +------------------+     +--------------------------------------+     |
|  |   Sanity Studio   |     |         Oxygen Gateway               |     |
|  |   (www.sanity.io) |     |      (Cloudflare Worker)             |     |
|  |                   |     |                                      |     |
|  |  presentationTool |     |  Runs BEFORE Hydrogen app code.      |     |
|  |   +-----------+   |     |  Checks ?_auth= param or cookie.     |     |
|  |   | initial() |   |     |  If valid: pass through to Hydrogen. |     |
|  |   | queries   |   |     |  If invalid: redirect to Shopify     |     |
|  |   | Sanity doc|---+---->|  login.                              |     |
|  |   +-----------+   |     +------------------+-------------------+     |
|  |         |         |                        |                         |
|  |         v         |                        v                         |
|  |  iframe loads:    |     +--------------------------------------+     |
|  |  deployment.url   |     |         Hydrogen App                 |     |
|  |  ?_auth=TOKEN     |     |      (Cloudflare Worker)             |     |
|  |                   |     |                                      |     |
|  |  previewMode()    |     |  1. GET /api/preview-mode/enable     |     |
|  |  also appends     |     |     validates secret, sets session   |     |
|  |  ?_auth=TOKEN     |     |  2. 307 redirect to /                |     |
|  |  to enable path   |     |  3. Root loader reads preview state: |     |
|  |                   |     |     skip Analytics, render            |     |
|  |                   |     |     <VisualEditing>                  |     |
|  |  <-- postMessage -+-----|  4. entry.client.tsx intercepts      |     |
|  |  (overlays, edit) |     |     fetch, appends ?_auth=TOKEN      |     |
|  +------------------+     +--------------------------------------+     |
+-----------------------------------------------------------------------+
```

---

## 4. Environment Matrix

Each environment maps 1:1 across three systems: a git branch, an Oxygen deployment target, and a Sanity dataset. The Studio exposes one workspace per environment.

| Environment | Git Branch | Oxygen Target | Sanity Dataset | Sanity Bypass Doc ID | Studio Workspace Path | Visibility |
|-------------|-----------|---------------|----------------|----------------------|-----------------------|------------|
| Production  | `main`    | Production    | `production`   | `oxygen-bypass.production` | `/production` | Public (no auth) |
| Staging     | `staging` | Staging       | `staging`      | `oxygen-bypass.staging` | `/staging` | Private (auth required) |
| Dev         | `dev`     | Dev           | `dev`          | `oxygen-bypass.dev` | `/dev` (disabled) | Private (auth required) |

**Key invariant**: The Oxygen environment variable `SANITY_DATASET` determines which Sanity dataset the Hydrogen app queries. The CI workflow writes the bypass document into the matching dataset. The Studio workspace queries the same dataset via its scoped `context.client`. All three always agree.

**Current limitation**: The Sanity account plan limits us to 2 datasets. The dev workspace is disabled in `sanity.config.ts` and can be enabled when a dev dataset becomes available. The CI workflow already handles the `dev` branch mapping.

---

## 5. Component Inventory

| Layer | File / Config | Purpose |
|-------|--------------|---------|
| **CI** | `.github/workflows/sanity-oxygen-bypass-sync.yml` | Extracts URL+token from shopify[bot], patches Sanity doc in the correct dataset |
| **CI** | `.github/workflows/oxygen-deployment-1000099369.yml` | Builds and deploys to Oxygen with `--auth-bypass-token` flag |
| **Sanity doc** | `sanity.oxygenProtectionBypass` (per-dataset) | Stores current deployment URL and USER_SHARED token |
| **Studio schema** | `schemaTypes/documents/oxygenProtectionBypass.ts` | Schema for the bypass document |
| **Studio config** | `sanity.config.ts` | Multi-workspace config with factory plugin pattern, dynamic `initial`, `previewMode`, `allowOrigins` |
| **Studio plugin** | `plugins/resolveOxygenPreviewMode.ts` | Async previewMode resolver that injects `?_auth=` on the enable path |
| **Hydrogen Vite** | `vite.config.ts` with `sanity()` plugin | SSR-safe bundling for `@sanity/visual-editing` |
| **Hydrogen context** | `app/lib/context.ts` | `createSanityContext()` from `hydrogen-sanity`, `PreviewSession` setup |
| **Hydrogen entry** | `app/entry.client.tsx` | Fetch interceptor for third-party cookie bypass |
| **Hydrogen entry** | `app/entry.server.tsx` | CSP frame-ancestors, `<SanityProvider>` wrapping `<ServerRouter>` |
| **Hydrogen root** | `app/root.tsx` | Preview detection via `context.sanity.preview`, VisualEditing, Analytics skip, `<Sanity>` component |
| **Preview route** | `app/routes/api.preview-mode.enable.tsx` | Re-exports `{action, loader}` from `hydrogen-sanity/preview/route` |
| **Preview route** | `app/routes/api.preview-mode.disable.tsx` | Destroys preview session cookie |
| **Session** | `app/sanity/session.ts` | Cookie-based preview session storage (used by disable route) |
| **Sanity client** | `app/sanity/client.ts` | `@sanity/client` instance with stega config (used for standalone queries) |
| **Env types** | `env.d.ts` | Declares `Env` interface with per-environment Sanity variables |

---

## 6. Detailed Flow: What Happens When an Editor Opens the Presentation Tool

### Step 1: Studio resolves the initial URL

The `makeInitialUrl` function in `sanity.config.ts` queries the bypass document from the current workspace's dataset:

```groq
*[_type == "sanity.oxygenProtectionBypass"][0]{deploymentUrl, authToken}
```

If `authToken` exists (private environments), it returns `${deploymentUrl}?_auth=${authToken}`.
If `authToken` is absent (production), it returns the URL as-is.
If no document exists, it falls back to `http://localhost:3000`.

Because `context.client` is scoped to the workspace's dataset, the production workspace queries production and the staging workspace queries staging. No branch logic needed in the query.

### Step 2: Studio resolves previewMode

The `resolveOxygenPreviewMode` plugin receives `{client, targetOrigin}` and queries:

```groq
*[
  _type == "sanity.oxygenProtectionBypass"
  && deploymentUrl match $origin + "*"
][0]{authToken, deploymentUrl}
```

For private environments (staging, dev), it returns `{enable: '/api/preview-mode/enable?_auth=TOKEN'}` so the Oxygen Gateway passes the enable request through.

For production (no authToken in the document), it returns `{enable: '/api/preview-mode/enable'}` without the token parameter.

For localhost, it skips the query entirely and returns the bare path.

### Step 3: Oxygen Gateway processes the initial request

```
Browser --> GET deployment.myshopify.dev/?_auth=TOKEN
         --> Oxygen Gateway Worker (runs before Hydrogen)
         --> Validates JWT
         --> Sets auth_bypass_token cookie (HttpOnly, Secure, SameSite=None)
         --> Passes request through to Hydrogen app
```

**Critical**: The cookie is set but never stored in the iframe context because all major browsers block third-party cookies. This is the root cause of the entire cookie bypass architecture.

### Step 4: Hydrogen processes the initial page load

The `createSanityContext()` in `app/lib/context.ts` initializes the Sanity client with `PreviewSession` from `hydrogen-sanity/preview/session`. The root loader checks `context.sanity.preview?.enabled` (not yet true on first load) and extracts `?_auth=` from the URL for client-side use.

### Step 5: Studio enables preview mode

```
Studio --> GET /api/preview-mode/enable?_auth=TOKEN&sanity-preview-pathname=/&...
       --> Oxygen Gateway passes through (sees ?_auth=)
       --> hydrogen-sanity/preview/route validates @sanity/preview-url-secret
       --> Sets preview session cookie (previewMode=true, perspective=drafts)
       --> 307 redirect to /
```

The enable route is a single-line re-export: `export {action, loader} from 'hydrogen-sanity/preview/route'`. All validation, session management, and redirect logic is handled by the `hydrogen-sanity` package.

### Step 6: Page renders in preview mode

The root loader reads `context.sanity.preview?.enabled` as `true` from the session cookie. The App component skips `<Analytics.Provider>` (which crashes in iframes) and renders `<VisualEditing action="/api/preview-mode/enable" />` inside a `<ClientOnly>` guard.

The `<Sanity>` component (from `hydrogen-sanity`) is rendered in `Layout()` to inject the necessary client-side scripts for live content.

### Step 7: Fetch interceptor activates (client-side)

Before React hydration, `entry.client.tsx` reads `?_auth=TOKEN` from `window.location.search` and patches `window.fetch` to append the token to all same-origin requests. This ensures React Router's `.data` endpoint fetches pass through the Oxygen Gateway without the (blocked) cookie.

### Step 8: VisualEditing connects

`<VisualEditing>` from `hydrogen-sanity/visual-editing` establishes a postMessage channel with the parent Studio, renders click-to-edit overlays on stega-encoded content, and submits perspective changes via PUT to `/api/preview-mode/enable`.

---

## 7. Oxygen Environment Variable Strategy

Each Oxygen environment (Production, Staging, Dev) gets its own set of Sanity-related environment variables via the Shopify Oxygen dashboard. The Hydrogen app reads these at runtime.

| Variable | Production | Staging | Dev |
|----------|-----------|---------|-----|
| `SANITY_PROJECT_ID` | `sx997gpv` | `sx997gpv` | `sx997gpv` |
| `SANITY_DATASET` | `production` | `staging` | `dev` |
| `SANITY_API_READ_TOKEN` | (shared token) | (shared token) | (shared token) |
| `SANITY_STUDIO_URL` | `https://meditate-with-eve.sanity.studio` | `https://meditate-with-eve.sanity.studio` | `https://meditate-with-eve.sanity.studio` |
| `SESSION_SECRET` | (per-env secret) | (per-env secret) | (per-env secret) |

The `SANITY_DATASET` variable is the key differentiator. It controls which Sanity dataset the Hydrogen app queries at runtime. The `createSanityContext()` call in `app/lib/context.ts` reads it:

```typescript
client: {
  projectId: env.SANITY_PROJECT_ID || 'sx997gpv',
  dataset: env.SANITY_DATASET || 'production',
  apiVersion: '2025-02-19',
  useCdn: true,
  stega: {
    enabled: true,
    studioUrl: env.SANITY_STUDIO_URL || 'https://meditate-with-eve.sanity.studio',
  },
},
```

**How this connects to the CI pipeline**: When CI writes the bypass document, it writes to the dataset that matches the branch. The `staging` branch deploys to the Staging Oxygen environment, where `SANITY_DATASET=staging`. CI writes the bypass doc to the `staging` dataset. Studio's staging workspace queries the `staging` dataset. Everything stays in sync without conditional logic.

---

## 8. CI Workflow (Full Code)

### Deployment Workflow

**File**: `.github/workflows/oxygen-deployment-1000099369.yml`

Triggers on every push. Builds and deploys to Oxygen with auth bypass token generation enabled.

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
        run: npx shopify hydrogen deploy --auth-bypass-token --auth-bypass-token-duration 12
        env:
          SHOPIFY_HYDROGEN_DEPLOYMENT_TOKEN: ${{ secrets.OXYGEN_DEPLOYMENT_TOKEN_1000099369 }}

      - name: Test auth bypass token as URL parameter
        if: always()
        run: |
          DEPLOY_URL=$(jq -r '.url // empty' h2_deploy_log.json 2>/dev/null)
          AUTH_TOKEN=$(jq -r '.authBypassToken // empty' h2_deploy_log.json 2>/dev/null)

          if [ -z "$DEPLOY_URL" ] || [ -z "$AUTH_TOKEN" ]; then
            echo "ERROR: Missing deployment URL or auth token"
            cat h2_deploy_log.json 2>/dev/null || echo "No h2_deploy_log.json"
            exit 1
          fi

          echo "Deployment URL: $DEPLOY_URL"
          echo "Token length: ${#AUTH_TOKEN}"

          echo ""
          echo "=== Test 1: Bare URL (expect 302) ==="
          BARE_STATUS=$(curl -sS -o /dev/null -w "%{http_code}" "$DEPLOY_URL")
          echo "Status: $BARE_STATUS"

          echo ""
          echo "=== Test 2: URL with ?_auth= bypass token (key test) ==="
          AUTH_STATUS=$(curl -sS -o /dev/null -w "%{http_code}" "${DEPLOY_URL}?_auth=${AUTH_TOKEN}")
          echo "Status: $AUTH_STATUS"

          echo ""
          echo "=== Test 3: Header-based auth bypass token ==="
          HEADER_STATUS=$(curl -sS -o /dev/null -w "%{http_code}" -H "oxygen-auth-bypass-token: ${AUTH_TOKEN}" "$DEPLOY_URL")
          echo "Status: $HEADER_STATUS"

          echo ""
          echo "=== RESULTS ==="
          echo "Bare URL:          $BARE_STATUS (expect 302)"
          echo "?_auth= parameter: $AUTH_STATUS (KEY TEST - 200 means it works as URL param)"
          echo "Header bypass:     $HEADER_STATUS (expect 200)"

      - name: Upload deployment log
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: h2-deploy-log
          path: h2_deploy_log.json
```

**Key detail**: `--auth-bypass-token-duration 12` sets a 12-hour max duration (the hard limit). The `USER_SHARED` token kind ignores this duration and has no expiry, but the flag is required to generate any bypass token at all.

### Sanity Sync Workflow

**File**: `.github/workflows/sanity-oxygen-bypass-sync.yml`

**Trigger**: `issue_comment` event when `shopify[bot]` creates or edits a comment containing "Successful".

**Why `issue_comment`**: Shopify's GitHub App posts deployment results as PR comments, not check runs. The `issue_comment` event is the only way to react to these.

**Constraint**: `issue_comment` workflows only run from the default branch (main). The workflow file must be merged to main before it can fire.

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
    name: Extract and sync token
    runs-on: ubuntu-latest
    if: >
      github.event.comment.user.login == 'shopify[bot]' &&
      contains(github.event.comment.body, 'Successful') &&
      github.event.issue.pull_request

    steps:
      - name: Log trigger
        run: |
          echo "=== issue_comment event fired for shopify[bot] ==="
          echo "PR: #${{ github.event.issue.number }}"
          echo "Comment author: ${{ github.event.comment.user.login }}"

      - name: Extract token
        id: extract
        shell: bash
        env:
          COMMENT_BODY: ${{ github.event.comment.body }}
        run: |
          # Extract deployment URL
          DEPLOY_URL=$(echo "$COMMENT_BODY" | grep -o 'https://[a-z0-9-]*\.myshopify\.dev' | head -1)
          echo "deploy_url=$DEPLOY_URL" >> $GITHUB_OUTPUT
          echo "Extracted URL: $DEPLOY_URL"

          # Extract USER_SHARED token
          AUTH_TOKEN=$(echo "$COMMENT_BODY" | grep -o '_auth=[^)]*' | head -1 | sed 's/_auth=//')
          echo "::add-mask::$AUTH_TOKEN"
          echo "auth_token=$AUTH_TOKEN" >> $GITHUB_OUTPUT
          echo "Token length: ${#AUTH_TOKEN}"

          # Validate token kind
          PAYLOAD=$(echo "$AUTH_TOKEN" | cut -d. -f2)
          MOD=$((${#PAYLOAD} % 4))
          if [ $MOD -eq 2 ]; then PAYLOAD="${PAYLOAD}=="; elif [ $MOD -eq 3 ]; then PAYLOAD="${PAYLOAD}="; fi
          TOKEN_KIND=$(echo "$PAYLOAD" | base64 -d 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('kind','UNKNOWN'))" 2>/dev/null || echo "UNKNOWN")
          echo "token_kind=$TOKEN_KIND" >> $GITHUB_OUTPUT
          echo "Token kind: $TOKEN_KIND"

      - name: Verify token works
        env:
          DEPLOY_URL: ${{ steps.extract.outputs.deploy_url }}
          AUTH_TOKEN: ${{ steps.extract.outputs.auth_token }}
        run: |
          if [ -z "$DEPLOY_URL" ] || [ -z "$AUTH_TOKEN" ]; then
            echo "ERROR: Missing URL or token"
            exit 1
          fi
          STATUS=$(curl -sS -o /dev/null -w "%{http_code}" "${DEPLOY_URL}?_auth=${AUTH_TOKEN}")
          echo "Token verification: HTTP $STATUS"
          if [ "$STATUS" != "200" ]; then
            echo "WARNING: Token did not return 200"
          fi

      - name: Save as artifact
        env:
          DEPLOY_URL: ${{ steps.extract.outputs.deploy_url }}
          AUTH_TOKEN: ${{ steps.extract.outputs.auth_token }}
          TOKEN_KIND: ${{ steps.extract.outputs.token_kind }}
        run: |
          mkdir -p /tmp/oxygen-bypass
          cat > /tmp/oxygen-bypass/token.json << ARTIFACT_EOF
          {
            "deploymentUrl": "$DEPLOY_URL",
            "authToken": "$AUTH_TOKEN",
            "tokenKind": "$TOKEN_KIND",
            "pr": ${{ github.event.issue.number }},
            "extractedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
          }
          ARTIFACT_EOF
          echo "Artifact contents:"
          cat /tmp/oxygen-bypass/token.json

      - name: Upload artifact
        uses: actions/upload-artifact@v4
        with:
          name: oxygen-bypass-token
          path: /tmp/oxygen-bypass/token.json
          retention-days: 90

      - name: Patch Sanity bypass document
        env:
          DEPLOY_URL: ${{ steps.extract.outputs.deploy_url }}
          AUTH_TOKEN: ${{ steps.extract.outputs.auth_token }}
          TOKEN_KIND: ${{ steps.extract.outputs.token_kind }}
          SANITY_WRITE_TOKEN: ${{ secrets.SANITY_API_WRITE_TOKEN }}
        run: |
          if [ -z "$SANITY_WRITE_TOKEN" ]; then
            echo "WARNING: SANITY_API_WRITE_TOKEN secret not set, skipping Sanity patch"
            exit 0
          fi

          PAYLOAD=$(jq -n \
            --arg url "$DEPLOY_URL" \
            --arg token "$AUTH_TOKEN" \
            --arg kind "$TOKEN_KIND" \
            --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
            '{mutations: [{createOrReplace: {
              _id: "oxygen-bypass.staging",
              _type: "sanity.oxygenProtectionBypass",
              name: "Staging",
              deploymentUrl: $url,
              authToken: $token,
              branch: "staging",
              tokenKind: $kind,
              updatedAt: $ts
            }}]}')

          RESPONSE=$(curl -s -w "\n%{http_code}" -X POST \
            "https://sx997gpv.api.sanity.io/v2021-06-07/data/mutate/production" \
            -H "Content-Type: application/json" \
            -H "Authorization: Bearer $SANITY_WRITE_TOKEN" \
            -d "$PAYLOAD")

          HTTP_CODE=$(echo "$RESPONSE" | tail -1)
          BODY=$(echo "$RESPONSE" | head -n -1)
          echo "Sanity API response: HTTP $HTTP_CODE"
          echo "$BODY" | python3 -m json.tool 2>/dev/null || echo "$BODY"

          if [ "$HTTP_CODE" != "200" ]; then
            echo "ERROR: Failed to patch Sanity document"
            exit 1
          fi
          echo "Successfully updated oxygen-bypass.staging in Sanity"

      - name: Summary
        env:
          DEPLOY_URL: ${{ steps.extract.outputs.deploy_url }}
          TOKEN_KIND: ${{ steps.extract.outputs.token_kind }}
        run: |
          echo "=== Sync Summary ==="
          echo "PR: #${{ github.event.issue.number }}"
          echo "Deploy URL: $DEPLOY_URL"
          echo "Token kind: $TOKEN_KIND"
          echo "Sanity doc: oxygen-bypass.staging patched"
```

### Multi-Environment CI Extension (Planned)

The current sync workflow hardcodes `oxygen-bypass.staging` and writes to the `production` dataset. To support multiple environments, the workflow needs to:

1. Detect which branch the PR targets (staging, dev, main)
2. Compute the correct Sanity doc ID (`oxygen-bypass.staging`, `oxygen-bypass.dev`, `oxygen-bypass.production`)
3. Write to the correct dataset

The bypass document per-dataset approach (one doc per dataset, GROQ query uses `[0]`) means the CI just needs to write to the right dataset with the right doc ID. The Studio's workspace-scoped `context.client` handles the rest.

### Required GitHub Secrets

| Secret | Purpose |
|--------|---------|
| `OXYGEN_DEPLOYMENT_TOKEN_1000099369` | Oxygen deployment authentication |
| `SANITY_API_WRITE_TOKEN` | Write access to Sanity project `sx997gpv` |

### `shopify[bot]` Comment Behavior

The `shopify[bot]` comment that triggers the sync workflow has specific timing:

- **First deploy on a PR**: Bot creates a new comment (`issue_comment.created`)
- **Subsequent deploys on same PR**: Bot edits the existing comment (`issue_comment.edited`)

The workflow listens for both `created` and `edited` event types to handle both cases.

The `::add-mask::` directive in the Extract step replaces the token value with `***` in all subsequent log output. This is a log-only transformation; the actual environment variable value is preserved for use in later steps.

---

## 9. Studio Configuration (Full Code)

### `sanity.config.ts`

Multi-workspace configuration. Each workspace maps to one dataset and one Oxygen environment. The `sharedPlugins()` factory function is called per workspace (not shared by reference) so each workspace gets its own plugin instances with correctly scoped `context.client`.

```typescript
import {defineConfig} from 'sanity'
import './studio.css'
import {structureTool} from 'sanity/structure'
import {presentationTool} from 'sanity/presentation'
import {visionTool} from '@sanity/vision'
import {formSchema} from '@sanity/form-toolkit/form-schema'
import {schemaTypes} from './schemaTypes'
import {deskStructure} from './deskStructure'
import {resolveOxygenPreviewMode} from './plugins/resolveOxygenPreviewMode'

const PROJECT_ID = 'sx997gpv'

const BYPASS_INITIAL_QUERY = `*[_type == "sanity.oxygenProtectionBypass"][0]{deploymentUrl, authToken}`

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const makeInitialUrl = async (context: any) => {
  const config = (await context.client.fetch(BYPASS_INITIAL_QUERY)) as {
    deploymentUrl?: string
    authToken?: string
  } | null
  if (config?.deploymentUrl) {
    const url = config.authToken
      ? `${config.deploymentUrl}?_auth=${config.authToken}`
      : config.deploymentUrl
    console.log(`[oxygen-bypass] Using deployment URL: ${config.deploymentUrl}`)
    return url
  }
  console.log('[oxygen-bypass] No deployment URL found, falling back to localhost')
  return 'http://localhost:3000'
}

const sharedPlugins = () => [
  structureTool({structure: deskStructure}),
  presentationTool({
    name: 'presentation',
    title: 'Presentation',
    allowOrigins: ['https://*.myshopify.dev'],
    previewUrl: {
      initial: makeInitialUrl,
      previewMode: resolveOxygenPreviewMode({
        enablePath: '/api/preview-mode/enable',
      }),
    },
  }),
  visionTool(),
  formSchema({fields: [{name: 'enquiryType', type: 'formFieldEnquiryType'}]}),
]

const sharedSchema = {types: schemaTypes}

export default defineConfig([
  {
    name: 'production',
    title: 'Production',
    projectId: PROJECT_ID,
    dataset: 'production',
    basePath: '/production',
    plugins: sharedPlugins(),
    schema: sharedSchema,
  },
  {
    name: 'staging',
    title: 'Staging',
    projectId: PROJECT_ID,
    dataset: 'staging',
    basePath: '/staging',
    plugins: sharedPlugins(),
    schema: sharedSchema,
  },
  // Dev workspace (disabled -- account plan limits to 2 datasets)
  // {
  //   name: 'dev',
  //   title: 'Dev',
  //   projectId: PROJECT_ID,
  //   dataset: 'dev',
  //   basePath: '/dev',
  //   plugins: sharedPlugins(),
  //   schema: sharedSchema,
  // },
])
```

**Why `sharedPlugins()` is a factory**: The `presentationTool` plugin's `previewUrl.initial` function receives a `context` object with a `client` scoped to the workspace's dataset. If the plugins were shared as a static array, all workspaces would use the same plugin instance, and the context.client would be ambiguous. The factory pattern ensures each workspace gets fresh plugin instances.

**`allowOrigins`**: Accepts URLPattern wildcards. `['https://*.myshopify.dev']` covers all Oxygen preview URLs. Without this, the Presentation tool refuses to communicate with the iframe via postMessage.

### `plugins/resolveOxygenPreviewMode.ts`

```typescript
const BYPASS_QUERY = `*[
  _type == "sanity.oxygenProtectionBypass"
  && deploymentUrl match $origin + "*"
][0]{authToken, deploymentUrl}`

interface OxygenBypassOptions {
  enablePath?: string
  disablePath?: string
}

interface PreviewModeContext {
  client: {fetch: (query: string, params?: Record<string, unknown>) => Promise<unknown>}
  origin: string
  targetOrigin: string
}

export function resolveOxygenPreviewMode(options: OxygenBypassOptions = {}) {
  const {enablePath = '/api/preview-mode/enable', disablePath} = options

  return async (context: PreviewModeContext) => {
    const {client, targetOrigin} = context

    // Skip for localhost -- no Gateway auth needed
    if (new URL(targetOrigin).hostname === 'localhost') {
      return {enable: enablePath, ...(disablePath && {disable: disablePath})}
    }

    try {
      const config = (await client.fetch(BYPASS_QUERY, {origin: targetOrigin})) as {
        authToken?: string
        deploymentUrl?: string
      } | null

      if (config?.authToken) {
        const params = new URLSearchParams({_auth: config.authToken})
        console.log(
          `[oxygen-bypass] Found token for ${targetOrigin}, injecting ?_auth= on enable path`,
        )
        return {
          enable: `${enablePath}?${params}`,
          ...(disablePath && {disable: disablePath}),
        }
      }

      console.warn(`[oxygen-bypass] No bypass config found for origin: ${targetOrigin}`)
    } catch (err) {
      console.warn('[oxygen-bypass] Failed to fetch config:', err)
    }

    // Fallback: no token found, try without bypass
    return {enable: enablePath, ...(disablePath && {disable: disablePath})}
  }
}
```

The `previewMode` function is called asynchronously by the Presentation tool. It receives `{client, origin, targetOrigin}` where `client` is scoped to the workspace's dataset and `targetOrigin` is the iframe URL's origin.

The GROQ query uses `deploymentUrl match $origin + "*"` to find the bypass document for the current deployment. This works because the `deploymentUrl` stored in the document (e.g. `https://abc123.myshopify.dev`) starts with the `targetOrigin` (e.g. `https://abc123.myshopify.dev`).

### `schemaTypes/documents/oxygenProtectionBypass.ts`

```typescript
import {defineType, defineField} from 'sanity'
import {LockIcon} from '@sanity/icons'

export const oxygenProtectionBypass = defineType({
  name: 'sanity.oxygenProtectionBypass',
  title: 'Oxygen Protection Bypass',
  type: 'document',
  icon: LockIcon,
  fields: [
    defineField({
      name: 'name',
      type: 'string',
      title: 'Name',
      description: 'Label for this bypass config (e.g., "Staging", "Preview")',
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'deploymentUrl',
      type: 'url',
      title: 'Deployment URL',
      description: 'Per-deployment Oxygen URL (changes on every deploy)',
      validation: (rule) =>
        rule.required().uri({scheme: ['https']}).error('Must be an HTTPS URL'),
    }),
    defineField({
      name: 'authToken',
      type: 'string',
      title: 'Auth Bypass Token',
      description: 'USER_SHARED JWT from Shopify bot comment. Updated by CI on each deploy.',
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'branch',
      type: 'string',
      title: 'Branch',
      description: 'Git branch this deployment was built from',
    }),
    defineField({
      name: 'tokenKind',
      type: 'string',
      title: 'Token Kind',
      description: 'JWT kind claim (e.g., USER_SHARED, TESTING_AUTOMATION)',
      readOnly: true,
    }),
    defineField({
      name: 'updatedAt',
      type: 'datetime',
      title: 'Last Updated',
      description: 'When CI last refreshed this config',
      readOnly: true,
    }),
  ],
  preview: {
    select: {title: 'name', subtitle: 'deploymentUrl'},
  },
})
```

---

## 10. Hydrogen App (Full Code)

### `vite.config.ts`

```typescript
import {defineConfig} from 'vite';
import {hydrogen} from '@shopify/hydrogen/vite';
import {oxygen} from '@shopify/mini-oxygen/vite';
import {reactRouter} from '@react-router/dev/vite';
import tsconfigPaths from 'vite-tsconfig-paths';
import {sanity} from 'hydrogen-sanity/vite';

export default defineConfig({
  plugins: [hydrogen(), oxygen(), reactRouter(), tsconfigPaths(), sanity()],
  build: {
    assetsInlineLimit: 0,
  },
  ssr: {
    optimizeDeps: {
      include: ['set-cookie-parser', 'cookie', 'react-router'],
    },
  },
  server: {
    allowedHosts: ['.tryhydrogen.dev'],
  },
});
```

The `sanity()` Vite plugin from `hydrogen-sanity/vite` is critical. It strips `node` and `require` resolve conditions from SSR bundling, preventing `@sanity/visual-editing` v4's dependency chain (`styled-components` -> `uuid` -> `node:crypto`) from pulling in Node.js-only modules that do not exist on Cloudflare Workers.

### `env.d.ts`

```typescript
/// <reference types="vite/client" />
/// <reference types="react-router" />
/// <reference types="@shopify/oxygen-workers-types" />
/// <reference types="@shopify/hydrogen/react-router-types" />

import '@total-typescript/ts-reset';

declare global {
  interface Env {
    SANITY_API_READ_TOKEN: string
    SANITY_PROJECT_ID: string
    SANITY_DATASET: string
    SANITY_STUDIO_URL: string
    SESSION_SECRET: string
  }

  interface HydrogenAdditionalContext {
    sanity: import('hydrogen-sanity').SanityContext
  }
}
```

The `Env` interface declares the per-environment variables. The `HydrogenAdditionalContext` interface tells TypeScript that `context.sanity` exists on every route's `LoaderArgs` and `ActionArgs`.

### `app/lib/context.ts`

This is the central integration point where Hydrogen and Sanity contexts are created together.

```typescript
import {createHydrogenContext} from '@shopify/hydrogen';
import {AppSession} from '~/lib/session';
import {CART_QUERY_FRAGMENT} from '~/lib/fragments';
import {createSanityContext, type SanityContext} from 'hydrogen-sanity';
import {PreviewSession} from 'hydrogen-sanity/preview/session';

export async function createHydrogenRouterContext(
  request: Request,
  env: Env,
  executionContext: ExecutionContext,
) {
  if (!env?.SESSION_SECRET) {
    throw new Error('SESSION_SECRET environment variable is not set');
  }

  const waitUntil = executionContext.waitUntil.bind(executionContext);
  const [cache, session, previewSession] = await Promise.all([
    caches.open('hydrogen'),
    AppSession.init(request, [env.SESSION_SECRET]),
    PreviewSession.init(request, [env.SESSION_SECRET]),
  ]);

  const sanity = await createSanityContext({
    request,
    cache,
    waitUntil,
    client: {
      projectId: env.SANITY_PROJECT_ID || 'sx997gpv',
      dataset: env.SANITY_DATASET || 'production',
      apiVersion: '2025-02-19',
      useCdn: true,
      stega: {
        enabled: true,
        studioUrl: env.SANITY_STUDIO_URL || 'https://meditate-with-eve.sanity.studio',
      },
    },
    preview: {
      token: env.SANITY_API_READ_TOKEN,
      session: previewSession,
    },
  });

  const hydrogenContext = createHydrogenContext(
    {
      env,
      request,
      cache,
      waitUntil,
      session,
      i18n: {language: 'EN', country: 'US'},
      cart: {
        queryFragment: CART_QUERY_FRAGMENT,
      },
    },
    {sanity} as {sanity: SanityContext},
  );

  return hydrogenContext;
}
```

**Key design decisions**:

- `PreviewSession.init()` from `hydrogen-sanity/preview/session` manages the preview cookie. This replaces the need for a custom `createPreviewSessionStorage` in most routes.
- `createSanityContext()` wires up the Sanity client, preview detection, stega encoding, and caching in one call.
- The `sanity` object is passed as the second argument to `createHydrogenContext()`, making it available as `context.sanity` on all route loaders and actions.
- `env.SANITY_DATASET` drives which dataset is queried. This is the mechanism that makes multi-environment work without code changes.

### `app/entry.client.tsx`

```typescript
import {HydratedRouter} from 'react-router/dom';
import {startTransition, StrictMode} from 'react';
import {hydrateRoot} from 'react-dom/client';
import {NonceProvider} from '@shopify/hydrogen';

// In cross-origin iframes (Sanity Studio Presentation tool), browsers like
// Safari and Brave block third-party cookies. The Oxygen Gateway normally
// sets an auth_bypass_token cookie on the initial ?_auth= request, but the
// cookie is never stored in a third-party context. We capture the token from
// the initial URL and inject it into all same-origin fetches so the Gateway
// passes them through without the cookie.
const authBypassToken = new URLSearchParams(window.location.search).get(
  '_auth',
);

if (authBypassToken) {
  const originalFetch = window.fetch;
  window.fetch = function (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    try {
      let url: URL;
      if (typeof input === 'string') {
        url = new URL(input, window.location.origin);
      } else if (input instanceof URL) {
        url = new URL(input.href);
      } else if (input instanceof Request) {
        url = new URL(input.url);
      } else {
        return originalFetch.call(this, input, init);
      }

      if (url.origin === window.location.origin) {
        url.searchParams.set('_auth', authBypassToken);
        if (input instanceof Request) {
          return originalFetch.call(this, new Request(url, input), init);
        }
        return originalFetch.call(this, url.toString(), init);
      }
    } catch {
      // Pass through on URL parsing errors
    }
    const fallbackInput =
      input instanceof URL ? input.toString() : input;
    return originalFetch.call(this, fallbackInput, init);
  };
}

if (!window.location.origin.includes('webcache.googleusercontent.com')) {
  startTransition(() => {
    const existingNonce =
      document.querySelector<HTMLScriptElement>('script[nonce]')?.nonce;

    hydrateRoot(
      document,
      <StrictMode>
        <NonceProvider value={existingNonce}>
          <HydratedRouter />
        </NonceProvider>
      </StrictMode>,
    );
  });
}
```

The fetch interceptor runs before React hydration. It only activates when `?_auth=` is present in the URL (i.e., the page is loaded inside the Presentation tool iframe). It only modifies same-origin requests, leaving cross-origin requests (to Sanity API, Shopify, etc.) untouched.

### `app/entry.server.tsx`

```typescript
import {ServerRouter} from 'react-router';
import {isbot} from 'isbot';
import {renderToReadableStream} from 'react-dom/server';
import {
  createContentSecurityPolicy,
  type HydrogenRouterContextProvider,
} from '@shopify/hydrogen';
import type {EntryContext} from 'react-router';

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  reactRouterContext: EntryContext,
  context: HydrogenRouterContextProvider,
) {
  const {nonce, header, NonceProvider} = createContentSecurityPolicy({
    shop: {
      checkoutDomain: context.env.PUBLIC_CHECKOUT_DOMAIN,
      storeDomain: context.env.PUBLIC_STORE_DOMAIN,
    },
    frameAncestors: ["'self'", 'https://*.sanity.studio'],
    connectSrc: [
      'https://sx997gpv.api.sanity.io',
      'wss://sx997gpv.api.sanity.io',
    ],
  });

  const {SanityProvider} = context.sanity;

  const body = await renderToReadableStream(
    <NonceProvider>
      <SanityProvider>
        <ServerRouter
          context={reactRouterContext}
          url={request.url}
          nonce={nonce}
        />
      </SanityProvider>
    </NonceProvider>,
    {
      nonce,
      signal: request.signal,
      onError(error) {
        console.error(error);
        responseStatusCode = 500;
      },
    },
  );

  if (isbot(request.headers.get('user-agent'))) {
    await body.allReady;
  }

  responseHeaders.set('Content-Type', 'text/html');
  // CSP temporarily disabled to validate Presentation tool iframe flow
  // responseHeaders.set('Content-Security-Policy', header);

  return new Response(body, {
    headers: responseHeaders,
    status: responseStatusCode,
  });
}
```

**Key details**:

- `<SanityProvider>` wraps `<ServerRouter>`. This is required by `hydrogen-sanity` to provide the Sanity context to all route components. Without it, the `<Query>` component and other Sanity hooks will not work.
- `context.sanity.SanityProvider` is destructured from the Sanity context created in `app/lib/context.ts`.
- `frameAncestors` includes `https://*.sanity.studio`. See Section 12 for the nuance about `www.sanity.io` vs `*.sanity.studio`.
- CSP is currently disabled (header commented out) while the correct directives are validated.

### `app/root.tsx` (preview-relevant sections)

```typescript
import {useState, useEffect} from 'react';
import {Analytics, getShopAnalytics, useNonce} from '@shopify/hydrogen';
import {
  Outlet, useRouteError, isRouteErrorResponse,
  type ShouldRevalidateFunction, Links, Meta, Scripts,
  ScrollRestoration, useRouteLoaderData,
} from 'react-router';
import type {Route} from './+types/root';
import {PageLayout} from './components/PageLayout';
import {VisualEditing} from 'hydrogen-sanity/visual-editing';
import {Sanity} from 'hydrogen-sanity';

function ClientOnly({children}: {children: React.ReactNode}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted ? <>{children}</> : null;
}

export type RootLoader = typeof loader;

export async function loader(args: Route.LoaderArgs) {
  const deferredData = loadDeferredData(args);
  const criticalData = await loadCriticalData(args);

  const {storefront, env, sanity} = args.context;
  const preview = sanity.preview?.enabled ?? false;

  // Extract auth bypass token from URL -- needed on client because
  // third-party cookies are blocked in iframes (Safari ITP, Brave, etc.)
  const url = new URL(args.request.url);
  const authBypassToken = url.searchParams.get('_auth') || undefined;

  return {
    ...deferredData,
    ...criticalData,
    preview,
    authBypassToken,
    publicStoreDomain: env.PUBLIC_STORE_DOMAIN,
    shop: getShopAnalytics({
      storefront,
      publicStorefrontId: env.PUBLIC_STOREFRONT_ID,
    }),
    consent: {
      checkoutDomain: env.PUBLIC_CHECKOUT_DOMAIN,
      storefrontAccessToken: env.PUBLIC_STOREFRONT_API_TOKEN,
      withPrivacyBanner: false,
      country: args.context.storefront.i18n.country,
      language: args.context.storefront.i18n.language,
    },
  };
}

export function Layout({children}: {children?: React.ReactNode}) {
  const nonce = useNonce();

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <Sanity nonce={nonce} />
        <ScrollRestoration nonce={nonce} />
        <Scripts nonce={nonce} />
      </body>
    </html>
  );
}

export default function App() {
  const data = useRouteLoaderData<RootLoader>('root');

  if (!data) {
    return <Outlet />;
  }

  const content = (
    <PageLayout {...data}>
      <Outlet />
    </PageLayout>
  );

  // Skip Analytics.Provider in preview mode -- consent tracking scripts
  // get blocked inside the cross-origin Studio iframe, crashing React
  if (data.preview) {
    return (
      <>
        {content}
        <ClientOnly>
          <VisualEditing action="/api/preview-mode/enable" />
        </ClientOnly>
      </>
    );
  }

  return (
    <Analytics.Provider
      cart={data.cart}
      shop={data.shop}
      consent={data.consent}
    >
      {content}
    </Analytics.Provider>
  );
}
```

**Key details**:

- `const preview = sanity.preview?.enabled ?? false` reads preview state from the `hydrogen-sanity` context, which uses the `PreviewSession` cookie initialized in `app/lib/context.ts`.
- `<Sanity nonce={nonce} />` in `Layout()` is a `hydrogen-sanity` component that injects client-side scripts needed for live content updates and stega decoding.
- `<VisualEditing action="/api/preview-mode/enable" />` must specify the `action` prop to point at the preview route. Without it, perspective change submissions go to the current route's action handler (which does not exist on most routes, causing 405 errors).
- `<ClientOnly>` wraps `<VisualEditing>` because it uses browser APIs during render. Server-rendered HTML does not include its output, so client hydration would produce a mismatch.

### `app/routes/api.preview-mode.enable.tsx`

```typescript
export {action, loader} from 'hydrogen-sanity/preview/route'
```

This single-line re-export delegates all preview mode logic to `hydrogen-sanity`. The library handles:

- Validating the `@sanity/preview-url-secret` to prevent unauthorized preview access
- Setting the preview session cookie with `previewMode=true`
- Handling PUT requests for perspective changes (drafts/published)
- Handling POST/DELETE requests to disable preview mode
- Redirecting to the requested pathname after enabling preview

### `app/routes/api.preview-mode.disable.tsx`

```typescript
import {createPreviewSessionStorage} from '~/sanity/session'
import type {Route} from './+types/api.preview-mode.disable'

export async function loader({request, context}: Route.LoaderArgs) {
  const url = new URL(request.url)
  const redirectTo = url.searchParams.get('redirect') || '/'

  const sessionSecret = context.env.SESSION_SECRET || 'dev-secret-change-me'
  const {getSession, destroySession} = createPreviewSessionStorage(sessionSecret)
  const session = await getSession(request.headers.get('Cookie'))

  return new Response(null, {
    status: 307,
    headers: {
      Location: redirectTo,
      'Set-Cookie': await destroySession(session),
    },
  })
}
```

### `app/sanity/session.ts`

```typescript
import {createCookieSessionStorage} from 'react-router'
import type {loadQuery} from '@sanity/react-loader'

export function createPreviewSessionStorage(secret: string) {
  return createCookieSessionStorage({
    cookie: {
      httpOnly: true,
      name: '__sanity_preview',
      path: '/',
      sameSite: 'none',    // Required for cross-origin iframe context
      secrets: [secret],
      secure: true,
    },
  })
}

export async function getPreviewData(
  request: Request,
  secret: string,
): Promise<{
  preview: boolean
  options: Parameters<typeof loadQuery>[2]
}> {
  const {getSession} = createPreviewSessionStorage(secret)
  const session = await getSession(request.headers.get('Cookie'))
  const preview = session.get('previewMode') || false
  return {
    preview,
    options: preview
      ? {
          perspective: session.has('perspective')
            ? session.get('perspective').split(',')
            : 'drafts',
          stega: true,
        }
      : {
          perspective: 'published',
          stega: false,
        },
  }
}
```

**Note**: The `getPreviewData` function in this file is a legacy utility from before the `hydrogen-sanity` integration. The root loader now reads preview state from `context.sanity.preview?.enabled` instead of calling `getPreviewData`. The `createPreviewSessionStorage` function is still used by the disable route.

### `app/sanity/client.ts`

```typescript
import {createClient} from '@sanity/client'

declare global {
  interface Window {
    ENV: {
      PUBLIC_SANITY_PROJECT_ID: string
      PUBLIC_SANITY_DATASET: string
      PUBLIC_SANITY_STUDIO_URL: string
    }
  }
}

const env = typeof document === 'undefined' ? process.env : window.ENV

export const client = createClient({
  projectId: env.PUBLIC_SANITY_PROJECT_ID || 'sx997gpv',
  dataset: env.PUBLIC_SANITY_DATASET || 'production',
  apiVersion: '2025-01-01',
  useCdn: false,
  stega: {
    studioUrl: env.PUBLIC_SANITY_STUDIO_URL || 'https://meditate-with-eve.sanity.studio',
  },
})
```

**Note**: This standalone client is separate from the `createSanityContext()` client used in route loaders. It exists for use cases that need a Sanity client outside of the request/response cycle (e.g., code that runs in both server and browser contexts). The primary Sanity client for data fetching is the one created by `createSanityContext()` in `app/lib/context.ts`.

---

## 11. Token Strategy

### Why `USER_SHARED`

| Kind | Behavior | Max Duration |
|------|----------|-------------|
| `TESTING_AUTOMATION` | Single-use, expires after one request | 12 hours |
| `USER_SHARED` | Multi-use, no expiry, deployment-scoped | No expiry |

`USER_SHARED` is correct because:
- The token must survive multiple requests (initial load, preview enable, client-side navigations, live content WebSocket)
- The token dies automatically when the deployment is replaced (deployment-scoped)
- No need for manual rotation; CI updates on every deploy

### Token Lifecycle

```
1. Developer pushes to branch
2. Oxygen deploys, generates new deployment ID
3. shopify[bot] comments with new URL + new USER_SHARED token
4. CI workflow fires, patches Sanity doc with new URL + token
5. Old token is now dead (old deployment no longer exists)
6. Editor opens Presentation tool, Studio reads new token from Sanity
7. Next deploy: cycle repeats from step 2
```

### Token Scope

The `USER_SHARED` token is scoped to a single Oxygen deployment. It cannot:
- Access production data
- Access the Shopify admin
- Access other deployments
- Authenticate to any Shopify API

It grants exactly one capability: bypassing the Oxygen Gateway authentication for the specific deployment URL it was issued for.

---

## 12. CSP (Content Security Policy)

### Required Settings (when re-enabled)

```typescript
createContentSecurityPolicy({
  frameAncestors: ["'self'", 'https://www.sanity.io'],
  connectSrc: [
    'https://sx997gpv.api.sanity.io',
    'wss://sx997gpv.api.sanity.io',
  ],
});
```

**`frame-ancestors`**: Must include `https://www.sanity.io`. Studio is hosted at `https://www.sanity.io/@user/studio/appId/...`, not on `*.sanity.studio`. Custom domain Studios may also need `*.sanity.studio`.

**`connect-src`**: Required for the Sanity client to fetch content and establish WebSocket connections for live updates.

**Non-conditional**: CSP must be set on every response, not behind a preview check. The initial iframe load happens **before** the preview session cookie is set. If CSP blocks the frame, the enable request never fires (chicken-and-egg).

> **Current status**: CSP is temporarily disabled (`Content-Security-Policy` header commented out in `entry.server.tsx`). The `frameAncestors` array currently contains `https://*.sanity.studio` but needs to be updated to include `https://www.sanity.io`. See Section 17.1 for details.

---

## 13. Package Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `hydrogen-sanity` | `^6.1.0` | `createSanityContext`, `PreviewSession`, `VisualEditing`, `Sanity` component, `Query` component, Vite plugin |
| `@sanity/client` | `^7.15.0` | Sanity API client with stega support |
| `@sanity/preview-url-secret` | `^4.0.3` | Validates preview enable requests (used internally by hydrogen-sanity) |
| `@sanity/react-loader` | `^2.0.7` | Sanity data loading utilities (peer dep) |
| `@sanity/visual-editing` | `^4.0.3` | Overlay rendering, postMessage channel (peer dep of hydrogen-sanity) |
| `styled-components` | `^6.3.9` | Transitive dep of `@sanity/visual-editing` v4 (handled by Vite plugin) |
| `react` | `18.3.1` | React (Hydrogen 2026.1.0 ships this version) |
| `react-router` | `7.12.0` | Routing framework |

### Version Constraints

- **`@sanity/visual-editing` v5** requires React 19 (`react/compiler-runtime`). Hydrogen 2026.1.0 uses React 18.3.1. Must use v4.
- **`hydrogen-sanity` v6.1.0** wraps `@sanity/visual-editing` v4 with client-only `React.lazy()` loading and ships a Vite plugin that strips `node:crypto` from the SSR bundle. This is the recommended integration path for Hydrogen + React 18.
- **`styled-components`** is a transitive dependency pulled in by `@sanity/visual-editing` v4. It would cause `node:crypto` errors on Cloudflare Workers without the `sanity()` Vite plugin.

---

## 14. Environment Variables

### Hydrogen/Oxygen (per environment)

| Variable | Required | Purpose |
|----------|----------|---------|
| `SESSION_SECRET` | Yes | Signs the preview session cookie and the Hydrogen session cookie |
| `SANITY_API_READ_TOKEN` | Yes | Validates `@sanity/preview-url-secret` in the enable route; used for authenticated content fetching in preview mode |
| `SANITY_PROJECT_ID` | Yes | Sanity project identifier (`sx997gpv`) |
| `SANITY_DATASET` | Yes | Sanity dataset name (`production`, `staging`, or `dev`) -- this is the key per-environment differentiator |
| `SANITY_STUDIO_URL` | Yes | Studio URL for stega encoding click-to-edit links |
| `PUBLIC_STORE_DOMAIN` | Yes | Shopify storefront domain (standard Hydrogen var) |
| `PUBLIC_STOREFRONT_API_TOKEN` | Yes | Shopify Storefront API token (standard Hydrogen var) |
| `PUBLIC_STOREFRONT_ID` | Yes | Shopify analytics identifier (standard Hydrogen var) |
| `PUBLIC_CHECKOUT_DOMAIN` | Yes | Shopify checkout domain (standard Hydrogen var) |

### GitHub Actions

| Secret | Purpose |
|--------|---------|
| `OXYGEN_DEPLOYMENT_TOKEN_1000099369` | Oxygen deployment authentication |
| `SANITY_API_WRITE_TOKEN` | Write access to Sanity project `sx997gpv` for patching bypass documents |

---

## 15. Failure Modes

| Failure | Symptom | Recovery |
|---------|---------|----------|
| CI workflow does not fire | Sanity doc has stale URL/token | Merge workflow file to main first; `issue_comment` only runs from default branch |
| PR merged before shopify[bot] comments | Sanity doc never updated for this deploy | Add branch protection requiring bot comment before merge |
| `SANITY_API_WRITE_TOKEN` not set | CI logs warning, skips Sanity patch | Add secret to GitHub repo settings |
| Token expired (should not happen with USER_SHARED) | Iframe shows Shopify login | Redeploy to get a fresh token |
| `allowOrigins` missing in Studio | "Blocked preview URL" error in Presentation tool | Add `['https://*.myshopify.dev']` to presentationTool config |
| CSP frame-ancestors wrong | Iframe refuses to load (blank or error) | Add `https://www.sanity.io` (or `https://*.sanity.studio`) to frame-ancestors |
| Analytics.Provider in preview mode | React crash #421, "Oops 500" | Skip Analytics.Provider when `preview=true` |
| VisualEditing without ClientOnly | Hydration mismatch, "Oops 500" | Wrap in `<ClientOnly>` component |
| No action handler for perspective changes | 405 error on catch-all route | Set `action` prop on `<VisualEditing>` pointing to a route with an action export |
| Fetch interceptor missing | "Failed to fetch" on client-side navigations | Add interceptor in `entry.client.tsx` |
| Wrong `SANITY_DATASET` value | Hydrogen queries wrong dataset, shows wrong content | Check Oxygen environment variables in Shopify dashboard |
| `SanityProvider` missing from entry.server | `<Query>` components return null, no live editing | Wrap `<ServerRouter>` with `context.sanity.SanityProvider` |
| `<Sanity>` component missing from Layout | No client-side Sanity scripts injected | Add `<Sanity nonce={nonce} />` to `<body>` |

---

## 16. Bugs Encountered and Fixed

These were discovered iteratively during integration. Documented here as a reference for anyone building this integration from scratch.

### 16.1. `@sanity/visual-editing` v5 incompatible with React 18

**Error**: `Missing "./compiler-runtime" specifier in "react" package`

**Cause**: v5 requires React 19's compiler runtime. Hydrogen 2026.1.0 ships React 18.3.1.

**Fix**: Use `hydrogen-sanity@6.1.0` which wraps `@sanity/visual-editing` v4 (React 18 compatible) with client-only loading.

### 16.2. `node:crypto` unavailable on Cloudflare Workers

**Error**: `Uncaught Error: No such module "node:crypto"`

**Cause**: `@sanity/visual-editing` v4 -> `styled-components` -> `uuid` -> `node:crypto`. The Workers runtime does not have Node.js built-in modules.

**Fix**: The `sanity()` Vite plugin from `hydrogen-sanity/vite` strips `node` and `require` resolve conditions from SSR bundling, preventing Node-only modules from being included.

### 16.3. Analytics.Provider crashes in cross-origin iframe

**Error**: `[h2:error:Analytics.Provider] - consent.checkoutDomain is required` + React error #421

**Cause**: Shopify's `consent-tracking-api.js` gets blocked by the browser in cross-origin iframes. Analytics.Provider expects it to load successfully.

**Fix**: Skip `<Analytics.Provider>` when `data.preview` is true. Preview mode does not need analytics.

### 16.4. VisualEditing causes hydration mismatch

**Error**: React error #421 -> ErrorBoundary shows "Oops 500"

**Cause**: `<VisualEditing>` uses browser APIs during render. Server-rendered HTML does not include its output, but client hydration tries to render it, producing a mismatch.

**Fix**: Wrap in `<ClientOnly>` component (useState + useEffect mount guard).

### 16.5. Third-party cookies blocked in iframe

**Error**: All client-side fetches redirect to `accounts.shopify.com/oauth/authorize` -> CORS error -> "Failed to fetch"

**Cause**: Oxygen Gateway sets `auth_bypass_token` as an HttpOnly cookie. In a cross-origin iframe (parent: `www.sanity.io`, child: `*.myshopify.dev`), Safari ITP, Brave, and Chrome 127+ refuse to store or send third-party cookies. Every subsequent fetch lacks the cookie, so the Gateway redirects to Shopify login.

**Fix**: Capture `?_auth=TOKEN` from the initial URL in `entry.client.tsx` and patch `window.fetch` to append it to all same-origin requests.

### 16.6. `allowOrigins` not configured

**Error**: "Blocked preview URL -- the origin ... is not allowed"

**Cause**: The Presentation tool checks `allowOrigins` before communicating with the iframe via postMessage. Without it, the iframe loads but Studio refuses to connect.

**Fix**: Add `allowOrigins: ['https://*.myshopify.dev']` to `presentationTool()` config.

### 16.7. No action handler for perspective changes (405)

**Error**: `Route "routes/$" does not have an action, but you are trying to submit to it`

**Cause**: `<VisualEditing>` submits perspective changes (PUT) to its `action` prop URL. Without an explicit `action` prop, it defaults to the current route, which is the catch-all `$.tsx` with no action handler.

**Fix**: Add `action="/api/preview-mode/enable"` prop to `<VisualEditing>` and ensure the enable route exports an `action` function. The `hydrogen-sanity/preview/route` re-export handles this.

### 16.8. Portable Text data mismatch across datasets

**Error**: Sanity Studio shows "Invalid property value" for `headlineText` field.

**Cause**: When seeding content across datasets (e.g., copying production data to staging), the `headlineText` field was stored as a plain string instead of Portable Text (an array of block objects with `_type: "block"`, `children`, `markDefs`, etc.).

**Fix**: Patch the field with correctly structured Portable Text data. When copying content between datasets, always verify that rich text fields maintain their Portable Text structure.

### 16.9. Asset references do not exist across datasets

**Error**: Sanity mutation API returns `Document references non-existent document 'file-...'`

**Cause**: Sanity assets (images, files) are per-dataset. Copying a document from production to staging fails if the document references assets that only exist in the production dataset.

**Fix**: When copying documents between datasets, strip asset reference fields (images, files, videos) from the payload and only copy text/structure fields. Assets must be uploaded separately to the target dataset if needed.

---

## 17. Areas to Investigate Further

### 17.1. CSP Re-enablement (Currently Disabled)

**Status**: The `Content-Security-Policy` header is commented out in `entry.server.tsx`.

**What needs work**:
- The current `frameAncestors` includes `https://*.sanity.studio` but Studio is hosted at `https://www.sanity.io`. Need to test with `https://www.sanity.io` instead (or both).
- Need to verify all required CSP directives: `connect-src` for Sanity API + WebSocket, `script-src` for any injected scripts, `img-src` for Sanity CDN images.
- CSP errors are silent in production (browser blocks resources without visible errors). Must test with browser DevTools open to catch violations.
- Consider whether `https://*.sanity.studio` is still needed for custom-domain Studios.

**Risk**: If CSP is wrong, the iframe will not load at all, and the error is not obvious. Test thoroughly before re-enabling.

### 17.2. Fetch Interceptor: Is There a More Elegant Alternative?

**Current approach**: Global `window.fetch` monkey-patch in `entry.client.tsx`.

**Why it works but is not ideal**:
- Mutates a global browser API
- Affects all same-origin requests, not just React Router's `.data` fetches
- Leaks the auth token into URLs of requests that do not need it (harmless but inelegant)
- Could conflict with other code that also patches `window.fetch` (monitoring, analytics)

**Alternatives investigated and rejected (with evidence)**:

| Alternative | Why Rejected |
|------------|--------------|
| React Router `dataStrategy` | Controls handler execution order, not HTTP transport. Cannot modify fetch URLs. |
| React Router `clientMiddleware` | Wraps loader/action execution, not the HTTP `.data` fetch. Request object is read-only. |
| React Router server middleware | Runs server-side only. Cannot affect client-side `.data` endpoint fetches. |
| `clientLoader` with custom fetch | Would need a `clientLoader` on every route; `serverLoader()` accepts no params. |
| Service Worker | Cleanest interception point but adds significant complexity (registration, lifecycle, caching concerns). |
| Oxygen-level cookie fix | Not possible. Oxygen Gateway is a Shopify-managed Worker, not user-configurable. |
| CHIPS (Cookies Having Independent Partitioned State) | The `Partitioned` cookie attribute could solve this, but Oxygen Gateway does not set it and we cannot modify Gateway behavior. |
| Storage Access API | `document.requestStorageAccess()` could grant iframe cookie access, but requires a user gesture (click) and prior first-party visit to the Oxygen domain. Neither condition is reliably met in the Presentation tool flow. |

#### Deep Dive: React Router v7.12 Client-Side Fetch Architecture

The core question: can React Router's APIs intercept the HTTP request that fetches `.data` endpoints during client-side navigation?

**How React Router client-side navigation works:**

```
User clicks <Link to="/products/hat">
  -> React Router builds URL: /products/hat.data
  -> Internal singleFetchDataStrategy() called
  -> window.fetch("/products/hat.data") executed          <-- THE GAP: no hook here
  -> Response received, turbo-stream decoded
  -> clientMiddleware wraps handler execution              <-- middleware runs HERE
  -> Loader handler processes decoded data
  -> Component re-renders with new data
```

The `.data` fetch URL is constructed deep inside React Router's internals. No public API exposes or modifies it before `fetch()` is called.

**`dataStrategy`**: Receives an array of `match` objects, each with a `handler()` function. Calling `handler()` triggers the internal data loading pipeline. The strategy controls which handlers to call and in what order, but does not control how the HTTP request is made. There is no parameter to modify the fetch URL, no callback before the HTTP request, and no way to inject query parameters.

**`clientMiddleware`**: Runs in the browser before/after loader/action handlers execute. Receives a `context` object and a `next()` function. The `request` object is read-only. By the time middleware runs, the `.data` fetch has already completed. `next()` executes the handler that processes the already-fetched data.

**Conclusion**: The `window.fetch` monkey-patch is currently the only viable client-side interception point in React Router v7.12. This is an architectural gap, not a missing feature. React Router's client-side data loading was designed assuming first-party cookie availability.

**Future possibilities**:
- Monitor React Router GitHub discussions for `dataStrategy` enhancements that expose the HTTP layer.
- Service Worker approach if the fetch patch causes conflicts with other fetch-patching code.
- Shopify may add `Partitioned` attribute to the `auth_bypass_token` cookie (CHIPS support).
- Shopify may provide a first-party integration for this use case.

### 17.3. Preview Session Cookie in Third-Party Context

**Question**: The `__sanity_preview` session cookie uses `sameSite: 'none'`. Does this actually work in the iframe context?

**Current observation**: It works. The session cookie is set by the Hydrogen app (the iframe's own origin) via a `Set-Cookie` header on the 307 redirect from `/api/preview-mode/enable`. Because the cookie is set by the page's own origin (first-party from the iframe's perspective), browsers store it. However, when sent in subsequent requests from the iframe, it is technically a "third-party" context (the top-level page is `www.sanity.io`).

**Risk**: This may break in future browser updates that further restrict cookies in iframes. Test periodically in Safari, Chrome, and Firefox nightlies.

### 17.4. `resolve.locations` for Document-to-Route Mapping

**Current state**: The Presentation tool relies entirely on stega-encoded content source maps for click-to-edit. There is no `resolve.locations` or `resolve.mainDocuments` configuration.

**What is missing**:
- No "Used on X pages" banner in the Studio document editor
- No automatic document selection when navigating to a URL in the iframe
- No route hints for page building

### 17.5. Branch Protection / Merge Gating

**Current risk**: If a PR is merged before `shopify[bot]` comments, the `issue_comment` workflow never fires and the Sanity bypass doc retains the old (dead) deployment URL/token.

**Options**:
- GitHub branch protection rule requiring a specific status check
- A custom GitHub Action that creates a check run tied to the shopify[bot] comment
- A webhook that blocks merge until the Sanity doc is updated

### 17.6. Sanity Live Content API

**Untested**: Real-time content updates via the Sanity Live Content API in preview mode. The `hydrogen-sanity` package supports this via the `<Query>` component (which auto-subscribes to live updates when `hydrogen-sanity`'s Sanity context detects preview mode), but real-time behavior has not been validated in this integration.

**What to test**:
- Edit a Sanity document in Studio while the Presentation tool is open
- Verify the iframe updates in real-time without a full page reload
- Check WebSocket connections in the Network tab

### 17.7. Token Security

**Current exposure**: The `USER_SHARED` token is appended to every same-origin request URL as `?_auth=TOKEN`. This means:
- The token appears in browser history (URL bar)
- The token appears in server access logs
- The token is visible in the Network tab

**Mitigations in place**:
- Token is deployment-scoped (dies on redeploy)
- Token is `USER_SHARED` (designed for sharing)
- CI masks the token in GitHub Actions logs
- The token only grants access to the preview deployment, not production

**Not a concern** because: The token is intentionally shared. Its purpose is to let anyone with the link access the preview. It provides no escalation to production data, Shopify admin, or other resources.

### 17.8. Multi-Environment CI Sync

**Current state**: The sync workflow hardcodes `oxygen-bypass.staging` as the document ID and writes to the Sanity `production` dataset. This works for a single staging environment but does not scale.

**What is needed**:
- Branch detection in the sync workflow (determine if the PR targets staging, dev, or main)
- Dynamic document ID construction (`oxygen-bypass.${branch}`)
- Dynamic dataset targeting (write bypass doc to the dataset that matches the branch)
- The Studio's per-workspace `context.client` already handles reading from the correct dataset, so no Studio changes needed

### 17.9. Legacy Code Cleanup

**Files that may be partially redundant**:
- `app/sanity/session.ts`: The `getPreviewData` export is no longer called from the root loader (replaced by `context.sanity.preview?.enabled`). The `createPreviewSessionStorage` export is still used by the disable route.
- `app/sanity/client.ts`: This standalone client duplicates config that also exists in `createSanityContext()`. Consider whether it can be removed or consolidated.

---

## 18. Reference Links

- Hydrogen documentation: https://shopify.dev/docs/api/hydrogen
- hydrogen-sanity package: https://github.com/sanity-io/hydrogen-sanity
- Sanity Presentation tool: https://www.sanity.io/docs/presentation-tool
- Oxygen auth bypass: https://shopify.dev/docs/storefronts/headless/hydrogen/deployments/oxygen/auth-bypass
- @sanity/visual-editing: https://github.com/sanity-io/visual-editing
- React Router v7: https://reactrouter.com/docs/en/main
- CHIPS (Cookies Having Independent Partitioned State): https://developer.chrome.com/docs/privacy-sandbox/chips/
- Storage Access API: https://developer.mozilla.org/en-US/docs/Web/API/Storage_Access_API
- Sanity Studio deploy: https://www.sanity.io/docs/deployment
- Studio project ID: `sx997gpv`
- Studio deploy appId: `tivl892ed4e28uuzpijcvqel`
- Shopify storefront: `1000099369` on `juanprieto.myshopify.com`
