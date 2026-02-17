import {createCookieSessionStorage} from 'react-router'
import type {loadQuery} from '@sanity/react-loader'

export function createPreviewSessionStorage(secret: string) {
  return createCookieSessionStorage({
    cookie: {
      httpOnly: true,
      name: '__sanity_preview',
      path: '/',
      sameSite: 'none',
      secrets: [secret],
      secure: true,
    },
  })
}

export async function getPreviewData(
  request: Request,
  secret: string,
): Promise<{
  preview: boolean
  options: Parameters<typeof loadQuery>[2]
}> {
  const {getSession} = createPreviewSessionStorage(secret)
  const session = await getSession(request.headers.get('Cookie'))
  const preview = session.get('previewMode') || false
  return {
    preview,
    options: preview
      ? {
          perspective: session.has('perspective')
            ? session.get('perspective').split(',')
            : 'drafts',
          stega: true,
        }
      : {
          perspective: 'published',
          stega: false,
        },
  }
}
