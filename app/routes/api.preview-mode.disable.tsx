import {getSession, destroySession} from '~/sanity/session'
import type {Route} from './+types/api.preview-mode.disable'

export async function loader({request}: Route.LoaderArgs) {
  const url = new URL(request.url)
  const redirectTo = url.searchParams.get('redirect') || '/'

  const session = await getSession(request.headers.get('Cookie'))

  return new Response(null, {
    status: 307,
    headers: {
      Location: redirectTo,
      'Set-Cookie': await destroySession(session),
    },
  })
}
