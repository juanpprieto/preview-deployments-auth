type BasicAuthEnv = Pick<
  Env,
  'PRIVATE_HYDROGEN_USERNAME' | 'PRIVATE_HYDROGEN_PASSWORD' | 'PRIVATE_HYDROGEN_AUTH_DISABLED'
>;

/**
 * Checks HTTP Basic Auth credentials against environment variables.
 * Returns a Response to short-circuit, or null to continue.
 *
 * Bypasses when:
 * - NODE_ENV=development (local dev)
 * - PRIVATE_HYDROGEN_AUTH_DISABLED=true (kill switch)
 * - No credential env vars set (production)
 */
export function checkBasicAuth(
  request: Request,
  env: BasicAuthEnv,
): Response | null {
  // 1. Local dev bypass (NODE_ENV replaced at build time by Vite)
  if (process.env.NODE_ENV === 'development') return null;

  // 2. Kill switch
  if (env.PRIVATE_HYDROGEN_AUTH_DISABLED === 'true') return null;

  // 3. No auth vars → production, skip
  const username = env.PRIVATE_HYDROGEN_USERNAME || undefined;
  const password = env.PRIVATE_HYDROGEN_PASSWORD || undefined;
  if (!username && !password) return null;

  // 4. Misconfiguration: only one of username/password set
  if (!username || !password) {
    return new Response('Server configuration error', {
      status: 500,
      headers: {'Cache-Control': 'no-store'},
    });
  }

  // 5. Parse Authorization header
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

  // 6. Timing-safe credential comparison
  if (
    timingSafeEqual(username, providedUsername) &&
    timingSafeEqual(password, providedPassword)
  ) {
    return null;
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
 * crypto.subtle.timingSafeEqual. When lengths differ, compares
 * a against itself to avoid leaking length via timing.
 */
function timingSafeEqual(a: string, b: string): boolean {
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  const lengthsMatch = bufA.byteLength === bufB.byteLength;
  return lengthsMatch
    ? crypto.subtle.timingSafeEqual(bufA, bufB)
    : !crypto.subtle.timingSafeEqual(bufA, bufA);
}
