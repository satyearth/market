# Machii Bazzar v2.0.0 — Deployment Configuration & Verification Checklist

**Target Platforms:** Vercel (Stateless Web + `api/**/*.js`), Supabase Storage (`machii-bazzar-datasets`), GitHub Actions (`.github/workflows/refresh-stock-data.yml`)

---

## 1. Source-Verified Environment Variable Inventory

All variables below were verified directly against `api/`, `src/`, `scripts/`, and `.github/workflows/refresh-stock-data.yml`.

### 1.1 Vercel Project Environment Variables (Production & Preview)

| Variable | Classification | Client-Exposed? | Status | Requirement & Behavior |
| :--- | :---: | :---: | :---: | :--- |
| `SUPABASE_URL` | **Required** | **No** (Serverless only) | **NOT VERIFIED** | Base HTTPS URL `https://<project-ref>.supabase.co`. Used by `src/storage/supabase-storage.js` to read `latest.json`, `datasets/`, and `history/`. |
| `SUPABASE_ANON_KEY` *(or `SUPABASE_SERVICE_ROLE_KEY`)* | **Recommended** (Required if bucket is Private) | **No** | **NOT VERIFIED** | Prefer `SUPABASE_ANON_KEY` (least privilege read-only) on Vercel when Storage RLS allows read; avoid exposing `service_role` to Vercel runtime unless bucket policies require it. |
| `SUPABASE_STORAGE_BUCKET` | Optional (default: `machii-bazzar-datasets`) | **No** | **NOT VERIFIED** | Overrides default bucket name. |
| `REFRESH_API_SECRET` | **Required in Production** | **No** | **NOT VERIFIED** | High-entropy random secret (`>= 32` chars). When running on Vercel (`VERCEL=1` or `NODE_ENV=production`), **omitting this variable causes `POST /api/market/refresh` to fail closed with HTTP `503`**. |

### 1.2 GitHub Actions Repository Configuration (`.github/workflows/refresh-stock-data.yml`)

| Scope | Name | Classification | Status | Requirement & Behavior |
| :--- | :--- | :---: | :---: | :--- |
| **Secret** | `SUPABASE_URL` | **Required** | **NOT VERIFIED** | Target Supabase project HTTPS URL. |
| **Secret** | `SUPABASE_SERVICE_ROLE_KEY` | **Required** | **NOT VERIFIED** | Server-side write credential for locks, datasets, history, references, pointer swaps, and pruning. Never inject into client bundles or logs. |
| **Variable** | `SUPABASE_STORAGE_BUCKET` | Optional (`machii-bazzar-datasets`) | **NOT VERIFIED** | Must match Vercel's `SUPABASE_STORAGE_BUCKET`. |
| **Variable** | `REFRESH_WAIT_MINUTES` | Optional (default: `15`) | **NOT VERIFIED** | Bounded polling window for delayed post-close BhavCopy files. |
| **Variable** | `REFRESH_POLL_SECONDS` | Optional (default: `30`) | **NOT VERIFIED** | Poll interval inside delayed-publication retry loop. |

### 1.3 Local Development Runtime Only

- `PORT` (optional HTTP bind port for `server.js`, default `3000`; binds `127.0.0.1` only unless configured).
- Note: `.github/workflows/refresh-stock-data.yml` sets `TZ: Asia/Kolkata`, `GITHUB_ACTIONS`, `GITHUB_OUTPUT`, `EXPECTED_DATE`, `INPUT_DRY_RUN`, `JOB_STATUS` at runtime.

---

## 2. Deployment Configuration Gate Status

| Gate | Status | Supporting Evidence | Remaining Action |
| :--- | :---: | :--- | :--- |
| `vercel.json` function sizing & headers | **PASS** | `includeFiles: "js/stocks-data.js"`, `maxDuration: 60`, CSP (`script-src 'self'`), `nosniff`, `Referrer-Policy`, `DENY`, `Permissions-Policy` verified | Confirm `js/stocks-data.js` (`22.19 MiB`) fits Vercel serverless bundle size limits during live deploy |
| `.vercelignore` excludes non-runtime assets | **PASS** | Excludes `.git`, `.github`, `.backup`, `.vscode`, `downloads`, `docs`, `tests`, `scripts`, `test-results`, `server.js`, `.env*` | Optionally add `*.md` to keep root Markdown audit reports out of Vercel lambda uploads |
| Zero secrets in client bundles / git | **PASS** | `Select-String` across `js/`, `index.html`, `stock.html` returned `0` secret token references; `.gitignore` ignores `.env*` | Re-verify after final commit before pushing |
| Fail-closed refresh auth in production | **PASS** | Tested in `tests/audit-regression.test.js` #13 & `smoke-verify.js`: `POST /api/market/refresh` returns `503` if `REFRESH_API_SECRET` unset in prod, `401` on invalid secret | Set `REFRESH_API_SECRET` in Vercel Env Vars |
| Supabase bucket ACLs & private boundaries | **NOT VERIFIED** | Offline tests mock REST transport cleanly (`test-bucket`) | Verify bucket is created (`machii-bazzar-datasets`), RLS prevents public `write`/`delete`, and Vercel can read `latest.json` |
| Vercel Firewall / WAF distributed rate limit | **NOT VERIFIED** | App-level `SlidingWindowRateLimiter` is single-instance only | Add Vercel Firewall rules capping bursts on `/api/stocks` and `/api/market/refresh` |
| GitHub Actions live dry-run & cron | **NOT VERIFIED** | Workflow statically verified (`contents: read`, `concurrency: stock-data-refresh`, zero git push) | Set Secrets in GitHub Settings -> run `workflow_dispatch` (`dry_run=true`, then `dry_run=false`) |

---

## 3. Authorized Production Cutover Procedure (Operator Steps)

1. **Stage & Commit Cleanly**:
   - Inspect `git status` and exclude any unwanted local reports (`docs/reports/logo-supplemental-audit-2026-11-28.json` if not intended for Git) before creating the release commit on `main`.
2. **Verify Supabase Storage & Permissions**:
   - Confirm bucket `machii-bazzar-datasets` exists with private write/delete access restricted to `service_role`.
   - Seed `reference/*.json` (`benchmark_stocks_verified.json`, `bse_list_securities_verified.json`, `screener_market_caps.json`, `api-companies-catalog.json`) via authorized upload (`npm run storage:publish-with-ref` or CI).
3. **Verify GitHub Actions Before Vercel Cutover**:
   - Configure `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in GitHub Actions Secrets.
   - Trigger **Daily NSE + BSE EOD Stock Data Refresh** manually with `dry_run: true`, then `dry_run: false`.
   - Confirm job summary shows `Trading Date = <latest session>`, `Total Stocks >= 5465`, and `Git Commits Created: 0`.
4. **Configure Vercel & Deploy**:
   - Set `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_STORAGE_BUCKET`, and `REFRESH_API_SECRET`.
   - Configure Vercel Firewall rate limits on `/api/stocks*` and `/api/market/refresh*`.
   - Deploy authorized release commit to Vercel Production.
5. **Post-Deploy Live Smoke Verification**:
   ```powershell
   curl.exe -sSI https://<prod-domain>/api/health
   curl.exe -sS https://<prod-domain>/api/market/status
   curl.exe -sS "https://<prod-domain>/api/stocks?limit=5&offset=0"
   curl.exe -sS -X POST https://<prod-domain>/api/market/refresh
   ```
   - Confirm `/api/health` returns `200`, `storageSource: "supabase"` (once seeded) and all 5 security headers.
   - Confirm `POST /api/market/refresh` without header returns `401 Unauthorized` (or `503` if secret unset), and returns `200`/`503` JSON status ONLY with valid `Authorization: Bearer <REFRESH_API_SECRET>`.
