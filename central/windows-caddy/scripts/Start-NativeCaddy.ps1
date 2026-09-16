<#
.SYNOPSIS
  原生 Windows Caddy —— 受控切换：停容器 caddy → 启动原生进程 → 记录 PID。

.DESCRIPTION
  只在显式授权（-Authorized 或交互确认）后执行。原则：
  - 只停 `caddy` 这一个服务，统一用 -p weflow-test 与同一组两个 -f 文件；
  - 绝不 `down`、绝不删容器、绝不删卷、不触碰 Central / PostgreSQL；
  - 只结束本轮自己记录在 state 文件里的 PID，绝不按映像名宽泛杀进程；
  - 失败时回滚：结束本轮原生进程，再恢复原容器 caddy。
  本轮不注册 Windows 服务或计划任务——本脚本启动的是当前会话的前台进程。

.PARAMETER PackageRoot
  交付包解压根目录。
.PARAMETER ReleaseDir
  现有 Central 发布目录（含 docker-compose.central.yml 与 central\.env）。
.PARAMETER NativeEnvPath
  native.env 路径。
.PARAMETER Authorized
  显式授权标志；缺失时脚本只打印计划并退出非零，不做任何变更。
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$PackageRoot,
  [Parameter(Mandatory)][string]$ReleaseDir,
  [string]$NativeEnvPath,
  [switch]$Authorized
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'WeFlowNative.Common.ps1')

$composeFileBase = 'docker-compose.central.yml'
$composeFileTls  = 'docker-compose.central.tls.yml'
$composeProject  = 'weflow-test'

function Invoke-ComposeCaddy {
  <#
  .SYNOPSIS
    在固定项目名与固定两个 -f 文件下，对 caddy 服务执行一条 Compose 子命令。
  .DESCRIPTION
    -p 决定实际卷名（weflow-test_weflow-postgres），因此绝不能省。
  #>
  param([Parameter(Mandatory)][string[]]$ComposeArgs)
  Push-Location $ReleaseDir
  try {
    & docker compose -p $composeProject --env-file central/proxy.env `
      -f $composeFileBase -f $composeFileTls @ComposeArgs
    return $LASTEXITCODE
  } finally {
    Pop-Location
  }
}

$templatePath = Join-Path $PackageRoot 'central\windows-caddy\Caddyfile.template'
if (-not $NativeEnvPath) { $NativeEnvPath = Join-Path $PackageRoot 'native.env' }
$config = Read-WeFlowNativeEnv -Path $NativeEnvPath -CaddyfileTemplatePath $templatePath

if (-not $Authorized) {
  Write-Host '未提供 -Authorized：以下操作尚未执行，脚本空跑退出。' -ForegroundColor Yellow
  Write-Host "  1) 停止容器 caddy：docker compose -p $composeProject --env-file central/proxy.env -f $composeFileBase -f $composeFileTls stop caddy"
  Write-Host "  2) 启动原生进程：$($config.CaddyExe) run --config $($config.Caddyfile) --adapter caddyfile"
  Write-Host "  3) 记录 PID / 路径 / StartedAt 到 $($config.StateDir)"
  exit 2
}

if (-not (Test-Path -LiteralPath $config.Caddyfile -PathType Leaf)) {
  throw "生效配置不存在：$($config.Caddyfile)（先运行 Install-NativeCaddy.ps1）"
}

# --- 1. 记录原状态，供回退核对 ---
$previous = [ordered]@{
  RecordedAt = (Get-Date).ToString('o')
  ComposePsOutput = ''
  ContainerCaddyRunning = $false
}
Push-Location $ReleaseDir
try {
  $previous.ComposePsOutput = (& docker compose -p $composeProject --env-file central/proxy.env `
    -f $composeFileBase -f $composeFileTls ps caddy 2>&1 | Out-String)
} finally { Pop-Location }
$previous.ContainerCaddyRunning = $previous.ComposePsOutput -match '\bUp\b|\brunning\b'
if (-not (Test-Path -LiteralPath $config.StateDir)) { New-Item -ItemType Directory -Force -Path $config.StateDir | Out-Null }
$statePath = Join-Path $config.StateDir 'native-caddy.state.json'
$previous | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $statePath -Encoding UTF8
Write-Host "已记录切换前状态 -> $statePath"

# --- 2. 只停容器 caddy ---
if ($previous.ContainerCaddyRunning) {
  Write-Host '停止容器 caddy（不 down、不删容器、不删卷）...'
  $exit = Invoke-ComposeCaddy -ComposeArgs @('stop', 'caddy')
  if ($exit -ne 0) { throw "docker compose stop caddy 失败（退出码 $exit）" }
} else {
  Write-Host '容器 caddy 当前未运行，跳过停止步骤。'
}

# --- 3. 启动原生 Caddy 并记录精确 PID ---
$stdoutLog = Join-Path $config.LogDir 'native-caddy.stdout.log'
$stderrLog = Join-Path $config.LogDir 'native-caddy.stderr.log'
Write-Host "启动原生 Caddy：$($config.CaddyExe)"
$process = Start-Process -FilePath $config.CaddyExe `
  -ArgumentList @('run', '--config', $config.Caddyfile, '--adapter', 'caddyfile') `
  -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog `
  -PassThru -WindowStyle Hidden

Start-Sleep -Seconds 3
$process.Refresh()
if ($process.HasExited) {
  Write-Host "原生 Caddy 启动后立即退出（退出码 $($process.ExitCode)），开始回滚。" -ForegroundColor Red
  Get-Content -LiteralPath $stderrLog -Tail 40 -ErrorAction SilentlyContinue | Write-Host
  if ($previous.ContainerCaddyRunning) {
    Invoke-ComposeCaddy -ComposeArgs @('start', 'caddy') | Out-Null
    Write-Host '已恢复原容器 caddy。' -ForegroundColor Yellow
  }
  throw '原生 Caddy 未能保持运行，本轮切换已回滚。'
}

$state = [ordered]@{
  Pid             = $process.Id
  ExecutablePath  = $config.CaddyExe
  ConfigPath      = $config.Caddyfile
  StartedAt       = $process.StartTime.ToString('o')
  BindIp          = $config.BindIp
  AllowedCidr     = $config.AllowedCidr
  Hostname        = $config.Hostname
  Upstream        = $config.Upstream
  RollbackStopCmd = "docker compose -p $composeProject --env-file central/proxy.env -f $composeFileBase -f $composeFileTls start caddy"
}
$state | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $config.StateDir 'native-caddy.current.json') -Encoding UTF8

Write-Host ''
Write-Host '原生 Caddy 已启动：' -ForegroundColor Green
Write-Host "  PID          : $($state.Pid)"
Write-Host "  可执行路径   : $($state.ExecutablePath)"
Write-Host "  配置路径     : $($state.ConfigPath)"
Write-Host "  启动时间     : $($state.StartedAt)"
Write-Host "  监听         : https://$($config.BindIp):443 （证书仅对 $($config.Hostname) 有效）"
Write-Host ''
Write-Host '退出本终端不会结束该进程；需要停止请执行 Stop-NativeCaddy.ps1（它只结束上面这个 PID）。'
