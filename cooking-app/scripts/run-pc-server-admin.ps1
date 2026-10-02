$ErrorActionPreference = "Stop"
$appPath = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$runtimeRuleName = "TeppanKitchenTimerRuntime8780"
$legacyRuleDisplayName = "Kitchen Timer 3-day"
$ruleCreated = $false
$exitCode = 0

try {
  Set-Location -LiteralPath $appPath

  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "管理者権限で起動してください。"
  }

  $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($nodeCommand) {
    $nodePath = $nodeCommand.Source
  } else {
    # Explorer may have a different PATH from the development terminal.
    $nodeCandidates = @(
      (Join-Path $env:ProgramFiles "nodejs\node.exe"),
      (Join-Path $env:LOCALAPPDATA "Programs\nodejs\node.exe"),
      (Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe")
    )
    $nodePath = $nodeCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if (-not $nodePath) { throw "Node.jsが見つかりません。Node.js 24.19.0以降をインストールしてください。" }
  }
  $nodeVersion = [version]((& $nodePath -p "process.versions.node").Trim())
  if ($nodeVersion -lt [version]"24.19.0") {
    throw "PC版には Node.js 24.19.0 以降が必要です。現在のバージョン: $nodeVersion"
  }

  $pages = @((Join-Path $appPath "dist-pc\index.html"), (Join-Path $appPath "dist-pc\admin.html"))
  if (@($pages | Where-Object { -not (Test-Path -LiteralPath $_) }).Count -gt 0) {
    $npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $npmCommand) { $npmCommand = Get-Command npm.exe -ErrorAction SilentlyContinue }
    if (-not $npmCommand) { $npmCommand = Get-Command npm -ErrorAction SilentlyContinue }
    $npmPath = if ($npmCommand) { $npmCommand.Source } else { Join-Path (Split-Path -Parent $nodePath) "npm.cmd" }
    if (-not (Test-Path -LiteralPath $npmPath)) { throw "PC版画面がなく、npmも見つかりません。Node.js 24.19.0以降（npm付き）をインストールしてから再実行してください。" }

    $vite = Join-Path $appPath "node_modules\vite\bin\vite.js"
    if (-not (Test-Path -LiteralPath $vite)) {
      Write-Host "初回準備: 依存関係をインストールしています..." -ForegroundColor Yellow
      & $npmPath ci
      if ($LASTEXITCODE -ne 0) { throw "npm ci に失敗しました。" }
    }
    Write-Host "初回準備: PC版画面をビルドしています..." -ForegroundColor Yellow
    & $npmPath run build:pc
    if ($LASTEXITCODE -ne 0) { throw "PC版画面のビルドに失敗しました。" }
    foreach ($page in $pages) { if (-not (Test-Path -LiteralPath $page)) { throw "ビルド後も必要な画面が見つかりません: $page" } }
  }

  $listener = Get-NetTCPConnection -State Listen -LocalPort 8780 -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($listener) { throw "8780番ポートはすでに使用中です。以前のサーバー用PowerShellを閉じてから再起動してください。" }

  Get-NetFirewallRule -Name $runtimeRuleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
  New-NetFirewallRule -Name $runtimeRuleName -DisplayName "鉄板タイマー（起動中のみ）" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8780 -RemoteAddress LocalSubnet -Profile Any | Out-Null
  $ruleCreated = $true
  Get-NetFirewallRule -DisplayName $legacyRuleDisplayName -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue

  $env:KITCHEN_HOST = "0.0.0.0"
  $env:KITCHEN_PORT = "8780"
  $env:KITCHEN_DB_PATH = Join-Path $appPath "data-pc\kitchen.sqlite"

  Write-Host ""
  Write-Host "鉄板タイマーを起動しました。スマホも同じWi-FiまたはPCのモバイル ホットスポットに接続してください。" -ForegroundColor Green
  Write-Host "PC:     http://localhost:8780"
  Write-Host "スマホ: ipconfig で確認したPC側のIPv4アドレスを使い、http://<IPv4>:8780 を開きます。"
  Write-Host "サーバーを止めるには、このPowerShellウィンドウを閉じるか Ctrl+C を押します。"
  Write-Host "ファイアウォールの許可は終了時に削除します。"
  Write-Host ""

  & $nodePath "server/index.mjs"
  $exitCode = $LASTEXITCODE
} catch {
  Write-Host "起動できませんでした: $($_.Exception.Message)" -ForegroundColor Red
  $exitCode = 1
} finally {
  if ($ruleCreated) {
    Get-NetFirewallRule -Name $runtimeRuleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
    Write-Host "起動中だけのファイアウォール許可を削除しました." -ForegroundColor Yellow
  }
}

if ($exitCode -ne 0) {
  Write-Host ""
  # The BAT keeps the console open even if parsing fails before this script runs.
}
exit $exitCode
