import {validatePreviewUrl} from '@sanity/preview-url-secret'
import type {ClientPerspective} from '@sanity/client'
import {client} from '~/sanity/client'
import {createPreviewSessionStorage} from '~/sanity/session'
import type {Route} from './+types/api.preview-mode.enable'

// PUT: change perspective (drafts/published). POST/DELETE: disable preview.
export async function action({request, context}: Route.ActionArgs) {
  const sessionSecret = context.env.SESSION_SECRET || 'dev-secret-change-me'
  const {getSession, commitSession, destroySession} =
    createPreviewSessionStorage(sessionSecret)
  const session = await getSession(request.headers.get('Cookie'))

  if (request.method === 'PUT') {
    const body = await request.formData()
    const perspective = body.get('perspective') as ClientPerspective | null
    if (perspective) {
      session.set('perspective', perspective)
    }
    return new Response(null, {
      status: 200,
      headers: {'Set-Cookie': await commitSession(session)},
    })
  }

  // POST or DELETE — disable preview
  return new Response(null, {
    status: 200,
    headers: {'Set-Cookie': await destroySession(session)},
  })
}

export async function loader({request, context}: Route.LoaderArgs) {
  const token = context.env.SANITY_API_READ_TOKEN

  if (!token) {
    throw new Response('SANITY_API_READ_TOKEN not set', {status: 500})
  }

  const clientWithToken = client.withConfig({token})
  const {isValid, redirectTo = '/'} = await validatePreviewUrl(
    clientWithToken,
    request.url,
  )

  if (!isValid) {
    return new Response('Invalid preview URL', {status: 401})
  }

  const sessionSecret = context.env.SESSION_SECRET || 'dev-secret-change-me'
  const {getSession, commitSession} = createPreviewSessionStorage(sessionSecret)
  const session = await getSession(request.headers.get('Cookie'))
  session.set('previewMode', true)

  const url = new URL(request.url)
  const perspectiveParam = url.searchParams.get('sanity-preview-perspective')
  if (perspectiveParam) {
    session.set('perspective', perspectiveParam as ClientPerspective)
  }

  return new Response(null, {
    status: 307,
    headers: {
      Location: redirectTo,
      'Set-Cookie': await commitSession(session),
    },
  })
}
