# Sanity Presentation Tool + Oxygen Auth Bypass: End-to-End Architecture

> Validated and working as of February 18, 2026.
> Hydrogen 2026.1.0 | React Router 7.12 | React 18.3.1 | hydrogen-sanity 6.1.0

---

## Table of Contents

1. [The Problem](#1-the-problem)
2. [The Solution (Summary)](#2-the-solution-summary)
3. [Architecture Diagram](#3-architecture-diagram)
4. [Component Inventory](#4-component-inventory)
5. [Detailed Flow](#5-detailed-flow-what-happens-when-an-editor-opens-the-presentation-tool)
6. [CI Workflow (Full Code)](#6-ci-workflow-full-code)
7. [Studio Configuration (Full Code)](#7-studio-configuration-full-code)
8. [Hydrogen App (Full Code)](#8-hydrogen-app-full-code)
9. [Token Strategy](#9-token-strategy)
10. [CSP Configuration](#10-csp-content-security-policy)
11. [Package Dependencies](#11-package-dependencies)
12. [Environment Variables](#12-environment-variables)
13. [Failure Modes](#13-failure-modes)
14. [Bugs Encountered and Fixed](#14-bugs-encountered-and-fixed)
15. [Areas to Investigate Further](#15-areas-to-investigate-further)

---

## 1. The Problem

Shopify Oxygen protects preview deployments behind Shopify login. Sanity Studio's Presentation tool loads the storefront in a cross-origin iframe. Two things break:

1. **Oxygen Gateway blocks unauthenticated requests** — the iframe can't load the storefront without a valid auth bypass token.
2. **Third-party cookies are blocked** — Safari (ITP), Brave, and Chrome (127+) refuse to store the `auth_bypass_token` cookie set by the Oxygen Gateway because the iframe origin (`*.myshopify.dev`) differs from the parent origin (`www.sanity.io`). Every subsequent client-side fetch redirects to `accounts.shopify.com/oauth/authorize` and fails with a CORS error.

## 2. The Solution (Summary)

A fully automated pipeline that:

1. **CI extracts** the deployment URL and `USER_SHARED` auth bypass token from `shopify[bot]`'s PR comment
2. **CI writes** both values into a Sanity document
3. **Studio reads** the Sanity document at runtime and constructs the iframe URL with `?_auth=TOKEN`
4. **Hydrogen** enables preview mode via a session cookie and renders `<VisualEditing>`
5. **A fetch interceptor** in `entry.client.tsx` appends `?_auth=TOKEN` to all same-origin client-side requests, bypassing the broken cookie path entirely

No manual token copying. No hardcoded URLs. Survives redeployments automatically.

---

## 3. Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         DEPLOYMENT PIPELINE                            │
│                                                                        │
│  git push ──► Oxygen Deploy ──► shopify[bot] PR Comment                │
│                                    │                                   │
│                                    ▼                                   │
│                           issue_comment workflow                       │
│                           (sanity-oxygen-bypass-sync.yml)              │
│                                    │                                   │
│                        Extract URL + TOKEN from comment                │
│                        Verify token (curl HTTP 200)                    │
│                                    │                                   │
│                                    ▼                                   │
│                     Sanity HTTP API: createOrReplace                   │
│                     doc: oxygen-bypass.staging                         │
│                     { deploymentUrl, authToken }                       │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│                      STUDIO → HYDROGEN FLOW                            │
│                                                                        │
│  ┌──────────────────┐     ┌──────────────────────────────────────────┐ │
│  │   Sanity Studio   │     │         Oxygen Gateway                   │ │
│  │   (www.sanity.io) │     │      (Cloudflare Worker)                 │ │
│  │                   │     │                                          │ │
│  │  presentationTool │     │  Runs BEFORE Hydrogen app code.          │ │
│  │   ┌─────────────┐ │     │  Checks ?_auth= param or cookie.        │ │
│  │   │ initial()   │ │     │  If valid → pass through to Hydrogen.    │ │
│  │   │ queries     │ │     │  If invalid → redirect to Shopify login. │ │
│  │   │ Sanity doc  │─┼────►│                                          │ │
│  │   └─────────────┘ │     └──────────┬───────────────────────────────┘ │
│  │         │         │                │                                 │
│  │         ▼         │                ▼                                 │
│  │  iframe loads:    │     ┌──────────────────────────────────────────┐ │
│  │  deployment.url   │     │         Hydrogen App                     │ │
│  │  ?_auth=TOKEN     │     │      (Cloudflare Worker)                 │ │
│  │                   │     │                                          │ │
│  │  previewMode()    │     │  1. GET /api/preview-mode/enable         │ │
│  │  also appends     │     │     validates secret, sets session cookie │ │
│  │  ?_auth=TOKEN     │     │  2. 307 redirect to /                    │ │
│  │  to enable path   │     │  3. Root loader reads session:           │ │
│  │                   │     │     preview=true → skip Analytics,        │ │
│  │  ◄── postMessage ─┼─────┤     render <VisualEditing>               │ │
│  │  (overlays, edit) │     │  4. entry.client.tsx intercepts fetch    │ │
│  │                   │     │     appends ?_auth=TOKEN to all requests │ │
│  └──────────────────┘     └──────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Component Inventory

| Layer | File / Config | Purpose |
|-------|--------------|---------|
| **CI** | `.github/workflows/sanity-oxygen-bypass-sync.yml` | Extracts URL+token from shopify[bot], patches Sanity doc |
| **Sanity doc** | `sanity.oxygenProtectionBypass` (id: `oxygen-bypass.staging`) | Stores current deployment URL and USER_SHARED token |
| **Studio schema** | `schemaTypes/documents/oxygenProtectionBypass.ts` | Schema for the bypass document |
| **Studio config** | `sanity.config.ts` → `presentationTool()` | Dynamic `initial`, `previewMode`, `allowOrigins` |
| **Studio plugin** | `plugins/resolveOxygenPreviewMode.ts` | Async previewMode resolver that injects `?_auth=` |
| **Hydrogen Vite** | `vite.config.ts` → `sanity()` plugin | SSR-safe bundling for `@sanity/visual-editing` |
| **Hydrogen entry** | `app/entry.client.tsx` | Fetch interceptor for third-party cookie bypass |
| **Hydrogen entry** | `app/entry.server.tsx` | CSP frame-ancestors config |
| **Hydrogen root** | `app/root.tsx` | Preview detection, `<VisualEditing>`, Analytics skip |
| **Preview route** | `app/routes/api.preview-mode.enable.tsx` | Loader: validate + enable. Action: perspective changes |
| **Preview route** | `app/routes/api.preview-mode.disable.tsx` | Destroys preview session |
| **Session** | `app/sanity/session.ts` | Cookie-based preview session storage |
| **Sanity client** | `app/sanity/client.ts` | `@sanity/client` instance with stega config |

---

## 5. Detailed Flow: What Happens When an Editor Opens the Presentation Tool

### Step 1: Studio resolves the initial URL

The `initial` function in `sanity.config.ts` queries the Sanity document:

```groq
*[_type == "sanity.oxygenProtectionBypass"][0]{deploymentUrl, authToken}
```

If `authToken` exists, it returns `${deploymentUrl}?_auth=${authToken}`.
Otherwise falls back to `http://localhost:3000`.

### Step 2: Studio resolves previewMode

The `resolveOxygenPreviewMode` plugin receives `{client, targetOrigin}` and queries:

```groq
*[_type == "sanity.oxygenProtectionBypass" && deploymentUrl match $origin + "*"][0]
  {authToken, deploymentUrl}
```

Returns `{enable: '/api/preview-mode/enable?_auth=TOKEN'}` so the Gateway passes the enable request through.

### Step 3: Oxygen Gateway processes the initial request

```
Browser → GET deployment.myshopify.dev/?_auth=TOKEN
         → Oxygen Gateway Worker (runs before Hydrogen)
         → Validates JWT
         → Sets auth_bypass_token cookie (HttpOnly, Secure, SameSite=None)
         → Passes request through to Hydrogen app
```

**Critical**: The cookie is set but **never stored** in the iframe context because all major browsers block third-party cookies.

### Step 4: Hydrogen processes the initial page load

The root loader checks the `__sanity_preview` session cookie (not yet set on first load), extracts `?_auth=` from the URL, and returns both values.

### Step 5: Studio enables preview mode

```
Studio → GET /api/preview-mode/enable?_auth=TOKEN&sanity-preview-pathname=/&...
      → Oxygen Gateway passes through (sees ?_auth=)
      → Hydrogen route validates @sanity/preview-url-secret
      → Sets __sanity_preview session cookie (previewMode=true, perspective=drafts)
      → 307 redirect to /
```

### Step 6: Page renders in preview mode

The root loader now reads `preview=true` from the session cookie. The App component skips `<Analytics.Provider>` and renders `<VisualEditing>` inside a `<ClientOnly>` guard.

### Step 7: Fetch interceptor activates (client-side)

Before React hydration, `entry.client.tsx` reads `?_auth=TOKEN` from `window.location.search` and patches `window.fetch` to append the token to all same-origin requests. This ensures React Router's `.data` endpoint fetches pass through the Oxygen Gateway.

### Step 8: VisualEditing connects

`<VisualEditing>` from `hydrogen-sanity/visual-editing` establishes a postMessage channel with the parent Studio, renders click-to-edit overlays on stega-encoded content, and submits perspective changes via PUT to `/api/preview-mode/enable`.

---

## 6. CI Workflow (Full Code)

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

### Required GitHub Secrets

| Secret | Purpose |
|--------|---------|
| `SANITY_API_WRITE_TOKEN` | Write access to Sanity dataset (project `sx997gpv`, dataset `production`) |

---

## 7. Studio Configuration (Full Code)

### `sanity.config.ts`

```typescript
import {defineConfig} from 'sanity'
import {structureTool} from 'sanity/structure'
import {presentationTool} from 'sanity/presentation'
import {visionTool} from '@sanity/vision'
import {schemaTypes} from './schemaTypes'
import {deskStructure} from './deskStructure'
import {resolveOxygenPreviewMode} from './plugins/resolveOxygenPreviewMode'

const BYPASS_INITIAL_QUERY = `*[_type == "sanity.oxygenProtectionBypass"][0]{deploymentUrl, authToken}`

export default defineConfig({
  name: 'default',
  title: 'Meditate with Eve',

  projectId: 'sx997gpv',
  dataset: 'production',

  plugins: [
    structureTool({structure: deskStructure}),
    presentationTool({
      name: 'presentation',
      title: 'Presentation',
      allowOrigins: ['https://*.myshopify.dev'],
      previewUrl: {
        // Dynamic: reads per-deploy URL from Sanity doc at runtime
        initial: async (context: any) => {
          const config = await context.client.fetch(BYPASS_INITIAL_QUERY) as {
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
        },
        previewMode: resolveOxygenPreviewMode({
          enablePath: '/api/preview-mode/enable',
        }),
      },
    }),
    visionTool(),
  ],

  schema: {types: schemaTypes},
})
```

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

    // Skip for localhost — no Gateway auth needed
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

    return {enable: enablePath, ...(disablePath && {disable: disablePath})}
  }
}
```

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

## 8. Hydrogen App (Full Code)

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

The `sanity()` Vite plugin from `hydrogen-sanity/vite` is critical. It strips `node` and `require` resolve conditions from SSR bundling, preventing `@sanity/visual-editing` v4's dependency chain (`styled-components` → `uuid` → `node:crypto`) from pulling in Node.js-only modules that don't exist on Cloudflare Workers.

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
    // Always allow Sanity Studio to iframe this app — the initial iframe load
    // happens BEFORE the preview cookie is set, so this cannot be conditional
    frameAncestors: ["'self'", 'https://*.sanity.studio'],
    connectSrc: [
      'https://sx997gpv.api.sanity.io',
      'wss://sx997gpv.api.sanity.io',
    ],
  });

  const body = await renderToReadableStream(
    <NonceProvider>
      <ServerRouter
        context={reactRouterContext}
        url={request.url}
        nonce={nonce}
      />
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
  // TODO: Re-enable with correct frame-ancestors (see §15 investigation items)
  // responseHeaders.set('Content-Security-Policy', header);

  return new Response(body, {
    headers: responseHeaders,
    status: responseStatusCode,
  });
}
```

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
import {getPreviewData} from '~/sanity/session';

// Prevents VisualEditing from rendering during SSR (hydration mismatch → crash)
function ClientOnly({children}: {children: React.ReactNode}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted ? <>{children}</> : null;
}

export async function loader(args: Route.LoaderArgs) {
  const deferredData = loadDeferredData(args);
  const criticalData = await loadCriticalData(args);

  const {storefront, env} = args.context;
  const sessionSecret = env.SESSION_SECRET || 'dev-secret-change-me';
  const {preview} = await getPreviewData(args.request, sessionSecret);

  // Extract auth bypass token from URL — needed on client because
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

  // Skip Analytics.Provider in preview mode — consent tracking scripts
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

### `app/routes/api.preview-mode.enable.tsx`

```typescript
import {validatePreviewUrl} from '@sanity/preview-url-secret'
import type {ClientPerspective} from '@sanity/client'
import {client} from '~/sanity/client'
import {createPreviewSessionStorage} from '~/sanity/session'
import type {Route} from './+types/api.preview-mode.enable'

// PUT: change perspective (drafts/published). POST/DELETE: disable preview.
export async function action({request, context}: Route.ActionArgs) {
  const sessionSecret = context.env.SESSION_SECRET || 'dev-secret-change-me'
  const {getSession, commitSession, destroySession} =
    createPreviewSessionStorage(sessionSecret)
  const session = await getSession(request.headers.get('Cookie'))

  if (request.method === 'PUT') {
    const body = await request.formData()
    const perspective = body.get('perspective') as ClientPerspective | null
    if (perspective) {
      session.set('perspective', perspective)
    }
    return new Response(null, {
      status: 200,
      headers: {'Set-Cookie': await commitSession(session)},
    })
  }

  // POST or DELETE — disable preview
  return new Response(null, {
    status: 200,
    headers: {'Set-Cookie': await destroySession(session)},
  })
}

export async function loader({request, context}: Route.LoaderArgs) {
  const token = context.env.SANITY_API_READ_TOKEN

  if (!token) {
    throw new Response('SANITY_API_READ_TOKEN not set', {status: 500})
  }

  const clientWithToken = client.withConfig({token})
  const {isValid, redirectTo = '/'} = await validatePreviewUrl(
    clientWithToken,
    request.url,
  )

  if (!isValid) {
    return new Response('Invalid preview URL', {status: 401})
  }

  const sessionSecret = context.env.SESSION_SECRET || 'dev-secret-change-me'
  const {getSession, commitSession} = createPreviewSessionStorage(sessionSecret)
  const session = await getSession(request.headers.get('Cookie'))
  session.set('previewMode', true)

  const url = new URL(request.url)
  const perspectiveParam = url.searchParams.get('sanity-preview-perspective')
  if (perspectiveParam) {
    session.set('perspective', perspectiveParam as ClientPerspective)
  }

  return new Response(null, {
    status: 307,
    headers: {
      Location: redirectTo,
      'Set-Cookie': await commitSession(session),
    },
  })
}
```

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

---

## 9. Token Strategy

### Why `USER_SHARED`

| Kind | Behavior | Max Duration |
|------|----------|-------------|
| `TESTING_AUTOMATION` | Single-use, expires after one request | 12 hours |
| `USER_SHARED` | Multi-use, no expiry, deployment-scoped | No expiry |

`USER_SHARED` is correct because:
- The token must survive multiple requests (initial load, preview enable, client-side navigations)
- The token dies automatically when the deployment is replaced (deployment-scoped)
- No need for manual rotation — CI updates on every deploy

### Token Lifecycle

```
1. Developer pushes to branch
2. Oxygen deploys → generates new deployment ID
3. shopify[bot] comments with new URL + new USER_SHARED token
4. CI workflow fires → patches Sanity doc with new URL + token
5. Old token is now dead (old deployment no longer exists)
6. Editor opens Presentation tool → Studio reads new token from Sanity
7. Next deploy → cycle repeats from step 2
```

---

## 10. CSP (Content Security Policy)

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

**`frame-ancestors`**: Must include `https://www.sanity.io` — Studio is hosted at `https://www.sanity.io/@user/studio/appId/...`, not on `*.sanity.studio`. Custom domain Studios may also need `*.sanity.studio`.

**`connect-src`**: Required for the Sanity client to fetch content and establish WebSocket connections for live updates.

**Non-conditional**: CSP must be set on every response, not behind a preview check. The initial iframe load happens **before** the preview session cookie is set — if CSP blocks the frame, the enable request never fires (chicken-and-egg).

> **Current status**: CSP is temporarily disabled (`Content-Security-Policy` header commented out). See [Areas to Investigate Further](#15-areas-to-investigate-further).

---

## 11. Package Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `hydrogen-sanity` | `^6.1.0` | VisualEditing component + Vite plugin (Workers-safe) |
| `@sanity/client` | `^7.15.0` | Sanity API client with stega support |
| `@sanity/preview-url-secret` | `^4.0.3` | Validates preview enable requests |
| `@sanity/react-loader` | `^2.0.7` | Sanity data loading utilities |
| `@sanity/visual-editing` | `^4.0.3` | Peer dep of hydrogen-sanity (v4, not v5 which requires React 19) |
| `styled-components` | `^6.3.9` | Transitive dep of `@sanity/visual-editing` v4 (handled by Vite plugin) |

### Version Constraints

- **`@sanity/visual-editing` v5** requires React 19 (`react/compiler-runtime`). Hydrogen 2026.1.0 uses React 18. Must use v4.
- **`hydrogen-sanity` v6.1.0** wraps `@sanity/visual-editing` v4 with client-only `React.lazy()` loading and ships a Vite plugin that strips `node:crypto` from the SSR bundle. This is the recommended integration path.

---

## 12. Environment Variables (Hydrogen/Oxygen)

| Variable | Required | Purpose |
|----------|----------|---------|
| `SESSION_SECRET` | Yes | Signs the preview session cookie |
| `SANITY_API_READ_TOKEN` | Yes | Validates `@sanity/preview-url-secret` in enable route |
| `PUBLIC_SANITY_PROJECT_ID` | Yes | Sanity client config |
| `PUBLIC_SANITY_DATASET` | Yes | Sanity client config |
| `PUBLIC_SANITY_STUDIO_URL` | Yes | Stega encoding studio URL for click-to-edit |
| `PUBLIC_STORE_DOMAIN` | Yes | Shopify storefront domain |
| `PUBLIC_STOREFRONT_API_TOKEN` | Yes | Shopify Storefront API |
| `PUBLIC_STOREFRONT_ID` | Yes | Shopify analytics |
| `PUBLIC_CHECKOUT_DOMAIN` | Yes | Shopify checkout (also used by Analytics.Provider) |

---

## 13. Failure Modes

| Failure | Symptom | Recovery |
|---------|---------|----------|
| CI workflow doesn't fire | Sanity doc has stale URL/token | Merge workflow file to main first; `issue_comment` only runs from default branch |
| PR merged before shopify[bot] comments | Sanity doc never updated for this deploy | Add branch protection requiring bot comment before merge |
| `SANITY_API_WRITE_TOKEN` not set | CI logs warning, skips Sanity patch | Add secret to GitHub repo settings |
| Token expired (shouldn't happen with USER_SHARED) | Iframe shows Shopify login | Redeploy to get a fresh token |
| `allowOrigins` missing in Studio | "Blocked preview URL" error | Add `['https://*.myshopify.dev']` to presentationTool config |
| CSP frame-ancestors wrong | Iframe refuses to load (blank or error) | Add `https://www.sanity.io` to frame-ancestors |
| Analytics.Provider in preview mode | React crash #421, "Oops 500" | Skip Analytics.Provider when `preview=true` |
| VisualEditing without ClientOnly | Hydration mismatch, "Oops 500" | Wrap in `<ClientOnly>` |
| No action handler for perspective changes | 405 error on catch-all route | Add `action` export to preview route, set `action` prop on `<VisualEditing>` |
| Fetch interceptor missing | "Failed to fetch" on client-side navigations | Add interceptor in `entry.client.tsx` |

---

## 14. Bugs Encountered and Fixed

These were discovered iteratively during integration. Documented here as a reference for anyone building this integration from scratch.

### 14.1. `@sanity/visual-editing` v5 incompatible with React 18

**Error**: `Missing "./compiler-runtime" specifier in "react" package`

**Cause**: v5 requires React 19's compiler runtime. Hydrogen 2026.1.0 ships React 18.3.1.

**Fix**: Use `hydrogen-sanity@6.1.0` which wraps `@sanity/visual-editing` v4 (React 18 compatible) with client-only loading.

### 14.2. `node:crypto` unavailable on Cloudflare Workers

**Error**: `Uncaught Error: No such module "node:crypto"`

**Cause**: `@sanity/visual-editing` v4 → `styled-components` → `uuid` → `node:crypto`. The Workers runtime doesn't have Node.js built-in modules.

**Fix**: The `sanity()` Vite plugin from `hydrogen-sanity/vite` strips `node` and `require` resolve conditions from SSR bundling, preventing Node-only modules from being included.

### 14.3. Analytics.Provider crashes in cross-origin iframe

**Error**: `[h2:error:Analytics.Provider] - consent.checkoutDomain is required` + React error #421

**Cause**: Shopify's `consent-tracking-api.js` gets blocked by the browser in cross-origin iframes. Analytics.Provider expects it to load successfully.

**Fix**: Skip `<Analytics.Provider>` when `data.preview` is true. Preview mode doesn't need analytics.

### 14.4. VisualEditing causes hydration mismatch

**Error**: React error #421 → ErrorBoundary shows "Oops 500"

**Cause**: `<VisualEditing>` uses browser APIs during render. Server-rendered HTML doesn't include its output, but client hydration tries to render it — mismatch.

**Fix**: Wrap in `<ClientOnly>` component (useState + useEffect mount guard).

### 14.5. Third-party cookies blocked in iframe

**Error**: All client-side fetches redirect to `accounts.shopify.com/oauth/authorize` → CORS error → "Failed to fetch"

**Cause**: Oxygen Gateway sets `auth_bypass_token` as an HttpOnly cookie. In a cross-origin iframe (parent: `www.sanity.io`, child: `*.myshopify.dev`), Safari ITP, Brave, and Chrome 127+ refuse to store or send third-party cookies. Every subsequent fetch lacks the cookie → Gateway redirects to Shopify login.

**Fix**: Capture `?_auth=TOKEN` from the initial URL in `entry.client.tsx` and patch `window.fetch` to append it to all same-origin requests.

### 14.6. `allowOrigins` not configured

**Error**: "Blocked preview URL — the origin ... is not allowed"

**Cause**: The Presentation tool checks `allowOrigins` before communicating with the iframe via postMessage. Without it, the iframe loads but Studio refuses to connect.

**Fix**: Add `allowOrigins: ['https://*.myshopify.dev']` to `presentationTool()` config.

### 14.7. No action handler for perspective changes (405)

**Error**: `Route "routes/$" does not have an action, but you are trying to submit to it`

**Cause**: `<VisualEditing>` submits perspective changes (PUT) to its `action` prop URL. Without an explicit `action` prop, it defaults to the current route — which is the catch-all `$.tsx` with no action handler.

**Fix**: Add `action="/api/preview-mode/enable"` prop to `<VisualEditing>` and add an `action` export to the enable route that handles PUT (perspective) and POST/DELETE (disable).

---

## 15. Areas to Investigate Further

### 15.1. CSP Re-enablement (Currently Disabled)

**Status**: The `Content-Security-Policy` header is commented out in `entry.server.tsx`.

**What needs work**:
- The current `frameAncestors` includes `https://*.sanity.studio` but Studio is actually hosted at `https://www.sanity.io`. Need to test with `https://www.sanity.io` instead (or both).
- Need to verify all required CSP directives: `connect-src` for Sanity API + WebSocket, `script-src` for any injected scripts, `img-src` for Sanity CDN images.
- CSP errors are silent in production (browser blocks resources without visible errors). Must test with browser DevTools open to catch violations.
- Consider whether `https://*.sanity.studio` is still needed for custom-domain Studios.

**Risk**: If CSP is wrong, the iframe won't load at all — and the error is not obvious. Test thoroughly before re-enabling.

### 15.2. Fetch Interceptor: Is There a More Elegant Alternative?

**Current approach**: Global `window.fetch` monkey-patch in `entry.client.tsx`.

**Why it's hacky**:
- Mutates a global browser API
- Affects all same-origin requests, not just React Router's `.data` fetches
- Leaks the auth token into URLs of requests that don't need it (harmless but inelegant)
- Could conflict with other code that also patches `window.fetch` (monitoring, analytics)

**Alternatives investigated and rejected (with evidence)**:

| Alternative | Why Rejected |
|------------|--------------|
| React Router `dataStrategy` | Controls handler execution order, not HTTP transport. Cannot modify fetch URLs. See detailed analysis below. |
| React Router `clientMiddleware` | Wraps loader/action execution, not the HTTP `.data` fetch. Request object is read-only. See detailed analysis below. |
| React Router server middleware | Runs server-side only. Cannot affect client-side `.data` endpoint fetches. |
| `clientLoader` with custom fetch | Would need a `clientLoader` on every route; `serverLoader()` accepts no params |
| Service Worker | Cleanest interception point but adds significant complexity (registration, lifecycle, caching concerns) |
| Oxygen-level cookie fix | Not possible — Oxygen Gateway is a Shopify-managed Worker, not user-configurable |
| CHIPS (Cookies Having Independent Partitioned State) | The `Partitioned` cookie attribute could solve this, but Oxygen Gateway doesn't set it and we can't modify Gateway behavior |
| Storage Access API | `document.requestStorageAccess()` could grant iframe cookie access, but requires a user gesture (click) and prior first-party visit to the Oxygen domain — neither condition is reliably met in the Presentation tool flow |
| Intercepting cookie in Studio | Impossible — the auth bypass cookie is `HttpOnly`, set by the Oxygen Gateway on the iframe's origin. Studio (parent frame on `www.sanity.io`) cannot read cross-origin response headers or access the iframe's `document.cookie`. Same-Origin Policy prevents this entirely. |

#### Deep Dive: React Router v7.12 Client-Side Fetch Architecture

The core question is: can React Router's APIs intercept the HTTP request that fetches `.data` endpoints during client-side navigation?

**How React Router client-side navigation works:**

```
User clicks <Link to="/products/hat">
  → React Router builds URL: /products/hat.data
  → Internal singleFetchDataStrategy() called
  → window.fetch("/products/hat.data") executed          ← THE GAP: no hook here
  → Response received, turbo-stream decoded
  → clientMiddleware wraps handler execution              ← middleware runs HERE
  → Loader handler processes decoded data
  → Component re-renders with new data
```

The `.data` fetch URL is constructed deep inside React Router's internals. No public API exposes or modifies it before `fetch()` is called.

**`dataStrategy` — cannot modify fetch URLs:**

`dataStrategy` receives an array of `match` objects, each with a `handler()` function. Calling `handler()` triggers the internal data loading pipeline. The strategy controls _which_ handlers to call and _in what order_, but does not control _how_ the HTTP request is made.

```typescript
// What dataStrategy looks like — no access to request URL
export const unstable_dataStrategy: DataStrategyFunction = async ({matches}) => {
  // matches[n].handler() triggers the internal fetch — opaque
  return Promise.all(matches.map((match) => match.handler()));
};
```

There is no parameter to modify the fetch URL, no callback before the HTTP request, and no way to inject query parameters.

**`clientMiddleware` — wraps execution, not transport:**

`clientMiddleware` runs in the browser before/after loader/action handlers execute. It receives a `context` object and a `next()` function.

```typescript
// What clientMiddleware looks like
export const unstable_clientMiddleware: ClientMiddlewareFunction[] = [
  async (context, next) => {
    // context.request exists but is READ-ONLY
    // Cannot do: context.request.url += "?_auth=TOKEN"

    const start = performance.now();
    await next(); // calls the loader handler (data already fetched)
    console.log(`Loader took ${performance.now() - start}ms`);
  }
];
```

Key limitations:
- The `request` object is read-only — no URL mutation
- By the time middleware runs, the `.data` fetch has already completed
- `next()` executes the handler that processes the already-fetched data
- Can throw redirects, set context, measure timing — but cannot intercept HTTP transport
- No `beforeFetch` or `transformRequest` callback exists

**Single Fetch vs browser `fetch()` — important distinction:**

"Single Fetch" is a server-side architecture where React Router batches all loader data for a navigation into a single HTTP request (the `.data` endpoint), encoded as a turbo-stream. It is NOT the same as the browser `fetch()` API. The term describes the server's response strategy (one response for all loaders), not the client's request mechanism.

The browser still calls `window.fetch()` to make the HTTP request to the `.data` endpoint. React Router provides no hook between "URL constructed" and "`fetch()` called."

**Conclusion:** The `window.fetch` monkey-patch is currently the only viable client-side interception point in React Router v7.12. This is an architectural gap, not a missing feature — React Router's client-side data loading was designed assuming first-party cookie availability.

**Future possibilities**:
- **React Router fetch customization hook**: Monitor [React Router GitHub discussions](https://github.com/remix-run/react-router/discussions) for `dataStrategy` enhancements that expose the HTTP layer. As of v7.12, no such API exists or has been proposed.
- **Service Worker approach**: Register a SW that intercepts same-origin fetches and adds `?_auth=TOKEN`. This is the "proper" Web Platform way to intercept fetches but adds lifecycle complexity (install/activate/update/scope). Worth investigating if the `window.fetch` patch causes conflicts with other fetch-patching code (monitoring, analytics, error tracking).
- **Shopify may add `Partitioned` attribute** to the `auth_bypass_token` cookie. [CHIPS](https://developer.chrome.com/docs/privacy-sandbox/chips/) allows third-party cookies when partitioned by top-level site. If Oxygen Gateway sets `Partitioned` on the cookie, it would work in all browsers that support CHIPS (Chrome 114+, Firefox 131+, not yet Safari). This would eliminate the need for the fetch interceptor entirely.
- **Shopify may provide a first-party integration** for this use case. The [Hydrogen discussion #1226](https://github.com/Shopify/hydrogen/discussions/1226) tracks this.
- **`Authorization` header support**: If Oxygen Gateway accepted `Authorization: Bearer <token>` in addition to the `?_auth=` query param, a simple fetch wrapper (or `headers` option on React Router's data loading) might work without monkey-patching. This would require a Shopify platform change.

### 15.3. Preview Session Cookie in Third-Party Context

**Question**: The `__sanity_preview` session cookie uses `sameSite: 'none'`. Does this actually work in the iframe context, or does it suffer the same third-party cookie blocking as the Oxygen Gateway cookie?

**Current observation**: It works — the session cookie is set by the Hydrogen app (the iframe's own origin) via a `Set-Cookie` header on the 307 redirect from `/api/preview-mode/enable`. Because the cookie is set by the page's own origin (first-party from the iframe's perspective), browsers store it. However, when sent in subsequent requests from the iframe, it's technically a "third-party" context (the top-level page is `www.sanity.io`). Modern browsers distinguish between first-party and third-party cookies by the top-level browsing context.

**Risk**: This may break in future browser updates that further restrict cookies in iframes. Test periodically in Safari, Chrome, and Firefox nightlies.

### 15.4. `resolve.locations` for Document-to-Route Mapping

**Current state**: The Presentation tool relies entirely on stega-encoded content source maps for click-to-edit. There's no `resolve.locations` or `resolve.mainDocuments` configuration.

**What's missing**:
- No "Used on X pages" banner in the Studio document editor
- No automatic document selection when navigating to a URL in the iframe
- No route hints for page building

**What to add** (example for Shopify document types):
```typescript
resolve: {
  mainDocuments: defineDocuments([
    {route: '/products/:handle', filter: `_type == "product" && store.slug.current == $handle`},
    {route: '/collections/:handle', filter: `_type == "collection" && store.slug.current == $handle`},
  ]),
  locations: {
    product: defineLocations({
      select: {title: 'store.title', slug: 'store.slug.current'},
      resolve: (doc) => ({
        locations: [{title: doc?.title || 'Untitled', href: `/products/${doc?.slug}`}],
      }),
    }),
  },
}
```

### 15.5. Multi-Environment Support

**Current state**: The CI workflow writes to a single Sanity document `oxygen-bypass.staging`. Only one deployment at a time is supported.

**What's needed for production**:
- Separate bypass documents per environment (staging, production preview, feature branches)
- Workflow variants that write to different document IDs based on the target branch
- Studio `initial` function that selects the correct bypass doc based on context

### 15.6. Branch Protection / Merge Gating

**Current risk**: If a PR is merged before `shopify[bot]` comments, the `issue_comment` workflow never fires and the Sanity bypass doc retains the old (dead) deployment URL/token.

**Options**:
- GitHub branch protection rule requiring a specific status check
- A custom GitHub Action that creates a check run tied to the shopify[bot] comment
- A webhook that blocks merge until the Sanity doc is updated

### 15.7. Sanity Live Content API (Q6)

**Untested**: Real-time content updates via the Sanity Live Content API in preview mode. The `hydrogen-sanity` package supports this via the `<LiveMode>` component (auto-detected by `<VisualEditing>`), but it hasn't been validated in this integration.

**What to test**:
- Edit a Sanity document in Studio while the Presentation tool is open
- Verify the iframe updates in real-time without a full page reload
- Check WebSocket connections in the Network tab

### 15.8. Token Security

**Current exposure**: The `USER_SHARED` token is appended to every same-origin request URL as `?_auth=TOKEN`. This means:
- The token appears in browser history (URL bar)
- The token appears in server access logs
- The token is visible in the Network tab
- The token is embedded in the initial HTML (via the loader data `authBypassToken`)

**Mitigations in place**:
- Token is deployment-scoped (dies on redeploy)
- Token is `USER_SHARED` (designed for sharing)
- CI masks the token in GitHub Actions logs
- The token only grants access to the preview deployment, not production

**Not a concern** because: The token is intentionally shared. Its purpose is to let anyone with the link access the preview. It provides no escalation to production data, Shopify admin, or other resources.

### 15.9. `hydrogen-sanity` vs Custom Integration

**Current approach**: We use `hydrogen-sanity@6.1.0` for the `<VisualEditing>` component and Vite plugin, but custom code for everything else (session management, preview routes, bypass resolver).

**Alternative**: `hydrogen-sanity` provides a complete preview route (`hydrogen-sanity/preview/route`) and session management (`hydrogen-sanity/preview/session`). We could potentially replace our custom routes with:

```typescript
// app/routes/api.preview.tsx
export {action, loader} from 'hydrogen-sanity/preview/route';
```

**Why we didn't**: Our custom implementation gives us control over the session cookie configuration (especially `sameSite: 'none'` which is critical for the iframe context) and the ability to handle the `?_auth=` parameter in the enable flow. Worth investigating whether `hydrogen-sanity`'s built-in route handles these cases.
