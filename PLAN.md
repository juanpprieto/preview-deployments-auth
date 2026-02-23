# Multi-Environment Sanity + Oxygen Plan

## Summary
Create `dev` and `staging` Sanity datasets, convert Studio to multi-workspace, parameterize CI, set per-environment Oxygen vars.

## Phases (sequential)

### Phase 1: Create Sanity datasets
- Create `staging` and `dev` datasets on project `sx997gpv`
- Via Sanity MCP `create_dataset` or CLI

### Phase 2: Seed minimal content per dataset
Each new dataset gets:
- 1x `sanity.oxygenProtectionBypass` doc (placeholder — CI overwrites on first deploy)
- 1x `marketingPage` with slug `home` + one hero section

Production dataset: rename existing `oxygen-bypass.staging` → `oxygen-bypass.production` for consistency.

### Phase 3: Convert Studio to multi-workspace
**File:** `~/code-jp/2026/studio-meditate-with-eve/sanity.config.ts`

Convert `defineConfig({...})` → `defineConfig([...])` with 3 workspace entries:
- `production` — dataset `production`, basePath `/production`
- `staging` — dataset `staging`, basePath `/staging`
- `dev` — dataset `dev`, basePath `/dev`

All share same schema, plugins, deskStructure. Each gets its own `presentationTool` instance (the `context.client` is auto-scoped to the workspace's dataset, so bypass queries return the correct env's URL).

`sanity.cli.ts` — no change needed (default dataset for CLI ops stays `production`).

### Phase 4: Update CI workflow
**File:** `.github/workflows/sanity-oxygen-bypass-sync.yml`

Add step: fetch PR `base.ref` via `gh api`, then map:
| Target branch | Dataset | Doc ID |
|---|---|---|
| `main` | `production` | `oxygen-bypass.production` |
| `staging` | `staging` | `oxygen-bypass.staging` |
| `dev` | `dev` | `oxygen-bypass.dev` |

All hardcoded values (`production`, `oxygen-bypass.staging`, `"Staging"`) become parameterized from this mapping.

**Constraint:** `SANITY_API_WRITE_TOKEN` must be project-scoped (not dataset-scoped) to write to all 3 datasets.

### Phase 5: Set Oxygen env vars
Per environment in Shopify admin:
| Oxygen env | `SANITY_DATASET` |
|---|---|
| Production | `production` |
| Staging | `staging` |
| Dev | `dev` |

Other vars (`SANITY_PROJECT_ID`, `SANITY_API_READ_TOKEN`, `SANITY_STUDIO_URL`) stay the same across all envs.

**No Hydrogen code changes** — `context.ts:33` already reads `env.SANITY_DATASET || 'production'`.

### Phase 6: Deploy Studio + validate
1. `sanity deploy` from Studio dir — deploys all 3 workspaces
2. Studio header shows workspace dropdown (Production / Staging / Dev)
3. Each workspace's Presentation tool queries its own dataset's bypass doc

### Phase 7: E2E validation
- Create PR targeting `staging` → push → Oxygen deploys → shopify[bot] comments → CI maps to `staging` dataset → patches bypass doc → Studio Staging workspace loads correct deployment
- Repeat for `dev` branch

## Files changed
| File | Change |
|---|---|
| Studio `sanity.config.ts` | Single config → array of 3 workspaces |
| `.github/workflows/sanity-oxygen-bypass-sync.yml` | Add branch→dataset mapping, parameterize all hardcoded values |

## Files NOT changed
- `app/lib/context.ts` — already reads `SANITY_DATASET` from env
- `app/entry.client.tsx` — auth interceptor is URL-agnostic
- `app/routes/_index.tsx` — queries run against whatever dataset context provides
- `plugins/resolveOxygenPreviewMode.ts` — queries by origin match, not dataset
- `deskStructure.ts`, `schemaTypes/` — shared across workspaces

## Risks
1. `SANITY_API_WRITE_TOKEN` must have project-level write access (not dataset-scoped)
2. `issue_comment` workflows only run from `main` — CI changes must be merged to main first before testing
3. First deploy to new env won't have bypass doc until CI runs — placeholder docs handle this
