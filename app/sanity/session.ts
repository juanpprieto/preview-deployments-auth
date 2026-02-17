import {createCookieSessionStorage} from 'react-router'
import type {loadQuery} from '@sanity/react-loader'

const {getSession, commitSession, destroySession} =
  createCookieSessionStorage({
    cookie: {
      httpOnly: true,
      name: '__sanity_preview',
      path: '/',
      sameSite: 'none',
      secrets: [
        typeof process !== 'undefined'
          ? process.env.SESSION_SECRET || 'dev-secret-change-me'
          : 'dev-secret-change-me',
      ],
      secure: true,
    },
  })

export async function getPreviewData(request: Request): Promise<{
  preview: boolean
  options: Parameters<typeof loadQuery>[2]
}> {
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

export {commitSession, destroySession, getSession, getPreviewData as default}
