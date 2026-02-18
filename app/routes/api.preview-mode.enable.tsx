import {
  action as _action,
  loader as _loader,
} from 'hydrogen-sanity/preview/route';
import {validatePreviewUrl} from '@sanity/preview-url-secret';

export const action = _action;

export const loader: typeof _loader = async (args) => {
  const {context, request} = args;
  const sanity = (context as any).sanity;
  const url = new URL(request.url, 'http://localhost');

  // If ?_debug=1 is present, return diagnostic JSON instead of normal flow
  if (url.searchParams.get('_debug') === '1') {
    const config = sanity?.client?.config?.() ?? {};
    const secret = url.searchParams.get('sanity-preview-secret');
    const debug: Record<string, unknown> = {
      dataset: config.dataset,
      projectId: config.projectId,
      hasPreviewToken: !!sanity?.preview?.token,
      tokenPrefix: sanity?.preview?.token?.substring(0, 12) + '...',
      hasSecret: !!secret,
      secretValue: secret,
    };

    if (sanity?.preview?.token) {
      try {
        const clientWithToken = sanity.client.withConfig({
          useCdn: false,
          token: sanity.preview.token,
          perspective: 'raw' as const,
          apiVersion: '2025-02-19',
          stega: false,
        });

        // Fetch all previewUrlSecret docs in this dataset
        const allSecrets = await clientWithToken.fetch(
          `*[_type == "sanity.previewUrlSecret"]{_id, _updatedAt, secret, studioUrl}`,
        );
        debug.secretDocsInDataset = allSecrets?.map((d: any) => ({
          _id: d._id,
          _updatedAt: d._updatedAt,
          secret: d.secret,
          studioUrl: d.studioUrl,
        }));

        // Try validation
        const result = await validatePreviewUrl(clientWithToken, request.url);
        debug.validateResult = result;
      } catch (err: any) {
        debug.validationError = err?.message || String(err);
      }
    }

    return new Response(JSON.stringify(debug, null, 2), {
      headers: {'Content-Type': 'application/json'},
    });
  }

  // Normal flow
  return _loader(args);
};
