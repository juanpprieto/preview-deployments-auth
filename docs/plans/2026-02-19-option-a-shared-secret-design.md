# Option A: Shared Secret Protection Bypass — Design

> Implementation-ready design for protecting Oxygen staging/dev environments with a shared
> secret validated by Hydrogen server middleware.

**Prerequisites**: Scaffolded Hydrogen project with `hydrogen-sanity` wired up (swag-store
baseline). Oxygen environments (staging, dev) and Sanity datasets configured. Production
remains public with no middleware.

**Reference repos**:
- [hydrogen skeleton](https://github.com/Shopify/hydrogen/tree/main/templates/skeleton) — latest Hydrogen patterns
- [swag-store](https://github.com/sanity-io/swag-store) — Hydrogen + Sanity integration

---

## 1. Component Overview

| # | File | What | New/Modified |
|---|---|---|---|
| 1 | `app/lib/auth.server.ts` | Middleware: validate secret, set cookie, return 401 | New |
| 2 | `server.ts` | Call middleware before request handler | Modified (+2 lines) |
| 3 | `env.d.ts` | Type declarations for bypass env vars | Modified |
| 4 | `app/entry.server.tsx` | CSP `frame-ancestors` for Studio domain | Modified |
| 5 | Studio: `schemaTypes/oxygenProtectionBypass.ts` | Bypass document type | New |
| 6 | Studio: `sanity.config.ts` | `previewMode` resolver per workspace | Modified |
| 7 | Sanity documents | One bypass doc per environment | Created via CLI |

---

## 2. Data Flow

```
Studio Presentation tool opens iframe
  → previewMode resolver queries Sanity for bypass secret
  → constructs URL: staging.acme.com/api/preview-mode/enable?x-oxygen-bypass=SECRET
  → iframe loads URL

server.ts receives request
  → validateProtectionBypass(request, env)
    → no cookie → checks query param → matches secret
    → returns 302 redirect to clean URL + Set-Cookie (SameSite=None; Secure; HttpOnly)

iframe reloads at clean URL
  → validateProtectionBypass(request, env)
    → cookie present and valid → returns null (pass through)
  → request reaches React Router → normal rendering + visual editing
```

Stakeholder flow: receives a link with `?x-oxygen-bypass=SECRET`. Same redirect + cookie flow.

---

## 3. Middleware — `app/lib/auth.server.ts`

```typescript
const BYPASS_COOKIE = '_oxygen_bypass';
const BYPASS_PARAM = 'x-oxygen-bypass';
const COOKIE_TTL = 60 * 60 * 24 * 30; // 30 days

export function validateProtectionBypass(
  request: Request,
  env: Env,
): Response | null {
  // Resolve which secret applies (only one is defined per environment)
  const secret = env.STAGING_BYPASS_SECRET || env.DEV_BYPASS_SECRET;
  if (!secret) return null; // Production or preview — no custom auth

  // 1. Check session cookie
  const cookieHeader = request.headers.get('Cookie') || '';
  const cookies = Object.fromEntries(
    cookieHeader.split('; ').filter(Boolean).map((c) => {
      const [k, ...v] = c.split('=');
      return [k, v.join('=')];
    }),
  );
  if (cookies[BYPASS_COOKIE] === secret) return null; // Authenticated

  // 2. Check bypass query param
  const url = new URL(request.url);
  const param = url.searchParams.get(BYPASS_PARAM);
  if (param === secret) {
    // Strip param, redirect with cookie
    url.searchParams.delete(BYPASS_PARAM);
    return new Response(null, {
      status: 302,
      headers: {
        Location: url.toString(),
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

  // 3. No valid auth
  return new Response('Unauthorized', {
    status: 401,
    headers: {'X-Robots-Tag': 'noindex'},
  });
}
```

Design decisions:
- **Cookie stores the secret directly** — rotation invalidates all sessions immediately. Cookie
  is `HttpOnly` so JS can't read it. Anyone with browser dev tools already received the secret
  in the URL.
- **`SameSite=None; Secure; HttpOnly`** — works in cross-origin iframes (Studio embeds the
  storefront). Mirrors Vercel's cookie pattern.
- **30-day TTL** — stakeholders don't re-auth frequently.
- **`X-Robots-Tag: noindex`** — crawlers can't index protected content.
- **No external dependencies** — plain string comparison, zero imports.

---

## 4. server.ts Integration

Two lines added before the standard Hydrogen flow:

```typescript
import {validateProtectionBypass} from '~/lib/auth.server';

export default {
  async fetch(
    request: Request,
    env: Env,
    executionContext: ExecutionContext,
  ): Promise<Response> {
    try {
      // Auth bypass check — runs before ALL other handling
      const authResponse = validateProtectionBypass(request, env);
      if (authResponse) return authResponse;

      // Standard Hydrogen flow (unchanged from skeleton/swag-store)
      const hydrogenContext = await createHydrogenRouterContext(
        request, env, executionContext,
      );

      const handleRequest = createRequestHandler({
        build: serverBuild,
        mode: process.env.NODE_ENV,
        getLoadContext: () => hydrogenContext,
      });

      const response = await handleRequest(request);

      if (hydrogenContext.session.isPending) {
        response.headers.set(
          'Set-Cookie',
          await hydrogenContext.session.commit(),
        );
      }

      if (response.status === 404) {
        return storefrontRedirect({
          request, response,
          storefront: hydrogenContext.storefront,
        });
      }

      return response;
    } catch (error) {
      console.error(error);
      return new Response('An unexpected error occurred', {status: 500});
    }
  },
};
```

The middleware runs before `createHydrogenRouterContext` — no Hydrogen context needed for auth.
This intercepts all request types: pages, `.data` fetches, static assets.

---

## 5. env.d.ts

```typescript
interface Env extends HydrogenEnv {
  // ... existing vars (SESSION_SECRET, SANITY_PROJECT_ID, etc.)

  // Protection bypass — one per environment, only defined in its respective env
  STAGING_BYPASS_SECRET?: string;
  DEV_BYPASS_SECRET?: string;
}
```

Both optional — only one is defined per Oxygen environment. Neither is defined in production.

---

## 6. entry.server.tsx — CSP

Add Studio domain to `frame-ancestors`:

```typescript
const {nonce, header, NonceProvider} = createContentSecurityPolicy({
  ...context.env,
  frameAncestors: [
    "'self'",
    'https://www.sanity.io',
    'https://*.sanity.studio',
  ],
});
```

Without this, Studio's iframe is blocked by the browser's CSP policy.

---

## 7. Sanity Schema — `oxygenProtectionBypass`

```typescript
// studio/schemaTypes/oxygenProtectionBypass.ts
import {defineType, defineField} from 'sanity'

export default defineType({
  name: 'oxygenProtectionBypass',
  title: 'Oxygen Protection Bypass',
  type: 'document',
  fields: [
    defineField({
      name: 'environment',
      type: 'string',
      options: {
        list: ['staging', 'dev'],
      },
      validation: (r) => r.required(),
    }),
    defineField({
      name: 'secret',
      type: 'string',
      validation: (r) => r.required(),
    }),
  ],
  preview: {
    select: {title: 'environment'},
  },
})
```

Register in the Studio schema index. One document per environment with deterministic IDs:

- `oxygenProtectionBypass.staging`
- `oxygenProtectionBypass.dev`

---

## 8. Studio `presentationTool` Config

Each workspace's `presentationTool` uses a `previewMode` resolver that reads the bypass secret
from the Sanity doc and appends it to the iframe URL.

### Staging workspace

```typescript
presentationTool({
  previewUrl: {
    initial: 'https://staging.acme.com',
    previewMode: {
      enable: async ({client, targetOrigin}) => {
        const doc = await client.fetch(
          `*[_type == "oxygenProtectionBypass" && environment == "staging"][0]{secret}`
        )
        const base = `${targetOrigin}/api/preview-mode/enable`
        return doc?.secret
          ? `${base}?x-oxygen-bypass=${doc.secret}`
          : base
      },
    },
  },
  allowOrigins: [
    'https://staging.acme.com',
    'https://*.myshopify.dev',
  ],
})
```

### Dev workspace

```typescript
presentationTool({
  previewUrl: {
    initial: 'https://dev.acme.com',
    previewMode: {
      enable: async ({client, targetOrigin}) => {
        const doc = await client.fetch(
          `*[_type == "oxygenProtectionBypass" && environment == "dev"][0]{secret}`
        )
        const base = `${targetOrigin}/api/preview-mode/enable`
        return doc?.secret
          ? `${base}?x-oxygen-bypass=${doc.secret}`
          : base
      },
    },
  },
  allowOrigins: [
    'https://dev.acme.com',
    'https://*.myshopify.dev',
  ],
})
```

### Production workspace

No `previewMode` resolver needed — production is public, no auth.

```typescript
presentationTool({
  previewUrl: {
    initial: 'https://acme.com',
    previewMode: {
      enable: '/api/preview-mode/enable',
    },
  },
})
```

---

## 9. Secret Generation and Storage

### Generate (one-time per environment)

```bash
# 32-character hex string (matches Vercel's format)
openssl rand -hex 16
```

### Store in Oxygen env vars

| Variable | Scoped To | Value |
|---|---|---|
| `STAGING_BYPASS_SECRET` | Staging environment only | `a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6` |
| `DEV_BYPASS_SECRET` | Dev environment only | `f1e2d3c4b5a6f7e8d9c0b1a2f3e4d5c6` |

Neither is set in Production — middleware auto-skips.

### Store in Sanity

```bash
npx sanity documents create --dataset production <<'EOF'
{
  "_type": "oxygenProtectionBypass",
  "_id": "oxygenProtectionBypass.staging",
  "environment": "staging",
  "secret": "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"
}
EOF

npx sanity documents create --dataset production <<'EOF'
{
  "_type": "oxygenProtectionBypass",
  "_id": "oxygenProtectionBypass.dev",
  "environment": "dev",
  "secret": "f1e2d3c4b5a6f7e8d9c0b1a2f3e4d5c6"
}
EOF
```

### Rotation

1. Generate new secret: `openssl rand -hex 16`
2. Update Oxygen env var → triggers redeploy
3. Update Sanity document (same `_id`, new `secret` value)
4. Distribute new stakeholder link
5. All old cookies invalidated immediately (cookie value no longer matches)
