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
    SANITY_STUDIO_URL: string
    SESSION_SECRET: string

    // Per-environment dataset vars. Oxygen does not allow the same env var
    // name to have different values per environment, so each environment
    // gets its own named var. Only the one scoped to the current Oxygen
    // environment will be defined at runtime.
    SANITY_DATASET_PRODUCTION?: string
    SANITY_DATASET_STAGING?: string
    SANITY_DATASET_PREVIEW?: string
    SANITY_DATASET_DEV?: string
  }

  interface HydrogenAdditionalContext {
    sanity: import('hydrogen-sanity').SanityContext
  }
}
