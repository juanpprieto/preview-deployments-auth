# Option D: HTTP Basic Auth + Cookie Bypass — Design

> Implementation-ready design for protecting Oxygen staging/dev environments with HTTP Basic Auth
> (for human browser access) combined with a cookie-based bypass (for Sanity Studio Presentation
> tool iframe). Adapted from [gcom-tempo SAS-541](../../gcom-tempo reference).

**Prerequisites**: Scaffolded Hydrogen project with `hydrogen-sanity` wired up (swag-store
baseline). Oxygen environments (staging, dev) and Sanity datasets configured. Production
remains public with no middleware.

**Reference repos**:
- [hydrogen skeleton](https://github.com/Shopify/hydrogen/tree/main/templates/skeleton) — latest Hydrogen patterns
- [swag-store](https://github.com/sanity-io/swag-store) — Hydrogen + Sanity integration
- [gcom-tempo SAS-541](../../../gcom-tempo/apps/web/SAS-541-basic-auth-middleware.md) — source implementation (multi-store, adapted here for single store)

**Key difference from Options A–C**: Stakeholders authenticate via the browser's native Basic Auth
dialog — no special link or authenticator app needed. Studio uses a parallel cookie bypass path
because Basic Auth dialogs are [suppressed in cross-origin iframes](#why-basic-auth-needs-a-cookie-fallback-for-studio).

---

## 1. Why Basic Auth Needs a Cookie Fallback for Studio

HTTP Basic Auth relies on the browser showing a native `401 → WWW-Authenticate → dialog` flow.
This **does not work** inside Studio's cross-origin iframe:

- Chrome [suppresses auth dialogs in cross-origin iframes](https://issues.chromium.org/issues/40607853) since 2011
- Chrome [blocks embedded credentials](https://chromestatus.com/feature/5669008342777856) (`user:pass@host`) in subresource URLs since Chrome 59
- Firefox behavior is [inconsistent](https://bugzilla.mozilla.org/show_bug.cgi?id=647010)
- There is no API to set an `Authorization` header on an `<iframe src>`

**Solution**: The middleware checks a session cookie **before** falling back to Basic Auth.
Studio's `previewMode` resolver reads a bypass secret from Sanity, appends it as a query
parameter, and the middleware converts it into a `SameSite=None; Secure; HttpOnly` cookie.
This is identical to Option A's mechanism. Basic Auth is the fallback for direct browser access.

---

## 2. Component Overview

| # | File | What | New/Modified |
|---|---|---|---|
| 1 | `app/lib/basic-auth.server.ts` | Middleware: session cookie → query param → Basic Auth → 401 | New |
| 2 | `server.ts` | Call middleware before request handler | Modified (+2 lines) |
| 3 | `env.d.ts` | Type declarations for auth env vars | Modified |
| 4 | `app/entry.server.tsx` | CSP `frame-ancestors` for Studio domain | Modified |
| 5 | Studio: `schemaTypes/oxygenProtectionBypass.ts` | Bypass document type (stores secret for Studio) | New |
| 6 | Studio: `sanity.config.ts` | `previewMode` resolver per workspace | Modified |
| 7 | Sanity documents | One bypass doc per environment with secret | Created via CLI |

**Same file count as Option A.** The middleware is larger (~80 lines vs ~25) due to Basic Auth
parsing + timing-safe comparison + dual auth paths.

---

## 3. Data Flow

### Studio editor flow (transparent — cookie bypass, same as Option A)

```
Studio Presentation tool opens iframe
  → previewMode resolver queries Sanity for bypass secret
  → constructs URL: staging.acme.com/api/preview-mode/enable?x-oxygen-bypass=SECRET
  → iframe loads URL

server.ts receives request
  → checkBasicAuth(request, env)
    → no session cookie → checks query param → matches bypass secret
    → 302 redirect to clean URL + Set-Cookie (SameSite=None; Secure; HttpOnly)

iframe reloads at clean URL
  → session cookie present → pass through
  → preview route runs → Sanity visual editing active
```

### Stakeholder flow (native browser auth dialog)

```
Stakeholder visits staging.acme.com
  → no session cookie, no query param, no Authorization header
  → middleware returns 401 + WWW-Authenticate: Basic realm="Staging"
  → browser shows native auth dialog
  → stakeholder enters username + password
  → browser re-sends request with Authorization: Basic base64(user:pass)
  → middleware validates credentials (timing-safe) → pass through
  → browser caches credentials for the session (all subsequent requests auto-authenticated)
```

### Production (no auth)

```
No PRIVATE_HYDROGEN_USERNAME or PRIVATE_HYDROGEN_PASSWORD set
  → middleware returns null → request proceeds normally
```

---

## 4. Middleware — `app/lib/basic-auth.server.ts`

```typescript
const BYPASS_COOKIE = '_oxygen_bypass';
const BYPASS_PARAM = 'x-oxygen-bypass';
const COOKIE_TTL = 60 * 60 * 24 * 30; // 30 days

type BasicAuthEnv = Pick<
  Env,
  | 'PRIVATE_HYDROGEN_USERNAME'
  | 'PRIVATE_HYDROGEN_PASSWORD'
  | 'PRIVATE_BYPASS_SECRET'
  | 'PRIVATE_HYDROGEN_AUTH_DISABLED'
>;

export function checkBasicAuth(
  request: Request,
  env: BasicAuthEnv,
): Response | null {
  // === Bypass paths ===

  // 1. Local dev — NODE_ENV is replaced at build time by Vite
  if (process.env.NODE_ENV === 'development') return null;

  // 2. Kill switch
  if (env.PRIVATE_HYDROGEN_AUTH_DISABLED === 'true') return null;

  // 3. No credentials AND no bypass secret = production (skip auth entirely)
  const username = env.PRIVATE_HYDROGEN_USERNAME || undefined;
  const password = env.PRIVATE_HYDROGEN_PASSWORD || undefined;
  const bypassSecret = env.PRIVATE_BYPASS_SECRET || undefined;
  if (!username && !password && !bypassSecret) return null;

  // === Cookie bypass (Studio iframe path — identical to Option A) ===

  if (bypassSecret) {
    const cookieHeader = request.headers.get('Cookie') || '';
    const cookies = Object.fromEntries(
      cookieHeader.split('; ').filter(Boolean).map((c) => {
        const [k, ...v] = c.split('=');
        return [k, v.join('=')];
      }),
    );

    // 4. Session cookie matches bypass secret → authenticated
    if (cookies[BYPASS_COOKIE] === bypassSecret) return null;

    // 5. Query param matches → set cookie, redirect
    const url = new URL(request.url);
    const param = url.searchParams.get(BYPASS_PARAM);
    if (param === bypassSecret) {
      url.searchParams.delete(BYPASS_PARAM);
      return new Response(null, {
        status: 302,
        headers: {
          Location: url.toString(),
          'Set-Cookie': [
            `${BYPASS_COOKIE}=${bypassSecret}`,
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
  }

  // === HTTP Basic Auth (human browser path) ===

  // 6. Misconfigured — only one of username/password set
  if ((!username) !== (!password)) {
    return new Response('Server configuration error', {
      status: 500,
      headers: {'Cache-Control': 'no-store'},
    });
  }

  // 7. Neither username nor password set (but bypass secret IS set) → locked
  if (!username || !password) {
    return unauthorized();
  }

  // 8. Parse Authorization header
  const authorization = request.headers.get('Authorization');
  if (!authorization || !authorization.startsWith('Basic ')) {
    return unauthorized();
  }

  const encoded = authorization.slice(6);
  if (!encoded) return unauthorized();

  let decoded: string;
  try {
    decoded = atob(encoded);
  } catch {
    return unauthorized();
  }

  const colonIndex = decoded.indexOf(':');
  if (colonIndex === -1) return unauthorized();

  const providedUsername = decoded.slice(0, colonIndex);
  const providedPassword = decoded.slice(colonIndex + 1);

  // 9. Timing-safe credential comparison
  if (
    timingSafeEqual(username, providedUsername) &&
    timingSafeEqual(password, providedPassword)
  ) {
    return null; // Authenticated
  }

  return unauthorized();
}

function unauthorized(): Response {
  return new Response('Unauthorized', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="Staging"',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex',
    },
  });
}

const encoder = new TextEncoder();

/**
 * Constant-time string comparison using Cloudflare Workers'
 * `crypto.subtle.timingSafeEqual`. When lengths differ, compares `a`
 * against itself to maintain constant-time behavior and avoid leaking
 * credential length via timing.
 */
function timingSafeEqual(a: string, b: string): boolean {
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  const lengthsMatch = bufA.byteLength === bufB.byteLength;
  return lengthsMatch
    ? crypto.subtle.timingSafeEqual(bufA, bufB)
    : !crypto.subtle.timingSafeEqual(bufA, bufA);
}
```

Design decisions:
- **Hybrid auth**: Cookie bypass runs first (for Studio iframe), Basic Auth runs second (for humans).
  This order matters — Studio requests never reach the Basic Auth path.
- **`timingSafeEqual`**: Uses Cloudflare Workers' non-standard `crypto.subtle.timingSafeEqual`.
  Not in lib.dom typings — needs a `declare global` for TypeScript.
- **`SameSite=None; Secure; HttpOnly`** on cookie — works in cross-origin iframes.
- **`WWW-Authenticate: Basic realm="Staging"`** — triggers native browser dialog.
- **`Cache-Control: no-store`** on 401/500 — prevents caching of auth responses.
- **Production bypass**: All three env vars absent → null (no auth). This is the "all vars absent"
  safety path. Unlike gcom-tempo which returns 401 when locked by default, our production
  environments intentionally have no auth.
- **No `PUBLIC_STORE_DOMAIN` check**: gcom-tempo uses `-prd.myshopify.com` suffix to detect
  production stores. In our single-store setup, all environments share the same Shopify domain,
  so this check is replaced by "no env vars = production."

---

## 5. server.ts Integration

Synchronous — no `await` needed (unlike Options B/C):

```typescript
import {checkBasicAuth} from '~/lib/basic-auth.server';

export default {
  async fetch(
    request: Request,
    env: Env,
    executionContext: ExecutionContext,
  ): Promise<Response> {
    try {
      // Auth check — runs before ALL other handling
      const authResponse = checkBasicAuth(request, env);
      if (authResponse) return authResponse;

      // Standard Hydrogen flow (unchanged)
      const hydrogenContext = await createHydrogenRouterContext(/* ... */);
      // ...
```

---

## 6. env.d.ts

```typescript
// Cloudflare Workers non-standard extension
declare global {
  interface SubtleCrypto {
    timingSafeEqual(
      a: ArrayBufferView | ArrayBuffer,
      b: ArrayBufferView | ArrayBuffer,
    ): boolean;
  }
}

interface Env extends HydrogenEnv {
  // HTTP Basic Auth credentials — shared across staging + dev
  PRIVATE_HYDROGEN_USERNAME?: string;
  PRIVATE_HYDROGEN_PASSWORD?: string;

  // Cookie bypass secret — for Studio Presentation tool iframe
  PRIVATE_BYPASS_SECRET?: string;

  // Kill switch — set to "true" to disable auth on a non-prod environment
  PRIVATE_HYDROGEN_AUTH_DISABLED?: string;
}
```

3 env vars (4 with kill switch), all shared across staging + dev. None set in production.

**Oxygen env var scoping:**

| Variable | Scoped To | Value |
|---|---|---|
| `PRIVATE_HYDROGEN_USERNAME` | Staging + Dev | Same username |
| `PRIVATE_HYDROGEN_PASSWORD` | Staging + Dev | Same password |
| `PRIVATE_BYPASS_SECRET` | Staging + Dev | Same secret (for Studio) |
| `PRIVATE_HYDROGEN_AUTH_DISABLED` | (optional, per-env) | `"true"` if needed |

Since credentials are shared, we can scope each var to both staging and dev environments
with a single value. This works within Oxygen's constraint (one value per var name).

---

## 7. entry.server.tsx — CSP

Identical to Options A–C:

```typescript
frameAncestors: [
  "'self'",
  'https://www.sanity.io',
  'https://*.sanity.studio',
],
```

---

## 8. Sanity Schema — `oxygenProtectionBypass`

Same structure as Options A–C. The `secret` field stores the bypass secret for Studio:

```typescript
import {defineType, defineField} from 'sanity'

export default defineType({
  name: 'oxygenProtectionBypass',
  title: 'Oxygen Protection Bypass',
  type: 'document',
  fields: [
    defineField({
      name: 'environment',
      type: 'string',
      options: {list: ['staging', 'dev']},
      validation: (r) => r.required(),
    }),
    defineField({
      name: 'secret',
      title: 'Bypass Secret',
      type: 'string',
      validation: (r) => r.required(),
    }),
  ],
  preview: {select: {title: 'environment'}},
})
```

---

## 9. Studio `presentationTool` Config

Identical to Option A — Studio reads the bypass secret, appends as query param:

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

### Production workspace (no auth)

```typescript
presentationTool({
  previewUrl: {
    initial: 'https://acme.com',
    previewMode: {enable: '/api/preview-mode/enable'},
  },
})
```

---

## 10. Secret Generation and Storage

### Generate bypass secret (one-time)

```bash
openssl rand -hex 16
```

### Generate Basic Auth credentials

Choose a username and a strong password. Same pair used for staging and dev.

### Store in Oxygen env vars

| Variable | Scoped To | Value |
|---|---|---|
| `PRIVATE_HYDROGEN_USERNAME` | Staging + Dev | `chosen-username` |
| `PRIVATE_HYDROGEN_PASSWORD` | Staging + Dev | `chosen-password` |
| `PRIVATE_BYPASS_SECRET` | Staging + Dev | `hex-from-openssl` |

None set in Production.

### Store bypass secret in Sanity

```bash
npx sanity documents create --dataset production <<'EOF'
{
  "_type": "oxygenProtectionBypass",
  "_id": "oxygenProtectionBypass.staging",
  "environment": "staging",
  "secret": "<HEX_FROM_OPENSSL>"
}
EOF

npx sanity documents create --dataset production <<'EOF'
{
  "_type": "oxygenProtectionBypass",
  "_id": "oxygenProtectionBypass.dev",
  "environment": "dev",
  "secret": "<HEX_FROM_OPENSSL>"
}
EOF
```

Both docs store the same secret (since `PRIVATE_BYPASS_SECRET` is shared). They exist as
separate docs for consistency with the schema's environment field.

### Rotation

**Basic Auth credentials:**
1. Update `PRIVATE_HYDROGEN_USERNAME` and/or `PRIVATE_HYDROGEN_PASSWORD` in Oxygen → triggers redeploy
2. Distribute new credentials to stakeholders (verbally, Slack, etc.)
3. Stakeholders re-authenticate on next browser visit

**Bypass secret (Studio):**
1. Generate new secret: `openssl rand -hex 16`
2. Update `PRIVATE_BYPASS_SECRET` in Oxygen → triggers redeploy
3. Update both Sanity documents
4. Studio sessions invalidated immediately (cookie no longer matches)

---

## 11. Comparison with gcom-tempo (SAS-541)

| Aspect | gcom-tempo | This adaptation |
|---|---|---|
| Store detection | `-prd.myshopify.com` suffix check | No env vars = production bypass |
| Credentials | Per-store (multi-market) | Shared across staging + dev |
| Studio integration | Not addressed (accepts broken dialog) | Cookie bypass parallel path |
| Kill switch | `PRIVATE_HYDROGEN_AUTH_DISABLED=true` | Same |
| Local dev bypass | `NODE_ENV=development` | Same |
| Timing-safe compare | `crypto.subtle.timingSafeEqual` | Same |
| Env vars | 3 (user, pass, disabled) | 4 (user, pass, secret, disabled) |
| Locked by default | 401 when no creds configured | 401 when creds configured but not sent |
| Sanity schema | None | `oxygenProtectionBypass` (for Studio secret) |

---

## 12. Known Limitations

### No logout for Basic Auth
HTTP Basic Auth has no native logout mechanism. Browsers cache credentials for the session
(until all tabs are closed). Acceptable for a UAT/staging gate.

### Browser credential caching is per-origin
If a stakeholder authenticates on `staging.acme.com`, the browser caches credentials for that
origin. Opening a new tab to the same origin works without re-authenticating. But credentials
are NOT shared across origins (staging vs dev require separate auth).

### `pnpm preview` static assets
In local `pnpm preview` (Vite preview mode), `/assets/*` and `/fonts/*` are served by Vite's
static file server, which bypasses the Worker `fetch()` handler. Auth does NOT protect these
locally. On Oxygen, all requests route through the Worker — assets ARE protected.

### Dual auth complexity
This option has two parallel auth paths (cookie for Studio, Basic Auth for humans). This is
necessary because Basic Auth is incompatible with cross-origin iframes, but adds middleware
complexity compared to Options A–C which have a single auth path.
