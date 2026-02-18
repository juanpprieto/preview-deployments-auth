import {createHydrogenContext} from '@shopify/hydrogen';
import {AppSession} from '~/lib/session';
import {CART_QUERY_FRAGMENT} from '~/lib/fragments';
import {createSanityContext, type SanityContext} from 'hydrogen-sanity';
import {PreviewSession} from 'hydrogen-sanity/preview/session';

/**
 * Resolves the Sanity dataset from per-environment Oxygen variables.
 *
 * Oxygen does not allow the same env var name to have different values per
 * environment. Each environment gets its own named variable:
 *   SANITY_DATASET_PRODUCTION  (scoped to Production)
 *   SANITY_DATASET_STAGING     (scoped to Staging)
 *   SANITY_DATASET_PREVIEW     (scoped to Preview)
 *   SANITY_DATASET_DEV         (scoped to Dev)
 *
 * At runtime, only the variable scoped to the current Oxygen environment is
 * defined. This function tries each name and returns the first defined value.
 */
function resolveSanityDataset(env: Env): string {
  return (
    env.SANITY_DATASET_PRODUCTION ||
    env.SANITY_DATASET_STAGING ||
    env.SANITY_DATASET_PREVIEW ||
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

  const dataset = resolveSanityDataset(env);

  const sanity = await createSanityContext({
    request,
    cache,
    waitUntil,
    client: {
      projectId: env.SANITY_PROJECT_ID || 'sx997gpv',
      dataset,
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
