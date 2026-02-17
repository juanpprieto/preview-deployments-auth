import {createClient} from '@sanity/client'

declare global {
  interface Window {
    ENV: {
      PUBLIC_SANITY_PROJECT_ID: string
      PUBLIC_SANITY_DATASET: string
      PUBLIC_SANITY_STUDIO_URL: string
    }
  }
}

const env = typeof document === 'undefined' ? process.env : window.ENV

export const client = createClient({
  projectId: env.PUBLIC_SANITY_PROJECT_ID || 'sx997gpv',
  dataset: env.PUBLIC_SANITY_DATASET || 'production',
  apiVersion: '2025-01-01',
  useCdn: false,
  stega: {
    studioUrl: env.PUBLIC_SANITY_STUDIO_URL || 'https://meditate-with-eve.sanity.studio',
  },
})
