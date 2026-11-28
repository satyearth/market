# Machii Bazzar v2.0.0 — Rollback & Recovery Guide

**Design Guarantee:** Dataset versions stored in Supabase Storage (`datasets/` and `history/`) are immutable (`upsert: false`). Failed uploads, SHA-256 checksum mismatches, validation errors, shrinkage >10%, or pre-commit lock-fence losses **abort before touching `latest.json`**, preserving the last-known-good dataset automatically.

---

## 1. Automatic Fail-Safe Guarantees (Verified in Tests)

1. **Failed Exchange Download / Corrupt Archive**: `bhavcopy-downloader.js` validates ZIP headers, required columns, minimum row counts, `TradDt`, and non-HTML content before replacing local files. Partial runs leave prior datasets intact (`test-pipeline.js` checks #2, #3, #9, #10, #11, #13).
2. **Dataset Validation / Universe Shrinkage (>10%)**: `dataset-validator.js` aborts compilation before writing `js/stocks-data.js` or uploading to Supabase Storage (`validation.test.js`, `test-pipeline.js` check #16).
3. **SHA-256 Read-Back Verification**: `supabase-storage.js` downloads every uploaded daily and historical snapshot back from Supabase Storage and compares `sha256Hex` + decoded stock count + schema invariants before considering pointer swap (`storage-retention.test.js`).
4. **Pre-Commit Lock Ownership Fence**: Immediately prior to uploading `latest.json`, `publishDatasetToStorage` calls `verifyLockOwnership(ownerId)` (`phase: 'verify_lock_fence'`). If ownership changed or expired mid-publish, pointer swap aborts (`audit-regression.test.js` #10).
5. **Client-Side & Serverless Fallback**: If Supabase Storage is unreachable, API handlers fall back cleanly to the bundled `js/stocks-data.js`; if APIs are offline, `stock.html` lazy-loads `./js/stocks-data.js` (`test-auto-refresh.js` check #22, `security-and-ci.test.js`).

---

## 2. Application Code Rollback (Vercel Deployment)

1. Open Vercel Project -> **Deployments** -> select the previous known-good Production deployment -> **Promote to Production** (or `git revert <bad-commit>` on `main`).
2. Confirm `GET /api/health`, `GET /api/market/status`, and `GET /api/stocks?limit=50&offset=0` return HTTP `200` with security headers.
3. Because `js/stocks-data.js` only serves as cold/local fallback and Supabase `latest.json` drives live datasets, Vercel code rollback completes without needing re-ingestion unless `latest.json` schema changed.

---

## 3. Dataset Rollback in Supabase Storage (Recovering Last-Known-Good Snapshot)

Every `latest.json` manifest carries a `previousVersion` block:
```json
{
  "versionId": "<current>",
  "tradingDate": "<current-date>",
  "datasetPath": "datasets/<current-date>/stocks-dataset-...json",
  "previousVersion": {
    "versionId": "<prior-good-versionId>",
    "tradingDate": "<prior-good-date>",
    "datasetPath": "datasets/<prior-good-date>/stocks-dataset-...json",
    "sha256": "<prior-sha256>",
    "historicalDataset": {
      "versionId": "<prior-hist-versionId>",
      "datasetPath": "history/<prior-good-date>/historical-prices-...json",
      "sha256": "<prior-hist-sha256>"
    }
  }
}
```

To roll back a bad dataset publication cleanly without waiting for full re-ingestion:

1. **Acquire/Verify Lock State**: Confirm no GitHub Actions `stock-data-refresh` job is active.
2. **Download Current `latest.json`** and inspect `previousVersion` (confirm `previousVersion.datasetPath` and `previousVersion.historicalDataset.datasetPath` exist in Supabase Storage — retention pruning strictly protects both `latest` and `previousVersion`, verified in `storage-retention.test.js` & `test-pipeline.js` check #29).
3. **Reconstruct Target Manifest**: Download the previous verified snapshot or download its previous `versionId` metadata and construct a restored `latest.json` manifest pointing `versionId`, `tradingDate`, `datasetPath`, `sha256`, and `historicalDataset` back to `previousVersion` (updating `refreshedAtUtc` if cache busting is desired, or keeping `versionId` exact).
4. **Upload `latest.json`** (`upsert: true`, `cacheControl: '30'`) via authenticated `service_role` REST/SDK call.
5. **Verify Cache Expiration**: Wait up to `15–60s` for serverless `15s` pointer cache + CDN `s-maxage=15` TTL to roll over, then confirm `GET /api/market/status` reports `tradingDate === <prior-good-date>`.
6. **Re-Publish Corrected Session**: Once root cause is fixed, run `node scripts/refresh.js --date=<target-date> --force` (with `SUPABASE_*` env configured) or `workflow_dispatch` with `date` + `force: true`.
   *(Note: if rolling back to an older date while CI runs later, `--allow-downgrade` is required on `refresh.js` ONLY if intentionally overwriting a newer corrupted date in `latest.json`.)*

---

## 4. Local Dataset Backup Recovery

On local server / operator workstation runs (`publisher.js`):
- `publisher.js` creates `js/stocks-data.backup.js` automatically prior to atomic `fs.renameSync` replacement and removes stale `.tmp` files via `cleanupTempFiles`.
- To restore locally if needed: copy `js/stocks-data.backup.js` over `js/stocks-data.js` and re-run `npm run verify:dataset`.
