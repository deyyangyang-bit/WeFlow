<#
.SYNOPSIS
  原生 Windows Caddy 部署脚本 —— 真实 PowerShell 隔离测试入口。

.DESCRIPTION
  设计原则：
    - 调用「真实的」生产脚本与公共逻辑（dot-source 各脚本的 -SelfTest 入口），
      不为测试另写一套算法自证；
    - 打开公共模块的测试模式后，所有叶子级系统调用都被 mock 拦截；
      未被替换的叶子调用会直接 throw（fail closed），绝不落到真实系统；
    - 文件类叶子被替换为「沙箱实现」：只允许读写本轮开发目录内的沙箱根，
      越界即 throw，因此测试不会碰到 F:\WeFlow-Test 之外的任何路径；
    - 契约守卫（只读）以子进程真实运行，含正向与危险变异两类用例；
    - 全部 mock 在结束时恢复（Restore-WeFlowMocks），不影响后续会话。

  用法：
    powershell -NoProfile -ExecutionPolicy Bypass -File .\central\windows-caddy\scripts\WeFlowNative.Tests.ps1

  退出码：0 = 全部通过；1 = 存在失败用例；2 = 测试环境自检失败。
#>
[CmdletBinding()]
param(
  [switch]$KeepSandbox
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:ProdScriptsRoot = $PSScriptRoot
$script:WorkRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$script:ProdScriptsRoot = [System.IO.Path]::GetFullPath($PSScriptRoot)
$script:SandboxRoot = Join-Path $PSScriptRoot '..\.test-sandbox'
$script:SandboxRoot = [System.IO.Path]::GetFullPath($script:SandboxRoot)

$script:Results = @()
$script:CurrentCase = ''
$script:SkipCount = 0

function Add-SkipResult {
  param(
    [Parameter(Mandatory)][string]$Name,
    [Parameter(Mandatory)][string]$Reason
  )
  $script:SkipCount++
  Write-Host ("    [SKIP] {0}（{1}）" -f $Name, $Reason) -ForegroundColor Yellow
}

function Add-Result {
  param(
    [Parameter(Mandatory)][string]$Name,
    [Parameter(Mandatory)][bool]$Passed,
    [string]$Detail = ''
  )
  $script:Results += [pscustomobject]@{ Case = $script:CurrentCase; Name = $Name; Passed = $Passed; Detail = $Detail }
  $color = if ($Passed) { 'Green' } else { 'Red' }
  $mark = if ($Passed) { 'PASS' } else { 'FAIL' }
  Write-Host ("    [{0}] {1} {2}" -f $mark, $Name, $Detail) -ForegroundColor $color
}

function Assert-Equal {
  param($Expected, $Actual, [string]$Name)
  $ok = ($Expected -eq $Actual)
  Add-Result -Name $Name -Passed $ok -Detail $(if ($ok) { '' } else { "(expected=$Expected actual=$Actual)" })
}

function Assert-True {
  param([bool]$Condition, [string]$Name, [string]$Detail = '')
  Add-Result -Name $Name -Passed $Condition -Detail $Detail
}

function Assert-Throws {
  param([Parameter(Mandatory)][scriptblock]$Action, [string]$Name, [string]$MessagePattern = '')
  $threw = $false
  $message = ''
  try { & $Action | Out-Null } catch { $threw = $true; $message = $_.Exception.Message }
  $ok = $threw
  if ($ok -and $MessagePattern -ne '') { $ok = ($message -match $MessagePattern) }
  Add-Result -Name $Name -Passed $ok -Detail $(if ($ok) { '' } else { "(threw=$threw message=$message)" })
}

function Start-Case {
  param([Parameter(Mandatory)][string]$Name)
  $script:CurrentCase = $Name
  Write-Host ("== {0} ==" -f $Name) -ForegroundColor Cyan
}

# =====================================================================
# Mock 基础设施
# =====================================================================

$script:MockRegistry = @{}

function Install-WeFlowMock {
  param(
    [Parameter(Mandatory)][string]$Name,
    [Parameter(Mandatory)][scriptblock]$Body
  )
  if (-not $script:MockRegistry.ContainsKey($Name)) {
    $existing = Get-Command -Name $Name -ErrorAction SilentlyContinue
    if ($existing) { $script:MockRegistry[$Name] = $existing.ScriptBlock } else { $script:MockRegistry[$Name] = $null }
  }
  Set-Item -Path ('function:' + $Name) -Value $Body
}

function Restore-WeFlowMocks {
  foreach ($name in @($script:MockRegistry.Keys)) {
    $original = $script:MockRegistry[$name]
    if ($null -eq $original) {
      Remove-Item -Path ('function:' + $name) -ErrorAction SilentlyContinue -Force
    } else {
      Set-Item -Path ('function:' + $name) -Value $original
    }
  }
  $script:MockRegistry.Clear()
}

# ---- 沙箱世界（供 mock 读取与断言） ----

$script:SandboxRootPath = $null
$script:World = $null

function New-World {
  $script:World = @{
    Processes      = @{}
    NextPid        = 4100
    Listeners      = @{ 443 = @(); 80 = @(); 2019 = @() }
    LocalIPv4      = @([pscustomobject]@{ IPAddress = '192.168.1.57'; InterfaceAlias = 'Ethernet'; PrefixOrigin = 'Dhcp' })
    CommandPaths   = @{}
    DockerQueue    = New-Object System.Collections.Queue
    DockerCalls    = @()
    ExternalQueue  = New-Object System.Collections.Queue
    ExternalCalls  = @()
    HttpQueue      = New-Object System.Collections.Queue
    HttpCalls      = @()
    FileHashes     = @{}
    AclRestricted  = @{}
    AclInheritanceProtected = $true
    IgnoreStopProcess = $false
    FailOn         = @{}
    StopProcessCalls = @()
    StartArgumentLines = @()
    WriteAttempts  = @()
    LastArgumentLine = ''
    AutoListenerOnNativeProcess = $false
  }
}

function Add-DockerResult {
  param([int]$ExitCode = 0, [string]$StdOut = '', [string]$StdErr = '')
  $script:World.DockerQueue.Enqueue([pscustomobject]@{ ExitCode = $ExitCode; StdOut = $StdOut; StdErr = $StdErr })
}

function Add-ExternalResult {
  param([int]$ExitCode = 0, [string]$StdOut = '', [string]$StdErr = '')
  $script:World.ExternalQueue.Enqueue([pscustomobject]@{ ExitCode = $ExitCode; StdOut = $StdOut; StdErr = $StdErr })
}

function Add-HttpResult {
  param([bool]$Ok = $true, [int]$StatusCode = 200, [string]$Content = '', [string]$Error = '')
  $script:World.HttpQueue.Enqueue([pscustomobject]@{ Ok = $Ok; StatusCode = $StatusCode; Content = $Content; Error = $Error })
}

function Get-SandboxPath {
  param([Parameter(Mandatory)][string]$Path)
  $full = [System.IO.Path]::GetFullPath($Path)
  if (-not $full.StartsWith($script:SandboxRootPath, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw ("沙箱越界：{0} 不在 {1} 之下" -f $full, $script:SandboxRootPath)
  }
  return $full
}

function Get-ReadablePath {
  <#
  .SYNOPSIS
    只读访问的允许范围：沙箱本身 + 生产脚本目录（只读读取生产脚本/模板/探测脚本是安全的）。
  .DESCRIPTION
    写操作仍然只允许沙箱；这里只放宽「读」。
  #>
  param([Parameter(Mandatory)][string]$Path)
  $full = [System.IO.Path]::GetFullPath($Path)
  if ($full.StartsWith($script:SandboxRootPath, [System.StringComparison]::OrdinalIgnoreCase)) { return $full }
  if ($full.StartsWith($script:ProdScriptsRoot, [System.StringComparison]::OrdinalIgnoreCase)) { return $full }
  throw ("只读越界：{0} 既不在沙箱 {1} 之下，也不在生产脚本目录 {2} 之下" -f $full, $script:SandboxRootPath, $script:ProdScriptsRoot)
}

function Install-SystemLeafMocks {
  <#
  .SYNOPSIS
    替换所有会触达真实系统的叶子函数：文件类走沙箱，进程/网络/Docker 走脚本化世界。
  #>
  $world = $script:World

  Install-WeFlowMock -Name 'Test-WeFlowPathExists' -Body {
    param([Parameter(Mandatory)][string]$Path, [switch]$Leaf)
    $full = Get-ReadablePath -Path $Path
    # FailOn：模拟「存在性检查本身抛异常」（如句柄被占用导致的系统调用失败）。
    if ($script:World.FailOn.ContainsKey('Test-WeFlowPathExists') -and $full -match $script:World.FailOn['Test-WeFlowPathExists']) {
      throw ("模拟存在性检查失败：{0}" -f $full)
    }
    if ($Leaf) { return (Test-Path -LiteralPath $full -PathType Leaf) }
    return (Test-Path -LiteralPath $full)
  }
  Install-WeFlowMock -Name 'Read-WeFlowTextFile' -Body {
    param([Parameter(Mandatory)][string]$Path)
    $full = Get-ReadablePath -Path $Path
    # FailOn：模拟「文件存在但读取抛 IOException」（如正被刚启动的进程占用）。
    if ($script:World.FailOn.ContainsKey('Read-WeFlowTextFile') -and $full -match $script:World.FailOn['Read-WeFlowTextFile']) {
      throw ("模拟读取失败（文件正被另一进程使用）：{0}" -f $full)
    }
    [System.IO.File]::ReadAllText($full, (New-Object System.Text.UTF8Encoding($false)))
  }
  Install-WeFlowMock -Name 'Write-WeFlowTextFile' -Body {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][AllowEmptyString()][string]$Content)
    $full = Get-SandboxPath -Path $Path
    # 先记录「尝试写入」这一事实本身（G8 要证明写入确实被尝试并被夹具失败，
    # 不能靠退出码反推），再按 FailOn 夹具决定成败。
    $script:World.WriteAttempts += $full
    if ($script:World.FailOn.ContainsKey('Write-WeFlowTextFile') -and $full -match $script:World.FailOn['Write-WeFlowTextFile']) {
      throw ("模拟写入失败：{0}" -f $full)
    }
    $dir = Split-Path -Parent $full
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($full, $Content, $encoding)
  }
  Install-WeFlowMock -Name 'New-WeFlowDirectory' -Body {
    param([Parameter(Mandatory)][string]$Path)
    $full = Get-SandboxPath -Path $Path
    if (-not (Test-Path -LiteralPath $full)) { New-Item -ItemType Directory -Force -Path $full | Out-Null; return $true }
    return $false
  }
  Install-WeFlowMock -Name 'Remove-WeFlowFilePath' -Body {
    param([Parameter(Mandatory)][string]$Path)
    Remove-Item -LiteralPath (Get-SandboxPath -Path $Path) -Force -ErrorAction SilentlyContinue
  }
  Install-WeFlowMock -Name 'Move-WeFlowFilePath' -Body {
    param([Parameter(Mandatory)][string]$Source, [Parameter(Mandatory)][string]$Destination, [switch]$Overwrite)
    $src = Get-SandboxPath -Path $Source
    $dst = Get-SandboxPath -Path $Destination
    if ($Overwrite) { Move-Item -LiteralPath $src -Destination $dst -Force } else { Move-Item -LiteralPath $src -Destination $dst }
  }
  Install-WeFlowMock -Name 'Copy-WeFlowFilePath' -Body {
    param([Parameter(Mandatory)][string]$Source, [Parameter(Mandatory)][string]$Destination, [switch]$Overwrite)
    $src = Get-SandboxPath -Path $Source
    $dst = Get-SandboxPath -Path $Destination
    if ($Overwrite) { Copy-Item -LiteralPath $src -Destination $dst -Force } else { Copy-Item -LiteralPath $src -Destination $dst }
  }
  Install-WeFlowMock -Name 'Expand-WeFlowArchiveZip' -Body {
    param([Parameter(Mandatory)][string]$ArchivePath, [Parameter(Mandatory)][string]$DestinationPath)
    $null = Get-SandboxPath -Path $ArchivePath
    $dst = Get-SandboxPath -Path $DestinationPath
    if (-not (Test-Path -LiteralPath $dst)) { New-Item -ItemType Directory -Force -Path $dst | Out-Null }
    if ($script:World.FailOn.ContainsKey('Expand-WeFlowArchiveZip')) { throw '模拟展开失败' }
    foreach ($name in @('caddy.exe', 'LICENSE', 'README.md')) {
      [System.IO.File]::WriteAllText((Join-Path $dst $name), ("stub-" + $name), (New-Object System.Text.UTF8Encoding($false)))
    }
  }
  Install-WeFlowMock -Name 'Get-WeFlowFileHash' -Body {
    param([Parameter(Mandatory)][string]$Path)
    if ($script:World.FileHashes.ContainsKey($Path)) { return $script:World.FileHashes[$Path] }
    $full = Get-ReadablePath -Path $Path
    return (Get-FileHash -LiteralPath $full -Algorithm SHA256).Hash.ToLowerInvariant()
  }
  Install-WeFlowMock -Name 'Get-WeFlowAcl' -Body {
    param([Parameter(Mandatory)][string]$Path)
    $null = Get-ReadablePath -Path $Path
    if ($script:World.AclRestricted.ContainsKey($Path)) {
      return @(
        [pscustomobject]@{ IdentityReference = "$env:COMPUTERNAME\$env:USERNAME"; FileSystemRights = 'FullControl'; AccessControlType = 'Allow'; IsInherited = $false },
        [pscustomobject]@{ IdentityReference = 'NT AUTHORITY\SYSTEM'; FileSystemRights = 'FullControl'; AccessControlType = 'Allow'; IsInherited = $false },
        [pscustomobject]@{ IdentityReference = 'BUILTIN\Administrators'; FileSystemRights = 'FullControl'; AccessControlType = 'Allow'; IsInherited = $false }
      )
    }
    return @(
      [pscustomobject]@{ IdentityReference = 'BUILTIN\Users'; FileSystemRights = 'ReadAndExecute'; AccessControlType = 'Allow'; IsInherited = $true }
    )
  }
  Install-WeFlowMock -Name 'Test-WeFlowAclInheritanceProtected' -Body {
    param([Parameter(Mandatory)][string]$Path)
    $null = Get-ReadablePath -Path $Path
    return [bool]$script:World.AclInheritanceProtected
  }
  Install-WeFlowMock -Name 'Set-WeFlowRestrictedAcl' -Body {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$DeploymentAccount)
    $null = Get-SandboxPath -Path $Path
    if ($script:World.FailOn.ContainsKey('Set-WeFlowRestrictedAcl')) { throw '模拟 ACL 收紧失败' }
    $script:World.AclRestricted[$Path] = $true
  }
  Install-WeFlowMock -Name 'Get-WeFlowProcessById' -Body {
    param([Parameter(Mandatory)][int]$Id)
    if (-not $script:World.Processes.ContainsKey($Id)) { return $null }
    $entry = $script:World.Processes[$Id]
    return [pscustomobject]@{ Id = $Id; Path = $entry.Path; StartTime = $entry.StartTime }
  }
  Install-WeFlowMock -Name 'Start-WeFlowCaddyProcess' -Body {
    param(
      [Parameter(Mandatory)][string]$ExePath,
      [Parameter(Mandatory)][string[]]$Arguments,
      [Parameter(Mandatory)][string]$StdOutPath,
      [Parameter(Mandatory)][string]$StdErrPath
    )
    if ($script:World.FailOn.ContainsKey('Start-WeFlowCaddyProcess')) { throw '模拟启动失败' }
    $pidValue = $script:World.NextPid
    $script:World.NextPid = $pidValue + 1
    # 与真实实现一致：返回实际使用的命令行（生产代码会打印它）
    $argumentLine = ConvertTo-WeFlowWindowsArgumentLine -Arguments $Arguments
    $script:World.StartArgumentLines += $argumentLine
    if ($script:World.FailOn.ContainsKey('Start-WeFlowCaddyProcess.ExitImmediately')) { return [pscustomobject]@{ Id = $pidValue; Path = $ExePath; StartTime = (Get-Date); ArgumentLine = $argumentLine } }
    $script:World.Processes[$pidValue] = @{ Path = $ExePath; StartTime = (Get-Date) }
    return [pscustomobject]@{ Id = $pidValue; Path = $ExePath; StartTime = $script:World.Processes[$pidValue].StartTime; ArgumentLine = $argumentLine }
  }
  Install-WeFlowMock -Name 'Stop-WeFlowProcessById' -Body {
    param([Parameter(Mandatory)][int]$Id)
    $script:World.StopProcessCalls += $Id
    # IgnoreStopProcess：模拟「发了结束请求但进程仍然存活」，用于验证退出确认。
    if ($script:World.IgnoreStopProcess) { return }
    if ($script:World.Processes.ContainsKey($Id)) { $script:World.Processes.Remove($Id) }
  }
  Install-WeFlowMock -Name 'Get-WeFlowNetTcpListener' -Body {
    param([Parameter(Mandatory)][int]$Port)
    $addresses = @()
    if ($script:World.Listeners.ContainsKey($Port)) { $addresses = @($script:World.Listeners[$Port]) }
    if ($Port -eq 443 -and $script:World.AutoListenerOnNativeProcess -and $script:World.Processes.Count -gt 0) {
      $addresses = @($addresses + '192.168.1.57')
    }
    $result = @()
    foreach ($address in $addresses) {
      $result += [pscustomobject]@{ LocalAddress = $address; LocalPort = $Port; OwningProcess = 9999 }
    }
    return $result
  }
  Install-WeFlowMock -Name 'Get-WeFlowLocalIPv4' -Body {
    return @($script:World.LocalIPv4)
  }
  Install-WeFlowMock -Name 'Get-WeFlowCommandPath' -Body {
    param([Parameter(Mandatory)][string]$Name)
    if ($script:World.CommandPaths.ContainsKey($Name)) { return $script:World.CommandPaths[$Name] }
    return $null
  }
  Install-WeFlowMock -Name 'Invoke-WeFlowExternalCommand' -Body {
    param([Parameter(Mandatory)][string]$FilePath, [string[]]$Arguments = @(), [string]$WorkingDirectory,
      [System.Text.Encoding]$OutputEncoding)
    # 形参必须与生产实现保持一致（含可选的 -OutputEncoding），否则生产调用一旦指定编码，
    # mock 会以「找不到参数」抛错——这正是本 mock 需要跟随生产签名演进的原因。
    $script:World.ExternalCalls += [pscustomobject]@{ FilePath = $FilePath; Arguments = $Arguments; WorkingDirectory = $WorkingDirectory; OutputEncoding = $OutputEncoding }
    if ($script:World.ExternalQueue.Count -eq 0) { throw '模拟外部命令队列已空（测试用例未提供结果）' }
    return $script:World.ExternalQueue.Dequeue()
  }
  Install-WeFlowMock -Name 'Invoke-WeFlowHttpRequest' -Body {
    param([Parameter(Mandatory)][string]$Url, [int]$TimeoutSec = 5)
    $script:World.HttpCalls += $Url
    if ($script:World.HttpQueue.Count -eq 0) { throw '模拟 HTTP 队列已空' }
    return $script:World.HttpQueue.Dequeue()
  }
  Install-WeFlowMock -Name 'Invoke-WeFlowDocker' -Body {
    param([Parameter(Mandatory)][string[]]$ComposeArgs, [Parameter(Mandatory)][string]$ReleaseDir)
    $script:World.DockerCalls += [pscustomobject]@{ ComposeArgs = $ComposeArgs; ReleaseDir = $ReleaseDir }
    if ($script:World.DockerQueue.Count -eq 0) { throw '模拟 Docker 队列已空（测试用例未提供结果）' }
    return $script:World.DockerQueue.Dequeue()
  }
}

# =====================================================================
# 夹具
# =====================================================================

function New-FixturePackage {
  param(
    [Parameter(Mandatory)][string]$Root,
    [switch]$BadCidr,
    [switch]$BadHostname,
    [switch]$Traversal,
    [switch]$PublicCidr
  )
  $scriptsDir = Join-Path $Root 'central\windows-caddy\scripts'
  New-Item -ItemType Directory -Force -Path $scriptsDir | Out-Null
  Copy-Item -LiteralPath (Join-Path $script:ProdScriptsRoot 'Caddyfile.template') -Destination (Join-Path $Root 'central\windows-caddy\Caddyfile.template') -Force -ErrorAction SilentlyContinue
  $templateSource = Join-Path $script:WorkRoot 'central\windows-caddy\Caddyfile.template'
  Copy-Item -LiteralPath $templateSource -Destination (Join-Path $Root 'central\windows-caddy\Caddyfile.template') -Force

  $cidr = '192.168.1.0/24'
  if ($BadCidr) { $cidr = '192.168.1.5/24' }
  if ($PublicCidr) { $cidr = '0.0.0.0/0' }
  $hostname = 'weflow-central.test'
  if ($BadHostname) { $hostname = 'evil.test{' }
  $rootPath = $Root
  if ($Traversal) { $rootPath = $Root }
  $lines = @(
    '# 测试夹具 native.env',
    'WEFLOW_NATIVE_BIND_IP=192.168.1.57',
    ('WEFLOW_NATIVE_ALLOWED_CIDR=' + $cidr),
    ('WEFLOW_NATIVE_HOSTNAME=' + $hostname),
    ('WEFLOW_NATIVE_ROOT=' + $rootPath),
    ('WEFLOW_NATIVE_CONFIG_DIR=' + (Join-Path $rootPath 'config')),
    ('WEFLOW_NATIVE_LOG_DIR=' + (Join-Path $rootPath 'logs')),
    ('WEFLOW_NATIVE_PKI_DIR=' + (Join-Path $rootPath 'pki')),
    ('WEFLOW_NATIVE_BIN_DIR=' + (Join-Path $rootPath 'bin')),
    ('WEFLOW_NATIVE_CADDY_EXE=' + (Join-Path $rootPath 'bin\caddy.exe')),
    ('WEFLOW_NATIVE_CADDYFILE=' + (Join-Path $rootPath 'config\Caddyfile')),
    ('WEFLOW_NATIVE_STATE_DIR=' + (Join-Path $rootPath 'state')),
    'WEFLOW_NATIVE_UPSTREAM=127.0.0.1:8787'
  )
  $encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText((Join-Path $Root 'native.env'), ($lines -join "`n"), $encoding)
  return (Join-Path $Root 'native.env')
}

# =====================================================================
# 载入生产脚本（-SelfTest：只定义函数，不执行主体）
# =====================================================================

# 说明：生产脚本必须点源在「脚本作用域」。点源发生在函数内部时，函数返回后定义会丢失。

# =====================================================================
# 用例
# =====================================================================

function Test-SyntaxAndStrictMode {
  Start-Case 'A. 语法解析与 StrictMode'
  $files = @(Get-ChildItem -LiteralPath $script:ProdScriptsRoot -Filter *.ps1 -File)
  Assert-True -Condition ($files.Count -ge 6) -Name '找到全部生产脚本'
  foreach ($file in $files) {
    $tokens = $null
    $errors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$tokens, [ref]$errors)
    Assert-True -Condition ($errors.Count -eq 0) -Name ("语法解析无错误：{0}" -f $file.Name) -Detail (($errors | ForEach-Object { $_.Message }) -join '; ')
  }
  Assert-True -Condition (Test-WeFlowNativeTestMode) -Name '测试模式已开启（危险叶子调用受拦截）'
}

function Test-Validators {
  Start-Case 'B. 参数校验（正例 + 危险负例）'
  Assert-True -Condition (Test-WeFlowIpv4Literal -Value '192.168.1.57') -Name '合法 IPv4 通过'
  Assert-True -Condition (-not (Test-WeFlowIpv4Literal -Value '192.168.1')) -Name '三段地址被拒绝'
  Assert-True -Condition (-not (Test-WeFlowIpv4Literal -Value '192.168.1.256')) -Name '越界段被拒绝'
  Assert-True -Condition (-not (Test-WeFlowIpv4Literal -Value '10.1.1.01')) -Name '前导零被拒绝'
  Assert-True -Condition (-not (Test-WeFlowIpv4Literal -Value '::1')) -Name 'IPv6 被拒绝'
  Assert-True -Condition (Test-WeFlowPrivateCidr -Value '192.168.1.0/24') -Name '合法私有 CIDR 通过'
  Assert-True -Condition (Test-WeFlowPrivateCidr -Value '10.0.0.0/8') -Name '10/8 通过'
  Assert-True -Condition (Test-WeFlowPrivateCidr -Value '172.16.0.0/12') -Name '172.16/12 通过'
  Assert-True -Condition (-not (Test-WeFlowPrivateCidr -Value '192.168.1.0/8')) -Name '跨段前缀被拒绝'
  Assert-True -Condition (-not (Test-WeFlowPrivateCidr -Value '192.168.1.5/24')) -Name '主机位非零被拒绝'
  Assert-True -Condition (-not (Test-WeFlowPrivateCidr -Value '10.999.0.0/8')) -Name '含 999 的 CIDR 被拒绝'
  Assert-True -Condition (-not (Test-WeFlowPrivateCidr -Value '8.8.8.0/24')) -Name '公网段被拒绝'
  Assert-True -Condition (-not (Test-WeFlowPrivateCidr -Value '0.0.0.0/0')) -Name '0.0.0.0/0 被拒绝'
  Assert-True -Condition (Test-WeFlowHostname -Value 'weflow-central.test') -Name '合法主机名通过'
  Assert-True -Condition (-not (Test-WeFlowHostname -Value 'weflow-central')) -Name '单标签主机名被拒绝'
  Assert-True -Condition (-not (Test-WeFlowHostname -Value 'a b.test')) -Name '含空格主机名被拒绝'
  Assert-True -Condition (-not (Test-WeFlowHostname -Value 'evil.test{')) -Name '含花括号主机名被拒绝'
  Assert-True -Condition (-not (Test-WeFlowHostname -Value 'evil.test/path')) -Name '含斜杠主机名被拒绝'
  Assert-True -Condition (Test-WeFlowPathUnderRoot -Path 'F:\WeFlow-Test\pki' -Root 'F:\WeFlow-Test') -Name '根下路径通过'
  Assert-True -Condition (-not (Test-WeFlowPathUnderRoot -Path 'F:\WeFlow-Test-Other\pki' -Root 'F:\WeFlow-Test')) -Name '前缀相似的越界路径被拒绝'
  Assert-True -Condition (Test-WeFlowPathTraversal -Value 'F:\WeFlow-Test\..\Windows') -Name '.. 穿越被识别'
  Assert-True -Condition (-not (Test-WeFlowPathIsCanonical -Value 'F:\WeFlow-Test\config\..\config')) -Name '非规范路径被识别'
}

function Test-EnvValidation {
  Start-Case 'C. native.env 强校验'
  $badRoot = Join-Path $script:SandboxRootPath 'env-bad'
  $envPath = New-FixturePackage -Root $badRoot -BadCidr
  Assert-Throws -Name '主机位非零 CIDR 被拒绝' -Action { Read-WeFlowNativeEnv -Path $envPath -CaddyfileTemplatePath (Join-Path $badRoot 'central\windows-caddy\Caddyfile.template') } -MessagePattern 'ALLOWED_CIDR'

  $badRoot2 = Join-Path $script:SandboxRootPath 'env-public'
  $envPath2 = New-FixturePackage -Root $badRoot2 -PublicCidr
  Assert-Throws -Name '0.0.0.0/0 被拒绝' -Action { Read-WeFlowNativeEnv -Path $envPath2 -CaddyfileTemplatePath (Join-Path $badRoot2 'central\windows-caddy\Caddyfile.template') } -MessagePattern 'ALLOWED_CIDR'

  $badRoot3 = Join-Path $script:SandboxRootPath 'env-host'
  $envPath3 = New-FixturePackage -Root $badRoot3 -BadHostname
  Assert-Throws -Name '注入型主机名被拒绝' -Action { Read-WeFlowNativeEnv -Path $envPath3 -CaddyfileTemplatePath (Join-Path $badRoot3 'central\windows-caddy\Caddyfile.template') } -MessagePattern 'HOSTNAME'

  $traversalRoot = Join-Path $script:SandboxRootPath 'env-traversal'
  $envPath4 = New-FixturePackage -Root $traversalRoot
  $text = (Get-Content -LiteralPath $envPath4 -Raw) -replace [regex]::Escape((Join-Path $traversalRoot 'pki')), ((Join-Path $traversalRoot 'pki') + '\..\..\Windows')
  [System.IO.File]::WriteAllText($envPath4, $text, (New-Object System.Text.UTF8Encoding($false)))
  Assert-Throws -Name '含 .. 的路径被拒绝' -Action { Read-WeFlowNativeEnv -Path $envPath4 -CaddyfileTemplatePath (Join-Path $traversalRoot 'central\windows-caddy\Caddyfile.template') } -MessagePattern '穿越|规范化'

  $goodRoot = Join-Path $script:SandboxRootPath 'env-good'
  $envPath5 = New-FixturePackage -Root $goodRoot
  $config = Read-WeFlowNativeEnv -Path $envPath5 -CaddyfileTemplatePath (Join-Path $goodRoot 'central\windows-caddy\Caddyfile.template')
  Assert-Equal -Expected '192.168.1.0/24' -Actual $config.AllowedCidr -Name '合法配置读取成功'
  Assert-Equal -Expected '127.0.0.1:8787' -Actual $config.Upstream -Name '上游固定为回环'

  $dupPath = Join-Path $goodRoot 'native-dupe.env'
  $dupeText = (Get-Content -LiteralPath $envPath5 -Raw) + "`nWEFLOW_NATIVE_UPSTREAM=127.0.0.1:8787"
  [System.IO.File]::WriteAllText($dupPath, $dupeText, (New-Object System.Text.UTF8Encoding($false)))
  Assert-Throws -Name '重复键被拒绝' -Action { Read-WeFlowNativeEnv -Path $dupPath -CaddyfileTemplatePath (Join-Path $goodRoot 'central\windows-caddy\Caddyfile.template') } -MessagePattern '重复键'
}

function Test-Render {
  Start-Case 'D. 配置渲染'
  $root = Join-Path $script:SandboxRootPath 'render'
  $envPath = New-FixturePackage -Root $root
  $templatePath = Join-Path $root 'central\windows-caddy\Caddyfile.template'
  $config = Read-WeFlowNativeEnv -Path $envPath -CaddyfileTemplatePath $templatePath

  $dest = Join-Path $root 'config\Caddyfile'
  New-WeFlowRenderedCaddyfile -Config $config -Destination $dest | Out-Null
  $rendered = Get-Content -LiteralPath $dest -Raw
  Assert-True -Condition (-not ($rendered -match '\{\$')) -Name '渲染后无残留占位符'
  Assert-True -Condition ($rendered -match 'bind 192\.168\.1\.57') -Name '绑定地址已写入'
  Assert-True -Condition ($rendered -match 'remote_ip 192\.168\.0\.0/24|remote_ip 192\.168\.1\.0/24') -Name '允许网段已写入'

  $outside = 'F:\WeFlow-Test-Other\Caddyfile'
  Assert-Throws -Name '渲染目标越界被拒绝' -Action { New-WeFlowRenderedCaddyfile -Config $config -Destination $outside } -MessagePattern '部署根'

  $placeholderTemplate = Join-Path $root 'central\windows-caddy\Bad.template'
  [System.IO.File]::WriteAllText($placeholderTemplate, "https://{`$WEFLOW_NATIVE_HOSTNAME}`n{`$UNKNOWN_PLACEHOLDER}`n", (New-Object System.Text.UTF8Encoding($false)))
  $configCopy = $config.Clone()
  $configCopy.CaddyfileTemplate = $placeholderTemplate
  Assert-Throws -Name '残留未知占位符被拒绝' -Action { New-WeFlowRenderedCaddyfile -Config $configCopy -Destination (Join-Path $root 'config\Caddyfile2') } -MessagePattern '占位符'
}

function Test-ArgumentEncoding {
  Start-Case 'K. Windows 命令行参数构造（纯函数，逐值断言）'
  Assert-Equal -Expected 'run' -Actual (ConvertTo-WeFlowWindowsArgument -Value 'run') -Name '无空白参数不加引号'
  Assert-Equal -Expected '/health' -Actual (ConvertTo-WeFlowWindowsArgument -Value '/health') -Name '路径参数不加引号'
  Assert-Equal -Expected '--config' -Actual (ConvertTo-WeFlowWindowsArgument -Value '--config') -Name '开关不加引号'
  Assert-Equal -Expected '"start with space"' -Actual (ConvertTo-WeFlowWindowsArgument -Value 'start with space') `
    -Name '含空格参数被整体加引号'
  Assert-Equal -Expected '"F:\WeFlow-Test\start with space\config\Caddyfile"' `
    -Actual (ConvertTo-WeFlowWindowsArgument -Value 'F:\WeFlow-Test\start with space\config\Caddyfile') `
    -Name '含空格路径（反斜杠）被整体加引号'
  Assert-Equal -Expected '""' -Actual (ConvertTo-WeFlowWindowsArgument -Value '') -Name '空参数编码为 ""'
  Assert-Equal -Expected '"say \"hi\""' -Actual (ConvertTo-WeFlowWindowsArgument -Value 'say "hi"') `
    -Name '内嵌双引号被反斜杠转义'
  Assert-Equal -Expected 'trailing\' -Actual (ConvertTo-WeFlowWindowsArgument -Value 'trailing\') `
    -Name '无空白的结尾反斜杠保持原样（不需要引号就没有歧义）'
  Assert-Equal -Expected '"C:\path with space\\"' -Actual (ConvertTo-WeFlowWindowsArgument -Value 'C:\path with space\') `
    -Name '含空格且以反斜杠结尾的参数'
  Assert-Equal -Expected '"a\\\"b"' -Actual (ConvertTo-WeFlowWindowsArgument -Value 'a\"b') `
    -Name '引号前的反斜杠按 2n+1 规则翻倍'
  $tabValue = "a`tb"
  $tabExpected = '"' + "a`tb" + '"'
  Assert-Equal -Expected $tabExpected -Actual (ConvertTo-WeFlowWindowsArgument -Value $tabValue) `
    -Name '含制表符参数被加引号'
  Assert-Equal -Expected '中文参数' -Actual (ConvertTo-WeFlowWindowsArgument -Value '中文参数') -Name '非 ASCII 无空白参数不加引号'

  Assert-Equal -Expected ('run --config "F:\a b\Caddyfile" --adapter caddyfile') `
    -Actual (ConvertTo-WeFlowWindowsArgumentLine -Arguments @('run', '--config', 'F:\a b\Caddyfile', '--adapter', 'caddyfile')) `
    -Name '多参数拼成一条命令行（含空格路径逐值正确）'

  Assert-Throws -Name '含 CR/LF 的参数被明确拒绝' `
    -Action { ConvertTo-WeFlowWindowsArgument -Value ("a`r`nb") } -MessagePattern 'CR/LF'
  Assert-Throws -Name '含 NUL 的参数被明确拒绝' `
    -Action { ConvertTo-WeFlowWindowsArgument -Value ('a' + [char]0 + 'b') } -MessagePattern 'NUL'
  Assert-Throws -Name '参数数组中任一项不合法即整条拒绝' `
    -Action { ConvertTo-WeFlowWindowsArgumentLine -Arguments @('run', ("bad`nvalue")) } -MessagePattern 'CR/LF'
}

function Test-ProcessReclaim {
  Start-Case 'L. 进程身份与回收（内存记录 + 退出确认，不依赖磁盘记账）'
  $root = Join-Path $script:SandboxRootPath 'reclaim'
  New-Item -ItemType Directory -Force -Path $root | Out-Null

  # L1：内存身份一致 → 结束并确认退出
  New-World
  $exePath = Join-Path $root 'bin\caddy.exe'
  $startedAt = (Get-Date).AddSeconds(-30)
  $script:World.Processes[6001] = @{ Path = $exePath; StartTime = $startedAt }
  $record = New-WeFlowProcessIdentityRecord -Id 6001 -ExecutablePath $exePath -StartTime $startedAt
  $stop = Stop-WeFlowOwnedProcess -Record $record
  Assert-True -Condition ($stop.Ok -and $stop.Status -eq 'stopped') -Name '内存身份一致 → 结束并确认退出' -Detail $stop.Message
  Assert-True -Condition ($null -eq (Get-WeFlowProcessById -Id 6001)) -Name '结束后进程确实消失'

  # L2：启动时间取不到（身份未知）→ 拒绝结束
  New-World
  $script:World.Processes[6002] = @{ Path = $exePath; StartTime = $startedAt }
  $unknown = New-WeFlowProcessIdentityRecord -Id 6002 -ExecutablePath $exePath -StartTime (Get-Date)
  $unknown.StartedAt = $null
  $stop = Stop-WeFlowOwnedProcess -Record $unknown
  Assert-True -Condition (-not $stop.Ok) -Name '身份未知（无启动时间）→ 拒绝结束'
  Assert-Equal -Expected 0 -Actual $script:World.StopProcessCalls.Count -Name '身份未知时未调用结束进程'

  # L3：PID 复用（路径不同）→ 拒绝结束
  New-World
  $script:World.Processes[6003] = @{ Path = 'C:\Windows\System32\notepad.exe'; StartTime = $startedAt }
  $reused = New-WeFlowProcessIdentityRecord -Id 6003 -ExecutablePath $exePath -StartTime $startedAt
  $stop = Stop-WeFlowOwnedProcess -Record $reused
  Assert-True -Condition (-not $stop.Ok -and $stop.Status -eq 'identity-mismatch') -Name 'PID 复用（路径不符）→ 拒绝结束' -Detail $stop.Message

  # L4：进程已不存在 → 无需回收，视为成功
  New-World
  $missing = New-WeFlowProcessIdentityRecord -Id 6004 -ExecutablePath $exePath -StartTime (Get-Date)
  $stop = Stop-WeFlowOwnedProcess -Record $missing
  Assert-True -Condition ($stop.Ok -and $stop.Status -eq 'not-running') -Name '进程已不存在 → 视为已回收' -Detail $stop.Message

  # L5：结束后仍存活 → 回退失败（不能只发结束请求就算成功）
  New-World
  $script:World.IgnoreStopProcess = $true
  $script:World.Processes[6005] = @{ Path = $exePath; StartTime = $startedAt }
  $stubborn = New-WeFlowProcessIdentityRecord -Id 6005 -ExecutablePath $exePath -StartTime $startedAt
  $savedWait = $script:WeFlowProcessExitWaitSeconds
  $script:WeFlowProcessExitWaitSeconds = 0.2
  $stop = Stop-WeFlowOwnedProcess -Record $stubborn
  $script:WeFlowProcessExitWaitSeconds = $savedWait
  Assert-True -Condition (-not $stop.Ok -and $stop.Status -eq 'still-running') -Name '结束后仍存活 → 判为回退失败' -Detail $stop.Message

  # L6：两条来源都没有 → 不猜测、不动手
  New-World
  $stop = Stop-WeFlowOwnedProcess -Record $null
  Assert-True -Condition (-not $stop.Ok -and $stop.Status -eq 'no-record') -Name '无任何记录 → 拒绝乱猜并报告失败' -Detail $stop.Message
  Assert-Equal -Expected 0 -Actual $script:World.StopProcessCalls.Count -Name '无记录时未结束任何进程'
}

function Test-StartAcceptanceContract {
  Start-Case 'M. 启动验收契约（/health 与 /ready 统一判定，403 不算通过）'
  $root = Join-Path $script:SandboxRootPath 'acceptance'
  $envPath = New-FixturePackage -Root $root
  New-FixtureCaddyfile -Root $root
  New-FakeExe -Root $root
  $healthBody = '{"ok":true,"data":{"service":"weflow-central","protocolVersion":1}}'
  $readyBody = '{"ok":true,"data":{"database":"ready"}}'

  function New-StartWorld {
    param([string]$HealthStdOut, [string]$ReadyStdOut)
    New-World
    $script:World.AutoListenerOnNativeProcess = $true
    $script:World.CommandPaths['curl.exe'] = 'C:\fake\curl.exe'
    Add-ExternalResult -ExitCode 0 -StdOut $HealthStdOut
    Add-ExternalResult -ExitCode 0 -StdOut $ReadyStdOut
    Add-DockerResult -ExitCode 0 -StdOut 'weflow-test-caddy-1  caddy  Up 5 minutes'
    Add-DockerResult -ExitCode 0   # stop caddy
    Add-DockerResult -ExitCode 0   # 回退时 start caddy
    $script:World.StopProcessCalls = @()
  }

  # M1：两端点均通过 → 0，且两次探测都发生
  New-StartWorld -HealthStdOut ($healthBody + "`n__WEFLOW_STATUS__200") -ReadyStdOut ($readyBody + "`n__WEFLOW_STATUS__200")
  $code = Invoke-NativeCaddyStart -PackageRoot $root -ReleaseDir $root -NativeEnvPath $envPath
  Assert-Equal -Expected 0 -Actual $code -Name '/health + /ready 均通过 → 退出码 0'
  Assert-Equal -Expected 2 -Actual $script:World.ExternalCalls.Count -Name '启动验收确实探测了两个端点'

  # M2：health 正常但 ready 失败 → 回退（3）
  New-StartWorld -HealthStdOut ($healthBody + "`n__WEFLOW_STATUS__200") -ReadyStdOut ("boom`n__WEFLOW_STATUS__500")
  $code = Invoke-NativeCaddyStart -PackageRoot $root -ReleaseDir $root -NativeEnvPath $envPath
  Assert-Equal -Expected 3 -Actual $code -Name 'health 正常但 ready 500 → 回退（退出码 3）'
  Assert-True -Condition ($script:World.StopProcessCalls.Count -ge 1) -Name 'ready 失败时回退结束了本轮进程'
  Assert-Equal -Expected 'start' -Actual $script:World.DockerCalls[-1].ComposeArgs[0] -Name 'ready 失败时按切换前记录恢复容器'

  # M3：403（来源门禁）不算通过 → 回退（3），不返回验收成功
  New-StartWorld -HealthStdOut ("forbidden`n__WEFLOW_STATUS__403") -ReadyStdOut ("forbidden`n__WEFLOW_STATUS__403")
  $code = Invoke-NativeCaddyStart -PackageRoot $root -ReleaseDir $root -NativeEnvPath $envPath
  Assert-Equal -Expected 3 -Actual $code -Name '403 来源门禁 → 不算启动成功，触发回退（退出码 3）'

  # M4：200 但响应体是错误 JSON → 回退（3）
  New-StartWorld -HealthStdOut ("not-json`n__WEFLOW_STATUS__200") -ReadyStdOut ($readyBody + "`n__WEFLOW_STATUS__200")
  $code = Invoke-NativeCaddyStart -PackageRoot $root -ReleaseDir $root -NativeEnvPath $envPath
  Assert-Equal -Expected 3 -Actual $code -Name '200 但响应不是合法 JSON → 回退（退出码 3）'

  # M5：protocolVersion 是字符串 "1"（错误类型） → 不得被强制转换洗白
  New-StartWorld -HealthStdOut ('{"ok":true,"data":{"service":"weflow-central","protocolVersion":"1"}}' + "`n__WEFLOW_STATUS__200") -ReadyStdOut ($readyBody + "`n__WEFLOW_STATUS__200")
  $code = Invoke-NativeCaddyStart -PackageRoot $root -ReleaseDir $root -NativeEnvPath $envPath
  Assert-Equal -Expected 3 -Actual $code -Name 'protocolVersion 类型错误 → 回退（退出码 3）'

  # M6：回退时无法确认本轮进程退出 → 4（并保留诊断记录）
  New-StartWorld -HealthStdOut ($healthBody + "`n__WEFLOW_STATUS__200") -ReadyStdOut ("boom`n__WEFLOW_STATUS__500")
  $script:World.IgnoreStopProcess = $true
  $savedWait = $script:WeFlowProcessExitWaitSeconds
  $script:WeFlowProcessExitWaitSeconds = 0.2
  $code = Invoke-NativeCaddyStart -PackageRoot $root -ReleaseDir $root -NativeEnvPath $envPath
  $script:WeFlowProcessExitWaitSeconds = $savedWait
  Assert-Equal -Expected 4 -Actual $code -Name '回退无法确认进程退出 → 退出码 4'
  Assert-True -Condition (Test-Path -LiteralPath (Join-Path $root 'state\native-caddy.rollback.json')) -Name '回退诊断记录已落盘'

  # M7：验收判定与诊断脚本共用同一份实现（不存在第二套阈值）
  Assert-True -Condition ((Get-Command -Name Invoke-WeFlowEndpointAcceptance -ErrorAction SilentlyContinue) -ne $null) `
    -Name '存在统一的端点验收函数'
  $commonSource = Get-Content -LiteralPath (Join-Path $script:ProdScriptsRoot 'WeFlowNative.Common.ps1') -Raw
  $startSource = Get-Content -LiteralPath (Join-Path $script:ProdScriptsRoot 'Start-NativeCaddy.ps1') -Raw
  $endpointSource = Get-Content -LiteralPath (Join-Path $script:ProdScriptsRoot 'Test-NativeCaddyEndpoint.ps1') -Raw
  Assert-True -Condition ((Test-WeFlowCodeContains -Source $startSource -Pattern 'Invoke-WeFlowEndpointAcceptance')) `
    -Name '启动脚本使用统一验收函数'
  Assert-True -Condition ((Test-WeFlowCodeContains -Source $endpointSource -Pattern 'Invoke-WeFlowEndpointAcceptance')) `
    -Name '诊断脚本使用同一验收函数'
  Assert-True -Condition ((Test-WeFlowCodeContains -Source $commonSource -Pattern 'Test-WeFlowEndpointPayload')) `
    -Name '契约判定只有一份实现'
}

function Test-WeFlowCodeContains {
  param([Parameter(Mandatory)][string]$Source, [Parameter(Mandatory)][string]$Pattern)
  return ($Source -match [regex]::Escape($Pattern))
}

function Test-EndpointContractStrict {
  Start-Case 'N. 端点契约严格性（类型 / 缺字段 / 协议版本）'
  $good = '{"ok":true,"data":{"service":"weflow-central","protocolVersion":1}}'
  Assert-True -Condition (Test-WeFlowEndpointPayload -Path '/health' -Body $good).Ok -Name '正例：合法 /health 通过'

  $cases = @(
    @{ Name = 'ok 是字符串 "true"'; Body = '{"ok":"true","data":{"service":"weflow-central","protocolVersion":1}}' },
    @{ Name = 'ok 是数字 1'; Body = '{"ok":1,"data":{"service":"weflow-central","protocolVersion":1}}' },
    @{ Name = '缺少 ok 字段'; Body = '{"data":{"service":"weflow-central","protocolVersion":1}}' },
    @{ Name = 'ok 为 null'; Body = '{"ok":null,"data":{"service":"weflow-central","protocolVersion":1}}' },
    @{ Name = '缺少 data 字段'; Body = '{"ok":true}' },
    @{ Name = 'data 为 null'; Body = '{"ok":true,"data":null}' },
    @{ Name = 'data 是标量'; Body = '{"ok":true,"data":5}' },
    @{ Name = '缺少 data.service'; Body = '{"ok":true,"data":{"protocolVersion":1}}' },
    @{ Name = 'service 为 null'; Body = '{"ok":true,"data":{"service":null,"protocolVersion":1}}' },
    @{ Name = 'service 值不符'; Body = '{"ok":true,"data":{"service":"weflow-other","protocolVersion":1}}' },
    @{ Name = 'service 是数字'; Body = '{"ok":true,"data":{"service":1,"protocolVersion":1}}' },
    @{ Name = '缺少 data.protocolVersion'; Body = '{"ok":true,"data":{"service":"weflow-central"}}' },
    @{ Name = 'protocolVersion 是字符串 "1"'; Body = '{"ok":true,"data":{"service":"weflow-central","protocolVersion":"1"}}' },
    @{ Name = 'protocolVersion 是小数 1.0'; Body = '{"ok":true,"data":{"service":"weflow-central","protocolVersion":1.0}}' },
    @{ Name = 'protocolVersion 是布尔'; Body = '{"ok":true,"data":{"service":"weflow-central","protocolVersion":true}}' },
    @{ Name = 'protocolVersion 是 2'; Body = '{"ok":true,"data":{"service":"weflow-central","protocolVersion":2}}' },
    @{ Name = '响应为空串'; Body = '' },
    @{ Name = '响应不是 JSON'; Body = '<html>502</html>' }
  )
  foreach ($case in $cases) {
    Assert-True -Condition (-not (Test-WeFlowEndpointPayload -Path '/health' -Body $case.Body).Ok) -Name ("/health 负例：" + $case.Name)
  }

  $readyGood = '{"ok":true,"data":{"database":"ready"}}'
  Assert-True -Condition (Test-WeFlowEndpointPayload -Path '/ready' -Body $readyGood).Ok -Name '正例：合法 /ready 通过'
  foreach ($case in @(
      @{ Name = 'database 大小写不符'; Body = '{"ok":true,"data":{"database":"Ready"}}' },
      @{ Name = 'database 是布尔'; Body = '{"ok":true,"data":{"database":true}}' },
      @{ Name = 'database 为 null'; Body = '{"ok":true,"data":{"database":null}}' },
      @{ Name = '缺少 data.database'; Body = '{"ok":true,"data":{}}' }
    )) {
    Assert-True -Condition (-not (Test-WeFlowEndpointPayload -Path '/ready' -Body $case.Body).Ok) -Name ("/ready 负例：" + $case.Name)
  }
}

function Test-EndpointScript {
  Start-Case 'E. 端点诊断脚本（真实逻辑 + 脚本化后端）'
  $root = Join-Path $script:SandboxRootPath 'endpoint'
  $envPath = New-FixturePackage -Root $root
  $certPath = Join-Path $root 'native-root.crt'
  [System.IO.File]::WriteAllText($certPath, 'stub-cert', (New-Object System.Text.UTF8Encoding($false)))

  $healthBody = '{"ok":true,"data":{"service":"weflow-central","protocolVersion":1}}'
  $readyBody = '{"ok":true,"data":{"database":"ready"}}'

  # 场景 1：curl 成功 + 契约匹配 → 0
  $script:World = $script:World
  New-World
  $script:World.CommandPaths['curl.exe'] = 'C:\fake\curl.exe'
  Add-ExternalResult -ExitCode 0 -StdOut ($healthBody + "`n__WEFLOW_STATUS__200")
  Add-ExternalResult -ExitCode 0 -StdOut ($readyBody + "`n__WEFLOW_STATUS__200")
  $code = Invoke-NativeCaddyEndpointDiagnostics -PackageRoot $root -NativeEnvPath $envPath -CaCertPath $certPath
  Assert-Equal -Expected 0 -Actual $code -Name 'curl 200 + 契约匹配 → 退出码 0'
  Assert-True -Condition ($script:World.ExternalCalls[0].Arguments -contains '--cacert') -Name 'curl 调用带 --cacert'
  Assert-True -Condition ($script:World.ExternalCalls[0].Arguments -contains '--resolve') -Name 'curl 调用带 --resolve'
  Assert-True -Condition (-not ($script:World.ExternalCalls[0].Arguments -contains '--insecure')) -Name 'curl 调用不含 --insecure'
  Assert-True -Condition (-not ($script:World.ExternalCalls[0].Arguments -contains '-k')) -Name 'curl 调用不含 -k'

  # 场景 2：403 → 8
  New-World
  $script:World.CommandPaths['curl.exe'] = 'C:\fake\curl.exe'
  Add-ExternalResult -ExitCode 0 -StdOut ("forbidden`n__WEFLOW_STATUS__403")
  Add-ExternalResult -ExitCode 0 -StdOut ("forbidden`n__WEFLOW_STATUS__403")
  $code = Invoke-NativeCaddyEndpointDiagnostics -PackageRoot $root -NativeEnvPath $envPath -CaCertPath $certPath
  Assert-Equal -Expected 8 -Actual $code -Name '403 来源门禁 → 退出码 8'

  # 场景 3：500 → 6
  New-World
  $script:World.CommandPaths['curl.exe'] = 'C:\fake\curl.exe'
  Add-ExternalResult -ExitCode 0 -StdOut ("boom`n__WEFLOW_STATUS__500")
  Add-ExternalResult -ExitCode 0 -StdOut ("boom`n__WEFLOW_STATUS__500")
  $code = Invoke-NativeCaddyEndpointDiagnostics -PackageRoot $root -NativeEnvPath $envPath -CaCertPath $certPath
  Assert-Equal -Expected 6 -Actual $code -Name 'HTTP 500 → 退出码 6'

  # 场景 4：200 但契约不匹配 → 7
  New-World
  $script:World.CommandPaths['curl.exe'] = 'C:\fake\curl.exe'
  Add-ExternalResult -ExitCode 0 -StdOut ('{"ok":true,"data":{"service":"wrong","protocolVersion":1}}' + "`n__WEFLOW_STATUS__200")
  Add-ExternalResult -ExitCode 0 -StdOut ($readyBody + "`n__WEFLOW_STATUS__200")
  $code = Invoke-NativeCaddyEndpointDiagnostics -PackageRoot $root -NativeEnvPath $envPath -CaCertPath $certPath
  Assert-Equal -Expected 7 -Actual $code -Name '契约不匹配 → 退出码 7'

  # 场景 5：TLS 校验失败（curl 60，非吊销） → 4
  New-World
  $script:World.CommandPaths['curl.exe'] = 'C:\fake\curl.exe'
  Add-ExternalResult -ExitCode 60 -StdErr 'SSL certificate problem: unable to get local issuer certificate'
  Add-ExternalResult -ExitCode 60 -StdErr 'SSL certificate problem: unable to get local issuer certificate'
  $code = Invoke-NativeCaddyEndpointDiagnostics -PackageRoot $root -NativeEnvPath $envPath -CaCertPath $certPath
  Assert-Equal -Expected 4 -Actual $code -Name 'TLS 链校验失败 → 退出码 4'

  # 场景 6：schannel 吊销未知 → 回落 python → 200 → 0
  New-World
  $script:World.CommandPaths['curl.exe'] = 'C:\fake\curl.exe'
  $script:World.CommandPaths['python.exe'] = 'C:\fake\python.exe'
  Add-ExternalResult -ExitCode 60 -StdErr 'schannel: the revocation status is unknown'
  Add-ExternalResult -ExitCode 0 -StdOut (@{ status = 200; body = $healthBody; category = 'transport-ok'; message = 'HTTP 200' } | ConvertTo-Json -Compress)
  Add-ExternalResult -ExitCode 60 -StdErr 'schannel: the revocation status is unknown'
  Add-ExternalResult -ExitCode 0 -StdOut (@{ status = 200; body = $readyBody; category = 'transport-ok'; message = 'HTTP 200' } | ConvertTo-Json -Compress)
  $code = Invoke-NativeCaddyEndpointDiagnostics -PackageRoot $root -NativeEnvPath $envPath -CaCertPath $certPath
  Assert-Equal -Expected 0 -Actual $code -Name 'schannel 不适用时回落 python 并成功 → 退出码 0'
  Assert-Equal -Expected 'C:\fake\python.exe' -Actual $script:World.ExternalCalls[1].FilePath -Name '第二次调用使用 python 后端'

  # 场景 7：无任何后端 → 3
  New-World
  $code = Invoke-NativeCaddyEndpointDiagnostics -PackageRoot $root -NativeEnvPath $envPath -CaCertPath $certPath
  Assert-Equal -Expected 3 -Actual $code -Name '无 curl / python → 退出码 3'

  # 场景 8：连接失败（curl 7） → 5
  New-World
  $script:World.CommandPaths['curl.exe'] = 'C:\fake\curl.exe'
  Add-ExternalResult -ExitCode 7 -StdErr 'Failed to connect'
  Add-ExternalResult -ExitCode 7 -StdErr 'Failed to connect'
  $code = Invoke-NativeCaddyEndpointDiagnostics -PackageRoot $root -NativeEnvPath $envPath -CaCertPath $certPath
  Assert-Equal -Expected 5 -Actual $code -Name '连接失败 → 退出码 5'

  # 场景 9：根证书缺失 → 1
  New-World
  $code = Invoke-NativeCaddyEndpointDiagnostics -PackageRoot $root -NativeEnvPath $envPath -CaCertPath (Join-Path $root 'missing.crt')
  Assert-Equal -Expected 1 -Actual $code -Name '缺根证书 → 退出码 1（拒绝跳过校验）'

  # 场景 10：200 但 protocolVersion 是字符串（类型错误）→ 7，不得被强制转换洗白
  New-World
  $script:World.CommandPaths['curl.exe'] = 'C:\fake\curl.exe'
  Add-ExternalResult -ExitCode 0 -StdOut ('{"ok":true,"data":{"service":"weflow-central","protocolVersion":"1"}}' + "`n__WEFLOW_STATUS__200")
  Add-ExternalResult -ExitCode 0 -StdOut ($readyBody + "`n__WEFLOW_STATUS__200")
  $code = Invoke-NativeCaddyEndpointDiagnostics -PackageRoot $root -NativeEnvPath $envPath -CaCertPath $certPath
  Assert-Equal -Expected 7 -Actual $code -Name '200 + 字段类型错误 → 退出码 7'

  # 场景 11：200 但响应体不是 JSON → 7
  New-World
  $script:World.CommandPaths['curl.exe'] = 'C:\fake\curl.exe'
  Add-ExternalResult -ExitCode 0 -StdOut ('<html>gateway</html>' + "`n__WEFLOW_STATUS__200")
  Add-ExternalResult -ExitCode 0 -StdOut ($readyBody + "`n__WEFLOW_STATUS__200")
  $code = Invoke-NativeCaddyEndpointDiagnostics -PackageRoot $root -NativeEnvPath $envPath -CaCertPath $certPath
  Assert-Equal -Expected 7 -Actual $code -Name '200 + 响应不是 JSON → 退出码 7'

  # 场景 12：python 后端报告响应协议错误（畸形 / 截断 / 超限）→ 9
  New-World
  $script:World.CommandPaths['curl.exe'] = 'C:\fake\curl.exe'
  $script:World.CommandPaths['python.exe'] = 'C:\fake\python.exe'
  Add-ExternalResult -ExitCode 60 -StdErr 'schannel: the revocation status is unknown'
  Add-ExternalResult -ExitCode 6 -StdOut (@{ status = $null; body = ''; category = 'protocol-error'; message = '响应被截断' } | ConvertTo-Json -Compress)
  Add-ExternalResult -ExitCode 60 -StdErr 'schannel: the revocation status is unknown'
  Add-ExternalResult -ExitCode 6 -StdOut (@{ status = $null; body = ''; category = 'protocol-error'; message = '响应被截断' } | ConvertTo-Json -Compress)
  $code = Invoke-NativeCaddyEndpointDiagnostics -PackageRoot $root -NativeEnvPath $envPath -CaCertPath $certPath
  Assert-Equal -Expected 9 -Actual $code -Name '响应协议错误 → 退出码 9'

  # 场景 13：health 正常但 ready 失败 → 仍为非零（不得只看一个端点）
  New-World
  $script:World.CommandPaths['curl.exe'] = 'C:\fake\curl.exe'
  Add-ExternalResult -ExitCode 0 -StdOut ($healthBody + "`n__WEFLOW_STATUS__200")
  Add-ExternalResult -ExitCode 0 -StdOut ("boom`n__WEFLOW_STATUS__500")
  $code = Invoke-NativeCaddyEndpointDiagnostics -PackageRoot $root -NativeEnvPath $envPath -CaCertPath $certPath
  Assert-Equal -Expected 6 -Actual $code -Name 'health 通过但 ready 500 → 非零退出'
}

function Test-RealArgumentConstruction {
  <#
  .SYNOPSIS
    P. 真实参数构造组合测试（mock 下沉到进程执行，参数构造不 mock）。
  .DESCRIPTION
    ee2ee77 真实切换的教训：旧隔离测试把 Invoke-WeFlowExternalCommand 整个 mock 掉，
    绕过了 ConvertTo-WeFlowWindowsArgumentLine 的 CR/LF 拒绝规则——curl -w 参数里的
    真实换行符在 Windows 上必然抛异常而测试全绿（假覆盖）。
    本组换上「构造器友好」的外部命令 mock：参数构造**真实执行**，只把进程执行
    替换为队列结果。探测函数给出的真实参数数组编码不出来，本组立即失败。
  #>
  Start-Case 'P. 真实参数构造组合测试（mock 下沉到进程执行叶子）'
  Install-WeFlowMock -Name 'Invoke-WeFlowExternalCommand' -Body {
    param([Parameter(Mandatory)][string]$FilePath, [string[]]$Arguments = @(), [string]$WorkingDirectory,
      [System.Text.Encoding]$OutputEncoding)
    # 与生产一致：先真实执行参数构造（CR/LF 等非法参数在这里 throw），再把进程执行替换为队列结果。
    $script:World.LastArgumentLine = ConvertTo-WeFlowWindowsArgumentLine -Arguments $Arguments
    $script:World.ExternalCalls += [pscustomobject]@{ FilePath = $FilePath; Arguments = $Arguments; WorkingDirectory = $WorkingDirectory; OutputEncoding = $OutputEncoding }
    if ($script:World.ExternalQueue.Count -eq 0) { throw '模拟外部命令队列已空（测试用例未提供结果）' }
    return $script:World.ExternalQueue.Dequeue()
  }

  $root = Join-Path $script:SandboxRootPath 'real-args'
  $envPath = New-FixturePackage -Root $root
  $certPath = Join-Path $root 'native-root.crt'
  [System.IO.File]::WriteAllText($certPath, 'stub-cert', (New-Object System.Text.UTF8Encoding($false)))
  $config = Read-WeFlowNativeEnv -Path $envPath -CaddyfileTemplatePath (Join-Path $root 'central\windows-caddy\Caddyfile.template')
  $healthBody = '{"ok":true,"data":{"service":"weflow-central","protocolVersion":1}}'
  $readyBody = '{"ok":true,"data":{"database":"ready"}}'

  # P1：curl 探测的真实参数数组（含 -w 格式参数）必须能通过真实参数构造
  New-World
  $script:World.CommandPaths['curl.exe'] = 'C:\fake\curl.exe'
  Add-ExternalResult -ExitCode 0 -StdOut ($healthBody + "`n__WEFLOW_STATUS__200")
  Add-ExternalResult -ExitCode 0 -StdOut ($readyBody + "`n__WEFLOW_STATUS__200")
  $code = Invoke-NativeCaddyEndpointDiagnostics -PackageRoot $root -NativeEnvPath $envPath -CaCertPath $certPath
  Assert-Equal -Expected 0 -Actual $code -Name 'curl 探测的真实参数数组通过真实参数构造 → 退出码 0'
  Assert-True -Condition ($script:World.LastArgumentLine.Length -gt 0) -Name '参数构造真实执行并产出命令行' -Detail $script:World.LastArgumentLine
  Assert-True -Condition ($script:World.LastArgumentLine -match '--cacert') -Name '构造的命令行带完整证书校验参数'
  Assert-True -Condition ($script:World.LastArgumentLine -match [regex]::Escape('\n__WEFLOW_STATUS__%{http_code}')) `
    -Name '-w 格式参数以「字面量反斜杠 + n」编码进命令行' -Detail $script:World.LastArgumentLine
  $badArgs = @($script:World.ExternalCalls[0].Arguments | Where-Object { $_ -match "[\r\n]" })
  Assert-Equal -Expected 0 -Actual $badArgs.Count -Name 'curl 参数数组逐项不含真实 CR/LF'
  Assert-Equal -Expected 2 -Actual $script:World.ExternalCalls.Count -Name '诊断验收确实探测了两个端点'

  # P2：状态码与 body 正确分离；正文里出现相同标记文本不干扰解析。
  # 标记文本放在**合法 JSON 的字符串字段**里，正文仍是有效 JSON，health 契约可满足，
  # 同时证明内联标记不干扰末尾状态提取。
  # （旧夹具把 `前缀 __WEFLOW_STATUS__500 ` 直接拼在 JSON 前面，正文必然不是合法 JSON，
  #   与「验收通过」断言自相矛盾——失败的是夹具，不是判定规则。）
  New-World
  $script:World.CommandPaths['curl.exe'] = 'C:\fake\curl.exe'
  $trickyBody = '{"ok":true,"data":{"service":"weflow-central","protocolVersion":1},"echo":"__WEFLOW_STATUS__500"}'
  Add-ExternalResult -ExitCode 0 -StdOut ($trickyBody + "`n__WEFLOW_STATUS__200")
  Add-ExternalResult -ExitCode 0 -StdOut ($readyBody + "`n__WEFLOW_STATUS__200")
  $acceptance = Invoke-WeFlowEndpointAcceptance -Config $config -CaCertPath $certPath
  $healthItem = @($acceptance.Items | Where-Object { $_.Path -eq '/health' })[0]
  Assert-Equal -Expected 200 -Actual ([int]$healthItem.Probe.HttpStatus) -Name '状态码只从 stdout 末尾提取（正文中的相同标记不干扰）'
  Assert-True -Condition (([string]$healthItem.Probe.Body) -ceq $trickyBody) -Name '正文逐字符完整保留（内联标记与 JSON 结构均未被破坏）'
  Assert-True -Condition (([string]$healthItem.Probe.Body).Contains('__WEFLOW_STATUS__500')) -Name '正文里的标记文本保留在 body 中（不误删、不误判状态）'
  Assert-Equal -Expected 0 -Actual ([int]$acceptance.ExitCode) -Name '正文含标记时端点验收仍按末尾状态码判定通过'

  # P2b（负例）：正文不是合法 JSON 时必须返回契约失败 7 —— 判定规则没有被放宽。
  New-World
  $script:World.CommandPaths['curl.exe'] = 'C:\fake\curl.exe'
  Add-ExternalResult -ExitCode 0 -StdOut ('not-a-json-body' + "`n__WEFLOW_STATUS__200")
  Add-ExternalResult -ExitCode 0 -StdOut ($readyBody + "`n__WEFLOW_STATUS__200")
  $badAcceptance = Invoke-WeFlowEndpointAcceptance -Config $config -CaCertPath $certPath
  $badHealthItem = @($badAcceptance.Items | Where-Object { $_.Path -eq '/health' })[0]
  Assert-Equal -Expected 7 -Actual ([int]$badHealthItem.ExitCode) -Name '负例：非 JSON 正文 → /health 契约失败退出码 7'
  Assert-Equal -Expected 7 -Actual ([int]$badAcceptance.ExitCode) -Name '负例：非 JSON 正文时端点验收整体非零（退出码 7）'

  # P3：真正非法的 CR/LF 仍被参数构造拒绝（规则未被绕过或放宽）
  Assert-Throws -Name '真实 CR/LF 参数仍被真实参数构造拒绝' `
    -Action { Invoke-WeFlowExternalCommand -FilePath 'C:\fake\curl.exe' -Arguments @('--silent', "bad`nvalue") } `
    -MessagePattern 'CR/LF'
  Assert-Throws -Name '真实 CR 参数同样被拒绝' `
    -Action { ConvertTo-WeFlowWindowsArgumentLine -Arguments @("a`rb") } `
    -MessagePattern 'CR/LF'

  # P5：编码契约的调用方边界——只给有明确 UTF-8 契约的后端指定，其余保持既有行为。
  # curl 因 Schannel 无法判定吊销状态而不适用时会回落到 python 后端，正是真实切换走过的路径。
  New-World
  $script:World.CommandPaths['curl.exe'] = 'C:\fake\curl.exe'
  $script:World.CommandPaths['python.exe'] = 'C:\fake\python.exe'
  Add-ExternalResult -ExitCode 60 -StdErr 'schannel: CertGetCertificateChain trust error CERT_TRUST_REVOCATION_STATUS_UNKNOWN'
  Add-ExternalResult -ExitCode 0 -StdOut '{"status":200,"body":"{}","category":"transport-ok","message":"HTTP 200"}'
  $probeP5 = Invoke-WeFlowEndpointProbe -Config $config -CaCertPath $certPath -Path '/health'
  Assert-Equal -Expected 'python' -Actual ([string]$probeP5.Backend) -Name 'P5 curl 吊销状态不适用 → 回落到 python 后端'
  $pyCalls = @($script:World.ExternalCalls | Where-Object { $_.FilePath -like '*python*' })
  $pyCall = if ($pyCalls.Count -gt 0) { $pyCalls[$pyCalls.Count - 1] } else { $null }
  Assert-True -Condition ($null -ne $pyCall -and $null -ne $pyCall.OutputEncoding -and $pyCall.OutputEncoding.CodePage -eq 65001) `
    -Name 'P5 python 后端调用显式指定 UTF-8 解码（CodePage 65001）'
  $curlCalls = @($script:World.ExternalCalls | Where-Object { $_.FilePath -like '*curl*' })
  $curlCall = if ($curlCalls.Count -gt 0) { $curlCalls[$curlCalls.Count - 1] } else { $null }
  Assert-True -Condition ($null -ne $curlCall -and $null -eq $curlCall.OutputEncoding) `
    -Name 'P5 curl 调用不指定编码（未把外部程序无差别统一成 UTF-8）'

  # P4（变异负例）：把 -w 格式参数改回真实 LF（转录自 ee2ee77 之前的实现），
  # 走真实探测调用 → 必须在真实参数构造处失败；否则 P1 的「构造通过」就是假覆盖。
  Install-WeFlowMock -Name 'Invoke-WeFlowEndpointProbe' -Body {
    param([Parameter(Mandatory)][hashtable]$Config, [Parameter(Mandatory)][string]$CaCertPath, [Parameter(Mandatory)][string]$Path, [int]$TimeoutSec = 15)
    # 变异体：与 ee2ee77 之前完全相同的参数构造（含真实换行的 -w）
    $legacyArguments = @(
      '--silent', '--show-error', '--max-time', [string]$TimeoutSec,
      '--cacert', $CaCertPath,
      '--resolve', ("{0}:443:{1}" -f $Config.Hostname, $Config.BindIp),
      '-o', '-', '-w', "`n__WEFLOW_STATUS__%{http_code}",
      ("https://{0}{1}" -f $Config.Hostname, $Path)
    )
    return Invoke-WeFlowExternalCommand -FilePath 'C:\fake\curl.exe' -Arguments $legacyArguments
  }
  Assert-Throws -Name '变异：-w 格式参数改回真实 LF → 真实参数构造拒绝（对应「构造通过」断言必然失败）' `
    -Action { Invoke-WeFlowEndpointProbe -Config $config -CaCertPath $certPath -Path '/health' } `
    -MessagePattern 'CR/LF'

  # 恢复标准叶子实现（本组的构造器友好 mock 一并还原）
  Restore-WeFlowMocks
  Install-SystemLeafMocks
}

function Test-WindowsArgumentEchoChild {
  <#
  .SYNOPSIS
    Windows 专属：用一个无害的参数回显子进程，逐值验证真实命令行参数传递。
  .DESCRIPTION
    纯函数测试只能证明「我们以为拼出的命令行是对的」；只有真的 CreateProcess 一次，
    才能证明含空格 / 引号 / 反斜杠的参数**逐值**到达子进程。

    被测路径是生产代码本身：Start-WeFlowCaddyProcess 构造命令行并启动进程。
    子进程是无害的 powershell.exe（只把收到的参数回显出来，不做任何变更）：
    不启动 Caddy、不启动 Docker、不监听端口。
    本用例必须在 mock 之外运行（打开测试模式时危险调用会被拦截）。

    子进程输出用 base64 包装后再落到 stdout 文件，避免 Windows 代码页把中文参数弄花。
  #>
  Start-Case 'O. 真实参数回显子进程（Windows 专属；不经 mock）'
  if ($env:OS -ne 'Windows_NT') {
    Add-SkipResult -Name 'Windows 参数回显子进程测试' -Reason ('当前平台 {0} 无法验证 CreateProcess 参数传递' -f $env:OS)
    return
  }
  $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  if (-not (Test-Path -LiteralPath $powershell)) {
    Add-SkipResult -Name 'Windows 参数回显子进程测试' -Reason '找不到 Windows PowerShell 5.1'
    return
  }

  $workDir = Join-Path $script:SandboxRootPath 'arg-echo'
  New-Item -ItemType Directory -Force -Path $workDir | Out-Null
  $childPath = Join-Path $workDir 'echo-child.ps1'
  $childSource = @'
$values = @($args | ForEach-Object { [string]$_ })
$json = ([pscustomobject]@{ Count = $values.Count; Values = $values } | ConvertTo-Json -Compress -Depth 4)
$bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
[Console]::Out.Write([System.Convert]::ToBase64String($bytes))
'@
  [System.IO.File]::WriteAllText($childPath, $childSource, (New-Object System.Text.UTF8Encoding($false)))

  $cases = @(
    @{ Name = '含空格路径的配置参数'; Values = @('--config', 'F:\WeFlow-Test\start with space\config\Caddyfile', '--adapter', 'caddyfile') },
    @{ Name = '内嵌引号与结尾反斜杠'; Values = @('say "hi"', 'back\slash\tail\', 'mixed "quote" and space') },
    @{ Name = '中文与非 ASCII 参数'; Values = @('中文路径\配置.caddyfile', 'plain', ("tab`tseparated")) }
  )

  foreach ($case in $cases) {
    $stdout = Join-Path $workDir 'child.out.txt'
    $stderr = Join-Path $workDir 'child.err.txt'
    Remove-WeFlowFilePath -Path $stdout
    Remove-WeFlowFilePath -Path $stderr
    $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $childPath) + $case.Values
    $started = Start-WeFlowCaddyProcess -ExePath $powershell -Arguments $arguments -StdOutPath $stdout -StdErrPath $stderr
    $deadline = (Get-Date).AddSeconds(30)
    while ($null -ne (Get-WeFlowProcessById -Id $started.Id) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 200 }
    $raw = ''
    if (Test-Path -LiteralPath $stdout) { $raw = (Read-WeFlowTextFile -Path $stdout).Trim() }
    $payload = $null
    try {
      $payload = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($raw)) | ConvertFrom-Json
    } catch {
      $payload = $null
    }
    if ($null -eq $payload) {
      $errText = ''
      if (Test-Path -LiteralPath $stderr) { $errText = (Read-WeFlowTextFile -Path $stderr).Trim() }
      Assert-True -Condition $false -Name ("回显子进程返回可解析参数：" + $case.Name) -Detail ("stdout='{0}' stderr='{1}'" -f $raw, $errText)
      continue
    }
    Assert-Equal -Expected $case.Values.Count -Actual ([int]$payload.Count) -Name ("参数个数逐值一致：" + $case.Name)
    for ($index = 0; $index -lt $case.Values.Count; $index++) {
      $actual = if ($index -lt @($payload.Values).Count) { [string]@($payload.Values)[$index] } else { '<缺失>' }
      Assert-Equal -Expected $case.Values[$index] -Actual $actual -Name ("参数 #{0} 逐值一致：{1}" -f ($index + 1), $case.Name)
    }
    Assert-True -Condition ($started.ArgumentLine -match '"') -Name ("实际命令行对含空白参数加了引号：" + $case.Name) -Detail $started.ArgumentLine
  }

  # 不支持的输入必须在启动之前就被拒绝（不能先启动再发现参数坏了）
  Assert-Throws -Name '含 CR/LF 的参数在启动前被拒绝' `
    -Action { Start-WeFlowCaddyProcess -ExePath $powershell -Arguments @('run', "bad`nvalue") -StdOutPath (Join-Path $workDir 'x.out') -StdErrPath (Join-Path $workDir 'x.err') } `
    -MessagePattern 'CR/LF'

  # 真实外部命令包装层端到端（Invoke-WeFlowExternalCommand，不经任何 mock）：
  # 以无害回显子进程核对「curl -w 的字面量 \n 格式参数」等真实参数逐值到达。
  # launcherArgs 与 payloadArgs 必须分开：powershell.exe 会消耗自身开关
  # （-NoProfile -ExecutionPolicy Bypass -File <child>），子脚本 $args 只收到载荷部分，
  # 因此逐值断言只与 payloadArgs 比较（旧用例拿整条数组比对，必然整体偏移 5 项）。
  $launcherArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $childPath)
  $payloadArgs = @('-w', '\n__WEFLOW_STATUS__%{http_code}', '--config', 'F:\WeFlow-Test\path with space\Caddyfile')
  $wrapperArgs = $launcherArgs + $payloadArgs
  $wrapperStdout = Join-Path $workDir 'wrapper.out.txt'
  $wrapperStderr = Join-Path $workDir 'wrapper.err.txt'
  Remove-WeFlowFilePath -Path $wrapperStdout
  Remove-WeFlowFilePath -Path $wrapperStderr
  $wrapperResult = Invoke-WeFlowExternalCommand -FilePath $powershell -Arguments $wrapperArgs
  $wrapperPayload = $null
  try {
    $wrapperPayload = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($wrapperResult.StdOut.Trim())) | ConvertFrom-Json
  } catch { $wrapperPayload = $null }
  if ($null -eq $wrapperPayload) {
    Assert-True -Condition $false -Name '真实外部命令包装层回显子进程返回可解析参数' `
      -Detail ("stdout='{0}' stderr='{1}'" -f $wrapperResult.StdOut.Trim(), $wrapperResult.StdErr.Trim())
  } else {
    Assert-Equal -Expected $payloadArgs.Count -Actual ([int]$wrapperPayload.Count) -Name '真实包装层：子脚本实收参数个数与载荷一致'
    for ($index = 0; $index -lt $payloadArgs.Count; $index++) {
      $actual = if ($index -lt @($wrapperPayload.Values).Count) { [string]@($wrapperPayload.Values)[$index] } else { '<缺失>' }
      Assert-Equal -Expected $payloadArgs[$index] -Actual $actual -Name ("真实包装层：载荷 #{0} 逐值一致" -f ($index + 1))
    }
  }
}

function Test-SubprocessEncodingRoundTrip {
  <#
  .SYNOPSIS
    Q. 真实子进程编码往返（UTF-8 契约；不经 mock）。
  .DESCRIPTION
    c95e4a3 在 Windows 真实切换时暴露的第三处缺陷：Invoke-WeFlowExternalCommand 未指定
    StandardOutputEncoding，PowerShell 5.1 因而按控制台代码页（中文环境为 CP936）解码子进程
    stdout。Python 探测后端输出 UTF-8 JSON，解码错乱后一个尾随的双字节序列会连同字符串的
    闭合引号一起被吞掉，ConvertFrom-Json 必然失败——端点探测被误判为「无有效输出」，
    进而触发回退。旧隔离测试完全看不出来：子进程输出全是 ASCII，编码环节未被覆盖。

    本组用**真实子进程**验证两侧编码契约一致（不 mock 掉编码读取环节）：
      Q1 子进程直写 UTF-8 字节，包装层显式按 UTF-8 解码 → JSON 可解析且中文 / 引号 /
         反斜杠 / 全角标点逐值一致；
      Q2 变异负例：同一字节流改用显式 CP936 解码 → 必须无法原样还原，证明用例能抓住退化；
      Q3 不指定编码时旧调用路径仍正常返回（保持旧调用兼容，未强制统一 UTF-8）；
      Q4 实际 Python 探测后端（WeFlowNative.HttpsProbe.py 真实子进程）→ 输出可解析为 JSON，
         且 message 字段含非 ASCII（其消息前缀恒为中文，故与操作系统语言无关）。
    本组必须在 mock 之外运行，且不依赖任何真实服务（Q4 对着未监听的本机端口探测）。
  #>
  Start-Case 'Q. 真实子进程编码往返（UTF-8 契约；不经 mock）'
  if ($env:OS -ne 'Windows_NT') {
    Add-SkipResult -Name '真实子进程编码往返测试' -Reason ('当前平台 {0} 无法验证 Windows 控制台代码页解码路径' -f $env:OS)
    return
  }
  $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  if (-not (Test-Path -LiteralPath $powershell)) {
    Add-SkipResult -Name '真实子进程编码往返测试' -Reason '找不到 Windows PowerShell 5.1'
    return
  }

  $utf8 = New-Object System.Text.UTF8Encoding($false)
  $workDir = Join-Path $script:SandboxRootPath 'encoding'
  New-Item -ItemType Directory -Force -Path $workDir | Out-Null
  Write-Host ("    系统默认代码页 : {0}" -f ([int][System.Text.Encoding]::Default.CodePage)) -ForegroundColor DarkGray

  # 子进程脚本含中文，必须以 UTF-8 **with BOM** 落盘：否则 PowerShell 5.1 会按代码页
  # 读取子脚本自身源码，子进程侧就先损坏了，测不到包装层的解码行为。
  $childPath = Join-Path $workDir 'emit-utf8-json.ps1'
  $childSource = @'
$obj = [ordered]@{ name = '中文测试'; quote = 'say "hi"'; path = 'F:\WeFlow-Test\路径\caddy.exe'; note = '括号（）与逗号，' }
$json = ($obj | ConvertTo-Json -Compress)
$bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
$out = [Console]::OpenStandardOutput()
$out.Write($bytes, 0, $bytes.Length)
$out.Flush()
'@
  [System.IO.File]::WriteAllText($childPath, $childSource, (New-Object System.Text.UTF8Encoding($true)))
  $childArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $childPath)

  # Q1：真实子进程 + 真实包装层 + 显式 UTF-8 解码 → 可解析且逐值一致
  $good = Invoke-WeFlowExternalCommand -FilePath $powershell -Arguments $childArgs -OutputEncoding $utf8
  $goodPayload = $null
  try { $goodPayload = $good.StdOut | ConvertFrom-Json } catch { $goodPayload = $null }
  Assert-True -Condition ($null -ne $goodPayload) -Name 'Q1 非 ASCII JSON 经真实包装层 + UTF-8 解码可解析' `
    -Detail ("stdout='{0}'" -f $good.StdOut.Trim())
  if ($null -ne $goodPayload) {
    Assert-Equal -Expected '中文测试' -Actual ([string]$goodPayload.name) -Name 'Q1 中文字段逐值一致'
    Assert-Equal -Expected 'say "hi"' -Actual ([string]$goodPayload.quote) -Name 'Q1 内嵌双引号逐值一致'
    Assert-Equal -Expected 'F:\WeFlow-Test\路径\caddy.exe' -Actual ([string]$goodPayload.path) -Name 'Q1 中文路径与反斜杠逐值一致'
    Assert-Equal -Expected '括号（）与逗号，' -Actual ([string]$goodPayload.note) -Name 'Q1 全角标点逐值一致'
  }

  # Q2：变异负例——同一字节流改用显式 CP936 解码，必须无法原样还原
  $cp936 = $null
  try { $cp936 = [System.Text.Encoding]::GetEncoding(936) } catch { $cp936 = $null }
  if ($null -eq $cp936) {
    Add-SkipResult -Name 'Q2 错误解码变异负例' -Reason '本机未提供 CP936 代码页，无法构造错误解码对照'
  } else {
    $bad = Invoke-WeFlowExternalCommand -FilePath $powershell -Arguments $childArgs -OutputEncoding $cp936
    $badPayload = $null
    try { $badPayload = $bad.StdOut | ConvertFrom-Json } catch { $badPayload = $null }
    $roundTrips = ($null -ne $badPayload) -and ([string]$badPayload.name -ceq '中文测试')
    Assert-True -Condition (-not $roundTrips) `
      -Name 'Q2 变异：改用 CP936 解码同一字节流 → 无法原样还原（退化必被抓住）' `
      -Detail ("parsed={0}" -f ($null -ne $badPayload))
  }

  # Q3：不指定编码（既有调用方的默认路径）必须仍然可用——旧调用未被强制改成 UTF-8
  $legacy = Invoke-WeFlowExternalCommand -FilePath $powershell -Arguments $childArgs
  Assert-Equal -Expected 0 -Actual ([int]$legacy.ExitCode) -Name 'Q3 不指定编码时旧调用路径仍正常返回退出码'

  # Q4：实际 Python 探测后端（真实子进程）
  $python = $null
  foreach ($candidate in @('python.exe', 'python3.exe', 'python', 'python3')) {
    $found = Get-Command -Name $candidate -ErrorAction SilentlyContinue
    if ($found) { $python = $found.Source; break }
  }
  $openssl = Get-Command -Name 'openssl' -ErrorAction SilentlyContinue
  if (-not $python) {
    Add-SkipResult -Name 'Q4 实际 Python 探测后端编码往返' -Reason '本机找不到 python 解释器'
  } elseif (-not $openssl) {
    Add-SkipResult -Name 'Q4 实际 Python 探测后端编码往返' -Reason '本机找不到 openssl，无法生成一次性测试证书供探测脚本加载'
  } else {
    $certPath = Join-Path $workDir 'probe-ca.crt'
    $keyPath = Join-Path $workDir 'probe-ca.key'
    $gen = Invoke-WeFlowExternalCommand -FilePath $openssl.Source `
      -Arguments @('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', $keyPath, '-out', $certPath,
        '-days', '2', '-subj', '/CN=weflow-probe-encoding-test')
    if ($gen.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $certPath)) {
      Add-SkipResult -Name 'Q4 实际 Python 探测后端编码往返' -Reason ("openssl 生成一次性证书失败（退出码 {0}）" -f $gen.ExitCode)
    } else {
      # 对着未监听的本机端口探测：不会碰到任何真实服务，但探测脚本仍会产出含中文的 JSON。
      $probeScript = Join-Path $script:ProdScriptsRoot 'WeFlowNative.HttpsProbe.py'
      $probeArgs = @($probeScript, '127.0.0.1', 'weflow-probe-encoding.test', '/health', $certPath, '3', '1')
      $probeResult = Invoke-WeFlowExternalCommand -FilePath $python -Arguments $probeArgs -OutputEncoding $utf8
      $probePayload = $null
      try { $probePayload = $probeResult.StdOut | ConvertFrom-Json } catch { $probePayload = $null }
      Assert-True -Condition ($null -ne $probePayload) `
        -Name 'Q4 实际 Python 探测后端输出经 UTF-8 解码可解析为 JSON' `
        -Detail ("stdout='{0}' stderr='{1}'" -f $probeResult.StdOut.Trim(), $probeResult.StdErr.Trim())
      if ($null -ne $probePayload) {
        Assert-True -Condition (([string]$probePayload.category).Length -gt 0) -Name 'Q4 探测结果含 category 字段'
        $nonAscii = @(([string]$probePayload.message).ToCharArray() | Where-Object { [int]$_ -gt 127 })
        Assert-True -Condition ($nonAscii.Count -gt 0) `
          -Name 'Q4 message 含非 ASCII（真实覆盖 CP936 控制台下的解码路径）' `
          -Detail ("message='{0}'" -f ([string]$probePayload.message))
      }
    }
  }
}

function Test-ContractGuard {
  Start-Case 'F. 契约守卫（正例子进程真实运行 + 沙箱变异）'
  # 正例要在「干净工作树」上跑：先清掉前面用例遗留的沙箱夹具（其中含 .crt 等测试文件）。
  if (Test-Path -LiteralPath $script:SandboxRootPath) { Remove-Item -LiteralPath $script:SandboxRootPath -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $script:SandboxRootPath | Out-Null
  $guard = Join-Path $script:ProdScriptsRoot 'Test-DeploymentContract.ps1'

  # 正例：对真实工作树运行（子进程、无 mock、只读）——这是最强的「正例真实通过」证据。
  $result = Invoke-GuardChildProcess -GuardPath $guard -PackageRoot $script:WorkRoot -EnvPath (Join-Path $script:WorkRoot 'native.env')
  Assert-Equal -Expected 0 -Actual $result -Name '正例：真实工作树通过全部断言（子进程，退出码 0）'

  # 变异与负例：在沙箱夹具上进行（仍调用同一份守卫逻辑，只是叶子被 mock 到沙箱）
  $fixtureRoot = Join-Path $script:SandboxRootPath 'guard-fixture'
  $envPath = New-FixturePackage -Root $fixtureRoot
  $scriptsDir = Join-Path $fixtureRoot 'central\windows-caddy\scripts'
  New-Item -ItemType Directory -Force -Path $scriptsDir | Out-Null
  foreach ($file in @('WeFlowNative.Common.ps1', 'Start-NativeCaddy.ps1', 'Stop-NativeCaddy.ps1', 'Install-NativeCaddy.ps1', 'Test-NativeCaddyEndpoint.ps1', 'Test-DeploymentContract.ps1', 'WeFlowNative.HttpsProbe.py')) {
    Copy-Item -LiteralPath (Join-Path $script:ProdScriptsRoot $file) -Destination (Join-Path $scriptsDir $file) -Force
  }
  [System.IO.File]::WriteAllText((Join-Path $fixtureRoot 'caddy_2.11.4_windows_amd64.zip'), 'stub', (New-Object System.Text.UTF8Encoding($false)))
  $templatePath = Join-Path $fixtureRoot 'central\windows-caddy\Caddyfile.template'

  $baseline = Invoke-WeFlowDeploymentContract -PackageRoot $fixtureRoot -NativeEnvPath $envPath -ScriptsRoot $scriptsDir -TemplatePath $templatePath -SkipRuntime $true
  Assert-Equal -Expected 0 -Actual $baseline -Name '夹具基线（未变异）通过全部断言'

  # 变异 1：注入真实执行的 compose down
  $mutated = Join-Path $script:SandboxRootPath 'guard-mutation-down'
  Copy-Item -LiteralPath $fixtureRoot -Destination $mutated -Recurse -Force
  $startPath = Join-Path $mutated 'central\windows-caddy\scripts\Start-NativeCaddy.ps1'
  Add-Content -LiteralPath $startPath -Value ("# mutated" + [Environment]::NewLine + "function Invoke-BadThing { docker compose -p weflow-test down }") -Encoding UTF8
  $code = Invoke-WeFlowDeploymentContract -PackageRoot $mutated -NativeEnvPath (Join-Path $mutated 'native.env') -ScriptsRoot (Join-Path $mutated 'central\windows-caddy\scripts') -TemplatePath (Join-Path $mutated 'central\windows-caddy\Caddyfile.template') -SkipRuntime $true
  Assert-True -Condition ($code -ne 0) -Name '变异：真实执行的 compose down 被拦下' -Detail ("exit=$code")

  # 变异 2：仅注释里出现 compose down —— 不得误报
  $commentOnly = Join-Path $script:SandboxRootPath 'guard-comment-only'
  Copy-Item -LiteralPath $fixtureRoot -Destination $commentOnly -Recurse -Force
  $startPath2 = Join-Path $commentOnly 'central\windows-caddy\scripts\Start-NativeCaddy.ps1'
  Add-Content -LiteralPath $startPath2 -Value ("# 说明：本脚本绝不执行 docker compose down，也不执行 docker compose down -v") -Encoding UTF8
  $code = Invoke-WeFlowDeploymentContract -PackageRoot $commentOnly -NativeEnvPath (Join-Path $commentOnly 'native.env') -ScriptsRoot (Join-Path $commentOnly 'central\windows-caddy\scripts') -TemplatePath (Join-Path $commentOnly 'central\windows-caddy\Caddyfile.template') -SkipRuntime $true
  Assert-Equal -Expected 0 -Actual $code -Name '注释中的 compose down 不触发误报'

  # 变异 3：反引号续行的危险调用必须被识别
  $multi = Join-Path $script:SandboxRootPath 'guard-multiline'
  Copy-Item -LiteralPath $fixtureRoot -Destination $multi -Recurse -Force
  $startPath3 = Join-Path $multi 'central\windows-caddy\scripts\Start-NativeCaddy.ps1'
  $lines = @('', '# mutated multiline', 'function Invoke-MultiLine {', '  docker compose -p weflow-test `', '    --env-file central/proxy.env `', '    -f docker-compose.central.yml -f docker-compose.central.tls.yml `', '    rm -f caddy', '}')
  Add-Content -LiteralPath $startPath3 -Value $lines -Encoding UTF8
  $code = Invoke-WeFlowDeploymentContract -PackageRoot $multi -NativeEnvPath (Join-Path $multi 'native.env') -ScriptsRoot (Join-Path $multi 'central\windows-caddy\scripts') -TemplatePath (Join-Path $multi 'central\windows-caddy\Caddyfile.template') -SkipRuntime $true
  Assert-True -Condition ($code -ne 0) -Name '变异：续行写法的 compose rm 被识别' -Detail ("exit=$code")

  # 变异 4：包装层项目名被改
  $badProject = Join-Path $script:SandboxRootPath 'guard-bad-project'
  Copy-Item -LiteralPath $fixtureRoot -Destination $badProject -Recurse -Force
  $commonPath = Join-Path $badProject 'central\windows-caddy\scripts\WeFlowNative.Common.ps1'
  $commonText = Get-Content -LiteralPath $commonPath -Raw
  $commonText = $commonText.Replace("'-p', 'weflow-test'", "'-p', 'other-project'")
  [System.IO.File]::WriteAllText($commonPath, $commonText, (New-Object System.Text.UTF8Encoding($false)))
  $code = Invoke-WeFlowDeploymentContract -PackageRoot $badProject -NativeEnvPath (Join-Path $badProject 'native.env') -ScriptsRoot (Join-Path $badProject 'central\windows-caddy\scripts') -TemplatePath (Join-Path $badProject 'central\windows-caddy\Caddyfile.template') -SkipRuntime $true
  Assert-True -Condition ($code -ne 0) -Name '变异：项目名不是 weflow-test 被拦下' -Detail ("exit=$code")

  # ---- 四条内容敏感不变量的针对性变异负例（对应守卫「本轮修复的不变量」） ----
  # 6bed1ca 版的教训：这四条断言在去字符串视图上匹配含字符串内容的模式，恒不命中（守卫假阴性）。
  # 修复后它们改用「保留字符串」视图并锚定真实代码形状；下面每条变异证明：
  # 目标行为删除或退化后，守卫退出码非零，且失败项正是对应断言（-contains 精确匹配）。

  # 变异 5：验收默认端点退化（去掉 /ready）
  $noReady = Join-Path $script:SandboxRootPath 'guard-no-ready'
  Copy-Item -LiteralPath $fixtureRoot -Destination $noReady -Recurse -Force
  $commonNoReady = Join-Path $noReady 'central\windows-caddy\scripts\WeFlowNative.Common.ps1'
  $noReadyText = Get-Content -LiteralPath $commonNoReady -Raw
  $pathsNeedle = "[string[]]" + '$Paths' + " = @('/health', '/ready')"
  if (-not $noReadyText.Contains($pathsNeedle)) { throw ('守卫变异夹具漂移：未找到 Paths 默认值原文：' + $pathsNeedle) }
  [System.IO.File]::WriteAllText($commonNoReady, $noReadyText.Replace($pathsNeedle, "[string[]]" + '$Paths' + " = @('/health')"), (New-Object System.Text.UTF8Encoding($false)))
  $code = Invoke-WeFlowDeploymentContract -PackageRoot $noReady -NativeEnvPath (Join-Path $noReady 'native.env') -ScriptsRoot (Join-Path $noReady 'central\windows-caddy\scripts') -TemplatePath (Join-Path $noReady 'central\windows-caddy\Caddyfile.template') -SkipRuntime $true
  Assert-True -Condition ($code -ne 0) -Name '变异：验收默认端点退化（去掉 /ready）被拦下' -Detail ("exit=$code")
  Assert-True -Condition ($script:FailMessages -contains '验收默认覆盖 /health 与 /ready 两个端点') -Name '变异定向：失败项正是「验收默认覆盖 /health 与 /ready」'

  # 变异 6：403 不再映射为非零退出码（gate-403 分支改为 return 0）
  $gateZero = Join-Path $script:SandboxRootPath 'guard-gate-zero'
  Copy-Item -LiteralPath $fixtureRoot -Destination $gateZero -Recurse -Force
  $commonGate = Join-Path $gateZero 'central\windows-caddy\scripts\WeFlowNative.Common.ps1'
  $gateText = Get-Content -LiteralPath $commonGate -Raw
  if (-not ($gateText -match "'gate-403'\s*\{\s*return\s+8\s*\}")) { throw '守卫变异夹具漂移：未找到 gate-403 分支原文' }
  $gateZeroText = [regex]::Replace($gateText, "'gate-403'\s*\{\s*return\s+8\s*\}", "'gate-403' { return 0 }")
  [System.IO.File]::WriteAllText($commonGate, $gateZeroText, (New-Object System.Text.UTF8Encoding($false)))
  $code = Invoke-WeFlowDeploymentContract -PackageRoot $gateZero -NativeEnvPath (Join-Path $gateZero 'native.env') -ScriptsRoot (Join-Path $gateZero 'central\windows-caddy\scripts') -TemplatePath (Join-Path $gateZero 'central\windows-caddy\Caddyfile.template') -SkipRuntime $true
  Assert-True -Condition ($code -ne 0) -Name '变异：403 门禁映射退化为 0 被拦下' -Detail ("exit=$code")
  Assert-True -Condition ($script:FailMessages -contains '403 来源门禁映射为非零退出码') -Name '变异定向：失败项正是「403 来源门禁映射为非零退出码」'

  # 变异 7：超时分支谎报「停止成功」（确认退出退化）
  $fakeStop = Join-Path $script:SandboxRootPath 'guard-fake-stop'
  Copy-Item -LiteralPath $fixtureRoot -Destination $fakeStop -Recurse -Force
  $commonFakeStop = Join-Path $fakeStop 'central\windows-caddy\scripts\WeFlowNative.Common.ps1'
  $stopText = Get-Content -LiteralPath $commonFakeStop -Raw
  $stopNeedle = "Ok = " + '$false' + "; Status = " + "'still-running'"
  if (-not $stopText.Contains($stopNeedle)) { throw '守卫变异夹具漂移：未找到 still-running 失败分支原文' }
  [System.IO.File]::WriteAllText($commonFakeStop, $stopText.Replace($stopNeedle, "Ok = " + '$true' + "; Status = " + "'still-running'"), (New-Object System.Text.UTF8Encoding($false)))
  $code = Invoke-WeFlowDeploymentContract -PackageRoot $fakeStop -NativeEnvPath (Join-Path $fakeStop 'native.env') -ScriptsRoot (Join-Path $fakeStop 'central\windows-caddy\scripts') -TemplatePath (Join-Path $fakeStop 'central\windows-caddy\Caddyfile.template') -SkipRuntime $true
  Assert-True -Condition ($code -ne 0) -Name '变异：超时分支谎报停止成功被拦下' -Detail ("exit=$code")
  Assert-True -Condition ($script:FailMessages -contains '结束进程后确认其确实消失（still-running 判定）') -Name '变异定向：失败项正是「结束进程后确认其确实消失」'

  # 变异 8：回退诊断记录的文件名漂移（路径还在、但不再是 rollback.json）
  $noRollback = Join-Path $script:SandboxRootPath 'guard-no-rollback'
  Copy-Item -LiteralPath $fixtureRoot -Destination $noRollback -Recurse -Force
  $startNoRollback = Join-Path $noRollback 'central\windows-caddy\scripts\Start-NativeCaddy.ps1'
  $startText = Get-Content -LiteralPath $startNoRollback -Raw
  if (-not $startText.Contains("'native-caddy.rollback.json'")) { throw '守卫变异夹具漂移：未找到 rollback 报告路径原文' }
  [System.IO.File]::WriteAllText($startNoRollback, $startText.Replace("'native-caddy.rollback.json'", "'native-caddy.rollback.old.json'"), (New-Object System.Text.UTF8Encoding($false)))
  $code = Invoke-WeFlowDeploymentContract -PackageRoot $noRollback -NativeEnvPath (Join-Path $noRollback 'native.env') -ScriptsRoot (Join-Path $noRollback 'central\windows-caddy\scripts') -TemplatePath (Join-Path $noRollback 'central\windows-caddy\Caddyfile.template') -SkipRuntime $true
  Assert-True -Condition ($code -ne 0) -Name '变异：回退诊断记录路径漂移被拦下' -Detail ("exit=$code")
  Assert-True -Condition ($script:FailMessages -contains '回退失败保留诊断记录（rollback.json）') -Name '变异定向：失败项正是「回退失败保留诊断记录」'
}

function Invoke-GuardChildProcess {
  param(
    [Parameter(Mandatory)][string]$GuardPath,
    [Parameter(Mandatory)][string]$PackageRoot,
    [Parameter(Mandatory)][string]$EnvPath
  )
  $arguments = @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $GuardPath,
    '-PackageRoot', $PackageRoot, '-NativeEnvPath', $EnvPath, '-SkipRuntimeChecks'
  )
  $process = Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -Wait -PassThru -WindowStyle Hidden
  return $process.ExitCode
}

function Invoke-G8BookkeepingFailureCase {
  <#
  .SYNOPSIS
    G8：记账写盘失败 → 凭内存身份回收本轮进程并恢复容器（子用例可独立执行）。
  .DESCRIPTION
    夹具要点（6bed1ca 版的缺陷是：启动前就把 443 置为占用，启动脚本在预检阶段即中止，
    记账路径从未被执行；且更早子用例残留的 current.json 让「没有落盘」断言不成立）：
      - 443 初始**无监听**，只在 mock 原生进程启动后才有监听（AutoListenerOnNativeProcess），
        启动脚本因此能通过预检、真正走到记账失败路径；
      - 沙箱记账文件在用例开始时明确重置，并断言 current.json 不存在（不依赖前一用例残留）；
      - Write-WeFlowTextFile 对 native-caddy.current.json 的写入按夹具失败（FailOn）。
    每条显式断言对应一个必须被证明的事实，全部基于 mock 世界里的结构化证据，
    不靠退出码或日志文本反推：
      1) 本轮进程确实被创建：本轮 StartArgumentLines 恰好 1 条且 PID 序列恰好前进 1；
      2) current.json 写入确实被尝试并按夹具失败：WriteAttempts 命中 + 文件未落盘；
      3) 失败后的进程确实被回收：StopProcessCalls 命中本轮 PID 且进程已消失；
      4) 原先运行的容器被恢复：最后一次 Compose 调用是 start caddy；
      5) 返回正确的失败码 3（不得声称启动成功），并留下结构化回退诊断记录。
  #>
  param(
    [Parameter(Mandatory)][string]$Root,
    [Parameter(Mandatory)][string]$EnvPath,
    [Parameter(Mandatory)][string]$Label
  )
  New-World
  # 443 初始无监听；mock 原生进程启动后 AutoListener 才让 443 出现监听。
  $script:World.AutoListenerOnNativeProcess = $true
  Add-DockerResult -ExitCode 0 -StdOut 'weflow-test-caddy-1  caddy  Up 5 minutes'
  Add-DockerResult -ExitCode 0                                     # stop caddy
  Add-DockerResult -ExitCode 0                                     # 回退时 start caddy
  New-FixtureCaddyfile -Root $Root
  New-FakeExe -Root $Root
  Remove-WeFlowTestStateFiles -Root $Root
  $currentPath = Join-Path $Root 'state\native-caddy.current.json'
  Assert-True -Condition (-not (Test-Path -LiteralPath $currentPath)) -Name ("{0}：开始时 current.json 不存在" -f $Label)
  $script:World.FailOn['Write-WeFlowTextFile'] = 'native-caddy\.current\.json'

  $nextPidBefore = [int]$script:World.NextPid
  $code = Invoke-NativeCaddyStart -PackageRoot $Root -ReleaseDir $Root -NativeEnvPath $EnvPath
  $launchedPid = $nextPidBefore

  # 5) 失败码：回退成功时 Start 的退出码是 3。
  Assert-Equal -Expected 3 -Actual $code -Name ("{0}：记账写入失败 → 回退（退出码 3）" -f $Label)
  # 1) 本轮进程确实被创建（在预检阶段就中止的话这里会是 0）
  Assert-Equal -Expected 1 -Actual $script:World.StartArgumentLines.Count -Name ("{0}：本轮原生进程确实被启动" -f $Label)
  Assert-Equal -Expected ($nextPidBefore + 1) -Actual ([int]$script:World.NextPid) -Name ("{0}：本轮恰好创建了一个新进程（PID 序列前进 1）" -f $Label)
  # 2) 写入确实被尝试并按夹具失败
  Assert-True -Condition (@($script:World.WriteAttempts | Where-Object { $_ -like '*native-caddy.current.json' }).Count -ge 1) `
    -Name ("{0}：current.json 写入确实被尝试" -f $Label)
  Assert-True -Condition (-not (Test-Path -LiteralPath $currentPath)) `
    -Name ("{0}：写入按夹具失败，current.json 未落盘（复现磁盘记账不可用的真实故障）" -f $Label)
  # 3) 失败后的进程确实被回收（凭内存身份，不是磁盘记账）
  Assert-True -Condition ($script:World.StopProcessCalls -contains $launchedPid) `
    -Name ("{0}：失败后确实按本轮 PID 结束了原生进程（PID {1}）" -f $Label, $launchedPid)
  Assert-True -Condition ($null -eq (Get-WeFlowProcessById -Id $launchedPid)) `
    -Name ("{0}：本轮进程已确认消失" -f $Label)
  # 4) 原先运行的容器被恢复
  Assert-True -Condition ($script:World.DockerCalls.Count -ge 3) -Name ("{0}：容器调用序列完整（状态读取 / stop / start）" -f $Label)
  Assert-Equal -Expected 'start' -Actual $script:World.DockerCalls[-1].ComposeArgs[0] -Name ("{0}：原先运行的容器被恢复（compose start caddy）" -f $Label)
  # 5) 结构化诊断记录已产出
  Assert-True -Condition (Test-Path -LiteralPath (Join-Path $Root 'state\native-caddy.rollback.json')) `
    -Name ("{0}：回退产出了结构化诊断记录" -f $Label)
}

function Test-StartScript {
  Start-Case 'G. Start-NativeCaddy（真实逻辑 + 全 mock）'
  $root = Join-Path $script:SandboxRootPath 'start'
  $envPath = New-FixturePackage -Root $root

  $healthBody = '{"ok":true,"data":{"service":"weflow-central","protocolVersion":1}}'

  # G1：正常路径
  New-World
  $script:World.AutoListenerOnNativeProcess = $true
  $script:World.CommandPaths['curl.exe'] = 'C:\fake\curl.exe'
  Add-ExternalResult -ExitCode 0 -StdOut ($healthBody + "`n__WEFLOW_STATUS__200")
  Add-ExternalResult -ExitCode 0 -StdOut ('{"ok":true,"data":{"database":"ready"}}' + "`n__WEFLOW_STATUS__200")
  New-FixtureCaddyfile -Root $root
  New-FakeExe -Root $root
  $script:World.Listeners[443] = @()
  Add-DockerResult -ExitCode 0 -StdOut 'NAME  IMAGE  STATUS
weflow-test-caddy-1  caddy  Up 5 minutes'
  Add-DockerResult -ExitCode 0   # stop caddy
  $script:World.PostStopListenerSequence = $true
  $code = Invoke-NativeCaddyStart -PackageRoot $root -ReleaseDir $root -NativeEnvPath $envPath
  Assert-Equal -Expected 0 -Actual $code -Name '正常路径 → 退出码 0'
  $statePath = Join-Path $root 'state\native-caddy.current.json'
  Assert-True -Condition (Test-Path -LiteralPath $statePath) -Name '已写入本轮记账'
  if (Test-Path -LiteralPath $statePath) {
    $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    Assert-True -Condition ($state.Pid -gt 0) -Name '记账含 PID'
    Assert-True -Condition ($state.ExecutablePath -like '*caddy.exe') -Name '记账含可执行路径'
    Assert-True -Condition ($null -ne $state.StartedAt) -Name '记账含启动时间'
  }
  Assert-Equal -Expected 2 -Actual $script:World.ExternalCalls.Count -Name '正常路径验收了两个端点（/health 与 /ready）'

  # G2：容器状态读取失败 → 拒绝切换（且不发生 stop）
  New-World
  Add-DockerResult -ExitCode 1 -StdErr 'Cannot connect to the Docker daemon'
  $code = Invoke-NativeCaddyStart -PackageRoot $root -ReleaseDir $root -NativeEnvPath $envPath
  Assert-Equal -Expected 1 -Actual $code -Name '容器状态读取失败 → 退出码 1'
  Assert-Equal -Expected 1 -Actual $script:World.DockerCalls.Count -Name '未发生后续 Docker 调用'

  # G3：重复启动（有效记账存在） → 拒绝且不覆盖
  New-World
  $existing = [ordered]@{ Pid = 4242; ExecutablePath = (Join-Path $root 'bin\caddy.exe'); ConfigPath = (Join-Path $root 'config\Caddyfile'); StartedAt = (Get-Date).ToString('o') }
  $stateDir = Join-Path $root 'state'
  New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $stateDir 'native-caddy.current.json'), ($existing | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))
  $script:World.Processes[4242] = @{ Path = (Join-Path $root 'bin\caddy.exe'); StartTime = [datetime]$existing.StartedAt }
  $code = Invoke-NativeCaddyStart -PackageRoot $root -ReleaseDir $root -NativeEnvPath $envPath
  Assert-Equal -Expected 1 -Actual $code -Name '重复启动被拒绝 → 退出码 1'
  Assert-Equal -Expected 0 -Actual $script:World.DockerCalls.Count -Name '重复启动未触发任何 Docker 调用'
  $existingAfter = Get-Content -LiteralPath (Join-Path $stateDir 'native-caddy.current.json') -Raw | ConvertFrom-Json
  Assert-Equal -Expected 4242 -Actual $existingAfter.Pid -Name '既有有效记账未被覆盖'

  # G4：陈旧记账（PID 不存在）→ 允许继续（子用例自播种陈旧记账，不依赖前一用例残留）
  Remove-WeFlowTestStateFiles -Root $root
  $stateDir = Join-Path $root 'state'
  New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
  $stale = [ordered]@{ Pid = 5555; ExecutablePath = (Join-Path $root 'bin\caddy.exe'); ConfigPath = (Join-Path $root 'config\Caddyfile'); StartedAt = (Get-Date).ToString('o') }
  [System.IO.File]::WriteAllText((Join-Path $stateDir 'native-caddy.current.json'), ($stale | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))
  New-World
  $script:World.AutoListenerOnNativeProcess = $true
  $script:World.CommandPaths['curl.exe'] = 'C:\fake\curl.exe'
  Add-ExternalResult -ExitCode 0 -StdOut ($healthBody + "`n__WEFLOW_STATUS__200")
  Add-ExternalResult -ExitCode 0 -StdOut ('{"ok":true,"data":{"database":"ready"}}' + "`n__WEFLOW_STATUS__200")
  Add-DockerResult -ExitCode 0 -StdOut 'weflow-test-caddy-1 Up'
  Add-DockerResult -ExitCode 0
  $code = Invoke-NativeCaddyStart -PackageRoot $root -ReleaseDir $root -NativeEnvPath $envPath
  Assert-Equal -Expected 0 -Actual $code -Name '陈旧记账可被覆盖（退出码 0）'
  $g4State = Get-Content -LiteralPath (Join-Path $stateDir 'native-caddy.current.json') -Raw | ConvertFrom-Json
  Assert-True -Condition ([int]$g4State.Pid -ne 5555) -Name '陈旧记账已被本轮新记账覆盖'

  # G5：stop 失败 → 回退 → 退出码 3
  New-World
  Remove-WeFlowTestStateFiles -Root $root
  Add-DockerResult -ExitCode 0 -StdOut 'weflow-test-caddy-1 Up'
  Add-DockerResult -ExitCode 1 -StdErr 'stop failed'
  Add-DockerResult -ExitCode 0   # rollback start
  $code = Invoke-NativeCaddyStart -PackageRoot $root -ReleaseDir $root -NativeEnvPath $envPath
  Assert-Equal -Expected 3 -Actual $code -Name 'stop 失败 → 已回退（退出码 3）'
  Assert-True -Condition ($script:World.DockerCalls[-1].ComposeArgs[0] -eq 'start') -Name '回退调用的是 compose start caddy'

  # G6：进程启动后立即退出 → 回退 → 3
  New-World
  Remove-WeFlowTestStateFiles -Root $root
  Add-DockerResult -ExitCode 0 -StdOut 'weflow-test-caddy-1 Up'
  Add-DockerResult -ExitCode 0
  Add-DockerResult -ExitCode 0
  $script:World.FailOn['Start-WeFlowCaddyProcess.ExitImmediately'] = 'yes'
  $code = Invoke-NativeCaddyStart -PackageRoot $root -ReleaseDir $root -NativeEnvPath $envPath
  Assert-Equal -Expected 3 -Actual $code -Name '进程立即退出 → 回退（退出码 3）'

  # G7：监听迟迟不出现 → 回退 → 3（含结束本轮进程）
  New-World
  Remove-WeFlowTestStateFiles -Root $root
  Add-DockerResult -ExitCode 0 -StdOut 'weflow-test-caddy-1 Up'
  Add-DockerResult -ExitCode 0
  Add-DockerResult -ExitCode 0
  $script:World.Listeners[443] = @()
  $savedWait = $script:WeFlowListenerWaitSeconds
  $script:WeFlowListenerWaitSeconds = 2
  $code = Invoke-NativeCaddyStart -PackageRoot $root -ReleaseDir $root -NativeEnvPath $envPath
  $script:WeFlowListenerWaitSeconds = $savedWait
  Assert-Equal -Expected 3 -Actual $code -Name '无监听证据 → 回退（退出码 3）'
  Assert-True -Condition ($script:World.StopProcessCalls.Count -ge 1) -Name '回退时结束了本轮原生进程'

  # G8：记账写入失败 → 回退（且必须凭内存身份回收本轮进程）。
  # 顺序变化检查：第一遍跟在 G1~G7 之后跑（沙箱里留着更早用例的记账文件，
  # 用例自己重置并断言起点干净）；第二遍在全新独立根上跑（等价于单独执行）。
  # 两遍都必须全绿，证明该用例不依赖任何前一用例的磁盘状态。
  Invoke-G8BookkeepingFailureCase -Root $root -EnvPath $envPath -Label 'G8（随组执行）'
  $g8Root = Join-Path $script:SandboxRootPath 'start-g8-standalone'
  $envPathG8 = New-FixturePackage -Root $g8Root
  Invoke-G8BookkeepingFailureCase -Root $g8Root -EnvPath $envPathG8 -Label 'G8（独立根）'

  # G9：回退也失败 → 4 且保留状态
  New-World
  Remove-WeFlowTestStateFiles -Root $root
  Add-DockerResult -ExitCode 0 -StdOut 'weflow-test-caddy-1 Up'
  Add-DockerResult -ExitCode 0
  Add-DockerResult -ExitCode 1 -StdErr 'start failed'
  $script:World.Listeners[443] = @()
  $savedWait2 = $script:WeFlowListenerWaitSeconds
  $script:WeFlowListenerWaitSeconds = 2
  $code = Invoke-NativeCaddyStart -PackageRoot $root -ReleaseDir $root -NativeEnvPath $envPath
  $script:WeFlowListenerWaitSeconds = $savedWait2
  Assert-Equal -Expected 4 -Actual $code -Name '回退失败 → 退出码 4'
  Assert-True -Condition (Test-Path -LiteralPath (Join-Path $root 'state\native-caddy.current.json')) -Name '回退失败时保留状态文件'
  Assert-True -Condition ($script:World.StopProcessCalls.Count -ge 1) -Name '回退失败时本轮进程确实被回收（容器失败不跳过进程回收）'
  Assert-True -Condition ($script:World.DockerCalls[-1].ComposeArgs[0] -eq 'start') -Name '容器恢复确实被尝试（失败也保留尝试证据）'
  Assert-True -Condition (Test-Path -LiteralPath (Join-Path $root 'state\native-caddy.rollback.json')) -Name '回退失败仍产出结构化诊断记录'

  # G10：绑定地址不属于本机 → 1
  New-World
  $script:World.LocalIPv4 = @([pscustomobject]@{ IPAddress = '10.0.0.5'; InterfaceAlias = 'Ethernet'; PrefixOrigin = 'Static' })
  $code = Invoke-NativeCaddyStart -PackageRoot $root -ReleaseDir $root -NativeEnvPath $envPath
  Assert-Equal -Expected 1 -Actual $code -Name '绑定地址不属于本机 → 退出码 1'

  # G11：含空格路径
  $spaceRoot = Join-Path $script:SandboxRootPath 'start with space'
  $envPathSpace = New-FixturePackage -Root $spaceRoot
  New-World
  $script:World.AutoListenerOnNativeProcess = $true
  $script:World.CommandPaths['curl.exe'] = 'C:\fake\curl.exe'
  Add-ExternalResult -ExitCode 0 -StdOut ($healthBody + "`n__WEFLOW_STATUS__200")
  Add-ExternalResult -ExitCode 0 -StdOut ('{"ok":true,"data":{"database":"ready"}}' + "`n__WEFLOW_STATUS__200")
  New-FixtureCaddyfile -Root $spaceRoot
  New-FakeExe -Root $spaceRoot
  Add-DockerResult -ExitCode 0 -StdOut 'weflow-test-caddy-1 Up'
  Add-DockerResult -ExitCode 0
  $code = Invoke-NativeCaddyStart -PackageRoot $spaceRoot -ReleaseDir $spaceRoot -NativeEnvPath $envPathSpace
  Assert-Equal -Expected 0 -Actual $code -Name '含空格路径的切换成功（退出码 0）'
  Assert-Equal -Expected 1 -Actual $script:World.StartArgumentLines.Count -Name '含空格路径确实走到真实参数构造'
  Assert-True -Condition ($script:World.StartArgumentLines[0] -match '"' + [regex]::Escape((Join-Path $spaceRoot 'config\Caddyfile')) + '"') `
    -Name '含空格的配置路径在命令行里被整体加引号' -Detail $script:World.StartArgumentLines[0]

  # G12：停容器阶段就失败（尚未启动进程）→ 回退不算「回收失败」，退出码 3
  New-World
  Remove-WeFlowTestStateFiles -Root $root
  Add-DockerResult -ExitCode 0 -StdOut 'weflow-test-caddy-1 Up'
  Add-DockerResult -ExitCode 1 -StdErr 'stop failed'
  Add-DockerResult -ExitCode 0   # rollback start
  $code = Invoke-NativeCaddyStart -PackageRoot $root -ReleaseDir $root -NativeEnvPath $envPath
  Assert-Equal -Expected 3 -Actual $code -Name '未启动进程即失败 → 回退成功（退出码 3）'
  Assert-Equal -Expected 0 -Actual $script:World.StopProcessCalls.Count -Name '未启动进程时不结束任何进程'

  # G13：stderr 日志存在但被占用（读取抛 IOException）→ 诊断失败不得打断回退
  #（ee2ee77 真实切换：旧实现在回退前读日志被占用，IOException 逃逸，自动回退根本没执行）
  New-World
  Remove-WeFlowTestStateFiles -Root $root
  $logsDir = Join-Path $root 'logs'
  New-Item -ItemType Directory -Force -Path $logsDir | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $logsDir 'native-caddy.stderr.log'), 'stub stderr content', (New-Object System.Text.UTF8Encoding($false)))
  $script:World.AutoListenerOnNativeProcess = $true
  $script:World.CommandPaths['curl.exe'] = 'C:\fake\curl.exe'
  Add-DockerResult -ExitCode 0 -StdOut 'weflow-test-caddy-1 Up'
  Add-DockerResult -ExitCode 0                                     # stop caddy
  Add-DockerResult -ExitCode 0                                     # 回退时 start caddy
  Add-ExternalResult -ExitCode 0 -StdOut ("boom`n__WEFLOW_STATUS__500")
  Add-ExternalResult -ExitCode 0 -StdOut ("boom`n__WEFLOW_STATUS__500")
  $script:World.FailOn['Read-WeFlowTextFile'] = 'native-caddy\.stderr\.log'
  New-FixtureCaddyfile -Root $root
  New-FakeExe -Root $root
  $nextPidBefore = [int]$script:World.NextPid
  $code = Invoke-NativeCaddyStart -PackageRoot $root -ReleaseDir $root -NativeEnvPath $envPath
  $launchedPid = $nextPidBefore
  Assert-Equal -Expected 3 -Actual $code -Name 'stderr 日志被占用（读取抛异常）→ 回退仍完整执行（退出码 3）'
  Assert-True -Condition ($script:World.StopProcessCalls -contains $launchedPid) `
    -Name ("日志读取失败时本轮进程仍被回收（PID {0}）" -f $launchedPid) `
    -Detail ("StopProcessCalls={0}" -f ($script:World.StopProcessCalls -join ','))
  Assert-True -Condition ($null -eq (Get-WeFlowProcessById -Id $launchedPid)) -Name '本轮进程已确认消失'
  Assert-Equal -Expected 'start' -Actual $script:World.DockerCalls[-1].ComposeArgs[0] -Name '原容器仍被恢复（compose start caddy）'
  Assert-True -Condition (Test-Path -LiteralPath (Join-Path $root 'state\native-caddy.rollback.json')) -Name '回退诊断记录已落盘'

  # G14：stderr 日志的存在性检查本身抛异常 → 同样不得阻断回退
  New-World
  Remove-WeFlowTestStateFiles -Root $root
  New-Item -ItemType Directory -Force -Path $logsDir | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $logsDir 'native-caddy.stderr.log'), 'stub', (New-Object System.Text.UTF8Encoding($false)))
  $script:World.AutoListenerOnNativeProcess = $true
  $script:World.CommandPaths['curl.exe'] = 'C:\fake\curl.exe'
  Add-DockerResult -ExitCode 0 -StdOut 'weflow-test-caddy-1 Up'
  Add-DockerResult -ExitCode 0
  Add-DockerResult -ExitCode 0
  Add-ExternalResult -ExitCode 0 -StdOut ("boom`n__WEFLOW_STATUS__500")
  Add-ExternalResult -ExitCode 0 -StdOut ("boom`n__WEFLOW_STATUS__500")
  $script:World.FailOn['Test-WeFlowPathExists'] = 'native-caddy\.stderr\.log'
  New-FixtureCaddyfile -Root $root
  New-FakeExe -Root $root
  $nextPidBefore = [int]$script:World.NextPid
  $code = Invoke-NativeCaddyStart -PackageRoot $root -ReleaseDir $root -NativeEnvPath $envPath
  $launchedPid = $nextPidBefore
  Assert-Equal -Expected 3 -Actual $code -Name '日志存在性检查抛异常 → 回退仍完整执行（退出码 3）'
  Assert-True -Condition ($script:World.StopProcessCalls -contains $launchedPid) -Name '存在性检查失败时本轮进程仍被回收'
  Assert-Equal -Expected 'start' -Actual $script:World.DockerCalls[-1].ComposeArgs[0] -Name '原容器仍被恢复'
  Assert-True -Condition (Test-Path -LiteralPath (Join-Path $root 'state\native-caddy.rollback.json')) -Name '回退诊断记录已落盘'

  # G15（变异）：把失败处理退回「先读日志（无防御）再回退」的旧流程（转录自 ee2ee77 之前的实现）——
  # 相同场景下旧流程会在读被占用日志时抛异常、回退根本没有执行；新用例（G13）必然抓住这种退化。
  Install-WeFlowMock -Name 'Invoke-WeFlowStartFailureHandling' -Body {
    param($Config, $ReleaseDir, $Reason, $ContainerWasRunning, $ProcessAttempted, $LaunchedIdentity, $CurrentStatePath, $RollbackReportPath)
    Write-Host ("切换过程中发生异常：{0}" -f $Reason) -ForegroundColor Red
    # 旧实现：诊断在回退之前，且无任何防御 —— 读取失败时 IOException 逃逸出 catch 块
    $stderrLog = Join-Path $Config.LogDir 'native-caddy.stderr.log'
    if (Test-WeFlowPathExists -Path $stderrLog -Leaf) {
      Read-WeFlowTextFile -Path $stderrLog | Select-Object -Last 40 | Write-Host
    }
    return Invoke-WeFlowStartRollback -ReleaseDir $ReleaseDir -ContainerWasRunning $ContainerWasRunning `
      -ProcessAttempted $ProcessAttempted -LaunchedIdentity $LaunchedIdentity `
      -CurrentStatePath $CurrentStatePath -Reason $Reason -ReportPath $RollbackReportPath
  }
  New-World
  Remove-WeFlowTestStateFiles -Root $root
  New-Item -ItemType Directory -Force -Path $logsDir | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $logsDir 'native-caddy.stderr.log'), 'stub', (New-Object System.Text.UTF8Encoding($false)))
  $script:World.AutoListenerOnNativeProcess = $true
  $script:World.CommandPaths['curl.exe'] = 'C:\fake\curl.exe'
  Add-DockerResult -ExitCode 0 -StdOut 'weflow-test-caddy-1 Up'
  Add-DockerResult -ExitCode 0
  Add-DockerResult -ExitCode 0
  Add-ExternalResult -ExitCode 0 -StdOut ("boom`n__WEFLOW_STATUS__500")
  Add-ExternalResult -ExitCode 0 -StdOut ("boom`n__WEFLOW_STATUS__500")
  $script:World.FailOn['Read-WeFlowTextFile'] = 'native-caddy\.stderr\.log'
  New-FixtureCaddyfile -Root $root
  New-FakeExe -Root $root
  $threw = $false
  try { Invoke-NativeCaddyStart -PackageRoot $root -ReleaseDir $root -NativeEnvPath $envPath | Out-Null } catch { $threw = $true }
  Assert-True -Condition $threw -Name '变异：旧诊断流程下读取被占用日志的异常逃逸出失败处理（新用例会抓住）'
  Assert-Equal -Expected 0 -Actual $script:World.StopProcessCalls.Count -Name '变异：旧流程下进程未被回收（「进程已回收」断言在此退化下必然失败）'
  Assert-True -Condition ($script:World.DockerCalls[-1].ComposeArgs[0] -eq 'stop') -Name '变异：旧流程下容器未被恢复'
  # 恢复真实实现与其余标准叶子 mock
  Restore-WeFlowMocks
  Install-SystemLeafMocks
}

function New-FixtureCaddyfile {
  param([Parameter(Mandatory)][string]$Root)
  $configDir = Join-Path $Root 'config'
  New-Item -ItemType Directory -Force -Path $configDir | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $configDir 'Caddyfile'), "https://weflow-central.test {`n}`n", (New-Object System.Text.UTF8Encoding($false)))
  $pkiRoot = Join-Path $Root 'pki\pki\authorities\local'
  New-Item -ItemType Directory -Force -Path $pkiRoot | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $pkiRoot 'root.crt'), 'stub-root', (New-Object System.Text.UTF8Encoding($false)))
}

function New-FakeExe {
  param([Parameter(Mandatory)][string]$Root)
  $binDir = Join-Path $Root 'bin'
  New-Item -ItemType Directory -Force -Path $binDir | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $binDir 'caddy.exe'), 'stub-exe', (New-Object System.Text.UTF8Encoding($false)))
}

function Remove-WeFlowTestStateFiles {
  <#
  .SYNOPSIS
    清空一个夹具部署根的记账/回退状态文件（沙箱内）。
  .DESCRIPTION
    依赖 state 文件的子用例必须先明确重置磁盘状态，只重置内存 World 不够：
    更早的子用例会把 native-caddy.current.json 留在沙箱里。
  #>
  param([Parameter(Mandatory)][string]$Root)
  $stateDir = Join-Path $Root 'state'
  if (Test-Path -LiteralPath $stateDir) {
    foreach ($name in @('native-caddy.current.json', 'native-caddy.state.json', 'native-caddy.rollback.json')) {
      Remove-Item -LiteralPath (Join-Path $stateDir $name) -Force -ErrorAction SilentlyContinue
    }
  }
}

function Test-StopScript {
  Start-Case 'H. Stop-NativeCaddy（真实逻辑 + 全 mock）'
  $root = Join-Path $script:SandboxRootPath 'stop'
  $envPath = New-FixturePackage -Root $root
  $stateDir = Join-Path $root 'state'
  New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
  $statePath = Join-Path $stateDir 'native-caddy.current.json'
  $previousPath = Join-Path $stateDir 'native-caddy.state.json'
  $exePath = Join-Path $root 'bin\caddy.exe'

  # H1：正常停止（身份一致）
  New-World
  $startedAt = (Get-Date).AddMinutes(-5)
  $script:World.Processes[5001] = @{ Path = $exePath; StartTime = $startedAt }
  [System.IO.File]::WriteAllText($statePath, ([ordered]@{ Pid = 5001; ExecutablePath = $exePath; StartedAt = $startedAt.ToString('o') } | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))
  [System.IO.File]::WriteAllText($previousPath, ([ordered]@{ ContainerCaddyRunning = $true } | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))
  $script:World.StopProcessCalls = @()
  Add-DockerResult -ExitCode 0
  $code = Invoke-NativeCaddyStop -PackageRoot $root -ReleaseDir $root -NativeEnvPath $envPath -RestoreContainerMode $true
  Assert-True -Condition (-not (Test-Path -LiteralPath $statePath)) -Name '成功后清理状态文件'

  # H2：PID 复用（路径不符）→ 拒绝结束
  New-World
  $script:World.Processes[5002] = @{ Path = 'C:\Windows\System32\notepad.exe'; StartTime = (Get-Date) }
  [System.IO.File]::WriteAllText($statePath, ([ordered]@{ Pid = 5002; ExecutablePath = $exePath; StartedAt = (Get-Date).ToString('o') } | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))
  $script:World.StopProcessCalls = @()
  $code = Invoke-NativeCaddyStop -PackageRoot $root -ReleaseDir $root -NativeEnvPath $envPath -RestoreContainerMode $false
  Assert-Equal -Expected 2 -Actual $code -Name 'PID 复用（路径不符）→ 退出码 2'
  Assert-Equal -Expected 0 -Actual $script:World.StopProcessCalls.Count -Name '拒绝结束时未调用 Stop'
  Assert-True -Condition (Test-Path -LiteralPath $statePath) -Name '拒绝时保留状态文件'

  # H3：启动时间不符 → 拒绝
  New-World
  $script:World.Processes[5003] = @{ Path = $exePath; StartTime = (Get-Date).AddHours(-3) }
  [System.IO.File]::WriteAllText($statePath, ([ordered]@{ Pid = 5003; ExecutablePath = $exePath; StartedAt = (Get-Date).ToString('o') } | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))
  $script:World.StopProcessCalls = @()
  $code = Invoke-NativeCaddyStop -PackageRoot $root -ReleaseDir $root -NativeEnvPath $envPath -RestoreContainerMode $false
  Assert-Equal -Expected 2 -Actual $code -Name '启动时间不符 → 退出码 2'

  # H4：进程已不存在 + 原先未运行 → 不启动容器
  New-World
  [System.IO.File]::WriteAllText($statePath, ([ordered]@{ Pid = 5004; ExecutablePath = $exePath; StartedAt = (Get-Date).ToString('o') } | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))
  [System.IO.File]::WriteAllText($previousPath, ([ordered]@{ ContainerCaddyRunning = $false } | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))
  $code = Invoke-NativeCaddyStop -PackageRoot $root -ReleaseDir $root -NativeEnvPath $envPath -RestoreContainerMode $true
  Assert-Equal -Expected 0 -Actual $code -Name '进程不存在且原先未运行 → 退出码 0'
  Assert-Equal -Expected 0 -Actual $script:World.DockerCalls.Count -Name '原先未运行时未执行 start（只恢复本轮停止的服务）'

  # H5：缺少切换前记录 + 要求恢复 → 4
  New-World
  Remove-Item -LiteralPath $previousPath -Force -ErrorAction SilentlyContinue
  [System.IO.File]::WriteAllText($statePath, ([ordered]@{ Pid = 5005; ExecutablePath = $exePath; StartedAt = (Get-Date).ToString('o') } | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))
  $code = Invoke-NativeCaddyStop -PackageRoot $root -ReleaseDir $root -NativeEnvPath $envPath -RestoreContainerMode $true
  Assert-Equal -Expected 4 -Actual $code -Name '无切换前记录 → 退出码 4（不擅自 start）'

  # H6：恢复失败 → 3 且保留状态
  New-World
  $startedAt6 = (Get-Date)
  $script:World.Processes[5006] = @{ Path = $exePath; StartTime = $startedAt6 }
  [System.IO.File]::WriteAllText($statePath, ([ordered]@{ Pid = 5006; ExecutablePath = $exePath; StartedAt = $startedAt6.ToString('o') } | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))
  [System.IO.File]::WriteAllText($previousPath, ([ordered]@{ ContainerCaddyRunning = $true } | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))
  Add-DockerResult -ExitCode 1 -StdErr 'start failed'
  $code = Invoke-NativeCaddyStop -PackageRoot $root -ReleaseDir $root -NativeEnvPath $envPath -RestoreContainerMode $true
  Assert-Equal -Expected 3 -Actual $code -Name '恢复容器失败 → 退出码 3'
  Assert-True -Condition (Test-Path -LiteralPath $statePath) -Name '恢复失败时保留状态文件'

  Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue
}

function Test-InstallScript {
  Start-Case 'I. Install-NativeCaddy（完整性 / 冲突 / ACL）'
  $root = Join-Path $script:SandboxRootPath 'install'
  $envPath = New-FixturePackage -Root $root
  $archivePath = Join-Path $root 'caddy_2.11.4_windows_amd64.zip'
  [System.IO.File]::WriteAllText($archivePath, 'stub-archive', (New-Object System.Text.UTF8Encoding($false)))
  $exePath = Join-Path $root 'bin\caddy.exe'
  $officialArchiveHash = '1708333f79e274c7697285afe6d592ab39314e0b131e9ec6bea08ad27df62ebf'
  $officialExeHash = '5cb9ab71e5756ce72840b8234177a2f40c8b4ab47a806b8e841e2b784e9df62b'

  # I1：归档摘要不一致 → 2，且不展开
  New-World
  $script:World.FileHashes[$archivePath] = 'deadbeef'
  $script:World.HttpQueue.Clear()
  Add-HttpResult -Ok $true -StatusCode 200 -Content '{"ok":true,"data":{"service":"weflow-central","protocolVersion":1}}'
  Add-HttpResult -Ok $true -StatusCode 200 -Content '{"ok":true,"data":{"database":"ready"}}'
  $script:World.FailOn.Clear()
  $code = Invoke-NativeCaddyInstall -PackageRoot $root -NativeEnvPath $envPath -AllowOverwrite $false
  Assert-Equal -Expected 2 -Actual $code -Name '归档摘要不一致 → 退出码 2'
  Assert-True -Condition (-not (Test-Path -LiteralPath $exePath)) -Name '摘要不一致时未展开可执行文件'

  # I2：既有 exe 摘要不符 → 2，且不覆盖
  New-World
  $script:World.FileHashes[$archivePath] = $officialArchiveHash
  New-Item -ItemType Directory -Force -Path (Join-Path $root 'bin') | Out-Null
  [System.IO.File]::WriteAllText($exePath, 'tampered', (New-Object System.Text.UTF8Encoding($false)))
  $script:World.FileHashes[$exePath] = 'not-the-official-hash'
  $script:World.HttpQueue.Clear()
  Add-HttpResult -Ok $true -StatusCode 200 -Content '{"ok":true,"data":{"service":"weflow-central","protocolVersion":1}}'
  Add-HttpResult -Ok $true -StatusCode 200 -Content '{"ok":true,"data":{"database":"ready"}}'
  $code = Invoke-NativeCaddyInstall -PackageRoot $root -NativeEnvPath $envPath -AllowOverwrite $false
  Assert-Equal -Expected 2 -Actual $code -Name '既有 exe 摘要不符 → 退出码 2'
  Assert-Equal -Expected 'tampered' -Actual (Get-Content -LiteralPath $exePath -Raw) -Name '未覆盖被篡改的 exe'

  # I3：Central 不健康 → 1
  Remove-Item -LiteralPath $exePath -Force -ErrorAction SilentlyContinue
  New-World
  $script:World.FileHashes[$archivePath] = $officialArchiveHash
  $script:World.HttpQueue.Clear()
  Add-HttpResult -Ok $false -StatusCode $null -Error 'connection refused'
  $code = Invoke-NativeCaddyInstall -PackageRoot $root -NativeEnvPath $envPath -AllowOverwrite $false
  Assert-Equal -Expected 1 -Actual $code -Name 'Central 不健康 → 退出码 1'

  # I4：绑定地址不属于本机 → 1
  New-World
  $script:World.LocalIPv4 = @([pscustomobject]@{ IPAddress = '10.1.1.1'; InterfaceAlias = 'Ethernet'; PrefixOrigin = 'Static' })
  $code = Invoke-NativeCaddyInstall -PackageRoot $root -NativeEnvPath $envPath -AllowOverwrite $false
  Assert-Equal -Expected 1 -Actual $code -Name '绑定地址不属于本机 → 退出码 1'

  # I5：ACL 收紧失败 → 3
  New-World
  $script:World.FileHashes[$archivePath] = $officialArchiveHash
  $script:World.FileHashes[$exePath] = $officialExeHash
  $script:World.FailOn['Set-WeFlowRestrictedAcl'] = 'yes'
  $script:World.HttpQueue.Clear()
  Add-HttpResult -Ok $true -StatusCode 200 -Content '{"ok":true,"data":{"service":"weflow-central","protocolVersion":1}}'
  Add-HttpResult -Ok $true -StatusCode 200 -Content '{"ok":true,"data":{"database":"ready"}}'
  $code = Invoke-NativeCaddyInstall -PackageRoot $root -NativeEnvPath $envPath -AllowOverwrite $false
  Assert-Equal -Expected 3 -Actual $code -Name 'ACL 收紧失败 → 退出码 3'

  # I6：既有配置与渲染结果不同且未加 -Force → 4
  New-World
  $script:World.FailOn.Clear()
  $script:World.FileHashes[$archivePath] = $officialArchiveHash
  $script:World.FileHashes[$exePath] = $officialExeHash
  New-Item -ItemType Directory -Force -Path (Join-Path $root 'config') | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $root 'config\Caddyfile'), 'https://old-config.test { }', (New-Object System.Text.UTF8Encoding($false)))
  $script:World.HttpQueue.Clear()
  Add-HttpResult -Ok $true -StatusCode 200 -Content '{"ok":true,"data":{"service":"weflow-central","protocolVersion":1}}'
  Add-HttpResult -Ok $true -StatusCode 200 -Content '{"ok":true,"data":{"database":"ready"}}'
  Add-ExternalResult -ExitCode 0   # caddy validate
  $code = Invoke-NativeCaddyInstall -PackageRoot $root -NativeEnvPath $envPath -AllowOverwrite $false
  Assert-Equal -Expected 4 -Actual $code -Name '配置冲突且未 -Force → 退出码 4'
  Assert-Equal -Expected 'https://old-config.test { }' -Actual (Get-Content -LiteralPath (Join-Path $root 'config\Caddyfile') -Raw) -Name '未静默覆盖既有配置'

  # I7：validate 失败 → 1，且不写生效配置
  New-World
  $script:World.FileHashes[$archivePath] = $officialArchiveHash
  $script:World.FileHashes[$exePath] = $officialExeHash
  $script:World.HttpQueue.Clear()
  Add-HttpResult -Ok $true -StatusCode 200 -Content '{"ok":true,"data":{"service":"weflow-central","protocolVersion":1}}'
  Add-HttpResult -Ok $true -StatusCode 200 -Content '{"ok":true,"data":{"database":"ready"}}'
  Add-ExternalResult -ExitCode 1 -StdErr 'invalid config'
  $code = Invoke-NativeCaddyInstall -PackageRoot $root -NativeEnvPath $envPath -AllowOverwrite $false
  Assert-Equal -Expected 1 -Actual $code -Name 'caddy validate 失败 → 退出码 1'

  # I8：正常路径（含空格目录）
  $spaceRoot = Join-Path $script:SandboxRootPath 'install with space'
  $envPathSpace = New-FixturePackage -Root $spaceRoot
  $archivePathSpace = Join-Path $spaceRoot 'caddy_2.11.4_windows_amd64.zip'
  [System.IO.File]::WriteAllText($archivePathSpace, 'stub', (New-Object System.Text.UTF8Encoding($false)))
  New-World
  $script:World.FileHashes[$archivePathSpace] = $officialArchiveHash
  $script:World.FileHashes[(Join-Path $spaceRoot 'bin\caddy.exe')] = $officialExeHash
  $script:World.HttpQueue.Clear()
  Add-HttpResult -Ok $true -StatusCode 200 -Content '{"ok":true,"data":{"service":"weflow-central","protocolVersion":1}}'
  Add-HttpResult -Ok $true -StatusCode 200 -Content '{"ok":true,"data":{"database":"ready"}}'
  Add-ExternalResult -ExitCode 0
  $code = Invoke-NativeCaddyInstall -PackageRoot $spaceRoot -NativeEnvPath $envPathSpace -AllowOverwrite $false
  Assert-Equal -Expected 0 -Actual $code -Name '含空格路径的正常准备 → 退出码 0'
  Assert-True -Condition (Test-Path -LiteralPath (Join-Path $spaceRoot 'config\Caddyfile')) -Name '生成了生效配置'

  # I9：目录 ACL 未断开继承（AreAccessRulesProtected=false）→ 3
  New-World
  $script:World.FileHashes[$archivePath] = $officialArchiveHash
  $script:World.FileHashes[$exePath] = $officialExeHash
  $script:World.AclInheritanceProtected = $false
  $script:World.HttpQueue.Clear()
  Add-HttpResult -Ok $true -StatusCode 200 -Content '{"ok":true,"data":{"service":"weflow-central","protocolVersion":1}}'
  Add-HttpResult -Ok $true -StatusCode 200 -Content '{"ok":true,"data":{"database":"ready"}}'
  $code = Invoke-NativeCaddyInstall -PackageRoot $root -NativeEnvPath $envPath -AllowOverwrite $false
  Assert-Equal -Expected 3 -Actual $code -Name '目录 ACL 仍启用继承 → 退出码 3'
}

function Test-FailClosed {
  Start-Case 'J. Mock 遗漏时 fail closed'
  Assert-True -Condition (Test-WeFlowNativeTestMode) -Name '测试模式处于开启状态'
  # 恢复「原始叶子实现」（带测试模式守卫），再调用它 —— 未替换的危险调用必须失败。
  $originalLeaf = $script:MockRegistry['Get-WeFlowProcessById']
  Set-Item -Path 'function:Get-WeFlowProcessById' -Value $originalLeaf
  Assert-Throws -Name '未替换的危险调用（读取进程）被拦截' -Action { Get-WeFlowProcessById -Id 1 } -MessagePattern '测试模式'
  Install-SystemLeafMocks
  Assert-True -Condition ($null -eq (Get-WeFlowProcessById -Id 123456)) -Name '重新注入 mock 后恢复脚本化行为'
}

# =====================================================================
# 主流程
# =====================================================================

$exitCode = 2
try {
  Write-Host 'WeFlow 原生 Windows Caddy —— 隔离测试' -ForegroundColor Cyan
  Write-Host ("PowerShell : {0}" -f $PSVersionTable.PSVersion.ToString())

  if (-not (Test-Path -LiteralPath $script:SandboxRoot)) { New-Item -ItemType Directory -Force -Path $script:SandboxRoot | Out-Null }
  $script:SandboxRootPath = [System.IO.Path]::GetFullPath($script:SandboxRoot)
  Write-Host ("沙箱根     : {0}" -f $script:SandboxRootPath)

  . (Join-Path $script:ProdScriptsRoot 'WeFlowNative.Common.ps1')
  . (Join-Path $script:ProdScriptsRoot 'Install-NativeCaddy.ps1') -SelfTest
  . (Join-Path $script:ProdScriptsRoot 'Start-NativeCaddy.ps1') -SelfTest
  . (Join-Path $script:ProdScriptsRoot 'Stop-NativeCaddy.ps1') -SelfTest
  . (Join-Path $script:ProdScriptsRoot 'Test-NativeCaddyEndpoint.ps1') -SelfTest
  . (Join-Path $script:ProdScriptsRoot 'Test-DeploymentContract.ps1') -SelfTest
  Set-WeFlowNativeTestMode -Enabled $true -Caller 'WeFlowNative.Tests.ps1'
  Set-WeFlowNativeTestAllowedRoot -Root $script:SandboxRootPath
  New-World
  Install-SystemLeafMocks

  Test-SyntaxAndStrictMode
  Test-Validators
  Test-EnvValidation
  Test-Render
  Test-EndpointScript
  Test-ContractGuard
  Test-StartScript
  Test-StopScript
  Test-InstallScript
  Test-FailClosed
  Test-ArgumentEncoding
  Test-ProcessReclaim
  Test-StartAcceptanceContract
  Test-EndpointContractStrict
  Test-RealArgumentConstruction

  # 真实子进程用例必须在 mock 之外运行：先恢复所有叶子实现、关闭测试模式，
  # 再让生产代码真的 CreateProcess 一次（只启动无害的回显子进程）。
  Restore-WeFlowMocks
  Set-WeFlowNativeTestMode -Enabled $false -Caller 'WeFlowNative.Tests.ps1 (echo child)'
  Test-WindowsArgumentEchoChild
  Test-SubprocessEncodingRoundTrip

  $passed = @($script:Results | Where-Object { $_.Passed }).Count
  $failed = @($script:Results | Where-Object { -not $_.Passed }).Count
  $skipped = $script:SkipCount

  Write-Host ''
  Write-Host ('-' * 60)
  Write-Host ("WeFlowNative.Tests: {0} passed, {1} failed, {2} skipped" -f $passed, $failed, $skipped)
  if ($failed -gt 0) {
    Write-Host '失败用例：' -ForegroundColor Red
    foreach ($item in @($script:Results | Where-Object { -not $_.Passed })) {
      Write-Host ("  [{0}] {1} {2}" -f $item.Case, $item.Name, $item.Detail) -ForegroundColor Red
    }
  }
  $exitCode = if ($failed -gt 0) { 1 } else { 0 }
} catch {
  Write-Host ("测试入口异常：{0}" -f $_.Exception.Message) -ForegroundColor Red
  Write-Host $_.ScriptStackTrace
  $exitCode = 2
} finally {
  Restore-WeFlowMocks
  Set-WeFlowNativeTestMode -Enabled $false -Caller 'WeFlowNative.Tests.ps1 (teardown)'
  if (-not $KeepSandbox -and (Test-Path -LiteralPath $script:SandboxRoot)) {
    Remove-Item -LiteralPath $script:SandboxRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}

exit $exitCode
