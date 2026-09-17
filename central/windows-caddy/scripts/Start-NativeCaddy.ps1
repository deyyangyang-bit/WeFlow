<#
.SYNOPSIS
  原生 Windows Caddy —— 受控切换：停容器 caddy → 启动原生进程 → 记录 PID。

.DESCRIPTION
  只在显式授权（-Authorized）后执行。安全原则：
    - 只停 `caddy` 这一个服务，统一用 -p weflow-test 与同一组两个 -f 文件；
    - 绝不 `down`、绝不删容器、绝不删卷、不触碰 Central / PostgreSQL；
    - 只结束本轮自己记录在 state 文件里的 PID（且必须 PID + 路径 + 启动时间三者一致）；
    - 停止容器之后的任何异常一律进入回退：结束本轮原生进程，并按切换前记录恢复原容器；
    - 启动后**立即**在内存里保存本轮进程身份（PID + 可执行路径 + 实际启动时间），
      回退不依赖磁盘记账：记账写盘失败时，仍然能精确回收本轮进程；
      身份无法核对（PID 复用 / 启动时间取不到）时拒绝结束该进程并如实报告回退失败；
    - 回退的每一步都产出结构化结果与诊断记录，成败只用布尔值判定，不靠搜索日志文本；
    - 启动成功必须有端点证据：/health 与 /ready 均在完整 TLS 校验下返回 200 且响应契约成立
      （与诊断脚本共用同一份判定，见 Invoke-WeFlowEndpointAcceptance）；
      403（来源门禁拒绝）不算通过，会触发回退；
    - 原有有效记账（PID 仍存活且身份一致）存在时拒绝重复启动，不覆盖记账；
    - 启动成功的判据是「进程存活 + 443 在配置的物理 IPv4 上处于监听 + 端点探测有响应」，
      而不是「存活三秒」这类弱证据。

  退出码：0 = 切换成功；1 = 参数/前置条件失败；2 = 未授权；3 = 切换失败已回退；
          4 = 切换失败且回退失败（需人工介入）。

.PARAMETER PackageRoot
  交付包解压根目录。
.PARAMETER ReleaseDir
  现有 Central 发布目录（含 docker-compose.central.yml 与 central\.env）。
.PARAMETER NativeEnvPath
  native.env 路径。
.PARAMETER Authorized
  显式授权标志；缺失时脚本只打印计划并以退出码 2 结束，不做任何变更。
.PARAMETER SelfTest
  仅显式用于测试：只加载函数定义，不执行任何切换。
#>
[CmdletBinding()]
param(
  [string]$PackageRoot,
  [string]$ReleaseDir,
  [string]$NativeEnvPath,
  [switch]$Authorized,
  [switch]$SelfTest
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'WeFlowNative.Common.ps1')

$script:WeFlowListenerWaitSeconds = 20
$script:WeFlowRootCertWaitSeconds = 20

function Invoke-WeFlowStartRollback {
  <#
  .SYNOPSIS
    切换失败后的回退：回收本轮原生进程 + 按切换前记录恢复容器。
  .DESCRIPTION
    进程回收的来源按优先级：

      1. **内存身份记录**（本轮启动后立即采集的 PID + 路径 + 实际启动时间）——
         记账写盘失败时它仍然可用，因此「磁盘记账没写成功」不会再让已创建的原生
         进程留在系统里；
      2. 磁盘记账（native-caddy.current.json）—— 仅当调用方没有内存记录时的兜底。

    「本轮从未启动过进程」（例如在停容器阶段就失败）由 -ProcessAttempted $false 表示：
    此时没有需要回收的进程，回收步骤判为成功。
    已经尝试启动、却两条来源都拿不到记录时不猜测：不结束任何进程，并如实报告回退失败
    （退出码 4），由人工核对。任一步骤抛异常都会被捕获成该步骤的结构化失败，
    不影响其它步骤继续执行，也不会阻断诊断记录的产生。

    返回 [pscustomobject]@{ Ok; ProcessStep; ContainerStep; Detail; ReportPath }。
    Ok 只由各步骤的布尔结果合并而来，不依赖任何文本匹配。
  #>
  param(
    [Parameter(Mandatory)][string]$ReleaseDir,
    [Parameter(Mandatory)][bool]$ContainerWasRunning,
    [Parameter(Mandatory)][bool]$ProcessAttempted,
    [AllowNull()]$LaunchedIdentity,
    [Parameter(Mandatory)][string]$CurrentStatePath,
    [Parameter(Mandatory)][string]$Reason,
    [Parameter(Mandatory)][string]$ReportPath
  )
  Write-Host ("开始回退（原因：{0}）" -f $Reason) -ForegroundColor Yellow

  # --- 步骤 1：回收本轮原生进程（内存身份优先，磁盘记账兜底） ---
  $processStep = $null
  try {
    if (-not $ProcessAttempted) {
      $processStep = [pscustomobject]@{
        Name      = 'stop-native-process'
        Source    = 'not-launched'
        Attempted = $false
        Ok        = $true
        Status    = 'not-launched'
        Message   = '本轮尚未启动原生进程，没有需要回收的进程'
      }
    } else {
      $record = $LaunchedIdentity
      $source = 'memory'
      if ($null -eq $record) {
        $source = 'state-file'
        $record = Read-WeFlowNativeProcessState -StatePath $CurrentStatePath
      }
      if ($null -eq $record) { $source = 'none' }
      $result = Stop-WeFlowOwnedProcess -Record $record
      $processStep = [pscustomobject]@{
        Name      = 'stop-native-process'
        Source    = $source
        Attempted = $result.Attempted
        Ok        = $result.Ok
        Status    = $result.Status
        Message   = $result.Message
      }
    }
  } catch {
    $processStep = [pscustomobject]@{
      Name      = 'stop-native-process'
      Source    = 'exception'
      Attempted = $true
      Ok        = $false
      Status    = 'exception'
      Message   = ("回退中结束原生进程时发生异常：{0}" -f $_.Exception.Message)
    }
  }
  Write-Host ("  [进程] {0}（来源 {1}，Ok={2}）" -f $processStep.Message, $processStep.Source, $processStep.Ok) `
    -ForegroundColor $(if ($processStep.Ok) { 'Yellow' } else { 'Red' })

  # --- 步骤 2：按切换前记录恢复容器（只恢复本轮停止且原先运行的） ---
  $containerStep = $null
  try {
    $restore = Restore-WeFlowContainerCaddy -ReleaseDir $ReleaseDir -WasRunning $ContainerWasRunning
    $containerStep = [pscustomobject]@{
      Name      = 'restore-container'
      Attempted = [bool]$restore.Attempted
      Ok        = [bool]$restore.Ok
      Status    = $(if ($restore.Ok) { 'restored' } else { 'failed' })
      Message   = $restore.Message
    }
  } catch {
    $containerStep = [pscustomobject]@{
      Name      = 'restore-container'
      Attempted = $true
      Ok        = $false
      Status    = 'exception'
      Message   = ("回退中恢复容器时发生异常：{0}" -f $_.Exception.Message)
    }
  }
  Write-Host ("  [容器] {0}（Ok={1}）" -f $containerStep.Message, $containerStep.Ok) `
    -ForegroundColor $(if ($containerStep.Ok) { 'Yellow' } else { 'Red' })

  $ok = ([bool]$processStep.Ok) -and ([bool]$containerStep.Ok)
  $detail = ("进程：{0}（来源 {1}）；容器：{2}" -f $processStep.Message, $processStep.Source, $containerStep.Message)

  # --- 步骤 3：结构化诊断记录（写失败不影响回退结论，但会显示在输出里） ---
  $report = [ordered]@{
    RecordedAt          = (Get-Date).ToString('o')
    Reason              = $Reason
    ContainerWasRunning = $ContainerWasRunning
    ProcessStep         = $processStep
    ContainerStep       = $containerStep
    Ok                  = $ok
  }
  try {
    Write-WeFlowTextFile -Path $ReportPath -Content ($report | ConvertTo-Json -Depth 6)
    Write-Host ("  回退诊断记录 -> {0}" -f $ReportPath)
  } catch {
    Write-Host ("  [警告] 回退诊断记录写入失败：{0}" -f $_.Exception.Message) -ForegroundColor Red
  }

  return [pscustomobject]@{ Ok = $ok; ProcessStep = $processStep; ContainerStep = $containerStep; Detail = $detail; ReportPath = $ReportPath }
}

function Wait-WeFlowTcpListener {
  <#
  .SYNOPSIS
    轮询等待指定 IPv4:端口 进入监听状态。
  #>
  param(
    [Parameter(Mandatory)][string]$BindIp,
    [Parameter(Mandatory)][int]$Port,
    [Parameter(Mandatory)][int]$TimeoutSeconds
  )
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $listeners = @(Get-WeFlowNetTcpListener -Port $Port)
    foreach ($listener in $listeners) {
      if ($listener.LocalAddress -eq $BindIp) { return $true }
    }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

function Invoke-WeFlowStartFailureHandling {
  <#
  .SYNOPSIS
    切换失败处理：**回退优先**，stderr 日志等非关键诊断殿后且全部防御。
  .DESCRIPTION
    ee2ee77 真实切换的教训：旧实现在回退**之前**读取 native-caddy.stderr.log，
    该文件正被刚启动的原生进程占用时 Read 抛 IOException，异常逃逸出 catch 块，
    自动回退整体没有执行（进程留在系统里、容器停在停止状态）。
    现在的顺序：原始异常 → 回退（进程回收 / 容器恢复在 Invoke-WeFlowStartRollback
    内部**各自**捕获失败，一步失败不跳过另一步，并总是产出结构化诊断记录）→
    stderr 日志诊断（存在性检查 / 读取 / 输出任何一步失败都只记录警告，绝不逃逸）。
    返回约定退出码：3 = 已回退；4 = 回退未完全成功。
  #>
  param(
    [Parameter(Mandatory)][hashtable]$Config,
    [Parameter(Mandatory)][string]$ReleaseDir,
    [Parameter(Mandatory)][string]$Reason,
    [Parameter(Mandatory)][bool]$ContainerWasRunning,
    [Parameter(Mandatory)][bool]$ProcessAttempted,
    [AllowNull()]$LaunchedIdentity,
    [Parameter(Mandatory)][string]$CurrentStatePath,
    [Parameter(Mandatory)][string]$rollbackReportPath
  )
  Write-Host ("切换过程中发生异常：{0}" -f $Reason) -ForegroundColor Red

  # --- 回退优先：先于任何诊断执行 ---
  $rollback = Invoke-WeFlowStartRollback -ReleaseDir $ReleaseDir -ContainerWasRunning $ContainerWasRunning `
    -ProcessAttempted $ProcessAttempted -LaunchedIdentity $LaunchedIdentity `
    -CurrentStatePath $CurrentStatePath -Reason $Reason -ReportPath $rollbackReportPath
  Write-Host ("回退结果：{0}" -f $rollback.Detail) -ForegroundColor Yellow

  # --- 诊断殿后（独立防御 try/catch）：日志可能正被刚启动的原生进程占用 ---
  try {
    $stderrLog = Join-Path $Config.LogDir 'native-caddy.stderr.log'
    if (Test-WeFlowPathExists -Path $stderrLog -Leaf) {
      Read-WeFlowTextFile -Path $stderrLog | Select-Object -Last 40 | Write-Host
    }
  } catch {
    Write-Host ("  [警告] stderr 日志诊断失败（不影响回退结论与退出码）：{0}" -f $_.Exception.Message) -ForegroundColor Yellow
  }

  if ($rollback.Ok) {
    Write-Host '本轮切换已回退（本轮原生进程已确认退出）；状态文件保留供人工核对。' -ForegroundColor Yellow
    return 3
  }
  Write-Host '回退未完全成功：请人工核对容器 caddy 与原生进程状态；诊断记录与记账文件均已保留。' -ForegroundColor Red
  return 4
}

function Invoke-NativeCaddyStart {
  <#
  .SYNOPSIS
    执行受控切换，返回退出码。
  #>
  param(
    [Parameter(Mandatory)][string]$PackageRoot,
    [Parameter(Mandatory)][string]$ReleaseDir,
    [Parameter(Mandatory)][string]$NativeEnvPath
  )

  $templatePath = Join-Path $PackageRoot 'central\windows-caddy\Caddyfile.template'
  try {
    $config = Read-WeFlowNativeEnv -Path $NativeEnvPath -CaddyfileTemplatePath $templatePath
  } catch {
    Write-Host ("配置校验失败：{0}" -f $_.Exception.Message) -ForegroundColor Red
    return 1
  }

  if (-not (Test-WeFlowPathExists -Path $config.Caddyfile -Leaf)) {
    Write-Host ("生效配置不存在：{0}（先运行 Install-NativeCaddy.ps1）" -f $config.Caddyfile) -ForegroundColor Red
    return 1
  }
  if (-not (Test-WeFlowPathExists -Path $config.CaddyExe -Leaf)) {
    Write-Host ("缺少原生 Caddy 可执行文件：{0}" -f $config.CaddyExe) -ForegroundColor Red
    return 1
  }

  # 前置条件 1：绑定地址必须属于本机物理网卡。
  $bindCheck = Test-WeFlowBindIpIsLocalPhysical -BindIp $config.BindIp
  if (-not $bindCheck.Ok) {
    Write-Host ("绑定地址校验失败：{0}（{1}）" -f $bindCheck.Reason, $config.BindIp) -ForegroundColor Red
    return 1
  }

  $statePath = Join-Path $config.StateDir 'native-caddy.current.json'
  New-WeFlowDirectory -Path $config.StateDir | Out-Null

  # 前置条件 2：不覆盖仍然有效的记账（重复启动防护）。
  $existingState = Read-WeFlowNativeProcessState -StatePath $statePath
  if ($null -ne $existingState) {
    $ownership = Get-WeFlowNativeProcessOwnership -State $existingState
    if ($ownership.Status -eq 'owned') {
      Write-Host ("检测到仍然有效的原生进程记账（PID {0}），拒绝重复启动以免丢失 PID 记录。" -f $existingState.Pid) -ForegroundColor Red
      Write-Host '如需重来，请先运行 Stop-NativeCaddy.ps1。' -ForegroundColor Yellow
      return 1
    }
    Write-Host ("发现陈旧记账（{0}），将在成功后覆盖。" -f $ownership.Status) -ForegroundColor Yellow
  }

  # 前置条件 3：读取切换前的容器状态；读取失败则拒绝切换。
  $containerState = $null
  try {
    $containerState = Get-WeFlowContainerCaddyState -ReleaseDir $ReleaseDir
  } catch {
    Write-Host ("无法确定容器 caddy 当前状态，拒绝切换：{0}" -f $_.Exception.Message) -ForegroundColor Red
    return 1
  }
  Write-Host ("容器 caddy 当前运行中：{0}" -f $containerState.Running)

  $previousStatePath = Join-Path $config.StateDir 'native-caddy.state.json'
  $previous = [ordered]@{
    RecordedAt             = (Get-Date).ToString('o')
    ContainerCaddyRunning  = [bool]$containerState.Running
    ContainerStateRaw      = $containerState.RawOutput
    ReleaseDir             = $ReleaseDir
  }
  try {
    Write-WeFlowTextFile -Path $previousStatePath -Content ($previous | ConvertTo-Json -Depth 4)
  } catch {
    # 此时尚未动容器、尚未启动进程：直接失败，不需要回退。
    Write-Host ("无法写入切换前状态记录，未做任何变更：{0}" -f $_.Exception.Message) -ForegroundColor Red
    return 1
  }
  Write-Host ("已记录切换前状态 -> {0}" -f $previousStatePath)

  $containerWasRunning = [bool]$containerState.Running
  $nativeProcess = $null
  # 本轮进程的**内存身份记录**：启动后立即采集，回退时不依赖磁盘记账。
  $launchedIdentity = $null
  # 是否已经尝试启动过原生进程（决定回退里「没有记录」是正常还是故障）。
  $processLaunchAttempted = $false
  $rollbackReportPath = Join-Path $config.StateDir 'native-caddy.rollback.json'

  try {
    # 步骤 1：只停容器 caddy。
    if ($containerWasRunning) {
      Write-Host '停止容器 caddy（不 down、不删容器、不删卷）...'
      $stopResult = Invoke-WeFlowDocker -ComposeArgs @('stop', 'caddy') -ReleaseDir $ReleaseDir
      if ($stopResult.ExitCode -ne 0) {
        throw ("docker compose stop caddy 失败（退出码 {0}）：{1}" -f $stopResult.ExitCode, $stopResult.StdErr.Trim())
      }
    } else {
      Write-Host '容器 caddy 当前未运行，跳过停止步骤。'
    }

    # 步骤 2：443 必须已经腾空（否则原生进程无法绑定，直接回退）。
    Start-Sleep -Seconds 1
    $leftover = @(Get-WeFlowNetTcpListener -Port 443)
    if ($leftover.Count -gt 0) {
      $holders = ($leftover | ForEach-Object { ("{0}:{1}(PID {2})" -f $_.LocalAddress, $_.LocalPort, $_.OwningProcess) }) -join ', '
      throw ("443 仍被占用，无法启动原生 Caddy：{0}" -f $holders)
    }

    # 步骤 3：启动原生进程并记录精确 PID。
    $stdoutLog = Join-Path $config.LogDir 'native-caddy.stdout.log'
    $stderrLog = Join-Path $config.LogDir 'native-caddy.stderr.log'
    New-WeFlowDirectory -Path $config.LogDir | Out-Null
    Write-Host ("启动原生 Caddy：{0}" -f $config.CaddyExe)
    $processLaunchAttempted = $true
    $nativeProcess = Start-WeFlowCaddyProcess -ExePath $config.CaddyExe `
      -Arguments @('run', '--config', $config.Caddyfile, '--adapter', 'caddyfile') `
      -StdOutPath $stdoutLog -StdErrPath $stderrLog
    Write-Host ("  实际命令行参数：{0}" -f $nativeProcess.ArgumentLine)

    # 步骤 3.1：**立即**把本轮进程的身份留在内存里。
    # 这一步必须在任何写盘动作之前完成：即使随后记账写盘失败，
    # 回退仍然能凭这份内存身份精确回收本轮进程。
    $launchedIdentity = New-WeFlowProcessIdentityRecord -Id ([int]$nativeProcess.Id) `
      -ExecutablePath $config.CaddyExe -StartTime $nativeProcess.StartTime
    if ($null -eq $launchedIdentity.StartedAt) {
      Write-Host ("  [警告] 取不到 PID {0} 的启动时间：回退时将拒绝结束身份不明的进程。" -f $launchedIdentity.Pid) -ForegroundColor Yellow
    }

    Start-Sleep -Seconds 2
    $alive = Get-WeFlowProcessById -Id $nativeProcess.Id
    if ($null -eq $alive) {
      throw ("原生 Caddy 启动后立即退出（PID {0}）" -f $nativeProcess.Id)
    }

    # 步骤 4：落记账（磁盘侧记录，供 Stop 与人工核对使用），再等监听证据。
    # 内存身份已在步骤 3.1 采集，因此这里写盘失败也不会让回退失去回收目标。
    $state = [ordered]@{
      Pid            = $nativeProcess.Id
      ExecutablePath = $config.CaddyExe
      ConfigPath     = $config.Caddyfile
      StartedAt      = $alive.StartTime.ToString('o')
      BindIp         = $config.BindIp
      AllowedCidr    = $config.AllowedCidr
      Hostname       = $config.Hostname
      Upstream       = $config.Upstream
      ReleaseDir     = $ReleaseDir
    }
    Write-WeFlowTextFile -Path $statePath -Content ($state | ConvertTo-Json -Depth 4)

    if (-not (Wait-WeFlowTcpListener -BindIp $config.BindIp -Port 443 -TimeoutSeconds $script:WeFlowListenerWaitSeconds)) {
      throw ("等待 {0} 秒后仍未在 {1}:443 上看到监听" -f $script:WeFlowListenerWaitSeconds, $config.BindIp)
    }

    # 步骤 5：端点验收（/health 与 /ready），与诊断脚本共用同一份判定。
    # 判定标准只有一条路径：TLS 校验 + HTTP 200 + 响应契约（见 Invoke-WeFlowEndpointAcceptance）。
    # 403（来源门禁拒绝）不算验收通过：它说明本次请求根本没被端点处理。
    $rootCert = Join-Path $config.PkiDir 'pki\authorities\local\root.crt'
    $certDeadline = (Get-Date).AddSeconds($script:WeFlowRootCertWaitSeconds)
    while (-not (Test-WeFlowPathExists -Path $rootCert -Leaf) -and (Get-Date) -lt $certDeadline) {
      Start-Sleep -Milliseconds 500
    }
    if (-not (Test-WeFlowPathExists -Path $rootCert -Leaf)) {
      throw ("等待 {0} 秒后仍未生成内部 CA 根证书：{1}" -f $script:WeFlowRootCertWaitSeconds, $rootCert)
    }

    $acceptance = Invoke-WeFlowEndpointAcceptance -Config $config -CaCertPath $rootCert
    foreach ($item in $acceptance.Items) {
      $color = if ($item.ExitCode -eq 0) { 'Green' } else { 'Red' }
      Write-Host ("  {0} -> {1}（后端 {2}，退出码 {3}）" -f $item.Path, $item.Reason, $item.Probe.Backend, $item.ExitCode) -ForegroundColor $color
    }
    if (-not $acceptance.Ok) {
      $failed = @($acceptance.Items | Where-Object { $_.ExitCode -ne 0 } | ForEach-Object { ("{0}（退出码 {1}：{2}）" -f $_.Path, $_.ExitCode, $_.Reason) })
      throw ("端点验收未通过（总退出码 {0}）：{1}" -f $acceptance.ExitCode, ($failed -join '；'))
    }

    Write-Host ''
    Write-Host '原生 Caddy 已启动：' -ForegroundColor Green
    Write-Host ("  PID          : {0}" -f $state.Pid)
    Write-Host ("  可执行路径   : {0}" -f $state.ExecutablePath)
    Write-Host ("  配置路径     : {0}" -f $state.ConfigPath)
    Write-Host ("  启动时间     : {0}" -f $state.StartedAt)
    Write-Host ("  监听         : https://{0}:443（证书仅对 {1} 有效）" -f $config.BindIp, $config.Hostname)
    Write-Host ''
    Write-Host '退出本终端不会结束该进程；需要停止请执行 Stop-NativeCaddy.ps1（它只结束上面这个 PID）。'
    return 0
  } catch {
    # 失败处理整体交给 Invoke-WeFlowStartFailureHandling：回退优先、诊断殿后且全防御，
    # 诊断失败不会逃逸出本 catch 打断回退（ee2ee77 教训）。
    return Invoke-WeFlowStartFailureHandling -Config $config -ReleaseDir $ReleaseDir -Reason ($_.Exception.Message) `
      -ContainerWasRunning $containerWasRunning -ProcessAttempted $processLaunchAttempted `
      -LaunchedIdentity $launchedIdentity -CurrentStatePath $statePath -RollbackReportPath $rollbackReportPath
  }
}

if ($SelfTest) {
  # 只加载函数定义，供隔离测试调用；不执行任何切换。
  return
}

if (-not $PackageRoot) { throw '缺少 -PackageRoot 参数' }
if (-not $ReleaseDir) { throw '缺少 -ReleaseDir 参数' }
if (-not $NativeEnvPath) { $NativeEnvPath = Join-Path $PackageRoot 'native.env' }

$composeFileBase = 'docker-compose.central.yml'
$composeFileTls = 'docker-compose.central.tls.yml'
$composeProject = 'weflow-test'

if (-not $Authorized) {
  Write-Host '未提供 -Authorized：以下操作尚未执行，脚本空跑退出。' -ForegroundColor Yellow
  Write-Host ("  1) 停止容器 caddy：docker compose -p {0} --env-file central/proxy.env -f {1} -f {2} stop caddy" -f $composeProject, $composeFileBase, $composeFileTls)
  Write-Host ("  2) 启动原生进程：<caddy.exe> run --config <Caddyfile> --adapter caddyfile")
  Write-Host ("  3) 记录 PID / 路径 / StartedAt 到 state 目录")
  exit 2
}

$exitCode = Invoke-NativeCaddyStart -PackageRoot $PackageRoot -ReleaseDir $ReleaseDir -NativeEnvPath $NativeEnvPath
exit $exitCode
