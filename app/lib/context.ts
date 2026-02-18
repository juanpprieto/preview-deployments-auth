import {createHydrogenContext} from '@shopify/hydrogen';
import {AppSession} from '~/lib/session';
import {CART_QUERY_FRAGMENT} from '~/lib/fragments';
import {createSanityContext, type SanityContext} from 'hydrogen-sanity';
import {PreviewSession} from 'hydrogen-sanity/preview/session';

/**
 * Resolves the Sanity dataset from Oxygen environment variables.
 *
 * Oxygen does NOT allow the same env var name to have different values
 * across environments. So each environment gets its own named var:
 *   Production → SANITY_DATASET_PRODUCTION=production
 *   Staging    → SANITY_DATASET_STAGING=staging
 *   Preview    → SANITY_DATASET_PREVIEW=staging
 *   Dev        → SANITY_DATASET_DEV=dev
 *
 * Only the var scoped to the current environment will be defined at runtime.
 * We try all of them; the first truthy one wins.
 */
function resolveSanityDataset(env: Env): string {
  return (
    env.SANITY_DATASET_PREVIEW ||
    env.SANITY_DATASET_STAGING ||
    env.SANITY_DATASET_PRODUCTION ||
    env.SANITY_DATASET_DEV ||
    'production'
  );
}

/**
 * Creates Hydrogen context for React Router 7.9.x
 * Returns HydrogenRouterContextProvider with hybrid access patterns
 * */
export async function createHydrogenRouterContext(
  request: Request,
  env: Env,
  executionContext: ExecutionContext,
) {
  if (!env?.SESSION_SECRET) {
    throw new Error('SESSION_SECRET environment variable is not set');
  }

  const waitUntil = executionContext.waitUntil.bind(executionContext);
  const [cache, session, previewSession] = await Promise.all([
    caches.open('hydrogen'),
    AppSession.init(request, [env.SESSION_SECRET]),
    PreviewSession.init(request, [env.SESSION_SECRET]),
  ]);

  const sanity = await createSanityContext({
    request,
    cache,
    waitUntil,
    client: {
      projectId: env.SANITY_PROJECT_ID || 'sx997gpv',
      dataset: resolveSanityDataset(env),
      apiVersion: '2025-02-19',
      useCdn: true,
      stega: {
        enabled: true,
        studioUrl: env.SANITY_STUDIO_URL || 'https://meditate-with-eve.sanity.studio',
      },
    },
    preview: {
      token: env.SANITY_API_READ_TOKEN,
      session: previewSession,
    },
  });

  const hydrogenContext = createHydrogenContext(
    {
      env,
      request,
      cache,
      waitUntil,
      session,
      i18n: {language: 'EN', country: 'US'},
      cart: {
        queryFragment: CART_QUERY_FRAGMENT,
      },
    },
    {sanity} as {sanity: SanityContext},
  );

  return hydrogenContext;
}
