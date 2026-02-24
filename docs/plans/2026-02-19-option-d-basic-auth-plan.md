# Option D: HTTP Basic Auth + Cookie Bypass — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Protect Oxygen staging/dev environments with HTTP Basic Auth (native browser dialog for humans) combined with a cookie-based bypass (for Sanity Studio Presentation tool iframe). Adapted from gcom-tempo SAS-541.

**Architecture:** A synchronous middleware function in `server.ts` checks three auth paths in order: (1) session cookie for Studio iframe sessions, (2) query param to initialize cookie sessions, (3) HTTP Basic Auth for direct browser access. Valid cookie/credentials pass through; otherwise 401 with `WWW-Authenticate` challenge. Studio's `previewMode` resolver reads a bypass secret from Sanity and appends it as a query param (identical to Option A).

**Tech Stack:** Hydrogen 2026.1.x, React Router 7.12, `hydrogen-sanity` v6.1.x, Sanity Studio, Vitest, Cloudflare Workers `crypto.subtle.timingSafeEqual`

**Design doc:** `docs/plans/2026-02-19-option-d-basic-auth-design.md`

---

## Task 1: Set Up Vitest

**Files:**
- Create: `vitest.config.ts`
- Modify: `package.json` (add dev dependency + test script)

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

**Step 1: Add SubtleCrypto global augmentation**

Add at the top of `env.d.ts` (before the `Env` interface):

```typescript
// Cloudflare Workers non-standard extension — not in lib.dom SubtleCrypto typings.
declare global {
  interface SubtleCrypto {
    timingSafeEqual(
      a: ArrayBufferView | ArrayBuffer,
      b: ArrayBufferView | ArrayBuffer,
    ): boolean;
  }
}
```

**Step 2: Add auth env var types**

Add to the `Env` interface in `env.d.ts`:

```typescript
// HTTP Basic Auth credentials — shared across staging + dev
PRIVATE_HYDROGEN_USERNAME?: string;
PRIVATE_HYDROGEN_PASSWORD?: string;

// Cookie bypass secret — for Studio Presentation tool iframe
PRIVATE_BYPASS_SECRET?: string;

// Kill switch — set to "true" to disable auth
PRIVATE_HYDROGEN_AUTH_DISABLED?: string;
```

All optional — none defined in production.

**Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 4: Commit**

```bash
git add env.d.ts
git commit -m "feat: add basic auth and bypass secret env var types"
```

---

## Task 3: Write Failing Tests for Middleware

**Files:**
- Create: `app/lib/basic-auth.server.test.ts`

This test file polyfills `crypto.subtle.timingSafeEqual` for Node.js/Vitest (Cloudflare Workers
extension not available in Node).

**Step 1: Write test file**

Create `app/lib/basic-auth.server.test.ts`:

```typescript
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

// Polyfill Cloudflare Workers' crypto.subtle.timingSafeEqual for Node.js/Vitest.
if (!crypto.subtle.timingSafeEqual) {
  Object.defineProperty(crypto.subtle, 'timingSafeEqual', {
    value(a: ArrayBufferView, b: ArrayBufferView): boolean {
      const bufA = new Uint8Array('buffer' in a ? a.buffer : a);
      const bufB = new Uint8Array('buffer' in b ? b.buffer : b);
      if (bufA.byteLength !== bufB.byteLength) return false;
      let result = 0;
      for (let i = 0; i < bufA.byteLength; i++) result |= bufA[i] ^ bufB[i];
      return result === 0;
    },
  });
}

import {checkBasicAuth} from './basic-auth.server';

function makeRequest(authorization?: string, cookie?: string): Request {
  const headers = new Headers();
  if (authorization) headers.set('Authorization', authorization);
  if (cookie) headers.set('Cookie', cookie);
  return new Request('https://staging.acme.com/', {headers});
}

function makeRequestWithUrl(url: string, cookie?: string): Request {
  const headers = new Headers();
  if (cookie) headers.set('Cookie', cookie);
  return new Request(url, {headers});
}

function encode(username: string, password: string): string {
  return `Basic ${btoa(`${username}:${password}`)}`;
}

const CREDS = {
  PRIVATE_HYDROGEN_USERNAME: 'admin',
  PRIVATE_HYDROGEN_PASSWORD: 'secret',
} as const;

const BYPASS_SECRET = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';

function makeEnv(
  overrides: Partial<Parameters<typeof checkBasicAuth>[1]> = {},
): Parameters<typeof checkBasicAuth>[1] {
  return overrides as Parameters<typeof checkBasicAuth>[1];
}

function expect401(result: Response | null) {
  expect(result).toBeInstanceOf(Response);
  expect(result?.status).toBe(401);
  expect(result?.headers.get('WWW-Authenticate')).toContain('Basic');
  expect(result?.headers.get('Cache-Control')).toBe('no-store');
  expect(result?.headers.get('X-Robots-Tag')).toBe('noindex');
}

describe('checkBasicAuth', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'production');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // ── Bypass paths ──────────────────────────────────────────────

  it('returns null when NODE_ENV=development', () => {
    vi.stubEnv('NODE_ENV', 'development');
    const result = checkBasicAuth(makeRequest(), makeEnv({...CREDS}));
    expect(result).toBeNull();
  });

  it('returns null when AUTH_DISABLED=true', () => {
    const result = checkBasicAuth(
      makeRequest(),
      makeEnv({PRIVATE_HYDROGEN_AUTH_DISABLED: 'true'}),
    );
    expect(result).toBeNull();
  });

  it('does not bypass for AUTH_DISABLED values other than "true"', () => {
    for (const value of ['false', 'TRUE', '1', 'yes']) {
      const result = checkBasicAuth(
        makeRequest(),
        makeEnv({...CREDS, PRIVATE_HYDROGEN_AUTH_DISABLED: value}),
      );
      expect(result).not.toBeNull();
    }
  });

  it('returns null when no env vars are set (production)', () => {
    const result = checkBasicAuth(makeRequest(), makeEnv());
    expect(result).toBeNull();
  });

  // ── Cookie bypass (Studio iframe path) ─────────────────────────

  it('returns null when session cookie matches bypass secret', () => {
    const result = checkBasicAuth(
      makeRequest(undefined, `_oxygen_bypass=${BYPASS_SECRET}`),
      makeEnv({PRIVATE_BYPASS_SECRET: BYPASS_SECRET}),
    );
    expect(result).toBeNull();
  });

  it('does not accept wrong cookie value', () => {
    const result = checkBasicAuth(
      makeRequest(undefined, '_oxygen_bypass=wrong'),
      makeEnv({...CREDS, PRIVATE_BYPASS_SECRET: BYPASS_SECRET}),
    );
    // Falls through to Basic Auth → 401
    expect401(result);
  });

  it('returns 302 with Set-Cookie when query param matches bypass secret', () => {
    const result = checkBasicAuth(
      makeRequestWithUrl(
        `https://staging.acme.com/some/path?x-oxygen-bypass=${BYPASS_SECRET}`,
      ),
      makeEnv({PRIVATE_BYPASS_SECRET: BYPASS_SECRET}),
    );
    expect(result).not.toBeNull();
    expect(result!.status).toBe(302);

    const location = result!.headers.get('Location')!;
    expect(location).toBe('https://staging.acme.com/some/path');
    expect(location).not.toContain('x-oxygen-bypass');

    const setCookie = result!.headers.get('Set-Cookie')!;
    expect(setCookie).toContain(`_oxygen_bypass=${BYPASS_SECRET}`);
    expect(setCookie).toContain('SameSite=None');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('HttpOnly');
  });

  it('preserves other query params in bypass redirect', () => {
    const result = checkBasicAuth(
      makeRequestWithUrl(
        `https://staging.acme.com/?foo=bar&x-oxygen-bypass=${BYPASS_SECRET}&baz=qux`,
      ),
      makeEnv({PRIVATE_BYPASS_SECRET: BYPASS_SECRET}),
    );
    const location = result!.headers.get('Location')!;
    expect(location).toContain('foo=bar');
    expect(location).toContain('baz=qux');
    expect(location).not.toContain('x-oxygen-bypass');
  });

  it('includes X-Robots-Tag: noindex on 302 bypass redirect', () => {
    const result = checkBasicAuth(
      makeRequestWithUrl(
        `https://staging.acme.com/?x-oxygen-bypass=${BYPASS_SECRET}`,
      ),
      makeEnv({PRIVATE_BYPASS_SECRET: BYPASS_SECRET}),
    );
    expect(result!.headers.get('X-Robots-Tag')).toBe('noindex');
  });

  // ── Misconfiguration ──────────────────────────────────────────

  it('returns 500 when only USERNAME is set', () => {
    const result = checkBasicAuth(
      makeRequest(),
      makeEnv({PRIVATE_HYDROGEN_USERNAME: 'admin'}),
    );
    expect(result!.status).toBe(500);
    expect(result!.headers.get('Cache-Control')).toBe('no-store');
    expect(result!.headers.has('WWW-Authenticate')).toBe(false);
  });

  it('returns 500 when only PASSWORD is set', () => {
    const result = checkBasicAuth(
      makeRequest(),
      makeEnv({PRIVATE_HYDROGEN_PASSWORD: 'secret'}),
    );
    expect(result!.status).toBe(500);
    expect(result!.headers.get('Cache-Control')).toBe('no-store');
    expect(result!.headers.has('WWW-Authenticate')).toBe(false);
  });

  // ── Locked by default (bypass secret only, no creds) ───────────

  it('returns 401 when only bypass secret is set (no Basic Auth creds)', () => {
    const result = checkBasicAuth(
      makeRequest(),
      makeEnv({PRIVATE_BYPASS_SECRET: BYPASS_SECRET}),
    );
    expect401(result);
  });

  // ── Basic Auth credential validation ───────────────────────────

  it('returns 401 when no Authorization header', () => {
    const result = checkBasicAuth(makeRequest(), makeEnv(CREDS));
    expect401(result);
  });

  it('returns 401 when credentials are wrong', () => {
    const result = checkBasicAuth(
      makeRequest(encode('wrong', 'creds')),
      makeEnv(CREDS),
    );
    expect401(result);
  });

  it('returns null when credentials are correct', () => {
    const result = checkBasicAuth(
      makeRequest(encode('admin', 'secret')),
      makeEnv(CREDS),
    );
    expect(result).toBeNull();
  });

  it('returns null when password contains a colon', () => {
    const env = makeEnv({
      PRIVATE_HYDROGEN_USERNAME: 'admin',
      PRIVATE_HYDROGEN_PASSWORD: 'pass:word:extra',
    });
    const result = checkBasicAuth(
      makeRequest(encode('admin', 'pass:word:extra')),
      env,
    );
    expect(result).toBeNull();
  });

  it('returns 401 when Authorization scheme is not Basic', () => {
    const result = checkBasicAuth(
      makeRequest('Bearer some-token'),
      makeEnv(CREDS),
    );
    expect401(result);
  });

  it('returns 401 when Basic payload is empty', () => {
    const result = checkBasicAuth(makeRequest('Basic '), makeEnv(CREDS));
    expect401(result);
  });

  it('returns 401 when Basic payload is invalid base64', () => {
    const result = checkBasicAuth(
      makeRequest('Basic !!!not-base64!!!'),
      makeEnv(CREDS),
    );
    expect401(result);
  });

  it('returns 401 when decoded value has no colon separator', () => {
    const result = checkBasicAuth(
      makeRequest(`Basic ${btoa('nocolonhere')}`),
      makeEnv(CREDS),
    );
    expect401(result);
  });

  // ── Combined: both auth paths configured ───────────────────────

  it('prefers cookie over Basic Auth when both present', () => {
    const result = checkBasicAuth(
      makeRequest(encode('wrong', 'creds'), `_oxygen_bypass=${BYPASS_SECRET}`),
      makeEnv({...CREDS, PRIVATE_BYPASS_SECRET: BYPASS_SECRET}),
    );
    // Cookie is valid → passes through even though Basic Auth creds are wrong
    expect(result).toBeNull();
  });

  it('falls through to Basic Auth when cookie is wrong but creds are right', () => {
    const result = checkBasicAuth(
      makeRequest(encode('admin', 'secret'), '_oxygen_bypass=wrong'),
      makeEnv({...CREDS, PRIVATE_BYPASS_SECRET: BYPASS_SECRET}),
    );
    expect(result).toBeNull();
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module './basic-auth.server'`

**Step 3: Commit**

```bash
git add app/lib/basic-auth.server.test.ts
git commit -m "test: add failing tests for basic auth + cookie bypass middleware"
```

---

## Task 4: Implement Middleware

**Files:**
- Create: `app/lib/basic-auth.server.ts`

**Step 1: Create middleware**

Create `app/lib/basic-auth.server.ts` with the full implementation from the design doc
(Section 4). See design doc for the complete ~80 lines.

Key implementation notes:
- Polyfill TypeScript declaration for `crypto.subtle.timingSafeEqual` is in `env.d.ts` (Task 2)
- `BasicAuthEnv = Pick<Env, ...>` derived from global `Env`
- Auth check order: dev bypass → kill switch → no vars (prod) → cookie → query param → misconfiguration → Basic Auth → 401

**Step 2: Run tests to verify they pass**

Run: `npm test`
Expected: All ~22 tests PASS

**Step 3: Commit**

```bash
git add app/lib/basic-auth.server.ts
git commit -m "feat: add basic auth + cookie bypass protection middleware"
```

---

## Task 5: Wire Middleware into server.ts

**Files:**
- Modify: `server.ts`

**Step 1: Add import**

Add at the top of `server.ts`:

```typescript
import {checkBasicAuth} from '~/lib/basic-auth.server';
```

**Step 2: Add middleware call**

Add as the first lines inside the `try` block, before `createHydrogenRouterContext`:

```typescript
const authResponse = checkBasicAuth(request, env);
if (authResponse) return authResponse;
```

Note: synchronous (no `await`), unlike Options B/C.

**Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 4: Verify dev server starts**

Run: `npx shopify hydrogen dev`
Expected: Dev server starts normally (`NODE_ENV=development` bypass active).

**Step 5: Commit**

```bash
git add server.ts
git commit -m "feat: wire basic auth middleware into server.ts"
```

---

## Task 6: Add CSP frame-ancestors

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

## Task 7: Create Sanity Schema

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

## Task 8: Generate Secrets and Create Sanity Documents

**Files:** None (CLI operations only)

**Step 1: Generate bypass secret**

Run: `openssl rand -hex 16`
Save the output (e.g., `a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6`).

**Step 2: Choose Basic Auth credentials**

Pick a username and strong password for stakeholders.

**Step 3: Set Oxygen env vars**

| Variable | Scoped To | Value |
|---|---|---|
| `PRIVATE_HYDROGEN_USERNAME` | Staging + Dev | chosen username |
| `PRIVATE_HYDROGEN_PASSWORD` | Staging + Dev | chosen password |
| `PRIVATE_BYPASS_SECRET` | Staging + Dev | hex from Step 1 |

None set in Production.

**Step 4: Create Sanity documents**

```bash
npx sanity documents create --dataset production <<'EOF'
{
  "_type": "oxygenProtectionBypass",
  "_id": "oxygenProtectionBypass.staging",
  "environment": "staging",
  "secret": "<BYPASS_SECRET_FROM_STEP_1>"
}
EOF

npx sanity documents create --dataset production <<'EOF'
{
  "_type": "oxygenProtectionBypass",
  "_id": "oxygenProtectionBypass.dev",
  "environment": "dev",
  "secret": "<BYPASS_SECRET_FROM_STEP_1>"
}
EOF
```

Both docs store the same secret (shared credentials model).

**Step 5: Verify documents exist**

Query: `*[_type == "oxygenProtectionBypass"]{_id, environment, secret}`
Expected: Two documents with the same secret.

---

## Task 9: Configure Studio previewMode Resolver

**Files:**
- Modify: `studio/sanity.config.ts`

**Step 1: Add previewMode resolver to staging workspace**

Identical to Option A — Studio reads bypass secret, appends as query param:

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

**Step 3: Production workspace (no auth)**

```typescript
presentationTool({
  previewUrl: {
    initial: 'https://acme.com',
    previewMode: {enable: '/api/preview-mode/enable'},
  },
})
```

**Step 4: Verify Studio starts**

Run: `npx sanity dev`
Expected: All workspaces load.

**Step 5: Commit**

```bash
git add studio/sanity.config.ts
git commit -m "feat: add previewMode resolver for bypass auth per workspace"
```

---

## Task 10: Deploy and E2E Verify

### Phase 1: Hydrogen deployment

**Step 1: Deploy to staging**

Run: `npx shopify hydrogen deploy --env staging`

**Step 2: Verify Basic Auth challenge**

Run: `curl -s -o /dev/null -w "%{http_code}" https://staging.acme.com/`
Expected: `401`

Run: `curl -s -D- https://staging.acme.com/ | head -10`
Expected: `WWW-Authenticate: Basic realm="Staging"`

**Step 3: Verify correct credentials pass**

Run: `curl -s -o /dev/null -w "%{http_code}" -u "admin:secret" https://staging.acme.com/`
Expected: `200`

**Step 4: Verify wrong credentials rejected**

Run: `curl -s -o /dev/null -w "%{http_code}" -u "wrong:creds" https://staging.acme.com/`
Expected: `401`

**Step 5: Verify cookie bypass (Studio path)**

Run: `curl -v "https://staging.acme.com/?x-oxygen-bypass=<SECRET>"`
Expected:
- HTTP 302
- `Location` without `x-oxygen-bypass`
- `Set-Cookie` with `_oxygen_bypass=<SECRET>; SameSite=None; Secure; HttpOnly`

Run: `curl -s -o /dev/null -w "%{http_code}" -H "Cookie: _oxygen_bypass=<SECRET>" https://staging.acme.com/`
Expected: `200`

### Phase 2: Studio verification

**Step 6: Deploy Studio**

Run: `npx sanity deploy`

**Step 7: Verify Presentation tool (staging)**

1. Open Studio staging workspace
2. Navigate to Presentation tool
3. Expected: iframe loads staging storefront with visual editing overlays
4. Verify no auth prompt — the cookie bypass handles it transparently

**Step 8: Verify Presentation tool (dev)**

Repeat Step 7 for dev workspace.

### Phase 3: Safety checks

**Step 9: Verify production is unaffected**

Run: `curl -s -o /dev/null -w "%{http_code}" https://acme.com/`
Expected: `200` (no middleware, no auth)

**Step 10: Verify static assets are protected**

Run: `curl -s -o /dev/null -w "%{http_code}" https://staging.acme.com/assets/some-file.js`
Expected: `401` (all requests go through Worker on Oxygen)

---

## Summary

| Task | What | Files | Commit |
|---|---|---|---|
| 1 | Set up Vitest | `vitest.config.ts`, `package.json` | `chore: add vitest` |
| 2 | Env type declarations | `env.d.ts` | `feat: add auth env var types` |
| 3 | Failing tests | `app/lib/basic-auth.server.test.ts` | `test: add failing tests` |
| 4 | Implement middleware | `app/lib/basic-auth.server.ts` | `feat: add middleware` |
| 5 | Wire into server.ts | `server.ts` | `feat: wire middleware` |
| 6 | CSP frame-ancestors | `app/entry.server.tsx` | `feat: add CSP` |
| 7 | Sanity schema | Studio schema files | `feat: add schema` |
| 8 | Generate secrets + docs | CLI operations | (no commit) |
| 9 | Studio previewMode | `studio/sanity.config.ts` | `feat: add previewMode` |
| 10 | Deploy + E2E verify | Deployment + curl + Studio | (no commit) |

**10 tasks, 8 commits** — same as Option A.

**Compared to Option A:**
- +1 env var (`PRIVATE_HYDROGEN_USERNAME`, `PRIVATE_HYDROGEN_PASSWORD`, `PRIVATE_BYPASS_SECRET` vs just `STAGING_BYPASS_SECRET`/`DEV_BYPASS_SECRET`)
- +`SubtleCrypto` global augmentation for `timingSafeEqual` typings
- +`timingSafeEqual` polyfill in test file (for Node.js)
- Synchronous middleware (same as A, unlike B/C which are async)
- Larger middleware (~80 lines vs ~25 for A) due to dual auth paths
- Same Sanity schema, same Studio config, same cookie behavior
- Stakeholders authenticate via native browser dialog (no special link needed)
- No logout mechanism for Basic Auth path (browser caches credentials per session)

**Compared to gcom-tempo SAS-541:**
- No `PUBLIC_STORE_DOMAIN` suffix check (single store; "no vars = production" replaces it)
- Added cookie bypass path for Sanity Studio iframe compatibility
- Shared credentials across staging + dev (vs per-store in gcom-tempo)
- Added `PRIVATE_BYPASS_SECRET` env var + Sanity doc + Studio previewMode resolver
- Same timing-safe comparison, same polyfill, same locked-by-default safety
