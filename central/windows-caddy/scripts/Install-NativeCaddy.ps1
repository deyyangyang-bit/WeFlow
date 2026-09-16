<#
.SYNOPSIS
  原生 Windows Caddy —— 本机准备：预检 + 从官方归档落地 caddy.exe + 渲染配置 + 官方 validate。

.DESCRIPTION
  【本脚本不是只读脚本】它会在 F 盘部署根下创建目录、从官方归档展开 caddy.exe、
  渲染并写入生效配置、收紧并核验 PKI 目录 ACL。它做的是「本机准备」，不是「只读预检」。
  它不做的事：不停止任何容器、不删卷、不动 Central / PostgreSQL、不启动 Caddy、
  不注册服务、不改防火墙/网络/DNS、不安装任何根证书。

  完整性要求：
    - 展开之前必须核对官方归档的 SHA-256；不一致直接失败，不展开；
    - 已存在的 caddy.exe 必须先核对 SHA-256 才能复用，核对不过则失败，绝不盲目复用；
    - 已存在的 Caddyfile 若与本次渲染结果不同，默认拒绝覆盖（需显式 -Force）；
    - ACL 无法收紧或核验不过 → 失败（PKI 私钥即将落在该目录）。

  退出码：0 = 准备完成；1 = 参数/前置条件失败；2 = 摘要核验失败；
          3 = ACL 收紧或核验失败；4 = 已存在文件冲突（未加 -Force）。

.PARAMETER PackageRoot
  交付包解压根目录（含官方归档与 central\windows-caddy\）。
.PARAMETER NativeEnvPath
  native.env 路径，默认 $PackageRoot\native.env。
.PARAMETER Force
  显式允许覆盖与本次渲染结果不同的既有生效配置。
.PARAMETER SelfTest
  仅显式用于测试：只加载函数定义，不执行任何准备动作。
#>
[CmdletBinding()]
param(
  [string]$PackageRoot,
  [string]$NativeEnvPath,
  [switch]$Force,
  [switch]$SelfTest
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'WeFlowNative.Common.ps1')

$script:OfficialArchiveSha256 = '1708333f79e274c7697285afe6d592ab39314e0b131e9ec6bea08ad27df62ebf'
$script:OfficialCaddyExeSha256 = '5cb9ab71e5756ce72840b8234177a2f40c8b4ab47a806b8e841e2b784e9df62b'
$script:ArchiveMemberNames = @('caddy.exe', 'LICENSE', 'README.md')

function Write-Section {
  param([string]$Title)
  Write-Host ''
  Write-Host ("== {0} ==" -f $Title) -ForegroundColor Cyan
}

function Assert-WeFlowArchiveIntegrity {
  <#
  .SYNOPSIS
    核对官方归档摘要；不一致即拒绝展开。
  #>
  param([Parameter(Mandatory)][string]$ArchivePath)
  if (-not (Test-WeFlowPathExists -Path $ArchivePath -Leaf)) {
    return [pscustomobject]@{ Ok = $false; Code = 2; Message = ("缺少官方归档：{0}" -f $ArchivePath) }
  }
  $actual = Get-WeFlowFileHash -Path $ArchivePath
  if ($actual -ne $script:OfficialArchiveSha256) {
    return [pscustomobject]@{ Ok = $false; Code = 2; Message = ("官方归档 SHA-256 不一致：实际 {0}，预期 {1}" -f $actual, $script:OfficialArchiveSha256) }
  }
  return [pscustomobject]@{ Ok = $true; Code = 0; Message = ("归档摘要一致（{0}）" -f $actual) }
}

function Assert-WeFlowExistingExeIntegrity {
  <#
  .SYNOPSIS
    核对既有 caddy.exe 摘要；核对不过则拒绝复用。
  #>
  param([Parameter(Mandatory)][string]$ExePath)
  $actual = Get-WeFlowFileHash -Path $ExePath
  if ($actual -ne $script:OfficialCaddyExeSha256) {
    return [pscustomobject]@{ Ok = $false; Message = ("既有 caddy.exe 摘要与官方不一致（实际 {0}）：拒绝复用、也不覆盖" -f $actual) }
  }
  return [pscustomobject]@{ Ok = $true; Message = ("既有 caddy.exe 摘要一致（{0}）" -f $actual) }
}

function Invoke-NativeCaddyInstall {
  <#
  .SYNOPSIS
    执行本机准备，返回退出码。
  #>
  param(
    [Parameter(Mandatory)][string]$PackageRoot,
    [Parameter(Mandatory)][string]$NativeEnvPath,
    [Parameter(Mandatory)][bool]$AllowOverwrite
  )

  $templatePath = Join-Path $PackageRoot 'central\windows-caddy\Caddyfile.template'
  $archivePath = Join-Path $PackageRoot 'caddy_2.11.4_windows_amd64.zip'

  try {
    $config = Read-WeFlowNativeEnv -Path $NativeEnvPath -CaddyfileTemplatePath $templatePath
  } catch {
    Write-Host ("配置校验失败：{0}" -f $_.Exception.Message) -ForegroundColor Red
    return 1
  }

  Write-Section '1. 主机与 IPv4'
  Write-Host ("  计算机名 : {0}" -f $env:COMPUTERNAME)
  Write-Host ("  当前时间 : {0}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz'))
  $addresses = @(Get-WeFlowLocalIPv4)
  foreach ($address in $addresses) {
    Write-Host ("  {0,-16} {1,-32} {2}" -f $address.IPAddress, $address.InterfaceAlias, $address.PrefixOrigin)
  }
  $bindCheck = Test-WeFlowBindIpIsLocalPhysical -BindIp $config.BindIp
  if (-not $bindCheck.Ok) {
    Write-Host ("  [FAIL] 绑定地址不可用：{0}（{1}）" -f $bindCheck.Reason, $config.BindIp) -ForegroundColor Red
    return 1
  }
  Write-Host ("  绑定地址 {0} 属于接口：{1}" -f $config.BindIp, $bindCheck.Reason) -ForegroundColor Green
  $dhcp = @($addresses | Where-Object { $_.IPAddress -eq $config.BindIp -and $_.PrefixOrigin -eq 'Dhcp' })
  if ($dhcp.Count -gt 0) {
    Write-Host '  [WARN] 该地址来自 DHCP：换网或租约变更后会变，验收前必须重新确认。' -ForegroundColor Yellow
  }

  Write-Section '2. Central 回环健康（只读探测，无凭据）'
  foreach ($path in @('/health', '/ready')) {
    $probe = Invoke-WeFlowHttpRequest -Url ("http://127.0.0.1:8787{0}" -f $path) -TimeoutSec 5
    if ($probe.Ok -and $probe.StatusCode -eq 200) {
      $contract = Test-WeFlowEndpointPayload -Path $path -Body $probe.Content
      if ($contract.Ok) {
        Write-Host ("  127.0.0.1:8787{0} -> HTTP 200，契约匹配" -f $path) -ForegroundColor Green
      } else {
        Write-Host ("  [FAIL] 127.0.0.1:8787{0} -> HTTP 200 但契约不匹配：{1}" -f $path, $contract.Reason) -ForegroundColor Red
        return 1
      }
    } else {
      Write-Host ("  [FAIL] 127.0.0.1:8787{0} -> 不可达（{1}）" -f $path, $probe.Error) -ForegroundColor Red
      return 1
    }
  }

  Write-Section '3. 443 占用情况（只读）'
  $port443 = @(Get-WeFlowNetTcpListener -Port 443)
  if ($port443.Count -gt 0) {
    foreach ($listener in $port443) {
      Write-Host ("  443 已被 PID {0} 占用，本地地址 {1}" -f $listener.OwningProcess, $listener.LocalAddress) -ForegroundColor Yellow
    }
    Write-Host '  提示：原生 Caddy 启动前必须先腾出 443（Start-NativeCaddy.ps1 会停容器 caddy）。' -ForegroundColor Yellow
  } else {
    Write-Host '  443 当前空闲。'
  }

  Write-Section '4. 官方归档与可执行文件完整性'
  $archiveCheck = Assert-WeFlowArchiveIntegrity -ArchivePath $archivePath
  Write-Host ("  {0}" -f $archiveCheck.Message) -ForegroundColor ($(if ($archiveCheck.Ok) { 'Green' } else { 'Red' }))
  if (-not $archiveCheck.Ok) { return $archiveCheck.Code }

  $exeExists = Test-WeFlowPathExists -Path $config.CaddyExe -Leaf
  if ($exeExists) {
    $exeCheck = Assert-WeFlowExistingExeIntegrity -ExePath $config.CaddyExe
    Write-Host ("  {0}" -f $exeCheck.Message) -ForegroundColor ($(if ($exeCheck.Ok) { 'Green' } else { 'Red' }))
    if (-not $exeCheck.Ok) { return 2 }
  } else {
    $conflicts = @()
    foreach ($member in $script:ArchiveMemberNames) {
      $candidate = Join-Path $config.BinDir $member
      if (Test-WeFlowPathExists -Path $candidate -Leaf) { $conflicts += $member }
    }
    if ($conflicts.Count -gt 0) {
      Write-Host ("  [FAIL] 程序目录已存在将被打包展开覆盖的文件：{0}（拒绝静默覆盖，请人工核对）" -f ($conflicts -join ', ')) -ForegroundColor Red
      return 4
    }
    New-WeFlowDirectory -Path $config.BinDir | Out-Null
    Expand-WeFlowArchiveZip -ArchivePath $archivePath -DestinationPath $config.BinDir
    $exeCheck = Assert-WeFlowExistingExeIntegrity -ExePath $config.CaddyExe
    Write-Host ("  已展开官方归档并复核：{0}" -f $exeCheck.Message) -ForegroundColor ($(if ($exeCheck.Ok) { 'Green' } else { 'Red' }))
    if (-not $exeCheck.Ok) { return 2 }
  }

  Write-Section '5. 目录与 ACL（PKI 私钥将落在其中）'
  foreach ($directory in @($config.ConfigDir, $config.LogDir, $config.PkiDir, $config.StateDir)) {
    $created = New-WeFlowDirectory -Path $directory
    Write-Host ("  {0}：{1}" -f $directory, $(if ($created) { '已创建' } else { '已存在' }))
  }
  try {
    Set-WeFlowRestrictedAcl -Path $config.PkiDir -DeploymentAccount ("{0}\{1}" -f $env:COMPUTERNAME, $env:USERNAME)
    Set-WeFlowRestrictedAcl -Path $config.StateDir -DeploymentAccount ("{0}\{1}" -f $env:COMPUTERNAME, $env:USERNAME)
  } catch {
    Write-Host ("  [FAIL] ACL 收紧失败：{0}" -f $_.Exception.Message) -ForegroundColor Red
    return 3
  }
  foreach ($directory in @($config.PkiDir, $config.StateDir)) {
    $aclCheck = Test-WeFlowAclIsRestricted -Path $directory -DeploymentAccount ("{0}\{1}" -f $env:COMPUTERNAME, $env:USERNAME)
    if (-not $aclCheck.Ok) {
      Write-Host ("  [FAIL] {0} 的 ACL 未被正确收紧：{1}" -f $directory, ($aclCheck.Problems -join '；')) -ForegroundColor Red
      return 3
    }
    Write-Host ("  {0} ACL 仅含部署账户 / SYSTEM / Administrators" -f $directory) -ForegroundColor Green
  }

  Write-Section '6. 配置渲染与官方 validate'
  $stagedCaddyfile = Join-Path $config.ConfigDir 'Caddyfile.staged'
  try {
    New-WeFlowRenderedCaddyfile -Config $config -Destination $stagedCaddyfile | Out-Null
  } catch {
    Write-Host ("  [FAIL] 配置渲染失败：{0}" -f $_.Exception.Message) -ForegroundColor Red
    return 1
  }

  $validate = Invoke-WeFlowExternalCommand -FilePath $config.CaddyExe `
    -Arguments @('validate', '--config', $stagedCaddyfile, '--adapter', 'caddyfile')
  if ($validate.ExitCode -ne 0) {
    Write-Host ("  [FAIL] caddy validate 退出码 {0}：{1}" -f $validate.ExitCode, $validate.StdErr.Trim()) -ForegroundColor Red
    Write-Host '  未写入生效配置（暂存文件保留供排查）。' -ForegroundColor Yellow
    return 1
  }
  Write-Host '  官方 Caddy 已接受渲染后的配置。' -ForegroundColor Green

  if (Test-WeFlowPathExists -Path $config.Caddyfile -Leaf) {
    if (Compare-WeFlowFileContent -PathA $stagedCaddyfile -PathB $config.Caddyfile) {
      Write-Host '  生效配置与本次渲染一致，无需写入。' -ForegroundColor Green
      Remove-WeFlowFilePath -Path $stagedCaddyfile
      return 0
    }
    if (-not $AllowOverwrite) {
      Write-Host ("  [FAIL] 已存在的生效配置与本次渲染不同：{0}" -f $config.Caddyfile) -ForegroundColor Red
      Write-Host '  默认拒绝静默覆盖；确认无误后再加 -Force 重新执行。' -ForegroundColor Yellow
      return 4
    }
    Write-Host '  已显式 -Force：覆盖既有生效配置。' -ForegroundColor Yellow
  }
  Move-WeFlowFilePath -Source $stagedCaddyfile -Destination $config.Caddyfile -Overwrite
  Write-Host ("  生效配置已写入：{0}" -f $config.Caddyfile) -ForegroundColor Green

  Write-Host ''
  Write-Host '本机准备完成：未停止任何容器、未触碰 Central / PostgreSQL 与数据卷。' -ForegroundColor Green
  Write-Host '下一步需要显式授权后执行 Start-NativeCaddy.ps1（它会停止容器 caddy 并启动原生进程）。'
  return 0
}

if ($SelfTest) {
  # 只加载函数定义，供隔离测试调用；不执行任何准备动作。
  return
}

if (-not $PackageRoot) { throw '缺少 -PackageRoot 参数' }
if (-not $NativeEnvPath) { $NativeEnvPath = Join-Path $PackageRoot 'native.env' }

$exitCode = Invoke-NativeCaddyInstall -PackageRoot $PackageRoot -NativeEnvPath $NativeEnvPath -AllowOverwrite ([bool]$Force)
exit $exitCode
