@echo off
setlocal
echo ========================================================
echo   Machii Bazzar - EOD Auto Sync ^& Vercel Auto Deploy
echo ========================================================

cd /d "%~dp0"

echo [1/3] Running sync engine...
call node scripts/sync-stock-universe.js
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Synchronization failed. Aborting deploy.
    pause
    exit /b %ERRORLEVEL%
)

echo [2/3] Staging and committing updated stock data...
git add -A
git diff --staged --quiet
if %ERRORLEVEL% EQU 0 (
    echo [INFO] Dataset is already up-to-date. Nothing to deploy.
) else (
    git commit -m "chore(data): auto-update EOD stock data"
    echo [3/3] Pushing to GitHub (triggers Vercel Auto-Deploy)...
    git push origin main
    echo ========================================================
    echo   SUCCESS: Changes pushed to GitHub!
    echo   Vercel is now building and deploying to production.
    echo ========================================================
)

endlocal
