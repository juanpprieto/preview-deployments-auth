/// <reference types="vite/client" />
/// <reference types="react-router" />
/// <reference types="@shopify/oxygen-workers-types" />
/// <reference types="@shopify/hydrogen/react-router-types" />

// Enhance TypeScript's built-in typings.
import '@total-typescript/ts-reset';

declare global {
  interface Env {
    SANITY_API_READ_TOKEN: string
    SANITY_PROJECT_ID: string
    SANITY_DATASET: string
    SANITY_STUDIO_URL: string
    SESSION_SECRET: string
  }

  interface HydrogenAdditionalContext {
    sanity: import('hydrogen-sanity').SanityContext
  }
}
