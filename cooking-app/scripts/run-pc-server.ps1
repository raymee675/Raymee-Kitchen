param(
  [string]$NodePath = "",
  [string]$LogPath = ""
)

$ErrorActionPreference = "Stop"
$appPath = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
Set-Location -LiteralPath $appPath

if ([string]::IsNullOrWhiteSpace($NodePath)) {
  $nodeCommand = Get-Command node -ErrorAction Stop
  $NodePath = $nodeCommand.Source
}
if (-not (Test-Path -LiteralPath $NodePath)) {
  throw "Node.jsが見つかりません: $NodePath"
}
foreach ($page in @("index.html", "admin.html")) {
  if (-not (Test-Path -LiteralPath (Join-Path $appPath "dist-pc\$page"))) {
    throw "PC版の画面がありません。先に npm ci と npm run build:pc を実行してください。"
  }
}

$dataPath = Join-Path $appPath "data-pc"
New-Item -ItemType Directory -Path $dataPath -Force | Out-Null
$env:KITCHEN_DB_PATH = Join-Path $dataPath "kitchen.sqlite"
if ([string]::IsNullOrWhiteSpace($LogPath)) {
  & $NodePath "server/index.mjs"
} else {
  New-Item -ItemType Directory -Path (Split-Path -Parent $LogPath) -Force | Out-Null
  & $NodePath "server/index.mjs" *>> $LogPath
}
exit $LASTEXITCODE
