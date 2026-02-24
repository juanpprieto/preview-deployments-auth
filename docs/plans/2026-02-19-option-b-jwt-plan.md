# Option B: Self-Issued JWT Protection Bypass — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Protect Oxygen staging/dev environments with HMAC-SHA256 signed JWTs validated by Hydrogen server middleware, integrated with Sanity Studio's Presentation tool.

**Architecture:** An async middleware function in `server.ts` verifies JWT signatures using Web Crypto before any Hydrogen processing. Valid JWTs get a `SameSite=None; Secure; HttpOnly` cookie (30-day browser TTL). The JWT itself has a configurable `exp` claim (default 30 days). A CLI script generates signed JWTs. Studio's `previewMode` resolver reads the JWT from a Sanity document and appends it to the iframe URL.

**Tech Stack:** Hydrogen 2026.1.x, React Router 7.12, `hydrogen-sanity` v6.1.x, Sanity Studio, Vitest, Web Crypto API, tsx

**Design doc:** `docs/plans/2026-02-19-option-b-jwt-design.md`

---

## Task 1: Set Up Vitest

**Files:**
- Create: `vitest.config.ts`
- Modify: `package.json`

**Step 1: Install vitest**

Run: `npm install -D vitest`

**Step 2: Create vitest config**

Create `vitest.config.ts`:

```typescript
import {defineConfig} from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: 'node',
  },
});
```

**Step 3: Add test script to package.json**

Add to `"scripts"`:

```json
"test": "vitest run",
"test:watch": "vitest"
```

**Step 4: Verify vitest runs**

Run: `npm test`
Expected: "No test files found" (no error)

**Step 5: Commit**

```bash
git add vitest.config.ts package.json package-lock.json
git commit -m "chore: add vitest for unit testing"
```

---

## Task 2: Add Env Type Declarations

**Files:**
- Modify: `env.d.ts`

**Step 1: Add signing key types**

Add to the `Env` interface in `env.d.ts`:

```typescript
// Protection bypass HMAC signing keys — one per environment
STAGING_BYPASS_SIGNING_KEY?: string;
DEV_BYPASS_SIGNING_KEY?: string;
```

**Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add env.d.ts
git commit -m "feat: add bypass signing key env var types"
```

---

## Task 3: Create JWT Generation Script

**Files:**
- Create: `scripts/generate-bypass-jwt.ts`
- Modify: `package.json` (add tsx dev dependency)

**Step 1: Install tsx**

Run: `npm install -D tsx`

**Step 2: Create script**

Create `scripts/generate-bypass-jwt.ts`:

```typescript
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

**Step 3: Verify script works**

Run: `npx tsx scripts/generate-bypass-jwt.ts test-key-12345`
Expected: Outputs a JWT string like `eyJhbGci...`

Run: `npx tsx scripts/generate-bypass-jwt.ts test-key-12345 --ttl 90d`
Expected: Outputs a JWT with 90-day expiry

**Step 4: Commit**

```bash
git add scripts/generate-bypass-jwt.ts package.json package-lock.json
git commit -m "feat: add CLI script for bypass JWT generation"
```

---

## Task 4: Write Failing Tests for Middleware

**Files:**
- Create: `app/lib/auth.server.test.ts`

**Step 1: Write test helper to generate JWTs for tests**

Create `app/lib/auth.server.test.ts`:

```typescript
import {describe, it, expect, beforeAll} from 'vitest';
import {validateProtectionBypass} from './auth.server';

const SIGNING_KEY = 'test-signing-key-for-unit-tests-only';

// Helper: generate a JWT for testing
async function generateTestJwt(
  key: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const header = base64Url(JSON.stringify({alg: 'HS256', typ: 'JWT'}));
  const now = Math.floor(Date.now() / 1000);
  const payload = base64Url(
    JSON.stringify({iat: now, exp: now + 86400, purpose: 'oxygen-bypass', ...overrides}),
  );

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(key),
    {name: 'HMAC', hash: 'SHA-256'},
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign(
    'HMAC',
    cryptoKey,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${base64Url(sig)}`;
}

function base64Url(input: string | ArrayBuffer): string {
  const str =
    typeof input === 'string'
      ? btoa(input)
      : btoa(String.fromCharCode(...new Uint8Array(input)));
  return str.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function makeRequest(url: string, cookie?: string): Request {
  const headers = new Headers();
  if (cookie) headers.set('Cookie', cookie);
  return new Request(url, {headers});
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return overrides as Env;
}

describe('validateProtectionBypass', () => {
  let validJwt: string;
  let expiredJwt: string;

  beforeAll(async () => {
    validJwt = await generateTestJwt(SIGNING_KEY);
    expiredJwt = await generateTestJwt(SIGNING_KEY, {exp: 1000}); // expired in 1970
  });

  describe('when no signing key is configured (production)', () => {
    it('returns null (pass through)', async () => {
      const result = await validateProtectionBypass(
        makeRequest('https://acme.com/'),
        makeEnv(),
      );
      expect(result).toBeNull();
    });
  });

  describe('when STAGING_BYPASS_SIGNING_KEY is set', () => {
    const env = makeEnv({STAGING_BYPASS_SIGNING_KEY: SIGNING_KEY});

    it('returns 401 when no cookie and no query param', async () => {
      const result = await validateProtectionBypass(
        makeRequest('https://staging.acme.com/'),
        env,
      );
      expect(result).not.toBeNull();
      expect(result!.status).toBe(401);
    });

    it('returns 401 when query param has invalid JWT', async () => {
      const result = await validateProtectionBypass(
        makeRequest('https://staging.acme.com/?x-oxygen-bypass=not-a-jwt'),
        env,
      );
      expect(result!.status).toBe(401);
    });

    it('returns 401 when JWT signed with wrong key', async () => {
      const wrongKeyJwt = await generateTestJwt('wrong-key');
      const result = await validateProtectionBypass(
        makeRequest(`https://staging.acme.com/?x-oxygen-bypass=${wrongKeyJwt}`),
        env,
      );
      expect(result!.status).toBe(401);
    });

    it('returns 401 when JWT is expired', async () => {
      const result = await validateProtectionBypass(
        makeRequest(`https://staging.acme.com/?x-oxygen-bypass=${expiredJwt}`),
        env,
      );
      expect(result!.status).toBe(401);
    });

    it('returns 302 redirect with Set-Cookie when JWT is valid', async () => {
      const result = await validateProtectionBypass(
        makeRequest(`https://staging.acme.com/some/path?x-oxygen-bypass=${validJwt}`),
        env,
      );
      expect(result).not.toBeNull();
      expect(result!.status).toBe(302);

      const location = result!.headers.get('Location')!;
      expect(location).toBe('https://staging.acme.com/some/path');
      expect(location).not.toContain('x-oxygen-bypass');

      const setCookie = result!.headers.get('Set-Cookie')!;
      expect(setCookie).toContain(`_oxygen_bypass=${validJwt}`);
      expect(setCookie).toContain('SameSite=None');
      expect(setCookie).toContain('Secure');
      expect(setCookie).toContain('HttpOnly');
    });

    it('preserves other query params in redirect', async () => {
      const result = await validateProtectionBypass(
        makeRequest(`https://staging.acme.com/?foo=bar&x-oxygen-bypass=${validJwt}&baz=qux`),
        env,
      );
      const location = result!.headers.get('Location')!;
      expect(location).toContain('foo=bar');
      expect(location).toContain('baz=qux');
      expect(location).not.toContain('x-oxygen-bypass');
    });

    it('returns null (pass through) when cookie has valid JWT', async () => {
      const result = await validateProtectionBypass(
        makeRequest('https://staging.acme.com/', `_oxygen_bypass=${validJwt}`),
        env,
      );
      expect(result).toBeNull();
    });

    it('returns 401 when cookie has expired JWT', async () => {
      const result = await validateProtectionBypass(
        makeRequest('https://staging.acme.com/', `_oxygen_bypass=${expiredJwt}`),
        env,
      );
      expect(result!.status).toBe(401);
    });

    it('includes X-Robots-Tag: noindex on 401', async () => {
      const result = await validateProtectionBypass(
        makeRequest('https://staging.acme.com/'),
        env,
      );
      expect(result!.headers.get('X-Robots-Tag')).toBe('noindex');
    });
  });

  describe('when DEV_BYPASS_SIGNING_KEY is set', () => {
    const env = makeEnv({DEV_BYPASS_SIGNING_KEY: SIGNING_KEY});

    it('returns null (pass through) when cookie has valid JWT', async () => {
      const result = await validateProtectionBypass(
        makeRequest('https://dev.acme.com/', `_oxygen_bypass=${validJwt}`),
        env,
      );
      expect(result).toBeNull();
    });

    it('returns 401 when no auth', async () => {
      const result = await validateProtectionBypass(
        makeRequest('https://dev.acme.com/'),
        env,
      );
      expect(result!.status).toBe(401);
    });
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module './auth.server'`

**Step 3: Commit**

```bash
git add app/lib/auth.server.test.ts
git commit -m "test: add failing tests for JWT protection bypass middleware"
```

---

## Task 5: Implement Middleware

**Files:**
- Create: `app/lib/auth.server.ts`

**Step 1: Create middleware**

Create `app/lib/auth.server.ts`:

```typescript
const BYPASS_COOKIE = '_oxygen_bypass';
const BYPASS_PARAM = 'x-oxygen-bypass';
const COOKIE_TTL = 60 * 60 * 24 * 30; // 30 days

export async function validateProtectionBypass(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const signingKey = env.STAGING_BYPASS_SIGNING_KEY || env.DEV_BYPASS_SIGNING_KEY;
  if (!signingKey) return null;

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

**Step 2: Run tests to verify they pass**

Run: `npm test`
Expected: All 12 tests PASS

**Step 3: Commit**

```bash
git add app/lib/auth.server.ts
git commit -m "feat: add JWT protection bypass middleware with HMAC-SHA256 verification"
```

---

## Task 6: Wire Middleware into server.ts

**Files:**
- Modify: `server.ts`

**Step 1: Add import**

Add at the top of `server.ts`:

```typescript
import {validateProtectionBypass} from '~/lib/auth.server';
```

**Step 2: Add async middleware call**

Add as the first lines inside the `try` block, before `createHydrogenRouterContext`:

```typescript
const authResponse = await validateProtectionBypass(request, env);
if (authResponse) return authResponse;
```

**Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 4: Verify dev server starts**

Run: `npx shopify hydrogen dev`
Expected: Dev server starts normally (no signing key in local env).

**Step 5: Commit**

```bash
git add server.ts
git commit -m "feat: wire JWT protection bypass middleware into server.ts"
```

---

## Task 7: Add CSP frame-ancestors

**Files:**
- Modify: `app/entry.server.tsx`

**Step 1: Add Studio domains to frame-ancestors**

Find the `createContentSecurityPolicy` call. Add `frameAncestors`:

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

**Step 2: Verify dev server still starts**

Run: `npx shopify hydrogen dev`
Expected: No errors.

**Step 3: Commit**

```bash
git add app/entry.server.tsx
git commit -m "feat: add Sanity Studio to CSP frame-ancestors"
```

---

## Task 8: Create Sanity Schema

**Files:**
- Create: `studio/schemaTypes/oxygenProtectionBypass.ts`
- Modify: `studio/schemaTypes/index.ts`

**Step 1: Create schema type**

Create `studio/schemaTypes/oxygenProtectionBypass.ts`:

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

**Step 2: Register in schema index**

Add to `studio/schemaTypes/index.ts`:

```typescript
import oxygenProtectionBypass from './oxygenProtectionBypass'

export const schemaTypes = [
  // ... existing types
  oxygenProtectionBypass,
]
```

**Step 3: Verify Studio starts**

Run: `npx sanity dev`
Expected: Studio starts. "Oxygen Protection Bypass" document type visible.

**Step 4: Deploy schema**

Run: `npx sanity schema deploy`

**Step 5: Commit**

```bash
git add studio/schemaTypes/oxygenProtectionBypass.ts studio/schemaTypes/index.ts
git commit -m "feat: add oxygenProtectionBypass schema type"
```

---

## Task 9: Generate Secrets, JWTs, and Create Sanity Documents

**Files:** None (CLI operations only)

**Step 1: Generate staging signing key**

Run: `openssl rand -hex 32`
Save the output.

**Step 2: Generate staging JWT**

Run: `npx tsx scripts/generate-bypass-jwt.ts <staging-signing-key>`
Save the output JWT.

**Step 3: Generate dev signing key**

Run: `openssl rand -hex 32`
Save the output.

**Step 4: Generate dev JWT**

Run: `npx tsx scripts/generate-bypass-jwt.ts <dev-signing-key>`
Save the output JWT.

**Step 5: Set Oxygen env vars**

Set `STAGING_BYPASS_SIGNING_KEY` scoped to Staging environment.
Set `DEV_BYPASS_SIGNING_KEY` scoped to Dev environment.

**Step 6: Create Sanity documents**

```bash
npx sanity documents create --dataset production <<'EOF'
{
  "_type": "oxygenProtectionBypass",
  "_id": "oxygenProtectionBypass.staging",
  "environment": "staging",
  "secret": "<STAGING_JWT>"
}
EOF

npx sanity documents create --dataset production <<'EOF'
{
  "_type": "oxygenProtectionBypass",
  "_id": "oxygenProtectionBypass.dev",
  "environment": "dev",
  "secret": "<DEV_JWT>"
}
EOF
```

**Step 7: Verify documents exist**

Query: `*[_type == "oxygenProtectionBypass"]{_id, environment, secret}`
Expected: Two documents with JWTs.

---

## Task 10: Configure Studio previewMode Resolver

**Files:**
- Modify: `studio/sanity.config.ts`

**Step 1: Add previewMode resolver to staging workspace**

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

**Step 2: Add previewMode resolver to dev workspace**

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

**Step 3: Production workspace (no resolver)**

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

**Step 4: Verify Studio starts**

Run: `npx sanity dev`
Expected: All workspaces load.

**Step 5: Commit**

```bash
git add studio/sanity.config.ts
git commit -m "feat: add previewMode resolver for JWT bypass auth per workspace"
```

---

## Task 11: Deploy and E2E Verify

**Step 1: Deploy Hydrogen to staging**

Run: `npx shopify hydrogen deploy --env staging`

**Step 2: Verify 401 without auth**

Run: `curl -s -o /dev/null -w "%{http_code}" https://staging.acme.com/`
Expected: `401`

**Step 3: Verify JWT bypass triggers redirect + cookie**

Run: `curl -v "https://staging.acme.com/?x-oxygen-bypass=<STAGING_JWT>"`
Expected:
- HTTP 302
- `Location` header without `x-oxygen-bypass`
- `Set-Cookie` with `_oxygen_bypass=eyJ...; SameSite=None; Secure; HttpOnly`

**Step 4: Verify cookie grants access**

Run: `curl -s -o /dev/null -w "%{http_code}" -H "Cookie: _oxygen_bypass=<STAGING_JWT>" https://staging.acme.com/`
Expected: `200`

**Step 5: Verify expired JWT is rejected**

Generate expired JWT: `npx tsx scripts/generate-bypass-jwt.ts <key> --ttl 1m`
Wait 2 minutes, then:
Run: `curl -s -o /dev/null -w "%{http_code}" "https://staging.acme.com/?x-oxygen-bypass=<EXPIRED_JWT>"`
Expected: `401`

**Step 6: Deploy Studio and verify Presentation tool**

Run: `npx sanity deploy`
Open Studio staging workspace → Presentation tool → verify iframe loads with visual editing.

**Step 7: Verify production is unaffected**

Run: `curl -s -o /dev/null -w "%{http_code}" https://acme.com/`
Expected: `200`

---

## Summary

| Task | What | Files | Commit |
|---|---|---|---|
| 1 | Set up Vitest | `vitest.config.ts`, `package.json` | `chore: add vitest` |
| 2 | Env type declarations | `env.d.ts` | `feat: add signing key types` |
| 3 | JWT generation script | `scripts/generate-bypass-jwt.ts` | `feat: add JWT gen script` |
| 4 | Failing tests | `app/lib/auth.server.test.ts` | `test: add failing tests` |
| 5 | Implement middleware | `app/lib/auth.server.ts` | `feat: add JWT middleware` |
| 6 | Wire into server.ts | `server.ts` | `feat: wire middleware` |
| 7 | CSP frame-ancestors | `app/entry.server.tsx` | `feat: add CSP` |
| 8 | Sanity schema | Studio schema files | `feat: add schema` |
| 9 | Generate secrets + docs | CLI operations | (no commit) |
| 10 | Studio previewMode | `studio/sanity.config.ts` | `feat: add previewMode resolver` |
| 11 | Deploy + E2E verify | Deployment + curl + Studio | (no commit) |

**Compared to Option A:** +1 task (JWT generation script), +1 dev dependency (tsx), async middleware, 2 more test cases (expired JWT, wrong signing key). Same Sanity schema, same Studio config, same cookie behavior.
