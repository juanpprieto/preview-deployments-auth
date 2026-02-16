# Preview Deployment Staff Authentication — API Responses

API: `sourceCodeProviderUpdate` mutation on Shopify Admin API.

Key field: `pullRequestPreviewPublicUrl`
- `true` = staff auth **disabled** (preview deployments are public)
- `false` = staff auth **enabled** (preview deployments require Shopify staff login)

---

## Staff auth DISABLED (`pullRequestPreviewPublicUrl: true`)

```json
{
  "data": {
    "sourceCodeProviderUpdate": {
      "sourceCodeProvider": {
        "id": "gid://hydrogen-storefronts/StorefrontRepositoryInfo/36736",
        "pullRequestCommentsEnabled": true,
        "pullRequestPreviewPublicUrl": true,
        "__typename": "StorefrontRepositoryInfo"
      },
      "userErrors": [],
      "__typename": "SourceCodeProviderUpdatePayload"
    }
  }
}
```

## Staff auth ENABLED (`pullRequestPreviewPublicUrl: false`)

```json
{
  "data": {
    "sourceCodeProviderUpdate": {
      "sourceCodeProvider": {
        "id": "gid://hydrogen-storefronts/StorefrontRepositoryInfo/36736",
        "pullRequestCommentsEnabled": true,
        "pullRequestPreviewPublicUrl": false,
        "__typename": "StorefrontRepositoryInfo"
      },
      "userErrors": [],
      "__typename": "SourceCodeProviderUpdatePayload"
    }
  }
}
```

---

## Request Details (disable auth example)

### Endpoint

```
POST /api/operations/70530823855fa8e50c73ae1e01d054dd84112a9c41303614e7236925c2e4422b/SourceCodeProviderUpdate/hydrogen_storefronts/juanprieto
Host: admin.shopify.com
```

### Key Request Headers

| Header | Value |
|--------|-------|
| `content-type` | `application/json` |
| `apollographql-client-name` | `hydrogenStorefronts` |
| `shopify-proxy-api-enable` | `true` |
| `target-manifest-route-id` | `hydrogen:settingsSection:oxygenDeployments` |
| `target-pathname` | `/store/:storeHandle/hydrogen/:id/settings/oxygen_deployments` |
| `target-slice` | `admin-integrations` |
| `x-csrf-token` | (session-specific) |
| `referer` | `https://admin.shopify.com/store/2ndgentrecords/hydrogen/1000099369/settings/oxygen_deployments` |

### Key Response Headers

| Header | Value |
|--------|-------|
| `x-shopify-api-version` | `2025-04` |
| `x-shopid` | `60187836438` |
| `x-stats-apiclientid` | `1830279` |
| `x-stats-apipermissionid` | `375162667030` |

---

## Request Details (enable auth example)

### Endpoint

```
POST /api/operations/70530823855fa8e50c73ae1e01d054dd84112a9c41303614e7236925c2e4422b/SourceCodeProviderUpdate/hydrogen_storefronts/juanprieto
Host: admin.shopify.com
```

### Key Request Headers

| Header | Value |
|--------|-------|
| `content-type` | `application/json` |
| `content-length` | `639` |
| `apollographql-client-name` | `hydrogenStorefronts` |
| `shopify-proxy-api-enable` | `true` |
| `target-manifest-route-id` | `hydrogen:settingsSection:oxygenDeployments` |
| `target-pathname` | `/store/:storeHandle/hydrogen/:id/settings/oxygen_deployments` |
| `target-slice` | `admin-integrations` |
| `x-csrf-token` | (session-specific) |
| `referer` | `https://admin.shopify.com/store/2ndgentrecords/hydrogen/1000099369/settings/oxygen_deployments` |

### Key Response Headers

| Header | Value |
|--------|-------|
| `x-shopify-api-version` | `2025-04` |
| `x-shopid` | `60187836438` |
| `x-request-id` | `2a60bfa7-b05d-4b45-a346-5d90b7bfc6cb-1771236398` |
| `x-stats-apiclientid` | `1830279` |
| `x-stats-apipermissionid` | `375162667030` |
| `server-timing` | `upstream_processing;dur=176` |

---

## GitHubAccounts Query (repo linking / deployment auth permissions)

### Endpoint

```
GET /api/operations/00b5db8417b7f7809f0d96a548eb46be6e446a49eb493f5d151a7b085dad2654/GitHubAccounts/shopify/2ndgentrecords?operationName=GitHubAccounts&variables=%7B%7D
Host: admin.shopify.com
```

### Key Differences from SourceCodeProviderUpdate

| Aspect | SourceCodeProviderUpdate | GitHubAccounts |
|--------|--------------------------|----------------|
| Method | `POST` | `GET` |
| Persisted query hash | `70530823...` | `00b5db84...` |
| `apollographql-client-name` | `hydrogenStorefronts` | `core` |
| `x-shopify-api-version` | `2025-04` | `unstable` |
| GQL engine | (default) | `cardinal` (`x-shopify-api-gql-engine`) |
| URL path segments | `.../hydrogen_storefronts/juanprieto` | `.../shopify/2ndgentrecords` |
| Sets cookie | No | Yes (`_merchant_essential`) |

### Key Request Headers

| Header | Value |
|--------|-------|
| `apollographql-client-name` | `core` |
| `shopify-proxy-api-enable` | `true` |
| `target-manifest-route-id` | `hydrogen:settingsSection:oxygenDeployments` |
| `target-pathname` | `/store/:storeHandle/hydrogen/:id/settings/oxygen_deployments` |
| `target-slice` | `admin-integrations` |
| `x-csrf-token` | (session-specific) |

### Key Response Headers

| Header | Value |
|--------|-------|
| `x-shopify-api-version` | `unstable` |
| `x-shopify-api-gql-engine` | `cardinal` |
| `x-shopid` | `60187836438` |
| `x-request-id` | `047c8d5d-b663-496e-9291-4518f391257b-1771236807` |
| `server-timing` | `upstream_processing;dur=1309` (slower — likely fetches GitHub data) |
| `upstream_graphql` | `admin/query/GitHubAccounts` |

### Response Payload

```json
{
  "data": {
    "onlineStore": {
      "versionControlGithub": {
        "accounts": [
          {
            "id": 56428315,
            "name": "calltheguys",
            "avatar": "https://avatars.githubusercontent.com/u/56428315?s=60&v=4",
            "type": "ORGANIZATION",
            "installationId": "26904178",
            "hasLatestPermissions": true,
            "__typename": "OnlineStoreVersionControlAccount"
          },
          {
            "id": 61891522,
            "name": "all-gold",
            "avatar": "https://avatars.githubusercontent.com/u/61891522?s=60&v=4",
            "type": "ORGANIZATION",
            "installationId": "56848569",
            "hasLatestPermissions": true,
            "__typename": "OnlineStoreVersionControlAccount"
          },
          {
            "id": 64235328,
            "name": "remix-run",
            "avatar": "https://avatars.githubusercontent.com/u/64235328?s=60&v=4",
            "type": "ORGANIZATION",
            "installationId": "52236874",
            "hasLatestPermissions": true,
            "__typename": "OnlineStoreVersionControlAccount"
          },
          {
            "id": 12080141,
            "name": "juanpprieto",
            "avatar": "https://avatars.githubusercontent.com/u/12080141?s=60&v=4",
            "type": "USER",
            "installationId": "26595788",
            "hasLatestPermissions": true,
            "__typename": "OnlineStoreVersionControlAccount"
          }
        ],
        "__typename": "OnlineStoreVersionControlGithub"
      },
      "__typename": "OnlineStore"
    }
  },
  "extensions": {
    "cost": {
      "requestedQueryCost": 3,
      "actualQueryCost": 3,
      "throttleStatus": {
        "maximumAvailable": 20000.0,
        "currentlyAvailable": 19997,
        "restoreRate": 1000.0
      }
    }
  }
}
```

### Notes

- This is a **GET** query (read-only) — fetches GitHub accounts with Shopify GitHub App installations for the deployment settings page.
- Returns all GitHub accounts (orgs + user) where the Shopify GitHub App is installed, with their `installationId` and permission status.
- Uses the `core` Apollo client (not `hydrogenStorefronts`) — runs against the **main Admin GraphQL API** (`onlineStore.versionControlGithub`) on `unstable` version.
- The `cardinal` GQL engine and `unstable` API version suggest this hits a newer/different backend path than the mutation.
- URL path includes `shopify/2ndgentrecords` — likely `{github_org}/{store_handle}`.
- Response sets a new `_merchant_essential` cookie (session refresh).
- Query cost: 3 units out of 20,000 available (standard Admin API throttling).

---

## Observations

- **SourceCodeProviderUpdate**: Same endpoint + persisted query hash for both enable/disable — only the body payload differs (`content-length` 638 vs 639, the boolean flip).
- **GitHubAccounts** vs **SourceCodeProviderUpdate**: Different Apollo clients (`core` vs `hydrogenStorefronts`), different API versions (`unstable` vs `2025-04`), different GQL engines.
- Auth is cookie-based (`koa.sid` session + `x-csrf-token`). CSRF token was identical across all requests (same session).
- All requests routed through Shopify's internal proxy (`shopify-proxy-api-enable: true`) to `admin-integrations` slice.
- These are **not** public APIs — internal Admin UI GraphQL proxies used by the Hydrogen settings page.
