<#
.SYNOPSIS
  原生 Windows Caddy —— 只读预检 + 渲染配置 + `caddy validate`。

.DESCRIPTION
  本脚本不做任何破坏性操作：不停止容器、不删卷、不动 Central/PostgreSQL。
  它只回答三个问题——环境和端口是否可用、配置能否渲染、官方 Caddy 是否接受该配置。
  真正的进程切换在 Start-NativeCaddy.ps1，且必须显式授权。

.PARAMETER PackageRoot
  交付包解压根目录（含 caddy_2.11.4_windows_amd64.zip 与 central\windows-caddy\）。

.PARAMETER NativeEnvPath
  native.env 路径。默认 $PackageRoot\native.env，也接受 F:\WeFlow-Test\config\native.env。
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$PackageRoot,
  [string]$NativeEnvPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'WeFlowNative.Common.ps1')

function Write-Section {
  param([string]$Title)
  Write-Host ''
  Write-Host "== $Title ==" -ForegroundColor Cyan
}

function Get-CentralHealth {
  <#
  .SYNOPSIS
    只读探测宿主回环上的 Central 是否已就绪。
  .DESCRIPTION
    只访问 127.0.0.1:8787，不触碰容器、不发送凭据。
  #>
  foreach ($path in @('/health', '/ready')) {
    try {
      $response = Invoke-WebRequest -Uri "http://127.0.0.1:8787$path" -TimeoutSec 5 -UseBasicParsing
      Write-Host "  127.0.0.1:8787$path -> HTTP $([int]$response.StatusCode)"
    } catch {
      Write-Host "  127.0.0.1:8787$path -> 不可达（$($_.Exception.Message)）" -ForegroundColor Yellow
    }
  }
}

$templatePath = Join-Path $PackageRoot 'central\windows-caddy\Caddyfile.template'
$archivePath  = Join-Path $PackageRoot 'caddy_2.11.4_windows_amd64.zip'
if (-not $NativeEnvPath) { $NativeEnvPath = Join-Path $PackageRoot 'native.env' }

Write-Section '1. 主机与 IPv4'
Write-Host "  计算机名 : $env:COMPUTERNAME"
Write-Host "  当前时间 : $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')"
$addresses = Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.IPAddress -ne '127.0.0.1' -and $_.PrefixOrigin -ne 'WellKnown' } |
  Select-Object IPAddress, InterfaceAlias, PrefixOrigin
$addresses | Format-Table -AutoSize | Out-String | Write-Host
$isDhcp = ($addresses | Where-Object { $_.PrefixOrigin -eq 'Dhcp' }).Count -gt 0
if ($isDhcp) {
  Write-Host '  ⚠ 存在 DHCP 动态地址：换网或租约变更后绑定地址会变，验收前必须重新确认。' -ForegroundColor Yellow
}

Write-Section '2. Central / PostgreSQL 只读状态'
Write-Host '  Central 诊断端口（仅回环）：'
Get-CentralHealth
Write-Host '  Docker 容器（只读列举，不做任何变更）：'
try {
  docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
} catch {
  Write-Host '  无法执行 docker ps（Docker Desktop 可能未运行）' -ForegroundColor Yellow
}
Write-Host '  PostgreSQL 不应有任何宿主端口映射；若上面出现 5432 请先停下来核查。'

Write-Section '3. 443 占用情况'
$port443 = Get-NetTCPConnection -LocalPort 443 -State Listen -ErrorAction SilentlyContinue
if ($port443) {
  foreach ($connection in $port443) {
    $owner = Get-Process -Id $connection.OwningProcess -ErrorAction SilentlyContinue
    Write-Host "  443 已被 PID $($connection.OwningProcess)（$($owner.ProcessName)）占用，本地地址 $($connection.LocalAddress)"
  }
  Write-Host '  ⚠ 原生 Caddy 启动前必须腾出 443；容器 Caddy 的宿主映射正是常见占用者。' -ForegroundColor Yellow
} else {
  Write-Host '  443 当前空闲。'
}

Write-Section '4. 程序目录冲突'
foreach ($path in @($archivePath, $templatePath, $NativeEnvPath)) {
  $state = if (Test-Path -LiteralPath $path) { '存在' } else { '缺失' }
  Write-Host "  $state : $path"
}

Write-Section '5. 配置渲染与官方 validate'
$config = Read-WeFlowNativeEnv -Path $NativeEnvPath -CaddyfileTemplatePath $templatePath
Write-Host "  绑定地址 : $($config.BindIp)"
Write-Host "  允许网段 : $($config.AllowedCidr)"
Write-Host "  测试域名 : $($config.Hostname)"
Write-Host "  上游     : $($config.Upstream)"
Write-Host "  PKI 目录 : $($config.PkiDir)"

foreach ($directory in @($config.Root, $config.ConfigDir, $config.LogDir, $config.PkiDir, $config.BinDir, $config.StateDir)) {
  if (-not (Test-Path -LiteralPath $directory)) {
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
    Write-Host "  已创建目录 : $directory"
  }
}

if (-not (Test-Path -LiteralPath $config.CaddyExe -PathType Leaf)) {
  if (-not (Test-Path -LiteralPath $archivePath -PathType Leaf)) {
    throw "既没有 $($config.CaddyExe)，也没有离线归档 $archivePath"
  }
  Expand-Archive -LiteralPath $archivePath -DestinationPath $config.BinDir -Force
  Write-Host "  已从官方归档展开到 : $($config.BinDir)"
}

# 先渲染到临时文件校验，通过后才覆盖目标路径 —— 绝不把未校验的配置落成生效配置。
$stagedCaddyfile = Join-Path $config.ConfigDir 'Caddyfile.staged'
New-WeFlowRenderedCaddyfile -Config $config -Destination $stagedCaddyfile | Out-Null

& $config.CaddyExe validate --config $stagedCaddyfile --adapter caddyfile
if ($LASTEXITCODE -ne 0) {
  Remove-Item -LiteralPath $stagedCaddyfile -Force -ErrorAction SilentlyContinue
  throw "caddy validate 失败（退出码 $LASTEXITCODE），未写入生效配置"
}
Move-Item -LiteralPath $stagedCaddyfile -Destination $config.Caddyfile -Force
Write-Host '  ✅ 官方 Caddy 已接受渲染后的 Caddyfile' -ForegroundColor Green

Write-Host ''
Write-Host '预检完成：未对容器、Central、PostgreSQL 或卷做任何变更。' -ForegroundColor Green
Write-Host '下一步需要显式授权后执行 Start-NativeCaddy.ps1（它会停止容器 caddy 并启动原生进程）。'
