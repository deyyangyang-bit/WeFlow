<#
.SYNOPSIS
  原生 Windows Caddy —— 停止本轮原生进程并按需恢复容器 caddy。

.DESCRIPTION
  安全边界：
  - 只结束 state 文件里记录的精确 PID；PID 不存在、进程已不属于本轮的
    可执行路径、或进程已退出时一律不动手；
  - 绝不按映像名宽泛结束进程（只认本轮记录的那一个 PID）；
  - 恢复只执行 `start caddy`，不 `up`、不 `down`、不删容器、不删卷；
  - 不触碰 Central / PostgreSQL。

.PARAMETER PackageRoot
  交付包解压根目录。
.PARAMETER ReleaseDir
  现有 Central 发布目录。
.PARAMETER NativeEnvPath
  native.env 路径。
.PARAMETER RestoreContainer
  停止原生进程后，用 `start caddy` 恢复原容器 caddy。
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$PackageRoot,
  [Parameter(Mandatory)][string]$ReleaseDir,
  [string]$NativeEnvPath,
  [switch]$RestoreContainer
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'WeFlowNative.Common.ps1')

$composeProject = 'weflow-test'
$templatePath = Join-Path $PackageRoot 'central\windows-caddy\Caddyfile.template'
if (-not $NativeEnvPath) { $NativeEnvPath = Join-Path $PackageRoot 'native.env' }
$config = Read-WeFlowNativeEnv -Path $NativeEnvPath -CaddyfileTemplatePath $templatePath

$currentStatePath = Join-Path $config.StateDir 'native-caddy.current.json'
if (-not (Test-Path -LiteralPath $currentStatePath -PathType Leaf)) {
  throw "找不到本轮状态文件：$currentStatePath（无法确定要结束哪个 PID，拒绝执行）"
}
$state = Get-Content -LiteralPath $currentStatePath -Raw | ConvertFrom-Json

$process = Get-Process -Id $state.Pid -ErrorAction SilentlyContinue
if (-not $process) {
  Write-Host "PID $($state.Pid) 已不存在，无需停止。" -ForegroundColor Yellow
} else {
  # 只认同一条记录：PID 存活且其主模块路径等于本轮记录的可执行路径。
  $actualPath = $process.Path
  if ($actualPath -ne $state.ExecutablePath) {
    throw "PID $($state.Pid) 的可执行路径为 '$actualPath'，与本轮记录的 '$($state.ExecutablePath)' 不符——拒绝结束该进程。"
  }
  Stop-Process -Id $state.Pid -Force
  Write-Host "已结束原生 Caddy PID $($state.Pid)（$actualPath）" -ForegroundColor Green
}

if ($RestoreContainer) {
  Push-Location $ReleaseDir
  try {
    Write-Host '恢复原容器 caddy（只 start，不 up/down，不删卷）...'
    & docker compose -p $composeProject --env-file central/proxy.env `
      -f docker-compose.central.yml -f docker-compose.central.tls.yml start caddy
    if ($LASTEXITCODE -ne 0) { throw "docker compose start caddy 失败（退出码 $LASTEXITCODE）" }
    Write-Host '原容器 caddy 已恢复。' -ForegroundColor Green
  } finally { Pop-Location }
}

Remove-Item -LiteralPath $currentStatePath -Force -ErrorAction SilentlyContinue
Write-Host '本轮原生进程状态已清理；Central / PostgreSQL 与数据卷全程未被触碰。'
