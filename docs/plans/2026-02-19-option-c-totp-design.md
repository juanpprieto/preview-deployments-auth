# Option C: TOTP + Session Protection Bypass — Design

> Implementation-ready design for protecting Oxygen staging/dev environments with TOTP
> codes validated by Hydrogen server middleware, issuing HMAC-signed session JWTs.

**Prerequisites**: Scaffolded Hydrogen project with `hydrogen-sanity` wired up (swag-store
baseline). Oxygen environments (staging, dev) and Sanity datasets configured. Production
remains public with no middleware.

**Reference repos**:
- [hydrogen skeleton](https://github.com/Shopify/hydrogen/tree/main/templates/skeleton)
- [swag-store](https://github.com/sanity-io/swag-store)

**TOTP implementation**: Zero-dependency, ~50 lines, using Web Crypto API (`crypto.subtle`).
No third-party TOTP library.

**Why zero-dep**: `otplib` v12 is [broken on Cloudflare Workers](https://community.cloudflare.com/t/solved-otplib-library-throws-typeerror-crypto2-createhmac-is-not-a-function-error/533009).
v13 uses [`@noble/hashes`](https://jsr.io/@noble/hashes) (CF Workers compatible) but otplib
itself hasn't been tested on CF Workers. TOTP is a simple algorithm (~50 lines with Web Crypto),
so the library risk isn't worth it.

---

## 1. Component Overview

| # | File | What | New/Modified |
|---|---|---|---|
| 1 | `app/lib/totp.server.ts` | Zero-dep TOTP: generate + verify using Web Crypto | New |
| 2 | `app/lib/auth.server.ts` | Middleware: verify TOTP or session JWT, set cookie, return form | New |
| 3 | `app/lib/totp-form.server.ts` | Inline HTML form for stakeholder code entry | New |
| 4 | `server.ts` | Call middleware before request handler (async) | Modified (+2 lines) |
| 5 | `env.d.ts` | Type declarations for TOTP seed + session signing key | Modified |
| 6 | `app/entry.server.tsx` | CSP `frame-ancestors` for Studio | Modified |
| 7 | Studio: `schemaTypes/oxygenProtectionBypass.ts` | Bypass document type (stores TOTP seed) | New |
| 8 | Studio: `lib/totp.ts` | Browser TOTP generation for previewMode | New |
| 9 | Studio: `sanity.config.ts` | `previewMode` resolver: generate TOTP in browser | Modified |
| 10 | Sanity documents | One bypass doc per env with base32 TOTP seed | Created via CLI |

**What differs from Options A/B:**
- Two auth paths: TOTP code (query param or form POST) + session JWT (cookie)
- Two env vars per environment (TOTP seed + session signing key) vs one
- Zero-dep TOTP implementation (~50 lines using Web Crypto)
- Session JWT issued after TOTP validation (same HMAC pattern as Option B)
- Inline HTML form for stakeholder code entry
- Studio-side TOTP generation in browser (Web Crypto)
- QR code distribution for stakeholder onboarding

---

## 2. Data Flow

### Editor flow (transparent — same UX as Options A/B)

```
Studio Presentation tool opens iframe
  → previewMode resolver queries Sanity for TOTP seed
  → generates current 6-digit TOTP code in browser (Web Crypto)
  → constructs URL: staging.acme.com/api/preview-mode/enable?x-oxygen-totp=123456
  → iframe loads URL

server.ts receives request
  → await validateProtectionBypass(request, env)
    → no session cookie → checks TOTP query param
    → verifies TOTP code against seed (current + previous 30s window)
    → valid → generates session JWT (HMAC-SHA256, 30-day default, configurable)
    → 302 redirect to clean URL + Set-Cookie (session JWT, SameSite=None)

subsequent requests carry session cookie → JWT verified → pass through
```

### Stakeholder flow (active authentication)

```
Stakeholder visits staging.acme.com
  → no session cookie, no TOTP param
  → middleware returns 401 + inline HTML form
  → stakeholder opens authenticator app, enters 6-digit code
  → form submits POST with TOTP code
  → middleware verifies → issues session JWT cookie → 302 redirect
  → site renders normally for 30 days (configurable)
```

---

## 3. TOTP Implementation — `app/lib/totp.server.ts`

RFC 6238 TOTP using Web Crypto API. Zero dependencies.

```typescript
const PERIOD = 30; // seconds
const DIGITS = 6;
const WINDOW = 1; // check current + 1 previous period (clock drift tolerance)

export async function verifyTotp(
  code: string,
  base32Secret: string,
): Promise<boolean> {
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

async function generateCode(secret: Uint8Array, counter: number): Promise<string> {
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

Key points:
- **HMAC-SHA1** — required by RFC 6238 and all major authenticator apps
- **Window of 1** — checks current + previous 30s period (handles clock drift)
- **`generateTotp`** reused in Studio's browser-side previewMode resolver
- **`crypto.subtle`** — guaranteed available in Cloudflare Workers and browsers

---

## 4. Middleware — `app/lib/auth.server.ts`

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

// --- Session JWT (HMAC-SHA256, same pattern as Option B) ---

async function createSessionJwt(secret: string, ttlSeconds: number): Promise<string> {
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

async function verifySessionJwt(token: string, secret: string): Promise<boolean> {
  try {
    const [header, payload, signature] = token.split('.');
    if (!header || !payload || !signature) return false;

    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(secret),
      {name: 'HMAC', hash: 'SHA-256'}, false, ['verify'],
    );
    const data = new TextEncoder().encode(`${header}.${payload}`);
    const base64 = signature.replace(/-/g, '+').replace(/_/g, '/');
    const sig = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const valid = await crypto.subtle.verify('HMAC', key, sig, data);
    if (!valid) return false;

    const claims = JSON.parse(atob(payload));
    if (claims.exp && claims.exp < Math.floor(Date.now() / 1000)) return false;
    return true;
  } catch { return false; }
}

function b64url(input: string | ArrayBuffer): string {
  const str = typeof input === 'string'
    ? btoa(input)
    : btoa(String.fromCharCode(...new Uint8Array(input)));
  return str.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
```

Design decisions:
- **Session JWT after TOTP validation** — TOTP codes expire in 30s, so they can't be stored
  in a cookie. The session JWT persists the authenticated state.
- **`SESSION_TTL = 30 days` (configurable)** — change the constant to adjust. A future
  enhancement could make this an env var.
- **Form POST handling** — stakeholders submit a POST form; Studio uses a GET query param.
  Middleware handles both.
- **401 returns HTML form** — stakeholders see a code entry form. Studio's previewMode never
  hits this path (it always sends a valid code).

> **Future enhancement:** Replace the inline HTML form with a React route at `/auth/totp`
> for custom styling and app-consistent UX. The middleware would redirect to that route
> instead of returning inline HTML. The route needs to be exempted from the middleware
> (whitelist pattern: `if (url.pathname === '/auth/totp') return null;`).

---

## 5. TOTP Form — `app/lib/totp-form.server.ts`

Inline HTML. Self-contained, no React, no build step.

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

---

## 6. server.ts Integration

Same as Option B — async call:

```typescript
import {validateProtectionBypass} from '~/lib/auth.server';

// Inside try block, before createHydrogenRouterContext:
const authResponse = await validateProtectionBypass(request, env);
if (authResponse) return authResponse;
```

---

## 7. env.d.ts

```typescript
interface Env extends HydrogenEnv {
  // TOTP seed (base32) — one per environment
  STAGING_TOTP_SEED?: string;
  DEV_TOTP_SEED?: string;

  // Session signing key — one per environment
  STAGING_SESSION_SIGNING_KEY?: string;
  DEV_SESSION_SIGNING_KEY?: string;
}
```

4 env vars total (2 per environment) vs 1 for Options A/B.

---

## 8. entry.server.tsx — CSP

Identical to Options A/B:

```typescript
frameAncestors: [
  "'self'",
  'https://www.sanity.io',
  'https://*.sanity.studio',
],
```

---

## 9. Sanity Schema — `oxygenProtectionBypass`

Same structure as Options A/B. The `secret` field stores a base32 TOTP seed:

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
      options: { list: ['staging', 'dev'] },
      validation: (r) => r.required(),
    }),
    defineField({
      name: 'secret',
      title: 'TOTP Seed (base32)',
      type: 'string',
      validation: (r) => r.required(),
    }),
  ],
  preview: { select: {title: 'environment'} },
})
```

---

## 10. Studio previewMode + Browser TOTP

### Studio: `lib/totp.ts`

Browser-compatible TOTP generation. Same algorithm as server, separate file since Studio and
Hydrogen are different projects.

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

### Staging workspace config

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
  allowOrigins: ['https://staging.acme.com', 'https://*.myshopify.dev'],
})
```

### Dev workspace config

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
  allowOrigins: ['https://dev.acme.com', 'https://*.myshopify.dev'],
})
```

### Production workspace (no auth)

```typescript
presentationTool({
  previewUrl: {
    initial: 'https://acme.com',
    previewMode: { enable: '/api/preview-mode/enable' },
  },
})
```

---

## 11. Secret Generation and Storage

### Generate TOTP seed (one per environment)

```bash
# 20-byte random seed, base32 encoded (standard for TOTP)
python3 -c "import base64, os; print(base64.b32encode(os.urandom(20)).decode())"
```

### Generate session signing key (one per environment)

```bash
openssl rand -hex 32  # 256-bit HMAC key
```

### Store in Oxygen env vars

| Variable | Scoped To |
|---|---|
| `STAGING_TOTP_SEED` | Staging |
| `STAGING_SESSION_SIGNING_KEY` | Staging |
| `DEV_TOTP_SEED` | Dev |
| `DEV_SESSION_SIGNING_KEY` | Dev |

None set in Production — middleware auto-skips.

### Store seed in Sanity

```bash
npx sanity documents create --dataset production <<'EOF'
{
  "_type": "oxygenProtectionBypass",
  "_id": "oxygenProtectionBypass.staging",
  "environment": "staging",
  "secret": "<BASE32_TOTP_SEED>"
}
EOF

npx sanity documents create --dataset production <<'EOF'
{
  "_type": "oxygenProtectionBypass",
  "_id": "oxygenProtectionBypass.dev",
  "environment": "dev",
  "secret": "<BASE32_TOTP_SEED>"
}
EOF
```

---

## 12. QR Code Generation and Stakeholder Onboarding

### Generate `otpauth://` URI

```
otpauth://totp/{Issuer}:{Account}?secret={BASE32_SEED}&issuer={Issuer}&algorithm=SHA1&digits=6&period=30
```

Example:
```
otpauth://totp/Acme%20Staging:team@acme.com?secret=JBSWY3DPEHPK3PXP&issuer=Acme%20Staging&algorithm=SHA1&digits=6&period=30
```

### Generate QR code

```bash
# macOS
brew install qrencode
qrencode -o staging-totp-qr.png "otpauth://totp/Acme%20Staging:team@acme.com?secret=<SEED>&issuer=Acme%20Staging&algorithm=SHA1&digits=6&period=30"
```

Or use any online QR generator with the `otpauth://` URI.

### Stakeholder onboarding

1. Generate QR image (one per environment)
2. Share via internal channel (Slack, Teams, email)
3. Each stakeholder scans QR into their authenticator app
4. They now get rotating 6-digit codes every 30 seconds
5. Visit the staging/dev URL → enter code → authenticated for 30 days

Compatible authenticator apps: Google Authenticator, Microsoft Authenticator, Authy, Cisco Duo,
1Password, Bitwarden.

### Rotation

1. Generate new TOTP seed + optionally new session signing key
2. Update Oxygen env vars → triggers redeploy
3. Update Sanity document
4. Generate new QR code, redistribute to stakeholders
5. Stakeholders re-scan QR into authenticator app
6. Old session cookies: valid if only TOTP seed changed (signing key unchanged),
   invalidated if signing key also rotated
