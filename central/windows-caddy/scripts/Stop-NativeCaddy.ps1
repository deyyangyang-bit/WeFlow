<#
.SYNOPSIS
  原生 Windows Caddy —— 停止本轮原生进程并按需恢复容器 caddy。

.DESCRIPTION
  安全边界（本版相对 975ced5 待修版强化）：
    - 结束进程前同时核对 PID、可执行路径与启动时间；任一项不符（含 PID 复用）一律拒绝；
    - 结束之后轮询确认该进程确实消失；超时仍存活按「无法确认」处理，非零退出并保留记账；
    - 绝不按映像名宽泛结束进程；
    - 恢复容器时只恢复「本轮停止且原先运行」的服务：读取切换前记录
      native-caddy.state.json，原先未运行则不执行 start；
    - 恢复失败时保留状态文件并以非零退出，绝不删除记账；
    - 不 `up`、不 `down`、不删容器、不删卷、不触碰 Central / PostgreSQL。

  退出码：0 = 完成；1 = 参数/前置条件失败；2 = 进程身份不符或无法确认已退出，拒绝结束；
          3 = 恢复容器失败（状态文件保留）；4 = 无可用的切换前记录而无法判断恢复。

.PARAMETER PackageRoot
  交付包解压根目录。
.PARAMETER ReleaseDir
  现有 Central 发布目录。
.PARAMETER NativeEnvPath
  native.env 路径。
.PARAMETER RestoreContainer
  停止原生进程后按切换前记录恢复原容器 caddy（仅当原先确实在运行）。
.PARAMETER SelfTest
  仅显式用于测试：只加载函数定义，不执行任何停止。
#>
[CmdletBinding()]
param(
  [string]$PackageRoot,
  [string]$ReleaseDir,
  [string]$NativeEnvPath,
  [switch]$RestoreContainer,
  [switch]$SelfTest
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'WeFlowNative.Common.ps1')

function Invoke-NativeCaddyStop {
  <#
  .SYNOPSIS
    停止本轮原生进程（可选恢复容器），返回退出码。
  #>
  param(
    [Parameter(Mandatory)][string]$PackageRoot,
    [Parameter(Mandatory)][string]$ReleaseDir,
    [Parameter(Mandatory)][string]$NativeEnvPath,
    [Parameter(Mandatory)][bool]$RestoreContainerMode
  )

  $templatePath = Join-Path $PackageRoot 'central\windows-caddy\Caddyfile.template'
  try {
    $config = Read-WeFlowNativeEnv -Path $NativeEnvPath -CaddyfileTemplatePath $templatePath
  } catch {
    Write-Host ("配置校验失败：{0}" -f $_.Exception.Message) -ForegroundColor Red
    return 1
  }

  $currentStatePath = Join-Path $config.StateDir 'native-caddy.current.json'
  $previousStatePath = Join-Path $config.StateDir 'native-caddy.state.json'

  if (-not (Test-WeFlowPathExists -Path $currentStatePath -Leaf)) {
    Write-Host ("找不到本轮状态文件：{0}（无法确定要结束哪个 PID，拒绝执行）" -f $currentStatePath) -ForegroundColor Red
    return 1
  }

  $state = Read-WeFlowNativeProcessState -StatePath $currentStatePath
  $ownership = Get-WeFlowNativeProcessOwnership -State $state
  Write-Host ("进程身份核对：{0} —— {1}" -f $ownership.Status, $ownership.Message)

  switch ($ownership.Status) {
    'identity-mismatch' {
      Write-Host 'PID 复用或身份不符：拒绝结束该进程，状态文件保留。' -ForegroundColor Red
      return 2
    }
    'identity-unknown' {
      Write-Host '无法读取该 PID 的可执行路径：拒绝结束该进程，状态文件保留。' -ForegroundColor Red
      return 2
    }
    'not-running' {
      Write-Host '本轮原生进程已不在运行，跳过结束步骤。' -ForegroundColor Yellow
    }
    'owned' {
      # 结束之后必须确认进程确实退出，而不是「已发出结束请求」就算完成。
      $stopResult = Stop-WeFlowOwnedProcess -Record $state
      if (-not $stopResult.Ok) {
        Write-Host ("无法确认本轮原生进程已退出：{0}" -f $stopResult.Message) -ForegroundColor Red
        Write-Host '状态文件保留，请人工核对该 PID 后再决定下一步。' -ForegroundColor Yellow
        return 2
      }
      Write-Host ("已结束原生 Caddy PID {0}（{1}）" -f $state.Pid, $state.ExecutablePath) -ForegroundColor Green
    }
  }

  if ($RestoreContainerMode) {
    $containerWasRunning = $null
    if (Test-WeFlowPathExists -Path $previousStatePath -Leaf) {
      $previous = (Read-WeFlowTextFile -Path $previousStatePath) | ConvertFrom-Json
      $containerWasRunning = [bool]$previous.ContainerCaddyRunning
    }
    if ($null -eq $containerWasRunning) {
      Write-Host ("找不到可信的切换前记录（{0}），无法判断原容器是否在运行；拒绝执行 start。" -f $previousStatePath) -ForegroundColor Red
      Write-Host '状态文件保留，请人工核对后再决定是否恢复容器。' -ForegroundColor Yellow
      return 4
    }

    Write-Host ("切换前容器 caddy 运行中：{0}" -f $containerWasRunning)
    $restoreResult = Restore-WeFlowContainerCaddy -ReleaseDir $ReleaseDir -WasRunning $containerWasRunning
    Write-Host ("恢复结果：{0}" -f $restoreResult.Message) -ForegroundColor $(if ($restoreResult.Ok) { 'Green' } else { 'Red' })
    if (-not $restoreResult.Ok) {
      Write-Host '恢复容器失败：保留状态文件并以非零退出，未做任何删除。' -ForegroundColor Red
      return 3
    }
  }

  Remove-WeFlowFilePath -Path $currentStatePath
  Write-Host '本轮原生进程状态已清理；Central / PostgreSQL 与数据卷全程未被触碰。'
  return 0
}

if ($SelfTest) {
  # 只加载函数定义，供隔离测试调用；不执行任何停止。
  return
}

if (-not $PackageRoot) { throw '缺少 -PackageRoot 参数' }
if (-not $ReleaseDir) { throw '缺少 -ReleaseDir 参数' }
if (-not $NativeEnvPath) { $NativeEnvPath = Join-Path $PackageRoot 'native.env' }

$exitCode = Invoke-NativeCaddyStop -PackageRoot $PackageRoot -ReleaseDir $ReleaseDir -NativeEnvPath $NativeEnvPath -RestoreContainerMode ([bool]$RestoreContainer)
exit $exitCode
