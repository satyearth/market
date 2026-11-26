# External Storage Architecture & Setup (Supabase Storage)

Machii Bazzar publishes daily NSE + BSE EOD datasets to **Supabase Storage** from GitHub Actions without creating Git commits or triggering daily Vercel redeployments.

---

## Architecture Overview

```
GitHub Actions (scheduled Mon-Fri IST + Sun Muhurat check)
  ├─ 1. Download & validate NSE (.csv.zip) + BSE (.CSV) BhavCopy + India VIX + 52W High/Low
  ├─ 2. Backfill any missing trailing sessions (respecting holidays & weekends)
  ├─ 3. Hydrate cached reference/*.json enrichment metadata when running on cold runner
  ├─ 4. Merge on canonical ISIN & run strict financial integrity checks
  ├─ 5. Acquire distributed lock (locks/refresh.lock.json)
  ├─ 6. Upload compact gzip+base64 historical matrix -> history/<tradingDate>/historical-prices-<versionId>.json (reused if unchanged) + verify SHA-256
  ├─ 7. Upload lean daily stocks snapshot (no inline 90-session arrays) -> datasets/<tradingDate>/stocks-dataset-<versionId>.json + verify SHA-256
  ├─ 8. Atomically swap pointer -> latest.json (previous valid daily & historical versions preserved)
  └─ 9. Retain latest 90 daily sessions (datasets/) + 10 rolling 90-session history snapshots (history/), protecting active/previous/locks/reference

Vercel Serverless APIs (zero redeploy needed)
  ├─ GET /api/health          -> readiness, dataset date, freshness & storage configuration probe
  ├─ GET /api/market/status   -> checks latest.json manifest + IST calendar freshness + historicalDataset metadata
  ├─ GET /api/market/dataset  -> returns latest.json stats + historicalDataset metadata + freshness
  ├─ GET /api/market/history  -> returns 90-session history metadata or per-ISIN closing series on demand
  └─ GET /api/stocks          -> caches daily dataset per versionId and hydrates separated history automatically for ISIN queries
```

---

## 1. Create Supabase Storage Bucket

1. Open your Supabase project → **Storage** → **New bucket**.
2. Name the bucket **`machii-bazzar-datasets`** (or set a custom name in `SUPABASE_STORAGE_BUCKET`).
3. Recommended: keep the bucket **Private** (Vercel uses `SUPABASE_ANON_KEY` or `SUPABASE_SERVICE_ROLE_KEY`, or make the bucket public if you prefer unauthenticated read URLs).

---

## 2. Configure GitHub Actions Secrets & Variables

In your GitHub repository → **Settings → Secrets and variables → Actions**:

| Type | Name | Value | Required |
|---|---|---|---|
| Secret | `SUPABASE_URL` | `https://<project-ref>.supabase.co` | Yes |
| Secret | `SUPABASE_SERVICE_ROLE_KEY` | Supabase `service_role` key (server-side write + lock) | Yes |
| Variable | `SUPABASE_STORAGE_BUCKET` | `machii-bazzar-datasets` (default if omitted) | Optional |

> **Security:** Never commit `SUPABASE_SERVICE_ROLE_KEY` or `.env` files to source control.

---

## 3. Configure Vercel Environment Variables

In your Vercel project → **Settings → Environment Variables** (Production & Preview):

| Name | Value | Required |
|---|---|---|
| `SUPABASE_URL` | `https://<project-ref>.supabase.co` | Yes |
| `SUPABASE_STORAGE_BUCKET` | `machii-bazzar-datasets` (default if omitted) | Optional |
| `SUPABASE_ANON_KEY` *(or `SUPABASE_SERVICE_ROLE_KEY`)* | Needed if the bucket is **Private**; omit only if bucket is **Public** | Recommended |

Once set, redeploy Vercel **once** so the updated serverless functions pick up these environment variables. All subsequent daily stock updates appear automatically within seconds of GitHub Actions publishing `latest.json`.

---

## 4. Local Development Compatibility

- **Without Supabase env vars set locally:** `npm start` and `node scripts/refresh.js --latest` read and write `js/stocks-data.js` locally on disk as before.
- **With Supabase env vars set locally:** `node scripts/refresh.js --latest` builds locally **and** publishes atomically to Supabase Storage, and `npm start` serves from Supabase Storage with automatic fallback to local `js/stocks-data.js`.
