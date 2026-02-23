# Option B: Self-Issued JWT Protection Bypass — Design

> Implementation-ready design for protecting Oxygen staging/dev environments with HMAC-SHA256
> signed JWTs validated by Hydrogen server middleware.

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
| 1 | `app/lib/auth.server.ts` | Middleware: verify HMAC JWT, set cookie, return 401 | New |
| 2 | `server.ts` | Call middleware before request handler (async) | Modified (+2 lines) |
| 3 | `env.d.ts` | Type declarations for signing key env vars | Modified |
| 4 | `app/entry.server.tsx` | CSP `frame-ancestors` for Studio domain | Modified |
| 5 | `scripts/generate-bypass-jwt.ts` | CLI script to generate signed JWTs | New |
| 6 | Studio: `schemaTypes/oxygenProtectionBypass.ts` | Bypass document type | New |
| 7 | Studio: `sanity.config.ts` | `previewMode` resolver per workspace | Modified |
| 8 | Sanity documents | One bypass doc per environment with JWT | Created via CLI |

**What differs from Option A:**
- Middleware uses `crypto.subtle.verify()` instead of string comparison
- Middleware is `async` (Web Crypto API is async)
- Env var stores an HMAC signing key (not the bypass value itself)
- Sanity doc stores a signed JWT (not a raw secret)
- New CLI script (`scripts/generate-bypass-jwt.ts`) generates JWTs
- Cookie stores the JWT (same verification path as query param)

---

## 2. Data Flow

```
Studio Presentation tool opens iframe
  → previewMode resolver queries Sanity for bypass JWT
  → constructs URL: staging.acme.com/api/preview-mode/enable?x-oxygen-bypass=eyJhbG...
  → iframe loads URL

server.ts receives request
  → await validateProtectionBypass(request, env)
    → no cookie → checks query param
    → splits JWT → verifies HMAC-SHA256 signature with signing key
    → checks exp claim (if present)
    → valid → 302 redirect to clean URL + Set-Cookie (JWT as value, SameSite=None)

iframe reloads at clean URL
  → await validateProtectionBypass(request, env)
    → cookie contains JWT → verifies signature → valid → returns null (pass through)
  → request reaches React Router → normal rendering + visual editing
```

---

## 3. Middleware — `app/lib/auth.server.ts`

```typescript
const BYPASS_COOKIE = '_oxygen_bypass';
const BYPASS_PARAM = 'x-oxygen-bypass';
const COOKIE_TTL = 60 * 60 * 24 * 30; // 30 days

export async function validateProtectionBypass(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const signingKey = env.STAGING_BYPASS_SIGNING_KEY || env.DEV_BYPASS_SIGNING_KEY;
  if (!signingKey) return null; // Production — no custom auth

  // 1. Check cookie
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
  const cookieJwt = cookies[BYPASS_COOKIE];
  if (cookieJwt && (await verifyJwt(cookieJwt, signingKey))) return null;

  // 2. Check query param
  const url = new URL(request.url);
  const paramJwt = url.searchParams.get(BYPASS_PARAM);
  if (paramJwt && (await verifyJwt(paramJwt, signingKey))) {
    url.searchParams.delete(BYPASS_PARAM);
    return new Response(null, {
      status: 302,
      headers: {
        Location: url.toString(),
        'Set-Cookie': [
          `${BYPASS_COOKIE}=${paramJwt}`,
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

async function verifyJwt(token: string, secret: string): Promise<boolean> {
  try {
    const [header, payload, signature] = token.split('.');
    if (!header || !payload || !signature) return false;

    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      {name: 'HMAC', hash: 'SHA-256'},
      false,
      ['verify'],
    );

    const data = new TextEncoder().encode(`${header}.${payload}`);
    const sig = base64UrlDecode(signature);
    const valid = await crypto.subtle.verify('HMAC', key, sig, data);
    if (!valid) return false;

    // Check expiry (if present — no-expiry JWTs omit the exp claim)
    const claims = JSON.parse(atob(payload));
    if (claims.exp && claims.exp < Math.floor(Date.now() / 1000)) return false;

    return true;
  } catch {
    return false;
  }
}

function base64UrlDecode(str: string): Uint8Array {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}
```

Design decisions:
- **`async` function** — `crypto.subtle` is async. server.ts must `await` the call.
- **Cookie stores the JWT** — same verification path for cookie and query param. JWT is ~150
  chars, fine for a cookie.
- **`exp` claim: 30-day default** — configurable at generation time via `--ttl` flag (e.g.,
  `--ttl 90d`). Changing expiry requires regenerating the JWT and updating the Sanity doc.
- **`SameSite=None; Secure; HttpOnly`** — works in cross-origin iframes.
- **No external dependencies** — uses platform Web Crypto (`crypto.subtle`), available in
  Oxygen/Cloudflare Workers and Node 18+.
- **Tamper-proof** — HMAC signature prevents forging tokens. Option A's shared secret can be
  guessed; a JWT requires the signing key.

---

## 4. server.ts Integration

One difference from Option A — the call is `await`:

```typescript
import {validateProtectionBypass} from '~/lib/auth.server';

export default {
  async fetch(
    request: Request,
    env: Env,
    executionContext: ExecutionContext,
  ): Promise<Response> {
    try {
      // Auth bypass check — async for Web Crypto verification
      const authResponse = await validateProtectionBypass(request, env);
      if (authResponse) return authResponse;

      // Standard Hydrogen flow (unchanged)
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

---

## 5. env.d.ts

```typescript
interface Env extends HydrogenEnv {
  // ... existing vars

  // Protection bypass HMAC signing keys — one per environment
  STAGING_BYPASS_SIGNING_KEY?: string;
  DEV_BYPASS_SIGNING_KEY?: string;
}
```

Different var names from Option A (`_SIGNING_KEY` not `_SECRET`) — this is an HMAC key used
to verify JWTs, not the bypass value itself.

---

## 6. entry.server.tsx — CSP

Identical to Option A:

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

---

## 7. CLI Script — `scripts/generate-bypass-jwt.ts`

```typescript
// scripts/generate-bypass-jwt.ts
// Usage: npx tsx scripts/generate-bypass-jwt.ts <signing-key> [--ttl 30d]
//   --ttl: 30d (default), 90d, 12h, 60m, or "none" for no expiry

const args = process.argv.slice(2);
const signingKey = args[0];
if (!signingKey) {
  console.error('Usage: npx tsx scripts/generate-bypass-jwt.ts <signing-key> [--ttl 30d]');
  process.exit(1);
}

const ttlArg = args.indexOf('--ttl') !== -1 ? args[args.indexOf('--ttl') + 1] : '30d';
const ttlSeconds = parseTtl(ttlArg);

const header = base64Url(JSON.stringify({alg: 'HS256', typ: 'JWT'}));
const now = Math.floor(Date.now() / 1000);
const payload = base64Url(
  JSON.stringify({
    iat: now,
    ...(ttlSeconds ? {exp: now + ttlSeconds} : {}),
    purpose: 'oxygen-bypass',
  }),
);

const key = await crypto.subtle.importKey(
  'raw',
  new TextEncoder().encode(signingKey),
  {name: 'HMAC', hash: 'SHA-256'},
  false,
  ['sign'],
);
const sig = await crypto.subtle.sign(
  'HMAC',
  key,
  new TextEncoder().encode(`${header}.${payload}`),
);
const signature = base64Url(sig);

console.log(`${header}.${payload}.${signature}`);

function base64Url(input: string | ArrayBuffer): string {
  const str =
    typeof input === 'string'
      ? btoa(input)
      : btoa(String.fromCharCode(...new Uint8Array(input)));
  return str.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function parseTtl(val: string): number | null {
  if (val === 'none') return null;
  const match = val.match(/^(\d+)([dhm])$/);
  if (!match) throw new Error(`Invalid TTL: ${val}. Use 30d, 12h, 60m, or none.`);
  const [, n, unit] = match;
  const multipliers: Record<string, number> = {d: 86400, h: 3600, m: 60};
  return parseInt(n) * multipliers[unit];
}
```

Requires `tsx` as a dev dependency: `npm install -D tsx`

---

## 8. Sanity Schema — `oxygenProtectionBypass`

Same structure as Option A. The `secret` field stores a JWT instead of a raw string:

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
      title: 'Bypass JWT',
      type: 'string',
      validation: (r) => r.required(),
    }),
  ],
  preview: {
    select: {title: 'environment'},
  },
})
```

Documents:
```json
{
  "_type": "oxygenProtectionBypass",
  "_id": "oxygenProtectionBypass.staging",
  "environment": "staging",
  "secret": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

---

## 9. Studio `presentationTool` Config

Identical to Option A — the resolver reads `secret` from the Sanity doc and appends it as a
query parameter. Doesn't matter that the value is a JWT instead of a raw string.

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

## 10. Secret Generation and Storage

### Generate signing key (one per environment)

```bash
# 256-bit HMAC key (64-char hex string)
openssl rand -hex 32
```

### Generate JWT (uses the signing key)

```bash
# 30-day expiry (default)
npx tsx scripts/generate-bypass-jwt.ts <signing-key>

# 90-day expiry
npx tsx scripts/generate-bypass-jwt.ts <signing-key> --ttl 90d

# No expiry
npx tsx scripts/generate-bypass-jwt.ts <signing-key> --ttl none
```

### Store in Oxygen env vars

| Variable | Scoped To | Value |
|---|---|---|
| `STAGING_BYPASS_SIGNING_KEY` | Staging environment only | `<64-char-hex-signing-key>` |
| `DEV_BYPASS_SIGNING_KEY` | Dev environment only | `<64-char-hex-signing-key>` |

Neither is set in Production — middleware auto-skips.

### Store JWT in Sanity

```bash
npx sanity documents create --dataset production <<'EOF'
{
  "_type": "oxygenProtectionBypass",
  "_id": "oxygenProtectionBypass.staging",
  "environment": "staging",
  "secret": "<JWT_FROM_GENERATE_SCRIPT>"
}
EOF

npx sanity documents create --dataset production <<'EOF'
{
  "_type": "oxygenProtectionBypass",
  "_id": "oxygenProtectionBypass.dev",
  "environment": "dev",
  "secret": "<JWT_FROM_GENERATE_SCRIPT>"
}
EOF
```

### Rotation

1. Generate new signing key: `openssl rand -hex 32`
2. Generate new JWT: `npx tsx scripts/generate-bypass-jwt.ts <new-key>`
3. Update Oxygen env var (signing key) → triggers redeploy
4. Update Sanity document (JWT)
5. Distribute new stakeholder link
6. All old JWTs and cookies invalidated (signature won't verify with new key)
