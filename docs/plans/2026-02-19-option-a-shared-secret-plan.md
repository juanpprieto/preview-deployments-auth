# Option A: Shared Secret Protection Bypass — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Protect Oxygen staging/dev environments with a shared secret validated by Hydrogen server middleware, integrated with Sanity Studio's Presentation tool.

**Architecture:** A single middleware function in `server.ts` checks for a bypass cookie or query parameter before any Hydrogen processing. Valid secrets get a `SameSite=None; Secure; HttpOnly` cookie (30-day TTL). Studio's `previewMode` resolver reads the secret from a Sanity document and appends it to the iframe URL, making auth transparent to editors.

**Tech Stack:** Hydrogen 2026.1.x, React Router 7.12, `hydrogen-sanity` v6.1.x, Sanity Studio, Vitest

**Design doc:** `docs/plans/2026-02-19-option-a-shared-secret-design.md`

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

**Step 1: Add bypass secret types**

Add to the `Env` interface in `env.d.ts`:

```typescript
// Protection bypass — one per environment, only defined in its respective env
STAGING_BYPASS_SECRET?: string;
DEV_BYPASS_SECRET?: string;
```

Both optional (`?`) — only one is defined per Oxygen environment. Neither is defined in production.

**Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add env.d.ts
git commit -m "feat: add bypass secret env var types"
```

---

## Task 3: Write Failing Tests for Middleware

**Files:**
- Create: `app/lib/auth.server.test.ts`

**Step 1: Write test file**

Create `app/lib/auth.server.test.ts`:

```typescript
import {describe, it, expect} from 'vitest';
import {validateProtectionBypass} from './auth.server';

function makeRequest(url: string, cookie?: string): Request {
  const headers = new Headers();
  if (cookie) headers.set('Cookie', cookie);
  return new Request(url, {headers});
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return overrides as Env;
}

describe('validateProtectionBypass', () => {
  const SECRET = 'abc123def456abc123def456abc123de';

  describe('when no secret is configured (production)', () => {
    it('returns null (pass through)', () => {
      const result = validateProtectionBypass(
        makeRequest('https://acme.com/'),
        makeEnv(),
      );
      expect(result).toBeNull();
    });
  });

  describe('when STAGING_BYPASS_SECRET is set', () => {
    const env = makeEnv({STAGING_BYPASS_SECRET: SECRET});

    it('returns 401 when no cookie and no query param', () => {
      const result = validateProtectionBypass(
        makeRequest('https://staging.acme.com/'),
        env,
      );
      expect(result).not.toBeNull();
      expect(result!.status).toBe(401);
    });

    it('returns 401 when query param has wrong secret', () => {
      const result = validateProtectionBypass(
        makeRequest('https://staging.acme.com/?x-oxygen-bypass=wrong'),
        env,
      );
      expect(result).not.toBeNull();
      expect(result!.status).toBe(401);
    });

    it('returns 302 redirect with Set-Cookie when query param is valid', () => {
      const result = validateProtectionBypass(
        makeRequest(`https://staging.acme.com/some/path?x-oxygen-bypass=${SECRET}`),
        env,
      );
      expect(result).not.toBeNull();
      expect(result!.status).toBe(302);

      // Redirect strips the bypass param
      const location = result!.headers.get('Location')!;
      expect(location).toBe('https://staging.acme.com/some/path');
      expect(location).not.toContain('x-oxygen-bypass');

      // Cookie attributes
      const setCookie = result!.headers.get('Set-Cookie')!;
      expect(setCookie).toContain(`_oxygen_bypass=${SECRET}`);
      expect(setCookie).toContain('SameSite=None');
      expect(setCookie).toContain('Secure');
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).toContain('Path=/');
    });

    it('preserves other query params in redirect', () => {
      const result = validateProtectionBypass(
        makeRequest(`https://staging.acme.com/?foo=bar&x-oxygen-bypass=${SECRET}&baz=qux`),
        env,
      );
      const location = result!.headers.get('Location')!;
      expect(location).toContain('foo=bar');
      expect(location).toContain('baz=qux');
      expect(location).not.toContain('x-oxygen-bypass');
    });

    it('returns null (pass through) when cookie matches', () => {
      const result = validateProtectionBypass(
        makeRequest('https://staging.acme.com/', `_oxygen_bypass=${SECRET}`),
        env,
      );
      expect(result).toBeNull();
    });

    it('returns 401 when cookie has wrong value', () => {
      const result = validateProtectionBypass(
        makeRequest('https://staging.acme.com/', '_oxygen_bypass=wrong'),
        env,
      );
      expect(result!.status).toBe(401);
    });

    it('includes X-Robots-Tag: noindex on 401', () => {
      const result = validateProtectionBypass(
        makeRequest('https://staging.acme.com/'),
        env,
      );
      expect(result!.headers.get('X-Robots-Tag')).toBe('noindex');
    });

    it('includes X-Robots-Tag: noindex on 302', () => {
      const result = validateProtectionBypass(
        makeRequest(`https://staging.acme.com/?x-oxygen-bypass=${SECRET}`),
        env,
      );
      expect(result!.headers.get('X-Robots-Tag')).toBe('noindex');
    });
  });

  describe('when DEV_BYPASS_SECRET is set', () => {
    const env = makeEnv({DEV_BYPASS_SECRET: SECRET});

    it('returns null (pass through) when cookie matches', () => {
      const result = validateProtectionBypass(
        makeRequest('https://dev.acme.com/', `_oxygen_bypass=${SECRET}`),
        env,
      );
      expect(result).toBeNull();
    });

    it('returns 401 when no auth', () => {
      const result = validateProtectionBypass(
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
git commit -m "test: add failing tests for protection bypass middleware"
```

---

## Task 4: Implement Middleware

**Files:**
- Create: `app/lib/auth.server.ts`

**Step 1: Create middleware**

Create `app/lib/auth.server.ts`:

```typescript
const BYPASS_COOKIE = '_oxygen_bypass';
const BYPASS_PARAM = 'x-oxygen-bypass';
const COOKIE_TTL = 60 * 60 * 24 * 30; // 30 days

export function validateProtectionBypass(
  request: Request,
  env: Env,
): Response | null {
  const secret = env.STAGING_BYPASS_SECRET || env.DEV_BYPASS_SECRET;
  if (!secret) return null;

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
  if (cookies[BYPASS_COOKIE] === secret) return null;

  const url = new URL(request.url);
  const param = url.searchParams.get(BYPASS_PARAM);
  if (param === secret) {
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

  return new Response('Unauthorized', {
    status: 401,
    headers: {'X-Robots-Tag': 'noindex'},
  });
}
```

**Step 2: Run tests to verify they pass**

Run: `npm test`
Expected: All 10 tests PASS

**Step 3: Commit**

```bash
git add app/lib/auth.server.ts
git commit -m "feat: add shared secret protection bypass middleware"
```

---

## Task 5: Wire Middleware into server.ts

**Files:**
- Modify: `server.ts`

**Step 1: Add import**

Add at the top of `server.ts`:

```typescript
import {validateProtectionBypass} from '~/lib/auth.server';
```

**Step 2: Add middleware call**

Add as the first lines inside the `try` block of the `fetch` handler, before `createHydrogenRouterContext`:

```typescript
const authResponse = validateProtectionBypass(request, env);
if (authResponse) return authResponse;
```

**Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 4: Verify dev server starts**

Run: `npx shopify hydrogen dev`
Expected: Dev server starts. Visit `http://localhost:3000` — should load normally (no bypass secret in dev env vars locally).

**Step 5: Commit**

```bash
git add server.ts
git commit -m "feat: wire protection bypass middleware into server.ts"
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

If `createContentSecurityPolicy` is not yet called, check the swag-store reference for the full pattern.

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
- Create: `studio/schemaTypes/oxygenProtectionBypass.ts` (adjust path to match Studio project structure)
- Modify: `studio/schemaTypes/index.ts` (register the new type)

> **Note:** The Studio project may be in a separate directory. Adjust paths to match
> your Studio project structure (e.g., `~/studio/schemaTypes/`).

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

// Add to the exported array:
export const schemaTypes = [
  // ... existing types
  oxygenProtectionBypass,
]
```

**Step 3: Verify Studio starts**

Run: `npx sanity dev` (in the Studio directory)
Expected: Studio starts. The "Oxygen Protection Bypass" document type is visible.

**Step 4: Deploy schema**

Run: `npx sanity schema deploy`
Expected: Schema deployed successfully.

**Step 5: Commit**

```bash
git add studio/schemaTypes/oxygenProtectionBypass.ts studio/schemaTypes/index.ts
git commit -m "feat: add oxygenProtectionBypass schema type"
```

---

## Task 8: Generate Secrets and Create Sanity Documents

**Files:** None (CLI operations only)

**Step 1: Generate staging secret**

Run: `openssl rand -hex 16`
Save the output (e.g., `a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6`).

**Step 2: Generate dev secret**

Run: `openssl rand -hex 16`
Save the output (e.g., `f1e2d3c4b5a6f7e8d9c0b1a2f3e4d5c6`).

**Step 3: Set Oxygen env vars**

Set `STAGING_BYPASS_SECRET` scoped to the Staging environment in Shopify Admin or CLI.
Set `DEV_BYPASS_SECRET` scoped to the Dev environment in Shopify Admin or CLI.

**Step 4: Create Sanity documents**

Use the Sanity MCP tool or CLI to create two documents:

```bash
# Staging bypass doc
npx sanity documents create --dataset production <<'EOF'
{
  "_type": "oxygenProtectionBypass",
  "_id": "oxygenProtectionBypass.staging",
  "environment": "staging",
  "secret": "<STAGING_SECRET_FROM_STEP_1>"
}
EOF

# Dev bypass doc
npx sanity documents create --dataset production <<'EOF'
{
  "_type": "oxygenProtectionBypass",
  "_id": "oxygenProtectionBypass.dev",
  "environment": "dev",
  "secret": "<DEV_SECRET_FROM_STEP_2>"
}
EOF
```

**Step 5: Verify documents exist**

Query Sanity to confirm:

```
*[_type == "oxygenProtectionBypass"]{_id, environment, secret}
```

Expected: Two documents with correct secrets.

---

## Task 9: Configure Studio previewMode Resolver

**Files:**
- Modify: `studio/sanity.config.ts`

**Step 1: Add previewMode resolver to staging workspace**

In the staging workspace's `presentationTool` config:

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

In the dev workspace's `presentationTool` config:

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

Production workspace uses the simple string form — no auth needed:

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

**Step 4: Verify Studio starts with all workspaces**

Run: `npx sanity dev` (in the Studio directory)
Expected: Studio starts. All three workspaces load. Presentation tool opens without errors.

**Step 5: Commit**

```bash
git add studio/sanity.config.ts
git commit -m "feat: add previewMode resolver for bypass auth per workspace"
```

---

## Task 10: Deploy and E2E Verify

**Files:** None (deployment + manual verification)

**Step 1: Deploy Hydrogen to staging**

Run: `npx shopify hydrogen deploy --env staging`
Expected: Deployment succeeds.

**Step 2: Verify 401 on staging without auth**

Run: `curl -s -o /dev/null -w "%{http_code}" https://staging.acme.com/`
Expected: `401`

**Step 3: Verify bypass param triggers redirect + cookie**

Run: `curl -v "https://staging.acme.com/?x-oxygen-bypass=<STAGING_SECRET>"`
Expected:
- HTTP 302
- `Location` header without `x-oxygen-bypass` param
- `Set-Cookie` header with `_oxygen_bypass=<SECRET>; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=2592000`

**Step 4: Verify cookie grants access**

Run: `curl -s -o /dev/null -w "%{http_code}" -H "Cookie: _oxygen_bypass=<STAGING_SECRET>" https://staging.acme.com/`
Expected: `200`

**Step 5: Deploy Studio**

Run: `npx sanity deploy` (in the Studio directory)
Expected: Studio deploys.

**Step 6: Verify Presentation tool (staging workspace)**

1. Open Studio staging workspace
2. Navigate to Presentation tool
3. Expected: iframe loads staging storefront with visual editing overlays
4. Verify no auth prompt — the `previewMode` resolver handles it transparently

**Step 7: Verify Presentation tool (dev workspace)**

Repeat Step 6 for the dev workspace.

**Step 8: Verify production is unaffected**

Run: `curl -s -o /dev/null -w "%{http_code}" https://acme.com/`
Expected: `200` (no middleware, no auth)

---

## Summary

| Task | What | Files | Commit |
|---|---|---|---|
| 1 | Set up Vitest | `vitest.config.ts`, `package.json` | `chore: add vitest` |
| 2 | Env type declarations | `env.d.ts` | `feat: add bypass secret env var types` |
| 3 | Failing tests | `app/lib/auth.server.test.ts` | `test: add failing tests` |
| 4 | Implement middleware | `app/lib/auth.server.ts` | `feat: add middleware` |
| 5 | Wire into server.ts | `server.ts` | `feat: wire middleware` |
| 6 | CSP frame-ancestors | `app/entry.server.tsx` | `feat: add CSP` |
| 7 | Sanity schema | Studio schema files | `feat: add schema` |
| 8 | Generate secrets + docs | CLI operations | (no commit) |
| 9 | Studio previewMode | `studio/sanity.config.ts` | `feat: add previewMode resolver` |
| 10 | Deploy + E2E verify | Deployment + curl + Studio | (no commit) |
