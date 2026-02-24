import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

// Polyfill Cloudflare Workers' crypto.subtle.timingSafeEqual for Node.js/Vitest.
// On Oxygen this is a native built-in; in Node it doesn't exist.
if (typeof crypto !== 'undefined' && crypto.subtle && !('timingSafeEqual' in crypto.subtle)) {
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

// --- Helpers ---

function makeRequest(url: string, authorization?: string): Request {
  const headers = new Headers();
  if (authorization) headers.set('Authorization', authorization);
  return new Request(url, {headers});
}

function encode(username: string, password: string): string {
  return `Basic ${btoa(`${username}:${password}`)}`;
}

const CREDS = {
  PRIVATE_HYDROGEN_USERNAME: 'admin',
  PRIVATE_HYDROGEN_PASSWORD: 'secret',
} as const;

type AuthEnv = Parameters<typeof checkBasicAuth>[1];

function makeEnv(overrides: Partial<AuthEnv> = {}): AuthEnv {
  return overrides as AuthEnv;
}

function expect401(result: Response | null) {
  expect(result).not.toBeNull();
  expect(result!.status).toBe(401);
  expect(result!.headers.get('WWW-Authenticate')).toContain('Basic');
  expect(result!.headers.get('Cache-Control')).toBe('no-store');
  expect(result!.headers.get('X-Robots-Tag')).toBe('noindex');
}

// --- Tests ---

describe('checkBasicAuth', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'production');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // ── Bypass paths ──────────────────────────────────────────────

  it('bypasses when NODE_ENV=development', () => {
    vi.stubEnv('NODE_ENV', 'development');
    const result = checkBasicAuth(makeRequest('https://staging.acme.com/'), makeEnv({...CREDS}));
    expect(result).toBeNull();
  });

  it('bypasses when AUTH_DISABLED=true', () => {
    const result = checkBasicAuth(
      makeRequest('https://staging.acme.com/'),
      makeEnv({PRIVATE_HYDROGEN_AUTH_DISABLED: 'true'}),
    );
    expect(result).toBeNull();
  });

  it('does NOT bypass for AUTH_DISABLED values other than "true"', () => {
    for (const value of ['false', 'TRUE', '1', 'yes']) {
      const result = checkBasicAuth(
        makeRequest('https://staging.acme.com/'),
        makeEnv({...CREDS, PRIVATE_HYDROGEN_AUTH_DISABLED: value}),
      );
      expect(result).not.toBeNull();
    }
  });

  it('bypasses when no env vars set (production)', () => {
    const result = checkBasicAuth(makeRequest('https://acme.com/'), makeEnv());
    expect(result).toBeNull();
  });

  // ── Locked by default ─────────────────────────────────────────

  it('returns null when credentials vars are empty strings', () => {
    // Simulate: env vars exist in Oxygen config but both are empty
    const result = checkBasicAuth(
      makeRequest('https://staging.acme.com/'),
      makeEnv({PRIVATE_HYDROGEN_USERNAME: '', PRIVATE_HYDROGEN_PASSWORD: ''}),
    );
    expect(result).toBeNull(); // empty strings normalize to undefined → production bypass
  });

  // ── Misconfiguration ──────────────────────────────────────────

  it('returns 500 when only USERNAME is set', () => {
    const result = checkBasicAuth(
      makeRequest('https://staging.acme.com/'),
      makeEnv({PRIVATE_HYDROGEN_USERNAME: 'admin'}),
    );
    expect(result!.status).toBe(500);
    expect(result!.headers.get('Cache-Control')).toBe('no-store');
    expect(result!.headers.has('WWW-Authenticate')).toBe(false);
  });

  it('returns 500 when only PASSWORD is set', () => {
    const result = checkBasicAuth(
      makeRequest('https://staging.acme.com/'),
      makeEnv({PRIVATE_HYDROGEN_PASSWORD: 'secret'}),
    );
    expect(result!.status).toBe(500);
    expect(result!.headers.get('Cache-Control')).toBe('no-store');
    expect(result!.headers.has('WWW-Authenticate')).toBe(false);
  });

  // ── Credential validation ─────────────────────────────────────

  it('returns 401 with challenge when no Authorization header', () => {
    const result = checkBasicAuth(makeRequest('https://staging.acme.com/'), makeEnv(CREDS));
    expect401(result);
  });

  it('returns 401 when credentials are wrong', () => {
    const result = checkBasicAuth(
      makeRequest('https://staging.acme.com/', encode('wrong', 'creds')),
      makeEnv(CREDS),
    );
    expect401(result);
  });

  it('returns null when credentials are correct', () => {
    const result = checkBasicAuth(
      makeRequest('https://staging.acme.com/', encode('admin', 'secret')),
      makeEnv(CREDS),
    );
    expect(result).toBeNull();
  });

  it('handles password containing colons', () => {
    const env = makeEnv({
      PRIVATE_HYDROGEN_USERNAME: 'admin',
      PRIVATE_HYDROGEN_PASSWORD: 'pass:word:extra',
    });
    const result = checkBasicAuth(
      makeRequest('https://staging.acme.com/', encode('admin', 'pass:word:extra')),
      env,
    );
    expect(result).toBeNull();
  });

  it('returns 401 when Authorization scheme is Bearer (not Basic)', () => {
    const result = checkBasicAuth(
      makeRequest('https://staging.acme.com/', 'Bearer some-token'),
      makeEnv(CREDS),
    );
    expect401(result);
  });

  it('returns 401 when Basic payload is empty', () => {
    const result = checkBasicAuth(
      makeRequest('https://staging.acme.com/', 'Basic '),
      makeEnv(CREDS),
    );
    expect401(result);
  });

  it('returns 401 when Basic payload is invalid base64', () => {
    const result = checkBasicAuth(
      makeRequest('https://staging.acme.com/', 'Basic !!!not-base64!!!'),
      makeEnv(CREDS),
    );
    expect401(result);
  });

  it('returns 401 when decoded value has no colon separator', () => {
    const result = checkBasicAuth(
      makeRequest('https://staging.acme.com/', `Basic ${btoa('nocolonhere')}`),
      makeEnv(CREDS),
    );
    expect401(result);
  });
});
