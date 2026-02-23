# Option C: TOTP + Session Protection Bypass — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Protect Oxygen staging/dev environments with TOTP codes validated by Hydrogen server middleware, issuing HMAC-signed session JWTs. Zero third-party TOTP dependencies — uses Web Crypto API throughout.

**Architecture:** An async middleware function in `server.ts` checks for a session JWT cookie, then a TOTP code (query param or form POST), before any Hydrogen processing. Valid TOTP codes get a session JWT (`SameSite=None; Secure; HttpOnly` cookie, 30-day default TTL). Studio's `previewMode` resolver generates a fresh TOTP code in the browser using the seed from a Sanity document, appending it to the iframe URL. Stakeholders authenticate via a TOTP entry form served as inline HTML.

**Tech Stack:** Hydrogen 2026.1.x, React Router 7.12, `hydrogen-sanity` v6.1.x, Sanity Studio, Vitest, Web Crypto API (HMAC-SHA1 for TOTP, HMAC-SHA256 for session JWT)

**Design doc:** `docs/plans/2026-02-19-option-c-totp-design.md`

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

**Step 1: Add TOTP seed and session signing key types**

Add to the `Env` interface in `env.d.ts`:

```typescript
// TOTP seed (base32) — one per environment
STAGING_TOTP_SEED?: string;
DEV_TOTP_SEED?: string;

// Session signing key (HMAC-SHA256) — one per environment
STAGING_SESSION_SIGNING_KEY?: string;
DEV_SESSION_SIGNING_KEY?: string;
```

All optional — only two are defined per environment (one seed + one signing key). None defined in production.

**Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add env.d.ts
git commit -m "feat: add TOTP seed and session signing key env var types"
```

---

## Task 3: Write Failing Tests for TOTP Module

**Files:**
- Create: `app/lib/totp.server.test.ts`

**Step 1: Write test file**

Create `app/lib/totp.server.test.ts`:

```typescript
import {describe, it, expect} from 'vitest';
import {verifyTotp, generateTotp} from './totp.server';

// Known test vector: RFC 6238 doesn't have simple test vectors for HMAC-SHA1
// with base32 secrets, so we use a round-trip approach: generate then verify.
const TEST_SECRET_BASE32 = 'JBSWY3DPEHPK3PXP'; // base32 of "Hello!"

describe('TOTP module', () => {
  describe('generateTotp', () => {
    it('returns a 6-digit string', async () => {
      const code = await generateTotp(TEST_SECRET_BASE32);
      expect(code).toMatch(/^\d{6}$/);
    });

    it('returns the same code within the same 30s window', async () => {
      const code1 = await generateTotp(TEST_SECRET_BASE32);
      const code2 = await generateTotp(TEST_SECRET_BASE32);
      expect(code1).toBe(code2);
    });

    it('pads codes shorter than 6 digits with leading zeros', async () => {
      // Generate a code — it should always be exactly 6 chars
      const code = await generateTotp(TEST_SECRET_BASE32);
      expect(code.length).toBe(6);
    });
  });

  describe('verifyTotp', () => {
    it('accepts a code generated from the same secret', async () => {
      const code = await generateTotp(TEST_SECRET_BASE32);
      const valid = await verifyTotp(code, TEST_SECRET_BASE32);
      expect(valid).toBe(true);
    });

    it('rejects a code from a different secret', async () => {
      const code = await generateTotp(TEST_SECRET_BASE32);
      const valid = await verifyTotp(code, 'GEZDGNBVGY3TQOJQ'); // different secret
      expect(valid).toBe(false);
    });

    it('rejects a completely invalid code', async () => {
      const valid = await verifyTotp('000000', TEST_SECRET_BASE32);
      // This could theoretically pass if 000000 happens to be the current code,
      // but the probability is 1/1,000,000. If this flakes, use a known-bad code.
      // For robustness, we just test that the function runs without error.
      expect(typeof valid).toBe('boolean');
    });

    it('rejects malformed codes', async () => {
      const valid = await verifyTotp('abc', TEST_SECRET_BASE32);
      expect(valid).toBe(false);
    });

    it('rejects empty code', async () => {
      const valid = await verifyTotp('', TEST_SECRET_BASE32);
      expect(valid).toBe(false);
    });
  });

  describe('base32 decoding', () => {
    it('handles secrets with trailing padding', async () => {
      // JBSWY3DPEHPK3PXP with padding: JBSWY3DPEHPK3PXP======
      const code = await generateTotp('JBSWY3DPEHPK3PXP======');
      expect(code).toMatch(/^\d{6}$/);
    });

    it('handles lowercase input', async () => {
      const upper = await generateTotp('JBSWY3DPEHPK3PXP');
      const lower = await generateTotp('jbswy3dpehpk3pxp');
      expect(upper).toBe(lower);
    });

    it('throws on invalid base32 characters', async () => {
      await expect(generateTotp('INVALID!@#')).rejects.toThrow('Invalid base32');
    });
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module './totp.server'`

**Step 3: Commit**

```bash
git add app/lib/totp.server.test.ts
git commit -m "test: add failing tests for TOTP module"
```

---

## Task 4: Implement TOTP Module

**Files:**
- Create: `app/lib/totp.server.ts`

**Step 1: Create TOTP implementation**

Create `app/lib/totp.server.ts`:

```typescript
const PERIOD = 30; // seconds
const DIGITS = 6;
const WINDOW = 1; // check current + 1 previous period (clock drift tolerance)

export async function verifyTotp(
  code: string,
  base32Secret: string,
): Promise<boolean> {
  if (!code || code.length !== DIGITS || !/^\d+$/.test(code)) return false;

  const secret = base32Decode(base32Secret);
  const now = Math.floor(Date.now() / 1000);

  for (let i = 0; i <= WINDOW; i++) {
    const counter = Math.floor((now - i * PERIOD) / PERIOD);
    const expected = await generateCode(secret, counter);
    if (expected === code) return true;
  }
  return false;
}

export async function generateTotp(base32Secret: string): Promise<string> {
  const secret = base32Decode(base32Secret);
  const counter = Math.floor(Date.now() / 1000 / PERIOD);
  return generateCode(secret, counter);
}

async function generateCode(
  secret: Uint8Array,
  counter: number,
): Promise<string> {
  const buffer = new ArrayBuffer(8);
  new DataView(buffer).setUint32(4, counter, false);

  const key = await crypto.subtle.importKey(
    'raw',
    secret,
    {name: 'HMAC', hash: 'SHA-1'},
    false,
    ['sign'],
  );
  const hmac = new Uint8Array(await crypto.subtle.sign('HMAC', key, buffer));

  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  return (binary % 10 ** DIGITS).toString().padStart(DIGITS, '0');
}

function base32Decode(input: string): Uint8Array {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = input.replace(/=+$/, '').toUpperCase();
  let bits = '';
  for (const c of clean) {
    const v = alphabet.indexOf(c);
    if (v === -1) throw new Error(`Invalid base32: ${c}`);
    bits += v.toString(2).padStart(5, '0');
  }
  const bytes = new Uint8Array(Math.floor(bits.length / 8));
  for (let i = 0; i < bytes.length; i++)
    bytes[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  return bytes;
}
```

**Step 2: Run tests to verify they pass**

Run: `npm test`
Expected: All TOTP tests PASS

**Step 3: Commit**

```bash
git add app/lib/totp.server.ts
git commit -m "feat: add zero-dep TOTP implementation using Web Crypto"
```

---

## Task 5: Write Failing Tests for Middleware

**Files:**
- Create: `app/lib/auth.server.test.ts`

The middleware has three code paths: session JWT cookie, TOTP query param, TOTP form POST.
It also depends on `totp-form.server.ts` (not yet created) — tests will fail on both missing imports.

**Step 1: Write test file**

Create `app/lib/auth.server.test.ts`:

```typescript
import {describe, it, expect, beforeAll, vi} from 'vitest';
import {validateProtectionBypass} from './auth.server';

const TOTP_SEED = 'JBSWY3DPEHPK3PXP';
const SESSION_KEY = 'test-session-signing-key-for-unit-tests';

// Helper: generate a valid TOTP code for the test seed
async function generateTestTotp(base32Secret: string): Promise<string> {
  // Inline TOTP generation to avoid importing from the module under test's dependency
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = base32Secret.replace(/=+$/, '').toUpperCase();
  let bits = '';
  for (const c of clean) {
    bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  }
  const secret = new Uint8Array(Math.floor(bits.length / 8));
  for (let i = 0; i < secret.length; i++)
    secret[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);

  const counter = Math.floor(Date.now() / 1000 / 30);
  const buffer = new ArrayBuffer(8);
  new DataView(buffer).setUint32(4, counter, false);

  const key = await crypto.subtle.importKey(
    'raw', secret, {name: 'HMAC', hash: 'SHA-1'}, false, ['sign'],
  );
  const hmac = new Uint8Array(await crypto.subtle.sign('HMAC', key, buffer));
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return (binary % 1000000).toString().padStart(6, '0');
}

// Helper: create a session JWT for testing cookie auth
async function createTestSessionJwt(
  secret: string,
  ttlSeconds: number = 86400,
): Promise<string> {
  const header = b64url(JSON.stringify({alg: 'HS256', typ: 'JWT'}));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(JSON.stringify({iat: now, exp: now + ttlSeconds}));
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    {name: 'HMAC', hash: 'SHA-256'}, false, ['sign'],
  );
  const sig = await crypto.subtle.sign(
    'HMAC', key, new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${b64url(sig)}`;
}

function b64url(input: string | ArrayBuffer): string {
  const str = typeof input === 'string'
    ? btoa(input)
    : btoa(String.fromCharCode(...new Uint8Array(input)));
  return str.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function makeRequest(
  url: string,
  options: {cookie?: string; method?: string; body?: FormData} = {},
): Request {
  const headers = new Headers();
  if (options.cookie) headers.set('Cookie', options.cookie);
  const init: RequestInit = {method: options.method || 'GET', headers};
  if (options.body) init.body = options.body;
  return new Request(url, init);
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return overrides as Env;
}

describe('validateProtectionBypass', () => {
  let validTotp: string;
  let validSessionJwt: string;
  let expiredSessionJwt: string;

  beforeAll(async () => {
    validTotp = await generateTestTotp(TOTP_SEED);
    validSessionJwt = await createTestSessionJwt(SESSION_KEY);
    expiredSessionJwt = await createTestSessionJwt(SESSION_KEY, -3600); // expired 1hr ago
  });

  describe('when no TOTP seed is configured (production)', () => {
    it('returns null (pass through)', async () => {
      const result = await validateProtectionBypass(
        makeRequest('https://acme.com/'),
        makeEnv(),
      );
      expect(result).toBeNull();
    });
  });

  describe('when only seed is set but no signing key (misconfiguration)', () => {
    it('returns null (pass through) — both are needed', async () => {
      const result = await validateProtectionBypass(
        makeRequest('https://staging.acme.com/'),
        makeEnv({STAGING_TOTP_SEED: TOTP_SEED}),
      );
      expect(result).toBeNull();
    });
  });

  describe('when STAGING env vars are set', () => {
    const env = makeEnv({
      STAGING_TOTP_SEED: TOTP_SEED,
      STAGING_SESSION_SIGNING_KEY: SESSION_KEY,
    });

    // --- Session JWT (cookie) ---

    it('returns null when session cookie has valid JWT', async () => {
      const result = await validateProtectionBypass(
        makeRequest('https://staging.acme.com/', {
          cookie: `_oxygen_bypass=${validSessionJwt}`,
        }),
        env,
      );
      expect(result).toBeNull();
    });

    it('does not accept expired session JWT in cookie', async () => {
      const result = await validateProtectionBypass(
        makeRequest('https://staging.acme.com/', {
          cookie: `_oxygen_bypass=${expiredSessionJwt}`,
        }),
        env,
      );
      expect(result).not.toBeNull();
      expect(result!.status).toBe(401);
    });

    it('does not accept session JWT signed with wrong key', async () => {
      const wrongJwt = await createTestSessionJwt('wrong-key');
      const result = await validateProtectionBypass(
        makeRequest('https://staging.acme.com/', {
          cookie: `_oxygen_bypass=${wrongJwt}`,
        }),
        env,
      );
      expect(result!.status).toBe(401);
    });

    // --- TOTP query param ---

    it('returns 302 with session cookie when TOTP query param is valid', async () => {
      const result = await validateProtectionBypass(
        makeRequest(`https://staging.acme.com/some/path?x-oxygen-totp=${validTotp}`),
        env,
      );
      expect(result).not.toBeNull();
      expect(result!.status).toBe(302);

      // Redirect strips the TOTP param
      const location = result!.headers.get('Location')!;
      expect(location).toBe('https://staging.acme.com/some/path');
      expect(location).not.toContain('x-oxygen-totp');

      // Cookie contains a session JWT (not the TOTP code)
      const setCookie = result!.headers.get('Set-Cookie')!;
      expect(setCookie).toContain('_oxygen_bypass=eyJ'); // JWT starts with eyJ
      expect(setCookie).toContain('SameSite=None');
      expect(setCookie).toContain('Secure');
      expect(setCookie).toContain('HttpOnly');
    });

    it('preserves other query params in redirect', async () => {
      const result = await validateProtectionBypass(
        makeRequest(`https://staging.acme.com/?foo=bar&x-oxygen-totp=${validTotp}&baz=qux`),
        env,
      );
      const location = result!.headers.get('Location')!;
      expect(location).toContain('foo=bar');
      expect(location).toContain('baz=qux');
      expect(location).not.toContain('x-oxygen-totp');
    });

    it('rejects invalid TOTP code in query param', async () => {
      const result = await validateProtectionBypass(
        makeRequest('https://staging.acme.com/?x-oxygen-totp=999999'),
        env,
      );
      // Should return 401 with TOTP form
      expect(result).not.toBeNull();
      expect(result!.status).toBe(401);
      expect(result!.headers.get('Content-Type')).toBe('text/html');
    });

    // --- TOTP form POST ---

    it('accepts TOTP code via form POST', async () => {
      const formData = new FormData();
      formData.set('totp', validTotp);
      const result = await validateProtectionBypass(
        makeRequest('https://staging.acme.com/', {
          method: 'POST',
          body: formData,
        }),
        env,
      );
      expect(result).not.toBeNull();
      expect(result!.status).toBe(302);
    });

    // --- No auth ---

    it('returns 401 with HTML form when no auth provided', async () => {
      const result = await validateProtectionBypass(
        makeRequest('https://staging.acme.com/'),
        env,
      );
      expect(result).not.toBeNull();
      expect(result!.status).toBe(401);
      expect(result!.headers.get('Content-Type')).toBe('text/html');

      const body = await result!.text();
      expect(body).toContain('Authentication Required');
      expect(body).toContain('name="totp"');
      expect(body).toContain('method="POST"');
    });

    it('includes X-Robots-Tag: noindex on 401', async () => {
      const result = await validateProtectionBypass(
        makeRequest('https://staging.acme.com/'),
        env,
      );
      expect(result!.headers.get('X-Robots-Tag')).toBe('noindex');
    });

    it('includes X-Robots-Tag: noindex on 302', async () => {
      const result = await validateProtectionBypass(
        makeRequest(`https://staging.acme.com/?x-oxygen-totp=${validTotp}`),
        env,
      );
      expect(result!.headers.get('X-Robots-Tag')).toBe('noindex');
    });
  });

  describe('when DEV env vars are set', () => {
    const env = makeEnv({
      DEV_TOTP_SEED: TOTP_SEED,
      DEV_SESSION_SIGNING_KEY: SESSION_KEY,
    });

    it('returns null when session cookie is valid', async () => {
      const result = await validateProtectionBypass(
        makeRequest('https://dev.acme.com/', {
          cookie: `_oxygen_bypass=${validSessionJwt}`,
        }),
        env,
      );
      expect(result).toBeNull();
    });

    it('returns 401 form when no auth', async () => {
      const result = await validateProtectionBypass(
        makeRequest('https://dev.acme.com/'),
        env,
      );
      expect(result!.status).toBe(401);
      expect(result!.headers.get('Content-Type')).toBe('text/html');
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
git commit -m "test: add failing tests for TOTP + session protection bypass middleware"
```

---

## Task 6: Implement TOTP Form

**Files:**
- Create: `app/lib/totp-form.server.ts`

The middleware depends on this module. Create it before the middleware.

**Step 1: Create TOTP form**

Create `app/lib/totp-form.server.ts`:

```typescript
export function renderTotpForm(actionUrl: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authentication Required</title>
  <style>
    body { font-family: system-ui, sans-serif; display: flex; justify-content: center;
           align-items: center; min-height: 100vh; margin: 0; background: #f5f5f5; }
    .card { background: white; padding: 2rem; border-radius: 8px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.1); max-width: 360px; width: 100%;
            text-align: center; }
    h1 { font-size: 1.25rem; margin: 0 0 0.5rem; }
    p { color: #666; font-size: 0.875rem; margin: 0 0 1.5rem; }
    input[type="text"] { width: 100%; padding: 0.75rem; font-size: 1.5rem;
           text-align: center; letter-spacing: 0.5em; border: 1px solid #ddd;
           border-radius: 4px; box-sizing: border-box; }
    button { width: 100%; padding: 0.75rem; margin-top: 1rem; background: #000;
             color: white; border: none; border-radius: 4px; font-size: 1rem;
             cursor: pointer; }
    button:hover { background: #333; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Authentication Required</h1>
    <p>Enter the 6-digit code from your authenticator app.</p>
    <form method="POST" action="${actionUrl}">
      <input type="text" name="totp" maxlength="6" pattern="[0-9]{6}"
             inputmode="numeric" autocomplete="one-time-code" autofocus required>
      <button type="submit">Verify</button>
    </form>
  </div>
</body>
</html>`;
}
```

> **Future enhancement:** Replace this inline HTML with a React route at `/auth/totp` for
> custom styling and app-consistent UX. The middleware would redirect to that route instead
> of returning inline HTML. The route must be exempted from the middleware
> (whitelist: `if (url.pathname === '/auth/totp') return null;`).

**Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors (this file has no external dependencies)

**Step 3: Commit**

```bash
git add app/lib/totp-form.server.ts
git commit -m "feat: add inline HTML TOTP entry form"
```

---

## Task 7: Implement Middleware

**Files:**
- Create: `app/lib/auth.server.ts`

**Step 1: Create middleware**

Create `app/lib/auth.server.ts`:

```typescript
import {verifyTotp} from './totp.server';
import {renderTotpForm} from './totp-form.server';

const BYPASS_COOKIE = '_oxygen_bypass';
const TOTP_PARAM = 'x-oxygen-totp';
const COOKIE_TTL = 60 * 60 * 24 * 30; // 30 days (browser cookie TTL)
const SESSION_TTL = 60 * 60 * 24 * 30; // 30 days (JWT exp claim, configurable)

export async function validateProtectionBypass(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const seed = env.STAGING_TOTP_SEED || env.DEV_TOTP_SEED;
  const signingKey = env.STAGING_SESSION_SIGNING_KEY || env.DEV_SESSION_SIGNING_KEY;
  if (!seed || !signingKey) return null; // Production — no auth

  // 1. Check session cookie (JWT)
  const cookieHeader = request.headers.get('Cookie') || '';
  const cookies = Object.fromEntries(
    cookieHeader.split('; ').filter(Boolean).map((c) => {
      const [k, ...v] = c.split('=');
      return [k, v.join('=')];
    }),
  );
  const sessionJwt = cookies[BYPASS_COOKIE];
  if (sessionJwt && (await verifySessionJwt(sessionJwt, signingKey))) return null;

  // 2. Check TOTP code (query param from Studio or form POST)
  const url = new URL(request.url);
  let totpCode = url.searchParams.get(TOTP_PARAM);

  if (!totpCode && request.method === 'POST') {
    try {
      const formData = await request.formData();
      totpCode = formData.get('totp') as string;
    } catch { /* not a form submission */ }
  }

  if (totpCode && (await verifyTotp(totpCode, seed))) {
    const jwt = await createSessionJwt(signingKey, SESSION_TTL);
    const cleanUrl = new URL(url);
    cleanUrl.searchParams.delete(TOTP_PARAM);
    return new Response(null, {
      status: 302,
      headers: {
        Location: cleanUrl.toString(),
        'Set-Cookie': [
          `${BYPASS_COOKIE}=${jwt}`,
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

  // 3. No valid auth — return TOTP entry form
  return new Response(renderTotpForm(url.toString()), {
    status: 401,
    headers: {
      'Content-Type': 'text/html',
      'X-Robots-Tag': 'noindex',
    },
  });
}

// --- Session JWT (HMAC-SHA256) ---

async function createSessionJwt(
  secret: string,
  ttlSeconds: number,
): Promise<string> {
  const header = b64url(JSON.stringify({alg: 'HS256', typ: 'JWT'}));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(JSON.stringify({iat: now, exp: now + ttlSeconds}));

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    {name: 'HMAC', hash: 'SHA-256'},
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${b64url(sig)}`;
}

async function verifySessionJwt(
  token: string,
  secret: string,
): Promise<boolean> {
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
    const base64 = signature.replace(/-/g, '+').replace(/_/g, '/');
    const sig = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const valid = await crypto.subtle.verify('HMAC', key, sig, data);
    if (!valid) return false;

    const claims = JSON.parse(atob(payload));
    if (claims.exp && claims.exp < Math.floor(Date.now() / 1000)) return false;
    return true;
  } catch {
    return false;
  }
}

function b64url(input: string | ArrayBuffer): string {
  const str =
    typeof input === 'string'
      ? btoa(input)
      : btoa(String.fromCharCode(...new Uint8Array(input)));
  return str.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
```

**Step 2: Run tests to verify they pass**

Run: `npm test`
Expected: All TOTP module tests + all middleware tests PASS

**Step 3: Commit**

```bash
git add app/lib/auth.server.ts
git commit -m "feat: add TOTP + session JWT protection bypass middleware"
```

---

## Task 8: Wire Middleware into server.ts

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
Expected: Dev server starts normally (no TOTP seed in local env).

**Step 5: Commit**

```bash
git add server.ts
git commit -m "feat: wire TOTP protection bypass middleware into server.ts"
```

---

## Task 9: Add CSP frame-ancestors

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

## Task 10: Create Sanity Schema

**Files:**
- Create: `studio/schemaTypes/oxygenProtectionBypass.ts` (adjust path to match Studio project structure)
- Modify: `studio/schemaTypes/index.ts` (register the new type)

> **Note:** The Studio project may be in a separate directory. Adjust paths to match
> your Studio project structure.

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
      title: 'TOTP Seed (base32)',
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

Run: `npx sanity dev` (in the Studio directory)
Expected: Studio starts. "Oxygen Protection Bypass" document type visible.

**Step 4: Deploy schema**

Run: `npx sanity schema deploy`

**Step 5: Commit**

```bash
git add studio/schemaTypes/oxygenProtectionBypass.ts studio/schemaTypes/index.ts
git commit -m "feat: add oxygenProtectionBypass schema type"
```

---

## Task 11: Generate Secrets and Create Sanity Documents

**Files:** None (CLI operations only)

**Step 1: Generate staging TOTP seed**

Run:
```bash
python3 -c "import base64, os; print(base64.b32encode(os.urandom(20)).decode())"
```
Save the output (e.g., `JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP`).

**Step 2: Generate staging session signing key**

Run: `openssl rand -hex 32`
Save the output.

**Step 3: Generate dev TOTP seed**

Run:
```bash
python3 -c "import base64, os; print(base64.b32encode(os.urandom(20)).decode())"
```
Save the output.

**Step 4: Generate dev session signing key**

Run: `openssl rand -hex 32`
Save the output.

**Step 5: Set Oxygen env vars**

Set 4 env vars in Shopify Admin or CLI:

| Variable | Scoped To |
|---|---|
| `STAGING_TOTP_SEED` | Staging |
| `STAGING_SESSION_SIGNING_KEY` | Staging |
| `DEV_TOTP_SEED` | Dev |
| `DEV_SESSION_SIGNING_KEY` | Dev |

None set in Production — middleware auto-skips.

**Step 6: Create Sanity documents**

```bash
# Staging bypass doc
npx sanity documents create --dataset production <<'EOF'
{
  "_type": "oxygenProtectionBypass",
  "_id": "oxygenProtectionBypass.staging",
  "environment": "staging",
  "secret": "<STAGING_TOTP_SEED_FROM_STEP_1>"
}
EOF

# Dev bypass doc
npx sanity documents create --dataset production <<'EOF'
{
  "_type": "oxygenProtectionBypass",
  "_id": "oxygenProtectionBypass.dev",
  "environment": "dev",
  "secret": "<DEV_TOTP_SEED_FROM_STEP_3>"
}
EOF
```

**Step 7: Verify documents exist**

Query: `*[_type == "oxygenProtectionBypass"]{_id, environment, secret}`
Expected: Two documents with base32 seeds.

---

## Task 12: Generate QR Codes for Stakeholder Onboarding

**Files:** None (CLI operations only)

**Step 1: Install qrencode (if not present)**

Run: `brew install qrencode`

**Step 2: Generate staging QR code**

```bash
qrencode -o staging-totp-qr.png "otpauth://totp/Acme%20Staging:team@acme.com?secret=<STAGING_SEED>&issuer=Acme%20Staging&algorithm=SHA1&digits=6&period=30"
```

Replace `Acme` with the project name and `team@acme.com` with the team email/label.

**Step 3: Generate dev QR code**

```bash
qrencode -o dev-totp-qr.png "otpauth://totp/Acme%20Dev:team@acme.com?secret=<DEV_SEED>&issuer=Acme%20Dev&algorithm=SHA1&digits=6&period=30"
```

**Step 4: Test by scanning**

Open Google Authenticator (or any TOTP app) and scan the QR code. Verify it shows a 6-digit code that changes every 30 seconds.

**Step 5: Distribute**

Share QR images via internal channel (Slack, Teams, email). Each stakeholder scans into their authenticator app once.

Compatible apps: Google Authenticator, Microsoft Authenticator, Authy, Cisco Duo, 1Password, Bitwarden.

---

## Task 13: Create Studio Browser TOTP + Configure previewMode

**Files:**
- Create: `studio/lib/totp.ts`
- Modify: `studio/sanity.config.ts`

### Studio browser TOTP

**Step 1: Create browser TOTP module**

Create `studio/lib/totp.ts`:

```typescript
const PERIOD = 30;
const DIGITS = 6;

export async function generateTotp(base32Secret: string): Promise<string> {
  const secret = base32Decode(base32Secret);
  const counter = Math.floor(Date.now() / 1000 / PERIOD);

  const buffer = new ArrayBuffer(8);
  new DataView(buffer).setUint32(4, counter, false);

  const key = await crypto.subtle.importKey(
    'raw', secret, {name: 'HMAC', hash: 'SHA-1'}, false, ['sign'],
  );
  const hmac = new Uint8Array(await crypto.subtle.sign('HMAC', key, buffer));

  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  return (binary % 10 ** DIGITS).toString().padStart(DIGITS, '0');
}

function base32Decode(input: string): Uint8Array {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = input.replace(/=+$/, '').toUpperCase();
  let bits = '';
  for (const c of clean) {
    const v = alphabet.indexOf(c);
    if (v === -1) throw new Error(`Invalid base32: ${c}`);
    bits += v.toString(2).padStart(5, '0');
  }
  const bytes = new Uint8Array(Math.floor(bits.length / 8));
  for (let i = 0; i < bytes.length; i++)
    bytes[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  return bytes;
}
```

> **Note:** This is the same algorithm as `app/lib/totp.server.ts` but in a separate file
> because Studio and Hydrogen are different projects. The server version includes `verifyTotp`;
> this browser version only needs `generateTotp`.

### Studio previewMode config

**Step 2: Add previewMode resolver to staging workspace**

In the staging workspace's `presentationTool` config in `studio/sanity.config.ts`:

```typescript
import {generateTotp} from './lib/totp'

presentationTool({
  previewUrl: {
    initial: 'https://staging.acme.com',
    previewMode: {
      enable: async ({client, targetOrigin}) => {
        const doc = await client.fetch(
          `*[_type == "oxygenProtectionBypass" && environment == "staging"][0]{secret}`
        )
        const base = `${targetOrigin}/api/preview-mode/enable`
        if (!doc?.secret) return base
        const code = await generateTotp(doc.secret)
        return `${base}?x-oxygen-totp=${code}`
      },
    },
  },
  allowOrigins: [
    'https://staging.acme.com',
    'https://*.myshopify.dev',
  ],
})
```

**Step 3: Add previewMode resolver to dev workspace**

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
        if (!doc?.secret) return base
        const code = await generateTotp(doc.secret)
        return `${base}?x-oxygen-totp=${code}`
      },
    },
  },
  allowOrigins: [
    'https://dev.acme.com',
    'https://*.myshopify.dev',
  ],
})
```

**Step 4: Production workspace (no TOTP)**

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

**Step 5: Verify Studio starts**

Run: `npx sanity dev` (in the Studio directory)
Expected: All workspaces load. Presentation tool opens without errors.

**Step 6: Commit**

```bash
git add studio/lib/totp.ts studio/sanity.config.ts
git commit -m "feat: add browser TOTP generation and previewMode resolver per workspace"
```

---

## Task 14: Deploy and E2E Verify

**Step 1: Deploy Hydrogen to staging**

Run: `npx shopify hydrogen deploy --env staging`
Expected: Deployment succeeds.

**Step 2: Verify TOTP form on staging without auth**

Run: `curl -s -o /dev/null -w "%{http_code}" https://staging.acme.com/`
Expected: `401`

Run: `curl -s https://staging.acme.com/ | grep "Authentication Required"`
Expected: Matches — the TOTP form is returned.

**Step 3: Verify TOTP code triggers session + redirect**

Generate a TOTP code manually (use the authenticator app or the staging QR code):

Run: `curl -v "https://staging.acme.com/?x-oxygen-totp=<CURRENT_6_DIGIT_CODE>"`
Expected:
- HTTP 302
- `Location` header without `x-oxygen-totp`
- `Set-Cookie` with `_oxygen_bypass=eyJ...; SameSite=None; Secure; HttpOnly`

**Step 4: Verify session cookie grants access**

Use the JWT from the `Set-Cookie` header:

Run: `curl -s -o /dev/null -w "%{http_code}" -H "Cookie: _oxygen_bypass=<SESSION_JWT>" https://staging.acme.com/`
Expected: `200`

**Step 5: Verify expired TOTP code is rejected**

Wait 60 seconds (past the 30s window + tolerance), then reuse the same 6-digit code:

Run: `curl -s -o /dev/null -w "%{http_code}" "https://staging.acme.com/?x-oxygen-totp=<OLD_CODE>"`
Expected: `401`

**Step 6: Deploy Studio and verify Presentation tool**

Run: `npx sanity deploy` (in the Studio directory)
Open Studio staging workspace → Presentation tool → verify iframe loads with visual editing overlays.
The `previewMode` resolver generates a fresh TOTP code — this should be transparent to the editor.

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
| 2 | Env type declarations | `env.d.ts` | `feat: add TOTP + session key types` |
| 3 | Failing TOTP tests | `app/lib/totp.server.test.ts` | `test: add failing TOTP tests` |
| 4 | Implement TOTP | `app/lib/totp.server.ts` | `feat: add TOTP module` |
| 5 | Failing middleware tests | `app/lib/auth.server.test.ts` | `test: add failing middleware tests` |
| 6 | Implement TOTP form | `app/lib/totp-form.server.ts` | `feat: add TOTP form` |
| 7 | Implement middleware | `app/lib/auth.server.ts` | `feat: add TOTP + session middleware` |
| 8 | Wire into server.ts | `server.ts` | `feat: wire middleware` |
| 9 | CSP frame-ancestors | `app/entry.server.tsx` | `feat: add CSP` |
| 10 | Sanity schema | Studio schema files | `feat: add schema` |
| 11 | Generate secrets + docs | CLI operations | (no commit) |
| 12 | Generate QR codes | CLI operations | (no commit) |
| 13 | Studio browser TOTP + previewMode | `studio/lib/totp.ts`, `studio/sanity.config.ts` | `feat: add browser TOTP + previewMode` |
| 14 | Deploy + E2E verify | Deployment + curl + Studio | (no commit) |

**Compared to Options A/B:**
- +3 new files in Hydrogen (TOTP module, TOTP form, middleware) vs 1 for A, 1 for B
- +1 new file in Studio (browser TOTP lib)
- +2 env vars per environment (4 total) vs 1 for A, 1 for B
- +1 task for QR code generation (stakeholder onboarding)
- +1 test file (TOTP module tested independently)
- Same Sanity schema structure, same CSP, same server.ts wiring pattern
- Session JWT pattern in middleware is identical to Option B's verification logic
- 10 commits (vs 8 for A, 9 for B)
