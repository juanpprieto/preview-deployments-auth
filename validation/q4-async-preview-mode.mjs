/**
 * Q4 Validation: Async previewMode E2E test
 *
 * Simulates what Sanity Presentation tool does:
 * 1. Calls async previewMode function with {client, origin, targetOrigin}
 * 2. Gets back {enable: '/api/preview?_auth=TOKEN'}
 * 3. Constructs the full iframe URL
 * 4. Tests if that URL passes through the Oxygen Gateway
 *
 * This validates the core flow WITHOUT needing a running Sanity Studio.
 */

// -- Config --
const STABLE_STAGING_URL = 'https://staging-f47de06af4f98b573090.o2.myshopify.dev'
// Deploy C token (current staging deployment)
const CURRENT_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJnaWQ6Ly9veHlnZW4taHViL0RlcGxveW1lbnQvNDA1MTYyMyIsImtpbmQiOiJURVNUSU5HX0FVVE9NQVRJT04iLCJpYXQiOjE3NzEzNTI2NDQsImV4cCI6MTc3MTM5NTg0NH0.4S_eD6_9MoslxRzBYFVKl48HBgbtbLiWYUDaS_mDvyQ'

// -- Simulate the plugin's resolveOxygenPreviewMode --
async function resolveOxygenPreviewMode(options = {}) {
  const {enablePath = '/api/preview', fallbackToStatic = true} = options

  return async (context) => {
    const {targetOrigin} = context

    // In real plugin: client.fetch() for the token from Sanity document
    // Here we simulate with the hardcoded token
    console.log(`[plugin] Called with targetOrigin: ${targetOrigin}`)

    if (targetOrigin.includes('localhost')) {
      console.log(`[plugin] Localhost detected, returning static enable path`)
      return {enable: enablePath}
    }

    // Simulate fetching token from Sanity document
    const authToken = CURRENT_TOKEN
    if (authToken) {
      const params = new URLSearchParams({_auth: authToken})
      const result = {enable: `${enablePath}?${params}`}
      console.log(`[plugin] Returning: ${JSON.stringify(result).slice(0, 80)}...`)
      return result
    }

    if (fallbackToStatic) return {enable: enablePath}
    return false
  }
}

// -- Simulate Presentation tool's iframe URL construction --
async function simulatePresentationTool() {
  console.log('=== Q4: Async previewMode E2E Validation ===\n')

  // Step 1: Create the async previewMode resolver (what the plugin exports)
  const previewModeResolver = await resolveOxygenPreviewMode({
    enablePath: '/api/preview-mode/enable', // This Hydrogen app doesn't have this route, but we test Gateway auth
  })

  // Step 2: Simulate the context Presentation tool provides
  const context = {
    client: null, // Would be SanityClient in real usage
    origin: 'https://test-studio.sanity.studio',
    targetOrigin: STABLE_STAGING_URL,
  }

  // Step 3: Call the resolver (what Presentation tool does internally)
  const previewMode = await previewModeResolver(context)
  console.log(`\n[presentation] previewMode result:`, JSON.stringify(previewMode).slice(0, 100))

  if (!previewMode || !previewMode.enable) {
    console.log('FAIL: previewMode returned false or no enable path')
    process.exit(1)
  }

  // Step 4: Construct the full iframe URL (what Presentation tool builds)
  // Pattern: ${targetOrigin}${enable}&sanity-preview-secret=xxx&sanity-preview-pathname=/
  const enableUrl = new URL(previewMode.enable, STABLE_STAGING_URL)
  enableUrl.searchParams.set('sanity-preview-secret', 'test-secret-not-real')
  enableUrl.searchParams.set('sanity-preview-pathname', '/')

  console.log(`\n[presentation] Full iframe URL:\n  ${enableUrl.toString().slice(0, 120)}...`)

  // Step 5: Test if the Gateway passes through
  console.log(`\n--- Testing Gateway auth ---`)

  // Test 1: The full enable URL (what Presentation tool sends to iframe)
  const fullUrl = enableUrl.toString()
  const res1 = await fetch(fullUrl, {redirect: 'manual'})
  console.log(`\n1. Full enable URL: HTTP ${res1.status}`)
  if (res1.status === 200) {
    console.log('   PASS: Gateway accepted ?_auth= on the enable path')
  } else if (res1.status === 302) {
    console.log('   FAIL: Gateway rejected - 302 redirect')
    console.log(`   Location: ${res1.headers.get('location')?.slice(0, 80)}...`)
  } else if (res1.status === 404) {
    console.log('   PARTIAL PASS: Gateway accepted (404 = app route not found, but Gateway passed through)')
  } else {
    console.log(`   UNKNOWN: Unexpected status ${res1.status}`)
  }

  // Test 2: Just the stable URL with ?_auth= (no extra params)
  const simpleUrl = `${STABLE_STAGING_URL}?_auth=${CURRENT_TOKEN}`
  const res2 = await fetch(simpleUrl, {redirect: 'manual'})
  console.log(`\n2. Simple ?_auth= URL: HTTP ${res2.status}`)

  // Test 3: Stable URL without auth (baseline)
  const res3 = await fetch(STABLE_STAGING_URL, {redirect: 'manual'})
  console.log(`3. No auth (baseline): HTTP ${res3.status}`)

  // Test 4: Check if cookie was set by the authenticated request
  const cookies = res1.headers.get('set-cookie')
  if (cookies && cookies.includes('auth_bypass_token')) {
    console.log(`\n4. Cookie set: YES (Max-Age=${cookies.match(/Max-Age=(\d+)/)?.[1]}s)`)
  } else {
    console.log(`\n4. Cookie set: ${cookies ? 'Other cookie: ' + cookies.slice(0, 80) : 'NO'}`)
  }

  console.log('\n=== Summary ===')
  console.log(`Gateway auth via ?_auth= on enable path: ${res1.status === 200 || res1.status === 404 ? 'PASS' : 'FAIL'}`)
  console.log(`Cookie issued for subsequent requests:   ${cookies?.includes('auth_bypass_token') ? 'PASS' : 'FAIL'}`)
  console.log(`Baseline (no auth) correctly blocked:    ${res3.status === 302 ? 'PASS' : 'FAIL'}`)

  if ((res1.status === 200 || res1.status === 404) && res3.status === 302) {
    console.log('\n** Q4 VALIDATED: Async previewMode with ?_auth= on enable path works E2E **')
  } else {
    console.log('\n** Q4 NEEDS INVESTIGATION **')
  }
}

simulatePresentationTool().catch(console.error)
