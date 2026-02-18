import {
  action as _action,
  loader as _loader,
} from 'hydrogen-sanity/preview/route';
import {validatePreviewUrl} from '@sanity/preview-url-secret';

export const action = _action;

export const loader: typeof _loader = async (args) => {
  const {context, request} = args;
  const sanity = (context as any).sanity;

  const config = sanity?.client?.config?.() ?? {};
  console.log('[preview-debug] === Preview Mode Enable ===');
  console.log('[preview-debug] Request URL:', request.url);
  console.log('[preview-debug] Dataset:', config.dataset);
  console.log('[preview-debug] ProjectId:', config.projectId);
  console.log('[preview-debug] Has preview token:', !!sanity?.preview?.token);
  console.log(
    '[preview-debug] Token prefix:',
    sanity?.preview?.token?.substring(0, 12) + '...',
  );

  // Extract the sanity-preview-secret from URL for logging
  const url = new URL(request.url, 'http://localhost');
  const secret = url.searchParams.get('sanity-preview-secret');
  console.log('[preview-debug] Has sanity-preview-secret:', !!secret);
  console.log(
    '[preview-debug] Secret prefix:',
    secret?.substring(0, 12) + '...',
  );

  // Manual validation for debug - query Sanity directly
  if (sanity?.preview?.token) {
    try {
      const clientWithToken = sanity.client.withConfig({
        useCdn: false,
        token: sanity.preview.token,
        perspective: 'raw' as const,
        apiVersion: '2025-02-19',
        stega: false,
      });
      // Check if we can read ANY previewUrlSecret docs
      const allSecrets = await clientWithToken.fetch(
        `*[_type == "sanity.previewUrlSecret"]{_id, _updatedAt, secret}`,
      );
      console.log(
        '[preview-debug] All previewUrlSecret docs in dataset:',
        JSON.stringify(
          allSecrets?.map((d: any) => ({
            _id: d._id,
            _updatedAt: d._updatedAt,
            secretPrefix: d.secret?.substring(0, 12),
          })),
        ),
      );

      // Now try the actual validation
      const result = await validatePreviewUrl(clientWithToken, request.url);
      console.log(
        '[preview-debug] Manual validatePreviewUrl:',
        JSON.stringify(result),
      );
    } catch (err) {
      console.error('[preview-debug] Debug validation error:', err);
    }
  }

  // Delegate to the real loader
  return _loader(args);
};
