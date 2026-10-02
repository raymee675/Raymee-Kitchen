@echo off
chcp 65001 >nul
setlocal
set "APP_DIR=%~dp0cooking-app"
set "KITCHEN_LAUNCHER=%~f0"

if not exist "%APP_DIR%\package.json" goto app_not_found

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$identity = [Security.Principal.WindowsIdentity]::GetCurrent(); if (([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { exit 0 } else { exit 1 }"
if not errorlevel 1 goto run_server

echo 管理者権限を求めています。表示された確認画面で「はい」を選択してください。
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "try { Start-Process -FilePath $env:KITCHEN_LAUNCHER -Verb RunAs -ErrorAction Stop; exit 0 } catch { Write-Error $_; exit 1 }"
if errorlevel 1 (
  echo 管理者権限が許可されなかったため、起動を中止しました。
  pause
)
exit /b

:run_server
cd /d "%APP_DIR%"

rem Open the browser once the elevated server is ready.
start "" /b powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference = 'SilentlyContinue'; for ($i = 0; $i -lt 60; $i++) { try { $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8780/api/health' -TimeoutSec 1; if ($health.status -eq 'ok') { Start-Process 'http://localhost:8780'; exit 0 } } catch {}; Start-Sleep -Milliseconds 500 }"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%APP_DIR%\scripts\run-pc-server-admin.ps1"
if errorlevel 1 (
  echo PowerShell could not start the server. See the error above.
  pause
  exit /b 1
)
exit /b 0

:app_not_found
echo このファイルと同じ場所に cooking-app フォルダーが見つかりません。
pause
exit /b 1
