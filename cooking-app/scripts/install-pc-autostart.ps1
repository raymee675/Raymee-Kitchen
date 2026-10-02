param(
  [string]$NodePath = ""
)

$ErrorActionPreference = "Stop"
$appPath = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$runner = Join-Path $appPath "scripts\run-pc-server.ps1"
if (-not (Test-Path -LiteralPath (Join-Path $appPath "dist-pc\index.html"))) {
  throw "先に npm ci と npm run build:pc を実行してください。"
}
if ([string]::IsNullOrWhiteSpace($NodePath)) {
  $NodePath = (Get-Command node -ErrorAction Stop).Source
}
if (-not (Test-Path -LiteralPath $NodePath)) {
  throw "Node.jsが見つかりません: $NodePath"
}
$powershell = (Get-Command powershell.exe -ErrorAction Stop).Source
$logPath = Join-Path $appPath "data-pc\server.log"
$argument = '-NoProfile -ExecutionPolicy Bypass -File "' + $runner + '" -NodePath "' + $NodePath + '" -LogPath "' + $logPath + '"'
$action = New-ScheduledTaskAction -Execute $powershell -Argument $argument -WorkingDirectory $appPath
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName "TeppanKitchenTimer" -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description "PC内で鉄板タイマーとSQLiteを起動します。" -Force | Out-Null
Write-Output "Windowsログオン時に鉄板タイマーを起動するタスクを登録しました。"
Write-Output "解除する場合: Unregister-ScheduledTask -TaskName TeppanKitchenTimer"
