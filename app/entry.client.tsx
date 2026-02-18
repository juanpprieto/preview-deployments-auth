import {HydratedRouter} from 'react-router/dom';
import {startTransition, StrictMode} from 'react';
import {hydrateRoot} from 'react-dom/client';
import {NonceProvider} from '@shopify/hydrogen';

// In cross-origin iframes (Sanity Studio Presentation tool), browsers like
// Safari and Brave block third-party cookies. The Oxygen Gateway normally
// sets an auth_bypass_token cookie on the initial ?_auth= request, but the
// cookie is never stored in a third-party context. We capture the token from
// the initial URL and inject it into all same-origin fetches so the Gateway
// passes them through without the cookie.
const authBypassToken = new URLSearchParams(window.location.search).get(
  '_auth',
);

if (authBypassToken) {
  const originalFetch = window.fetch;
  window.fetch = function (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    try {
      let url: URL;
      if (typeof input === 'string') {
        url = new URL(input, window.location.origin);
      } else if (input instanceof URL) {
        url = new URL(input.href);
      } else if (input instanceof Request) {
        url = new URL(input.url);
      } else {
        return originalFetch.call(this, input, init);
      }

      if (url.origin === window.location.origin) {
        url.searchParams.set('_auth', authBypassToken);
        if (input instanceof Request) {
          return originalFetch.call(this, new Request(url, input), init);
        }
        return originalFetch.call(this, url.toString(), init);
      }
    } catch {
      // Pass through on URL parsing errors
    }
    const fallbackInput =
      input instanceof URL ? input.toString() : input;
    return originalFetch.call(this, fallbackInput, init);
  };
}

if (!window.location.origin.includes('webcache.googleusercontent.com')) {
  startTransition(() => {
    // Extract nonce from existing script tags
    const existingNonce =
      document.querySelector<HTMLScriptElement>('script[nonce]')?.nonce;

    hydrateRoot(
      document,
      <StrictMode>
        <NonceProvider value={existingNonce}>
          <HydratedRouter />
        </NonceProvider>
      </StrictMode>,
    );
  });
}
