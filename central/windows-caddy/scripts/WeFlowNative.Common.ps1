<#
.SYNOPSIS
  原生 Windows Caddy 部署脚本的公共参数校验、配置渲染与系统调用包装层。

.DESCRIPTION
  被 install / start / stop / diagnostics / contract-guard 共用。本文件只做三件事：
    1) 把 native.env 读成强类型配置，并在写盘或启动之前拒绝危险值；
    2) 渲染 Caddyfile 模板（渲染后仍有占位符即失败）；
    3) 把所有会落到真实系统的调用收敛到少数「叶子函数」上。

  【测试模式】
  由测试入口显式调用 Set-WeFlowNativeTestMode -Enabled $true 打开。打开后，
  所有叶子函数一律 throw，必须由测试用同名 mock 覆盖；未被覆盖 = 直接失败。
  这样「忘记 mock」不会静默落到真实系统，而是立刻报错（fail closed）。
  正常部署流程不会打开测试模式，也不会加载任何 mock。

  所有校验失败一律 throw，由调用方以非零退出，绝不静默兜底。
#>

Set-StrictMode -Version Latest

# =====================================================================
# 1. 测试模式闸门
# =====================================================================

$script:WeFlowNativeTestMode = $false

$script:WeFlowTestAllowedRoot = $null

function Set-WeFlowNativeTestAllowedRoot {
  <#
  .SYNOPSIS
    测试模式下额外允许的部署根（例如本轮沙箱目录）。
  .DESCRIPTION
    仅当测试模式开启时生效；生产路径下该白名单为空，
    WEFLOW_NATIVE_ROOT 仍然只接受 F:\WeFlow-Test。
  #>
  param([Parameter(Mandatory)][AllowEmptyString()][string]$Root)
  if (-not $script:WeFlowNativeTestMode) {
    throw '只有测试模式开启时才允许设置测试部署根白名单'
  }
  $script:WeFlowTestAllowedRoot = $Root
}

function Test-WeFlowAllowedDeploymentRoot {
  <#
  .SYNOPSIS
    判断部署根是否被允许（生产：F:\WeFlow-Test；测试：沙箱根之下）。
  #>
  param([Parameter(Mandatory)][AllowEmptyString()][string]$Root)
  if ([string]::IsNullOrWhiteSpace($Root)) { return $false }
  $trimmed = $Root.Trim().TrimEnd('\')
  if ([regex]::IsMatch($trimmed, $script:WeFlowDeploymentRootPattern)) { return $true }
  if ($script:WeFlowNativeTestMode -and -not [string]::IsNullOrWhiteSpace($script:WeFlowTestAllowedRoot)) {
    return (Test-WeFlowPathUnderRoot -Path $trimmed -Root $script:WeFlowTestAllowedRoot)
  }
  return $false
}

function Set-WeFlowNativeTestMode {
  <#
  .SYNOPSIS
    显式开关测试模式。只允许测试入口调用。
  #>
  param(
    [Parameter(Mandatory)][bool]$Enabled,
    [string]$Caller = 'unspecified'
  )
  $script:WeFlowNativeTestMode = $Enabled
  $script:WeFlowNativeTestModeCaller = $Caller
}

function Test-WeFlowNativeTestMode {
  <#
  .SYNOPSIS
    返回当前是否处于测试模式。
  #>
  return $script:WeFlowNativeTestMode
}

function Assert-WeFlowNativeRealSystemAllowed {
  <#
  .SYNOPSIS
    叶子函数入口守卫：测试模式下拒绝执行真实系统调用。
  #>
  param([Parameter(Mandatory)][string]$Operation)
  if ($script:WeFlowNativeTestMode) {
    throw ("测试模式已开启，未替换的危险系统调用被拦截：{0}" +
      "（必须在测试中注入同名 mock，不允许触达真实系统）" -f $Operation)
  }
}

# =====================================================================
# 2. 参数校验（纯函数，无系统副作用）
# =====================================================================

$script:WeFlowDeploymentRootPattern = '^[Ff]:\\WeFlow-Test$'

function Test-WeFlowIpv4Literal {
  <#
  .SYNOPSIS
    判断字符串是否为合法的点分十进制 IPv4 字面量（四段、每段 0-255、无前导零）。
  #>
  param([Parameter(Mandatory)][AllowEmptyString()][string]$Value)
  if ([string]::IsNullOrWhiteSpace($Value)) { return $false }
  $text = $Value.Trim()
  $segments = $text.Split('.')
  if ($segments.Length -ne 4) { return $false }
  foreach ($segment in $segments) {
    if ($segment -notmatch '^\d{1,3}$') { return $false }
    $number = [int]$segment
    if ($number -lt 0 -or $number -gt 255) { return $false }
    if ($segment.Length -gt 1 -and $segment.StartsWith('0')) { return $false }
  }
  $parsed = $null
  if (-not [System.Net.IPAddress]::TryParse($text, [ref]$parsed)) { return $false }
  return $parsed.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork
}

function Test-WeFlowWildcardAddress {
  <#
  .SYNOPSIS
    判断字符串是否为通配监听地址（0.0.0.0 / :: / * / 空串）。
  #>
  param([Parameter(Mandatory)][AllowEmptyString()][string]$Value)
  if ([string]::IsNullOrWhiteSpace($Value)) { return $true }
  $text = $Value.Trim()
  if (@('0.0.0.0', '::', '[::]', '*', '0.0.0.0/0', '::/0') -contains $text) { return $true }
  if ($text -match '^0\.0\.0\.0/\d{1,2}$') { return $true }
  return $false
}

function Test-WeFlowPrivateCidr {
  <#
  .SYNOPSIS
    判断字符串是否为「受限私有 IPv4 CIDR」：RFC1918 段、合法前缀、规范网络地址。
  .DESCRIPTION
    拒绝 0.0.0.0/0、::/0、公网段、非规范地址（主机位非零）与跨段前缀。
  #>
  param([Parameter(Mandatory)][AllowEmptyString()][string]$Value)
  if ([string]::IsNullOrWhiteSpace($Value)) { return $false }
  $text = $Value.Trim()
  $parts = $text.Split('/')
  if ($parts.Length -ne 2) { return $false }
  $address = $parts[0]
  $prefixText = $parts[1]
  if ($prefixText -notmatch '^\d{1,2}$') { return $false }
  if (-not (Test-WeFlowIpv4Literal -Value $address)) { return $false }
  $prefix = [int]$prefixText
  if ($prefix -lt 1 -or $prefix -gt 32) { return $false }

  $octets = @()
  foreach ($segment in $address.Split('.')) { $octets += [int]$segment }

  $allowedMin = -1
  if ($octets[0] -eq 10) { $allowedMin = 8 }
  elseif ($octets[0] -eq 172 -and $octets[1] -ge 16 -and $octets[1] -le 31) { $allowedMin = 12 }
  elseif ($octets[0] -eq 192 -and $octets[1] -eq 168) { $allowedMin = 16 }
  if ($allowedMin -lt 0) { return $false }
  if ($prefix -lt $allowedMin) { return $false }

  $value32 = ([uint32]$octets[0] -shl 24) -bor ([uint32]$octets[1] -shl 16) -bor ([uint32]$octets[2] -shl 8) -bor ([uint32]$octets[3])
  if ($prefix -eq 32) { return $true }
  $mask = [uint32]::MaxValue -shl (32 - $prefix)
  if (($value32 -band ([uint32]::MaxValue -bxor $mask)) -ne 0) { return $false }
  return $true
}

function Test-WeFlowHostname {
  <#
  .SYNOPSIS
    判断字符串是否为可用于 Caddyfile 站点的安全主机名。
  .DESCRIPTION
    只接受 DNS 标签形式（字母数字/连字符、点分隔、至少两段、每段 ≤63、总长 ≤253）。
    显式拒绝空格、下划线、斜杠、冒号、花括号、引号、换行等注入字符。
  #>
  param([Parameter(Mandatory)][AllowEmptyString()][string]$Value)
  if ([string]::IsNullOrWhiteSpace($Value)) { return $false }
  if ($Value -ne $Value.Trim()) { return $false }
  $text = $Value
  if ($text.Length -gt 253) { return $false }
  $labelPattern = '^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$'
  $labels = $text.Split('.')
  if ($labels.Length -lt 2) { return $false }
  foreach ($label in $labels) {
    if ($label -notmatch $labelPattern) { return $false }
  }
  return $true
}

function Test-WeFlowAbsoluteWindowsPath {
  <#
  .SYNOPSIS
    判断字符串是否为绝对 Windows 路径（形如 F:\...），且不是 UNC 路径。
  #>
  param([Parameter(Mandatory)][AllowEmptyString()][string]$Value)
  if ([string]::IsNullOrWhiteSpace($Value)) { return $false }
  $text = $Value.Trim()
  if ($text.StartsWith('\\')) { return $false }
  return [regex]::IsMatch($text, '^[A-Za-z]:\\')
}

function Test-WeFlowPathTraversal {
  <#
  .SYNOPSIS
    判断路径中是否含 .. 穿越片段。
  #>
  param([Parameter(Mandatory)][AllowEmptyString()][string]$Value)
  if ([string]::IsNullOrWhiteSpace($Value)) { return $false }
  foreach ($segment in [regex]::Split($Value, '[\\/]')) {
    if ($segment -eq '..') { return $true }
  }
  return $false
}

function Test-WeFlowPathUnderRoot {
  <#
  .SYNOPSIS
    判断路径（规范化后）是否位于指定根目录之下（含等于根目录本身）。
  #>
  param(
    [Parameter(Mandatory)][AllowEmptyString()][string]$Path,
    [Parameter(Mandatory)][AllowEmptyString()][string]$Root
  )
  if ([string]::IsNullOrWhiteSpace($Path) -or [string]::IsNullOrWhiteSpace($Root)) { return $false }
  $normalizedRoot = $Root.Trim().TrimEnd('\')
  $normalizedPath = $Path.Trim().TrimEnd('\')
  if ([string]::Equals($normalizedPath, $normalizedRoot, [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
  return $normalizedPath.StartsWith($normalizedRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)
}

function Test-WeFlowPathIsCanonical {
  <#
  .SYNOPSIS
    判断路径是否为规范形式（GetFullPath 后与原文一致，忽略大小写与末尾分隔符）。
  #>
  param([Parameter(Mandatory)][AllowEmptyString()][string]$Value)
  if ([string]::IsNullOrWhiteSpace($Value)) { return $false }
  $text = $Value.Trim()
  try {
    $full = [System.IO.Path]::GetFullPath($text)
  } catch {
    return $false
  }
  return ([string]::Equals($full.TrimEnd('\'), $text.TrimEnd('\'), [System.StringComparison]::OrdinalIgnoreCase))
}

# =====================================================================
# 2b. Windows 命令行参数编码（纯函数，无系统副作用）
# =====================================================================

function ConvertTo-WeFlowWindowsArgument {
  <#
  .SYNOPSIS
    按 Windows 的 MSVCRT / CommandLineToArgvW 规则，把「一个参数」编码成命令行片段。
  .DESCRIPTION
    这里必须自己构造，不能依赖框架：

      - `Start-Process -ArgumentList @('a','b c')` 会把数组**用空格拼成一行**再交给
        CreateProcess，含空格的元素因此被重新切分（975ced5 的真实缺陷：含空格的配置
        路径在真实启动时被拆坏，而 mock 测试看不见，因为 mock 不经过 CreateProcess）；
      - PowerShell 5.1 的 ProcessStartInfo 没有 ArgumentList 属性（.NET Core 才有），
        所以唯一的正确做法是构造一条**已正确加引号**的命令行字符串。

    规则：不需要引号的参数原样输出；否则用双引号包裹，并在引号前把反斜杠翻倍、
    在参数结尾把反斜杠翻倍（这样引号不会被反斜杠转义，结尾的反斜杠也不会吃掉引号）。

    不能安全表达的值直接拒绝：NUL 与 CR/LF 在不同解析器（MSVCRT 与
    CommandLineToArgvW）下的处理不一致，宁可显式失败也不写出可能被重新切分的命令行。
  .PARAMETER Value
    单个参数原文（含空格、引号、反斜杠都可）。
  #>
  param([Parameter(Mandatory)][AllowEmptyString()][string]$Value)

  if ($Value.IndexOf([char]0) -ge 0) { throw '参数含 NUL 字符，拒绝构造命令行（无法安全表达）' }
  if ($Value -match "[\r\n]") { throw '参数含 CR/LF，拒绝构造命令行（无法安全表达）' }
  if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') { return $Value }

  $builder = New-Object System.Text.StringBuilder
  [void]$builder.Append('"')
  $backslashes = 0
  foreach ($character in $Value.ToCharArray()) {
    if ($character -eq '\') { $backslashes++; continue }
    if ($character -eq '"') {
      if ($backslashes -gt 0) { [void]$builder.Append('\', (($backslashes * 2) + 1)) }
      else { [void]$builder.Append('\') }
      $backslashes = 0
      [void]$builder.Append('"')
      continue
    }
    if ($backslashes -gt 0) { [void]$builder.Append('\', $backslashes); $backslashes = 0 }
    [void]$builder.Append($character)
  }
  if ($backslashes -gt 0) { [void]$builder.Append('\', ($backslashes * 2)) }
  [void]$builder.Append('"')
  return $builder.ToString()
}

function ConvertTo-WeFlowWindowsArgumentLine {
  <#
  .SYNOPSIS
    把参数数组编码成一条完整的 Windows 命令行字符串。
  .DESCRIPTION
    逐参数调用 ConvertTo-WeFlowWindowsArgument 后用单个空格连接。
    任何无法安全编码的参数都会 throw（调用方以非零退出，绝不退回数组直传）。
  .PARAMETER Arguments
    参数数组。
  #>
  param([Parameter(Mandatory)][AllowEmptyCollection()][AllowEmptyString()][string[]]$Arguments)
  $parts = New-Object System.Collections.Generic.List[string]
  foreach ($argument in $Arguments) {
    if ($null -eq $argument) { continue }
    $parts.Add((ConvertTo-WeFlowWindowsArgument -Value ([string]$argument)))
  }
  return ($parts -join ' ')
}

# =====================================================================
# 3. 叶子函数：所有真实系统调用都收敛到这里（全部受测试模式守卫）
# =====================================================================

function Invoke-WeFlowExternalCommand {
  <#
  .SYNOPSIS
    运行外部程序，stdout / stderr / 退出码三者分离返回。
  .DESCRIPTION
    返回 [pscustomobject]@{ ExitCode; StdOut; StdErr }。不使用管道，避免输出与退出码纠缠。
    参数按 Windows 规则显式加引号（见 ConvertTo-WeFlowWindowsArgumentLine）。
  #>
  param(
    [Parameter(Mandatory)][string]$FilePath,
    [string[]]$Arguments = @(),
    [string]$WorkingDirectory
  )
  Assert-WeFlowNativeRealSystemAllowed -Operation ("Invoke-WeFlowExternalCommand({0})" -f $FilePath)

  $argumentLine = ConvertTo-WeFlowWindowsArgumentLine -Arguments $Arguments

  $info = New-Object System.Diagnostics.ProcessStartInfo
  $info.FileName = $FilePath
  $info.Arguments = $argumentLine
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  if ($WorkingDirectory) { $info.WorkingDirectory = $WorkingDirectory }

  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $info
  [void]$process.Start()
  $stdout = $process.StandardOutput.ReadToEnd()
  $stderr = $process.StandardError.ReadToEnd()
  $process.WaitForExit()
  return [pscustomobject]@{
    ExitCode = $process.ExitCode
    StdOut   = $stdout
    StdErr   = $stderr
  }
}

function Get-WeFlowCommandPath {
  <#
  .SYNOPSIS
    查询外部工具路径（不存在返回 $null）。
  #>
  param([Parameter(Mandatory)][string]$Name)
  Assert-WeFlowNativeRealSystemAllowed -Operation ("Get-WeFlowCommandPath({0})" -f $Name)
  $command = Get-Command -Name $Name -ErrorAction SilentlyContinue
  if ($null -eq $command) { return $null }
  return $command.Source
}

function Get-WeFlowProcessById {
  <#
  .SYNOPSIS
    按 PID 读取进程身份（PID / 可执行路径 / 启动时间），不存在返回 $null。
  #>
  param([Parameter(Mandatory)][int]$Id)
  Assert-WeFlowNativeRealSystemAllowed -Operation ("Get-WeFlowProcessById({0})" -f $Id)
  $process = Get-Process -Id $Id -ErrorAction SilentlyContinue
  if ($null -eq $process) { return $null }
  $path = $null
  $startTime = $null
  try { $path = $process.Path } catch { $path = $null }
  try { $startTime = $process.StartTime } catch { $startTime = $null }
  return [pscustomobject]@{ Id = $process.Id; Path = $path; StartTime = $startTime }
}

function Start-WeFlowCaddyProcess {
  <#
  .SYNOPSIS
    以隐藏窗口方式启动原生 Caddy 进程，返回 PID / 可执行路径 / 启动时间。
  .DESCRIPTION
    参数必须构造为**一条已正确加引号的命令行字符串**再交给 -ArgumentList：
    直接传数组会被 Start-Process 用空格拼接（含空格的路径被拆坏），
    这个缺陷在带 mock 的测试里看不见，因为 mock 不经过 CreateProcess。
  #>
  param(
    [Parameter(Mandatory)][string]$ExePath,
    [Parameter(Mandatory)][string[]]$Arguments,
    [Parameter(Mandatory)][string]$StdOutPath,
    [Parameter(Mandatory)][string]$StdErrPath
  )
  Assert-WeFlowNativeRealSystemAllowed -Operation ("Start-WeFlowCaddyProcess({0})" -f $ExePath)
  $argumentLine = ConvertTo-WeFlowWindowsArgumentLine -Arguments $Arguments
  $process = Start-Process -FilePath $ExePath -ArgumentList $argumentLine `
    -RedirectStandardOutput $StdOutPath -RedirectStandardError $StdErrPath `
    -PassThru -WindowStyle Hidden
  $startTime = $null
  try { $startTime = $process.StartTime } catch { $startTime = $null }
  return [pscustomobject]@{ Id = $process.Id; Path = $ExePath; StartTime = $startTime; ArgumentLine = $argumentLine }
}

function Stop-WeFlowProcessById {
  <#
  .SYNOPSIS
    结束指定 PID 的进程（调用方必须先完成身份核对）。
  #>
  param([Parameter(Mandatory)][int]$Id)
  Assert-WeFlowNativeRealSystemAllowed -Operation ("Stop-WeFlowProcessById({0})" -f $Id)
  Stop-Process -Id $Id -Force
}

function Get-WeFlowNetTcpListener {
  <#
  .SYNOPSIS
    读取指定端口的 TCP 监听项（只读）。
  #>
  param([Parameter(Mandatory)][int]$Port)
  Assert-WeFlowNativeRealSystemAllowed -Operation ("Get-WeFlowNetTcpListener({0})" -f $Port)
  $listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
  $result = @()
  foreach ($listener in $listeners) {
    $result += [pscustomobject]@{
      LocalAddress  = $listener.LocalAddress
      LocalPort     = $listener.LocalPort
      OwningProcess = $listener.OwningProcess
    }
  }
  return $result
}

function Get-WeFlowLocalIPv4 {
  <#
  .SYNOPSIS
    读取本机 IPv4 地址清单（含接口名与来源），用于校验绑定地址归属。
  #>
  Assert-WeFlowNativeRealSystemAllowed -Operation 'Get-WeFlowLocalIPv4'
  $addresses = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue)
  $result = @()
  foreach ($address in $addresses) {
    $result += [pscustomobject]@{
      IPAddress      = $address.IPAddress
      InterfaceAlias = $address.InterfaceAlias
      PrefixOrigin   = $address.PrefixOrigin
    }
  }
  return $result
}

function Test-WeFlowPathExists {
  param([Parameter(Mandatory)][string]$Path, [switch]$Leaf)
  Assert-WeFlowNativeRealSystemAllowed -Operation ("Test-WeFlowPathExists({0})" -f $Path)
  if ($Leaf) { return (Test-Path -LiteralPath $Path -PathType Leaf) }
  return (Test-Path -LiteralPath $Path)
}

function Get-WeFlowFileHash {
  <#
  .SYNOPSIS
    计算文件 SHA-256（小写十六进制）。
  #>
  param([Parameter(Mandatory)][string]$Path)
  Assert-WeFlowNativeRealSystemAllowed -Operation ("Get-WeFlowFileHash({0})" -f $Path)
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Read-WeFlowTextFile {
  <#
  .SYNOPSIS
    以显式 UTF-8 读取文本文件（含无 BOM 的 UTF-8）。
  .DESCRIPTION
    Windows PowerShell 5.1 的 Get-Content 默认按 ANSI（中文系统 CP936）解码，
    会把无 BOM 的 UTF-8 模板读成乱码。这里统一走 .NET 的 UTF-8 解码，
    带不带 BOM 都能正确读取。
  #>
  param([Parameter(Mandatory)][string]$Path)
  Assert-WeFlowNativeRealSystemAllowed -Operation ("Read-WeFlowTextFile({0})" -f $Path)
  return [System.IO.File]::ReadAllText($Path, (New-Object System.Text.UTF8Encoding($false)))
}

function Write-WeFlowTextFile {
  param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][AllowEmptyString()][string]$Content)
  Assert-WeFlowNativeRealSystemAllowed -Operation ("Write-WeFlowTextFile({0})" -f $Path)
  $directory = Split-Path -Parent $Path
  if ($directory -and -not (Test-Path -LiteralPath $directory)) {
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
  }
  $encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Content, $encoding)
}

function New-WeFlowDirectory {
  param([Parameter(Mandatory)][string]$Path)
  Assert-WeFlowNativeRealSystemAllowed -Operation ("New-WeFlowDirectory({0})" -f $Path)
  if (-not (Test-Path -LiteralPath $Path)) {
    New-Item -ItemType Directory -Force -Path $Path | Out-Null
    return $true
  }
  return $false
}

function Remove-WeFlowFilePath {
  param([Parameter(Mandatory)][string]$Path)
  Assert-WeFlowNativeRealSystemAllowed -Operation ("Remove-WeFlowFilePath({0})" -f $Path)
  Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
}

function Move-WeFlowFilePath {
  param([Parameter(Mandatory)][string]$Source, [Parameter(Mandatory)][string]$Destination, [switch]$Overwrite)
  Assert-WeFlowNativeRealSystemAllowed -Operation ("Move-WeFlowFilePath({0} -> {1})" -f $Source, $Destination)
  if ($Overwrite) { Move-Item -LiteralPath $Source -Destination $Destination -Force }
  else { Move-Item -LiteralPath $Source -Destination $Destination }
}

function Copy-WeFlowFilePath {
  param([Parameter(Mandatory)][string]$Source, [Parameter(Mandatory)][string]$Destination, [switch]$Overwrite)
  Assert-WeFlowNativeRealSystemAllowed -Operation ("Copy-WeFlowFilePath({0} -> {1})" -f $Source, $Destination)
  if ($Overwrite) { Copy-Item -LiteralPath $Source -Destination $Destination -Force }
  else { Copy-Item -LiteralPath $Source -Destination $Destination }
}

function Expand-WeFlowArchiveZip {
  param([Parameter(Mandatory)][string]$ArchivePath, [Parameter(Mandatory)][string]$DestinationPath)
  Assert-WeFlowNativeRealSystemAllowed -Operation ("Expand-WeFlowArchiveZip({0})" -f $ArchivePath)
  Expand-Archive -LiteralPath $ArchivePath -DestinationPath $DestinationPath -Force
}

function Get-WeFlowAcl {
  <#
  .SYNOPSIS
    读取目录/文件的访问控制项（只读）。
  #>
  param([Parameter(Mandatory)][string]$Path)
  Assert-WeFlowNativeRealSystemAllowed -Operation ("Get-WeFlowAcl({0})" -f $Path)
  $acl = Get-Acl -LiteralPath $Path
  $entries = @()
  foreach ($entry in $acl.Access) {
    $entries += [pscustomobject]@{
      IdentityReference = $entry.IdentityReference.Value
      FileSystemRights  = $entry.FileSystemRights.ToString()
      AccessControlType = $entry.AccessControlType.ToString()
      IsInherited       = $entry.IsInherited
    }
  }
  return $entries
}

function Test-WeFlowAclInheritanceProtected {
  <#
  .SYNOPSIS
    判断目录 ACL 是否已断开继承（AreAccessRulesProtected）。
  .DESCRIPTION
    只看保护标记，不读取任何文件内容。
    「没有继承项」与「继承已被切断」不是同一件事：继承仍开着时，之后新建的子目录
    会重新获得父级的旧规则——上一轮 PKI 目录的 Users / Authenticated Users 访问权
    正是这样回来的。因此把保护标记也作为硬条件核验。
  #>
  param([Parameter(Mandatory)][string]$Path)
  Assert-WeFlowNativeRealSystemAllowed -Operation ("Test-WeFlowAclInheritanceProtected({0})" -f $Path)
  $acl = Get-Acl -LiteralPath $Path
  return [bool]$acl.AreAccessRulesProtected
}

function Set-WeFlowRestrictedAcl {
  <#
  .SYNOPSIS
    把目录 ACL 收紧为「仅部署账户 + SYSTEM + Administrators」，并断开继承。
  #>
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][string]$DeploymentAccount
  )
  Assert-WeFlowNativeRealSystemAllowed -Operation ("Set-WeFlowRestrictedAcl({0})" -f $Path)
  $acl = Get-Acl -LiteralPath $Path
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRule($rule) }
  $rights = [System.Security.AccessControl.FileSystemRights]::FullControl
  $inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
  $propagate = [System.Security.AccessControl.PropagationFlags]::None
  $allow = [System.Security.AccessControl.AccessControlType]::Allow
  foreach ($identity in @($DeploymentAccount, 'SYSTEM', 'Administrators')) {
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($identity, $rights, $inherit, $propagate, $allow)
    $acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $Path -AclObject $acl
}

function Test-WeFlowAclIsRestricted {
  <#
  .SYNOPSIS
    校验 ACL 仅包含「部署账户 + SYSTEM + Administrators」，且无继承来的宽泛主体。
  #>
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][string]$DeploymentAccount
  )
  $entries = Get-WeFlowAcl -Path $Path
  $allowed = @($DeploymentAccount, 'SYSTEM', 'Administrators', 'BUILTIN\Administrators', 'NT AUTHORITY\SYSTEM')
  $problems = @()
  if (-not (Test-WeFlowAclInheritanceProtected -Path $Path)) {
    $problems += 'ACL 仍启用继承（AreAccessRulesProtected=false），新建子目录会重新获得旧规则'
  }
  foreach ($entry in $entries) {
    if ($entry.IsInherited) { $problems += ("存在继承项：{0}" -f $entry.IdentityReference); continue }
    $identity = $entry.IdentityReference
    $shortName = $identity
    if ($identity.Contains('\')) { $shortName = $identity.Split('\')[-1] }
    $isAllowed = $false
    foreach ($candidate in $allowed) {
      if ($identity -eq $candidate -or $shortName -eq $candidate) { $isAllowed = $true; break }
    }
    if (-not $isAllowed) { $problems += ("非允许主体：{0}" -f $identity) }
  }
  return [pscustomobject]@{ Ok = ($problems.Count -eq 0); Problems = $problems }
}

function Invoke-WeFlowHttpRequest {
  <#
  .SYNOPSIS
    只读 HTTP 探测（无凭据、无请求体），返回状态码与响应体。
  #>
  param(
    [Parameter(Mandatory)][string]$Url,
    [int]$TimeoutSec = 5
  )
  Assert-WeFlowNativeRealSystemAllowed -Operation ("Invoke-WeFlowHttpRequest({0})" -f $Url)
  try {
    $response = Invoke-WebRequest -Uri $Url -TimeoutSec $TimeoutSec -UseBasicParsing
    return [pscustomobject]@{ Ok = $true; StatusCode = [int]$response.StatusCode; Content = [string]$response.Content; Error = $null }
  } catch {
    $status = $null
    $body = $null
    if ($null -ne $_.Exception.Response) {
      try { $status = [int]$_.Exception.Response.StatusCode } catch { $status = $null }
      try {
        $stream = $_.Exception.Response.GetResponseStream()
        $reader = New-Object System.IO.StreamReader($stream)
        $body = $reader.ReadToEnd()
        $reader.Dispose()
      } catch { $body = $null }
    }
    return [pscustomobject]@{ Ok = $false; StatusCode = $status; Content = $body; Error = $_.Exception.Message }
  }
}

# =====================================================================
# 4. 组合层：只做参数拼装与结果解释，全部经由上面的叶子函数
# =====================================================================

function ConvertTo-WeFlowComposeInvocation {
  <#
  .SYNOPSIS
    生成固定的 Compose 调用参数（项目名与两个配置文件写死，调用方无法覆盖）。
  #>
  param([Parameter(Mandatory)][string[]]$ComposeArgs)
  return @('compose', '-p', 'weflow-test', '--env-file', 'central/proxy.env',
           '-f', 'docker-compose.central.yml', '-f', 'docker-compose.central.tls.yml') + $ComposeArgs
}

function Test-WeFlowComposeSubcommandAllowed {
  <#
  .SYNOPSIS
    只允许 stop / start / ps / config；down / rm / up 一律拒绝。
  #>
  param([Parameter(Mandatory)][AllowEmptyString()][string]$Subcommand)
  return @('stop', 'start', 'ps', 'config') -contains $Subcommand
}

function Invoke-WeFlowDocker {
  <#
  .SYNOPSIS
    在固定项目名与固定两个 -f 文件下执行一条 Compose 子命令。
  .DESCRIPTION
    返回 @{ ExitCode; StdOut; StdErr }：stdout 与退出码严格分离。
    子命令白名单之外的调用直接 throw。
  #>
  param(
    [Parameter(Mandatory)][string[]]$ComposeArgs,
    [Parameter(Mandatory)][string]$ReleaseDir
  )
  if ($ComposeArgs.Count -lt 1) { throw 'Compose 调用缺少子命令' }
  if (-not (Test-WeFlowComposeSubcommandAllowed -Subcommand $ComposeArgs[0])) {
    throw ("Compose 子命令不在允许清单（stop/start/ps/config）内：{0}" -f $ComposeArgs[0])
  }
  $arguments = ConvertTo-WeFlowComposeInvocation -ComposeArgs $ComposeArgs
  return Invoke-WeFlowExternalCommand -FilePath 'docker' -Arguments $arguments -WorkingDirectory $ReleaseDir
}

function Get-WeFlowContainerCaddyState {
  <#
  .SYNOPSIS
    读取容器 caddy 状态；读取失败（退出码非零）时抛错，拒绝在该基础上切换。
  #>
  param([Parameter(Mandatory)][string]$ReleaseDir)
  $result = Invoke-WeFlowDocker -ComposeArgs @('ps', 'caddy') -ReleaseDir $ReleaseDir
  if ($result.ExitCode -ne 0) {
    throw ("无法读取容器 caddy 状态：docker compose ps 退出码 {0}；{1}" -f $result.ExitCode, ($result.StdErr.Trim()))
  }
  $text = ($result.StdOut + "`n" + $result.StdErr)
  $running = ($text -match '(?m)\bUp\b') -or ($text -match '(?m)\brunning\b')
  return [pscustomobject]@{ ExitCode = $result.ExitCode; Running = $running; RawOutput = $text }
}

function Test-WeFlowBindIpIsLocalPhysical {
  <#
  .SYNOPSIS
    校验绑定地址确实属于本机，且不落在已知虚拟/回环接口上。
  #>
  param([Parameter(Mandatory)][string]$BindIp)
  $addresses = Get-WeFlowLocalIPv4
  $match = $null
  foreach ($address in $addresses) {
    if ($address.IPAddress -eq $BindIp) { $match = $address; break }
  }
  if ($null -eq $match) { return [pscustomobject]@{ Ok = $false; Reason = '该地址不属于本机' } }
  $alias = [string]$match.InterfaceAlias
  if ($alias -match '^(vEthernet|Loopback|Default Switch|Bluetooth)') {
    return [pscustomobject]@{ Ok = $false; Reason = ("绑定地址位于虚拟/回环接口上：{0}" -f $alias) }
  }
  return [pscustomobject]@{ Ok = $true; Reason = $alias }
}

function Read-WeFlowNativeEnv {
  <#
  .SYNOPSIS
    读取并校验 native.env，返回强类型配置哈希表。
  #>
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][string]$CaddyfileTemplatePath
  )

  if (-not (Test-WeFlowPathExists -Path $Path -Leaf)) {
    throw "缺少部署参数文件：$Path（先复制 central\windows-caddy\native.env.example 并逐项确认）"
  }
  if (-not (Test-WeFlowPathExists -Path $CaddyfileTemplatePath -Leaf)) {
    throw "缺少 Caddyfile 模板：$CaddyfileTemplatePath"
  }

  $values = @{}
  foreach ($line in ((Read-WeFlowTextFile -Path $Path) -split "`r?`n")) {
    $trimmed = $line.Trim()
    if ($trimmed -eq '' -or $trimmed.StartsWith('#')) { continue }
    $parts = $trimmed.Split('=', 2)
    if ($parts.Count -ne 2) { throw "native.env 存在无法解析的行：$trimmed" }
    $name = $parts[0].Trim()
    if ($values.ContainsKey($name)) { throw "native.env 出现重复键：$name" }
    $values[$name] = $parts[1].Trim()
  }

  $required = @(
    'WEFLOW_NATIVE_BIND_IP', 'WEFLOW_NATIVE_ALLOWED_CIDR', 'WEFLOW_NATIVE_HOSTNAME',
    'WEFLOW_NATIVE_ROOT', 'WEFLOW_NATIVE_CONFIG_DIR', 'WEFLOW_NATIVE_LOG_DIR',
    'WEFLOW_NATIVE_PKI_DIR', 'WEFLOW_NATIVE_BIN_DIR', 'WEFLOW_NATIVE_CADDY_EXE',
    'WEFLOW_NATIVE_CADDYFILE', 'WEFLOW_NATIVE_STATE_DIR', 'WEFLOW_NATIVE_UPSTREAM'
  )
  foreach ($name in $required) {
    if (-not $values.ContainsKey($name) -or [string]::IsNullOrWhiteSpace($values[$name])) {
      throw "native.env 缺少必填项或值为空：$name"
    }
  }
  foreach ($key in @($values.Keys)) {
    if ($key -notmatch '^WEFLOW_NATIVE_[A-Z0-9_]+$') { throw "native.env 存在未预期的键名：$key" }
  }

  $bindIp = $values['WEFLOW_NATIVE_BIND_IP']
  if (Test-WeFlowWildcardAddress -Value $bindIp) {
    throw "WEFLOW_NATIVE_BIND_IP 不允许是通配地址或空值：'$bindIp'（必须是本机物理 IPv4）"
  }
  if (-not (Test-WeFlowIpv4Literal -Value $bindIp)) {
    throw "WEFLOW_NATIVE_BIND_IP 必须是点分十进制 IPv4 字面量：'$bindIp'"
  }

  $cidr = $values['WEFLOW_NATIVE_ALLOWED_CIDR']
  if (-not (Test-WeFlowPrivateCidr -Value $cidr)) {
    throw "WEFLOW_NATIVE_ALLOWED_CIDR 必须是受限私有 IPv4 CIDR（RFC1918、规范网络地址；拒绝 0.0.0.0/0、::/0、公网段、主机位非零）：'$cidr'"
  }

  $hostname = $values['WEFLOW_NATIVE_HOSTNAME']
  if (-not (Test-WeFlowHostname -Value $hostname)) {
    throw "WEFLOW_NATIVE_HOSTNAME 不是安全主机名（只允许 DNS 标签，禁止空格、斜杠、花括号、引号等注入字符）：'$hostname'"
  }

  $upstream = $values['WEFLOW_NATIVE_UPSTREAM']
  if ($upstream -ne '127.0.0.1:8787') {
    throw "WEFLOW_NATIVE_UPSTREAM 只允许 127.0.0.1:8787（不得指向 LAN 或容器网络）：'$upstream'"
  }

  $root = $values['WEFLOW_NATIVE_ROOT']
  if (-not (Test-WeFlowAbsoluteWindowsPath -Value $root)) {
    throw "WEFLOW_NATIVE_ROOT 必须是绝对 Windows 路径（形如 F:\WeFlow-Test）：'$root'"
  }
  if (-not (Test-WeFlowAllowedDeploymentRoot -Root $root)) {
    throw "WEFLOW_NATIVE_ROOT 只允许既定部署根 F:\WeFlow-Test：'$root'"
  }

  $pathKeys = @('WEFLOW_NATIVE_ROOT', 'WEFLOW_NATIVE_CONFIG_DIR', 'WEFLOW_NATIVE_LOG_DIR',
                'WEFLOW_NATIVE_PKI_DIR', 'WEFLOW_NATIVE_BIN_DIR', 'WEFLOW_NATIVE_CADDY_EXE',
                'WEFLOW_NATIVE_CADDYFILE', 'WEFLOW_NATIVE_STATE_DIR')
  foreach ($name in $pathKeys) {
    $value = $values[$name]
    if (-not (Test-WeFlowAbsoluteWindowsPath -Value $value)) {
      throw "$name 必须是绝对 Windows 路径（形如 F:\WeFlow-Test\...）：'$value'"
    }
    if ($value.StartsWith('\\')) { throw "$name 不允许是 UNC 路径：'$value'" }
    if (Test-WeFlowPathTraversal -Value $value) { throw "$name 含 .. 路径穿越片段：'$value'" }
    if (-not (Test-WeFlowPathIsCanonical -Value $value)) { throw "$name 不是规范化路径：'$value'" }
    if (-not (Test-WeFlowPathUnderRoot -Path $value -Root $root)) {
      throw "$name 必须位于部署根 $root 之下：'$value'"
    }
  }

  return @{
    BindIp            = $bindIp
    AllowedCidr       = $cidr
    Hostname          = $hostname
    Root              = $root
    ConfigDir         = $values['WEFLOW_NATIVE_CONFIG_DIR']
    LogDir            = $values['WEFLOW_NATIVE_LOG_DIR']
    PkiDir            = $values['WEFLOW_NATIVE_PKI_DIR']
    BinDir            = $values['WEFLOW_NATIVE_BIN_DIR']
    CaddyExe          = $values['WEFLOW_NATIVE_CADDY_EXE']
    Caddyfile         = $values['WEFLOW_NATIVE_CADDYFILE']
    StateDir          = $values['WEFLOW_NATIVE_STATE_DIR']
    Upstream          = $upstream
    CaddyfileTemplate = $CaddyfileTemplatePath
  }
}

function New-WeFlowRenderedCaddyfile {
  <#
  .SYNOPSIS
    把模板占位符替换成显式值，渲染出可运行 Caddyfile。
  .DESCRIPTION
    只替换已知占位符；渲染后若仍残留 `{$` 占位符则直接失败。
    目标路径必须位于部署根之下，且不得含 .. 穿越。
  #>
  param(
    [Parameter(Mandatory)][hashtable]$Config,
    [Parameter(Mandatory)][string]$Destination
  )

  if (-not (Test-WeFlowPathUnderRoot -Path $Destination -Root $Config.Root)) {
    throw "渲染目标必须位于部署根 $($Config.Root) 之下：$Destination"
  }
  if (Test-WeFlowPathTraversal -Value $Destination) {
    throw "渲染目标含 .. 路径穿越片段：$Destination"
  }

  $template = Read-WeFlowTextFile -Path $Config.CaddyfileTemplate
  $map = [ordered]@{
    '{$WEFLOW_NATIVE_BIND_IP}'      = $Config.BindIp
    '{$WEFLOW_NATIVE_ALLOWED_CIDR}' = $Config.AllowedCidr
    '{$WEFLOW_NATIVE_HOSTNAME}'     = $Config.Hostname
    '{$WEFLOW_NATIVE_LOG_DIR}'      = $Config.LogDir
    '{$WEFLOW_NATIVE_PKI_DIR}'      = $Config.PkiDir
  }
  foreach ($key in $map.Keys) {
    $template = $template.Replace($key, [string]$map[$key])
  }

  if ($template -match '\{\$') {
    $leftover = ([regex]::Matches($template, '\{\$[A-Z0-9_]+\}') | ForEach-Object { $_.Value } | Select-Object -Unique) -join ', '
    throw "渲染后仍存在未替换占位符：$leftover"
  }

  Write-WeFlowTextFile -Path $Destination -Content $template
  return $Destination
}

function Compare-WeFlowFileContent {
  <#
  .SYNOPSIS
    比较两个文本文件内容是否一致（任一侧不存在返回 $false）。
  #>
  param(
    [Parameter(Mandatory)][string]$PathA,
    [Parameter(Mandatory)][string]$PathB
  )
  if (-not (Test-WeFlowPathExists -Path $PathA -Leaf)) { return $false }
  if (-not (Test-WeFlowPathExists -Path $PathB -Leaf)) { return $false }
  return ((Read-WeFlowTextFile -Path $PathA) -eq (Read-WeFlowTextFile -Path $PathB))
}

# =====================================================================
# 5. 端点响应契约（诊断脚本与测试共用同一份定义）
# =====================================================================

$script:WeFlowHealthContract = @{ Service = 'weflow-central'; ProtocolVersion = 1 }
$script:WeFlowReadyContract = @{ Database = 'ready' }

function Get-WeFlowEndpointExpectation {
  param([Parameter(Mandatory)][string]$Path)
  switch ($Path) {
    '/health' { return @{ Kind = 'health'; Service = $script:WeFlowHealthContract.Service; ProtocolVersion = $script:WeFlowHealthContract.ProtocolVersion } }
    '/ready'  { return @{ Kind = 'ready'; Database = $script:WeFlowReadyContract.Database } }
    default   { throw "未知端点：$Path" }
  }
}

function Test-WeFlowEndpointPayload {
  <#
  .SYNOPSIS
    校验端点响应体是否符合既有契约（ok=true + 具体字段与类型）。
  .DESCRIPTION
    逐项做**类型**检查，不用强制转换把错误的值洗白：
      - ok 必须是 JSON 布尔 true（字符串 "true"、1、缺失都算失败）；
      - data 必须存在且是对象；
      - service / database 必须是字符串且逐字符相等（不做大小写或前后空格容忍）；
      - protocolVersion 必须是 **JSON 整数**且等于期望值：
        字符串 "1"、小数 1.0、布尔、缺失一律失败——把类型错误当成通过，
        等于让「协议版本对不上」这种真实故障在本机验收里消失。
    返回 [pscustomobject]@{ Ok; Reason }。
  #>
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][AllowEmptyString()][string]$Body
  )
  $expectation = Get-WeFlowEndpointExpectation -Path $Path
  if ([string]::IsNullOrWhiteSpace($Body)) { return [pscustomobject]@{ Ok = $false; Reason = '响应为空' } }
  $json = $null
  try { $json = $Body | ConvertFrom-Json } catch { return [pscustomobject]@{ Ok = $false; Reason = '响应不是合法 JSON' } }
  if ($null -eq $json) { return [pscustomobject]@{ Ok = $false; Reason = '响应为空' } }

  $rootProperties = $json.PSObject.Properties
  $okProperty = $rootProperties['ok']
  if ($null -eq $okProperty) { return [pscustomobject]@{ Ok = $false; Reason = '响应缺少 ok 字段' } }
  $okValue = $okProperty.Value
  if ($okValue -isnot [bool]) {
    $okTypeName = if ($null -eq $okValue) { 'null' } else { $okValue.GetType().Name }
    return [pscustomobject]@{ Ok = $false; Reason = ('ok 字段类型不是布尔（实际 {0}）' -f $okTypeName) }
  }
  if (-not $okValue) { return [pscustomobject]@{ Ok = $false; Reason = 'ok 不是 true' } }

  $dataProperty = $rootProperties['data']
  if ($null -eq $dataProperty) { return [pscustomobject]@{ Ok = $false; Reason = '响应缺少 data 字段' } }
  $data = $dataProperty.Value
  if ($null -eq $data) { return [pscustomobject]@{ Ok = $false; Reason = 'data 字段为 null' } }
  $dataProperties = $data.PSObject.Properties

  if ($expectation.Kind -eq 'health') {
    $serviceProperty = $dataProperties['service']
    if ($null -eq $serviceProperty) { return [pscustomobject]@{ Ok = $false; Reason = '缺少 data.service' } }
    $service = $serviceProperty.Value
    if ($service -isnot [string]) {
      $serviceTypeName = if ($null -eq $service) { 'null' } else { $service.GetType().Name }
      return [pscustomobject]@{ Ok = $false; Reason = ('data.service 类型不是字符串（实际 {0}）' -f $serviceTypeName) }
    }
    if (-not [string]::Equals($service, [string]$expectation.Service, [System.StringComparison]::Ordinal)) {
      return [pscustomobject]@{ Ok = $false; Reason = "service 不是 $($expectation.Service)" }
    }
    $versionProperty = $dataProperties['protocolVersion']
    if ($null -eq $versionProperty) { return [pscustomobject]@{ Ok = $false; Reason = '缺少 data.protocolVersion' } }
    $version = $versionProperty.Value
    $isInteger = ($version -is [int]) -or ($version -is [long]) -or ($version -is [int16]) -or ($version -is [byte])
    if (-not $isInteger) {
      $actualType = if ($null -eq $version) { 'null' } else { $version.GetType().Name }
      return [pscustomobject]@{ Ok = $false; Reason = ("data.protocolVersion 必须是 JSON 整数，实际类型 {0}" -f $actualType) }
    }
    if ([long]$version -ne [long]$expectation.ProtocolVersion) {
      return [pscustomobject]@{ Ok = $false; Reason = "protocolVersion 不是 $($expectation.ProtocolVersion)" }
    }
  } else {
    $databaseProperty = $dataProperties['database']
    if ($null -eq $databaseProperty) { return [pscustomobject]@{ Ok = $false; Reason = '缺少 data.database' } }
    $database = $databaseProperty.Value
    if ($database -isnot [string]) {
      $databaseTypeName = if ($null -eq $database) { 'null' } else { $database.GetType().Name }
      return [pscustomobject]@{ Ok = $false; Reason = ('data.database 类型不是字符串（实际 {0}）' -f $databaseTypeName) }
    }
    if (-not [string]::Equals($database, [string]$expectation.Database, [System.StringComparison]::Ordinal)) {
      return [pscustomobject]@{ Ok = $false; Reason = "database 不是 $($expectation.Database)" }
    }
  }
  return [pscustomobject]@{ Ok = $true; Reason = 'ok' }
}

function Get-WeFlowProbeBackends {
  <#
  .SYNOPSIS
    按优先级返回可用探测后端：curl 优先，python 兜底。
  #>
  $backends = @()
  $curl = Get-WeFlowCommandPath -Name 'curl.exe'
  if (-not $curl) { $curl = Get-WeFlowCommandPath -Name 'curl' }
  if ($curl) { $backends += [pscustomobject]@{ Name = 'curl'; Path = $curl } }
  $python = Get-WeFlowCommandPath -Name 'python.exe'
  if (-not $python) { $python = Get-WeFlowCommandPath -Name 'python' }
  if ($python) { $backends += [pscustomobject]@{ Name = 'python'; Path = $python } }
  return $backends
}

function Invoke-WeFlowEndpointProbe {
  <#
  .SYNOPSIS
    对 https://<hostname><path> 做一次带完整证书校验的探测（进程级 CA 信任 + IP/SNI 映射）。
  .DESCRIPTION
    curl：--cacert <root.crt> --resolve <host>:443:<bindIp>，不使用 -k / --insecure；
    python：ssl.create_default_context(cafile=...) + server_hostname=<host>（完整链 + 主机名）。
    Schannel 对内部 CA 报「吊销状态未知」时视为后端不适用并回落 python；
    其它校验失败如实报错，绝不回退到跳过校验。
  #>
  param(
    [Parameter(Mandatory)][hashtable]$Config,
    [Parameter(Mandatory)][string]$CaCertPath,
    [Parameter(Mandatory)][string]$Path,
    [int]$TimeoutSec = 15
  )

  $backends = @(Get-WeFlowProbeBackends)
  if ($backends.Count -eq 0) {
    return [pscustomobject]@{ Backend = 'none'; ExitCode = 3; HttpStatus = $null; Body = ''; Category = 'backend-missing'; Message = '既没有 curl，也没有 python：无法在不跳过校验的前提下探测端点' }
  }

  $lastMessage = ''
  foreach ($backend in $backends) {
    if ($backend.Name -eq 'curl') {
      $arguments = @(
        '--silent', '--show-error', '--max-time', [string]$TimeoutSec,
        '--cacert', $CaCertPath,
        '--resolve', ("{0}:443:{1}" -f $Config.Hostname, $Config.BindIp),
        '-o', '-', '-w', "`n__WEFLOW_STATUS__%{http_code}",
        ("https://{0}{1}" -f $Config.Hostname, $Path)
      )
      $result = Invoke-WeFlowExternalCommand -FilePath $backend.Path -Arguments $arguments
      $stdOut = $result.StdOut
      $stdErr = $result.StdErr
      $status = $null
      if ($stdOut -match '__WEFLOW_STATUS__(\d{3})') { $status = [int]$Matches[1] }
      $body = ($stdOut -replace '(?s)\n?__WEFLOW_STATUS__\d{3}\s*$', '')

      if ($result.ExitCode -eq 0) {
        return [pscustomobject]@{ Backend = 'curl'; ExitCode = 0; HttpStatus = $status; Body = $body; Category = 'transport-ok'; Message = ("HTTP {0}" -f $status) }
      }
      if ($result.ExitCode -eq 60) {
        if ($stdErr -match 'revocation') {
          $lastMessage = 'curl(schannel) 无法判定吊销状态：后端不适用，回落 python'
          continue
        }
        return [pscustomobject]@{ Backend = 'curl'; ExitCode = 60; HttpStatus = $null; Body = ''; Category = 'tls-failure'; Message = ("TLS 校验失败：{0}" -f $stdErr.Trim()) }
      }
      if ($result.ExitCode -in @(7, 28, 35, 52)) {
        return [pscustomobject]@{ Backend = 'curl'; ExitCode = $result.ExitCode; HttpStatus = $null; Body = ''; Category = 'connection-failure'; Message = ("连接失败（退出码 {0}）：{1}" -f $result.ExitCode, $stdErr.Trim()) }
      }
      $lastMessage = ("curl 探测失败（退出码 {0}）：{1}" -f $result.ExitCode, $stdErr.Trim())
      continue
    }

    $scriptPath = Join-Path $PSScriptRoot 'WeFlowNative.HttpsProbe.py'
    if (-not (Test-WeFlowPathExists -Path $scriptPath -Leaf)) {
      $lastMessage = "缺少 python 探测脚本：$scriptPath"
      continue
    }
    $arguments = @($scriptPath, $Config.BindIp, $Config.Hostname, $Path, $CaCertPath, [string]$TimeoutSec)
    $result = Invoke-WeFlowExternalCommand -FilePath $backend.Path -Arguments $arguments
    $payload = $null
    try { $payload = $result.StdOut | ConvertFrom-Json } catch { $payload = $null }
    if ($null -eq $payload) {
      $lastMessage = ("python 探测无有效输出（退出码 {0}）：{1}" -f $result.ExitCode, ($result.StdErr.Trim() + ' ' + $result.StdOut.Trim()))
      continue
    }
    return [pscustomobject]@{
      Backend = 'python'; ExitCode = $result.ExitCode; HttpStatus = $payload.status
      Body = [string]$payload.body; Category = [string]$payload.category; Message = [string]$payload.message
    }
  }

  return [pscustomobject]@{ Backend = 'none'; ExitCode = 3; HttpStatus = $null; Body = ''; Category = 'backend-missing'; Message = $lastMessage }
}

function Get-WeFlowProbeExitCode {
  <#
  .SYNOPSIS
    把一次端点探测结果映射为诊断 / 验收的退出码。
  .DESCRIPTION
    0 = 正常（HTTP 200 且契约匹配）；其余全部非零：
      1 = 参数/配置错误（由调用方处理）；3 = 无可用探测后端；
      4 = TLS 校验失败；5 = 连接失败；6 = HTTP 状态非 200；7 = 契约不匹配；
      8 = 来源门禁拒绝（403）；9 = 响应协议错误（畸形 / 截断 / 超限）。
    403 不是「有响应就算通过」：它说明来源门禁把本次请求挡在门外，
    端点没有被真正验收，因此必须返回非零并触发既定回退。
  #>
  param([Parameter(Mandatory)][pscustomobject]$Probe)
  switch ($Probe.Category) {
    'backend-missing'    { return 3 }
    'tls-failure'        { return 4 }
    'connection-failure' { return 5 }
    'http-error'         { return 6 }
    'contract-error'     { return 7 }
    'gate-403'           { return 8 }
    'protocol-error'     { return 9 }
  }
  if ($null -eq $Probe.HttpStatus) { return 5 }
  if ($Probe.HttpStatus -eq 403) { return 8 }
  if ($Probe.HttpStatus -ne 200) { return 6 }
  return 0
}

function Invoke-WeFlowEndpointAcceptance {
  <#
  .SYNOPSIS
    对一组端点做统一验收：TLS 校验 + HTTP 200 + 响应契约。
  .DESCRIPTION
    启动验收（Start-NativeCaddy）与端点诊断（Test-NativeCaddyEndpoint）**共用这一份判定**，
    避免出现「启动按一套标准、诊断按另一套标准」的两套阈值：
    同一份探测结果，在两个入口必须得出同一个结论。

    每个端点的结论只取决于三件事：探测结果的退出码（见 Get-WeFlowProbeExitCode）、
    状态码是否为 200、响应体是否满足 Test-WeFlowEndpointPayload 的契约。
    403（来源门禁拒绝）、非 200、契约不匹配、TLS/连接失败、协议错误一律不算通过。

    返回 [pscustomobject]@{ Ok; ExitCode; Items }，Items 每项含
    Path / Probe / ExitCode / ContractOk / Reason。
  .PARAMETER Config
    Read-WeFlowNativeEnv 返回的配置。
  .PARAMETER CaCertPath
    本轮原生 CA 的公开根证书路径（root.crt）。
  .PARAMETER Paths
    待验收端点，默认 /health 与 /ready。
  #>
  param(
    [Parameter(Mandatory)][hashtable]$Config,
    [Parameter(Mandatory)][string]$CaCertPath,
    [string[]]$Paths = @('/health', '/ready')
  )

  $items = @()
  $worstExit = 0
  foreach ($path in $Paths) {
    $probe = Invoke-WeFlowEndpointProbe -Config $Config -CaCertPath $CaCertPath -Path $path
    $exitCode = Get-WeFlowProbeExitCode -Probe $probe
    $reason = $probe.Message
    $contractOk = $false
    if ($exitCode -eq 0) {
      $contract = Test-WeFlowEndpointPayload -Path $path -Body ([string]$probe.Body)
      if ($contract.Ok) {
        $contractOk = $true
        $reason = 'ok'
      } else {
        $exitCode = 7
        $reason = ("响应契约不匹配：{0}" -f $contract.Reason)
      }
    }
    $items += [pscustomobject]@{
      Path       = $path
      Probe      = $probe
      ExitCode   = $exitCode
      ContractOk = $contractOk
      Reason     = $reason
    }
    if ($exitCode -ne 0 -and ($worstExit -eq 0 -or $exitCode -lt $worstExit)) { $worstExit = $exitCode }
  }

  return [pscustomobject]@{ Ok = ($worstExit -eq 0); ExitCode = $worstExit; Items = $items }
}

# =====================================================================
# 6. 进程记账与回退（Start / Stop 共用）
# =====================================================================

$script:WeFlowStartTimeToleranceSeconds = 2

# 结束进程后等待其真正消失的秒数（每个 PID 单独计时）。测试会把它调小。
$script:WeFlowProcessExitWaitSeconds = 5

function Test-WeFlowStartTimeMatches {
  <#
  .SYNOPSIS
    比较两次启动时间是否一致（容忍 JSON 往返的秒级精度损失）。
  #>
  param(
    [Parameter(Mandatory)][AllowNull()]$Expected,
    [Parameter(Mandatory)][AllowNull()]$Actual
  )
  if ($null -eq $Expected -or $null -eq $Actual) { return $false }
  try {
    $expectedTime = [datetime]$Expected
    $actualTime = [datetime]$Actual
  } catch {
    return $false
  }
  $delta = [math]::Abs(($expectedTime - $actualTime).TotalSeconds)
  return ($delta -le $script:WeFlowStartTimeToleranceSeconds)
}

function Read-WeFlowNativeProcessState {
  <#
  .SYNOPSIS
    读取 native-caddy.current.json（不存在返回 $null）。
  #>
  param([Parameter(Mandatory)][string]$StatePath)
  if (-not (Test-WeFlowPathExists -Path $StatePath -Leaf)) { return $null }
  try {
    return (Read-WeFlowTextFile -Path $StatePath) | ConvertFrom-Json
  } catch {
    throw ("状态文件无法解析：{0}（{1}）" -f $StatePath, $_.Exception.Message)
  }
}

function Get-WeFlowNativeProcessOwnership {
  <#
  .SYNOPSIS
    核对 PID 是否仍属于「本轮记录的那个进程」：PID 存活 + 规范化路径一致 + 启动时间一致。
  .DESCRIPTION
    PID 复用（PID 存活但身份不符）必须被识别为 NotOwned，绝不能据此结束进程。
  #>
  param([Parameter(Mandatory)][AllowNull()]$State)
  if ($null -eq $State) { return [pscustomobject]@{ Status = 'no-state'; Process = $null; Message = '没有状态记录' } }
  $process = Get-WeFlowProcessById -Id ([int]$State.Pid)
  if ($null -eq $process) { return [pscustomobject]@{ Status = 'not-running'; Process = $null; Message = ("PID {0} 已不存在" -f $State.Pid) } }

  $expectedPath = [string]$State.ExecutablePath
  $actualPath = [string]$process.Path
  if ([string]::IsNullOrWhiteSpace($actualPath)) {
    return [pscustomobject]@{ Status = 'identity-unknown'; Process = $process; Message = ("PID {0} 无法读取可执行路径，拒绝操作" -f $State.Pid) }
  }
  if (-not [string]::Equals($actualPath, $expectedPath, [System.StringComparison]::OrdinalIgnoreCase)) {
    return [pscustomobject]@{ Status = 'identity-mismatch'; Process = $process; Message = ("PID {0} 的可执行路径为 '{1}'，与本轮记录的 '{2}' 不符（PID 复用），拒绝结束该进程" -f $State.Pid, $actualPath, $expectedPath) }
  }
  if (-not (Test-WeFlowStartTimeMatches -Expected $State.StartedAt -Actual $process.StartTime)) {
    return [pscustomobject]@{ Status = 'identity-mismatch'; Process = $process; Message = ("PID {0} 的启动时间与本轮记录不符（PID 复用），拒绝结束该进程" -f $State.Pid) }
  }
  return [pscustomobject]@{ Status = 'owned'; Process = $process; Message = ("PID {0} 身份核对通过（{1}）" -f $State.Pid, $actualPath) }
}

function New-WeFlowProcessIdentityRecord {
  <#
  .SYNOPSIS
    采集本轮进程的**内存身份记录**（PID + 可执行路径 + 实际启动时间）。
  .DESCRIPTION
    启动后立即调用，并把结果留在调用方的内存里：回退时必须能在**没有任何磁盘记账**
    的情况下安全回收本轮进程（记账写入失败是真实故障，不能因此把进程留在系统里）。

    启动时间取不到时短暂重试：取不到就是「身份未知」，回退阶段会拒绝结束该 PID
    （宁可如实报告回退失败，也不结束一个身份不明的进程）。
  .PARAMETER Id
    已启动进程的 PID。
  .PARAMETER ExecutablePath
    本轮启动时使用的可执行文件路径。
  .PARAMETER StartTime
    启动时已取得的 StartTime（可为 $null，函数会自行重试补齐）。
  #>
  param(
    [Parameter(Mandatory)][int]$Id,
    [Parameter(Mandatory)][string]$ExecutablePath,
    $StartTime = $null
  )
  $startedAt = $StartTime
  $attempts = 0
  while ($null -eq $startedAt -and $attempts -lt 10) {
    $process = Get-WeFlowProcessById -Id $Id
    if ($null -ne $process) { $startedAt = $process.StartTime }
    if ($null -eq $startedAt) { Start-Sleep -Milliseconds 100 }
    $attempts++
  }
  return [pscustomobject]@{
    Pid            = [int]$Id
    ExecutablePath = $ExecutablePath
    StartedAt      = $startedAt
  }
}

function Stop-WeFlowOwnedProcess {
  <#
  .SYNOPSIS
    按一条进程记录（内存或磁盘）结束本轮进程，并**确认它确实退出**。
  .DESCRIPTION
    Ok 只有在「本轮进程已经不存在」时才为 $true：

      - 记录为 $null            -> 拒绝乱猜：Ok=$false（不知道是哪个进程，绝不动手）
      - 身份不符 / 身份未知     -> 拒绝结束：Ok=$false（PID 复用或无法核对，需人工介入）
      - 进程已不存在            -> Ok=$true（没有需要回收的东西）
      - 身份匹配                -> 结束，并轮询确认退出；超时仍存活 -> Ok=$false

    返回 [pscustomobject]@{ Attempted; Ok; Status; Message }，调用方只依据 Ok
    这个布尔值判定，「回退成功」不靠搜索日志文本。
  .PARAMETER Record
    进程记录：含 Pid / ExecutablePath / StartedAt 三个字段（见 New-WeFlowProcessIdentityRecord）。
  .PARAMETER ExitWaitSeconds
    结束后等待进程消失的秒数；超时未消失即判为回退失败。传 0 使用模块默认值
    （$script:WeFlowProcessExitWaitSeconds）。
  #>
  param(
    [Parameter(Mandatory)][AllowNull()]$Record,
    [double]$ExitWaitSeconds = 0
  )
  if ($ExitWaitSeconds -le 0) { $ExitWaitSeconds = $script:WeFlowProcessExitWaitSeconds }
  if ($null -eq $Record) {
    return [pscustomobject]@{ Attempted = $false; Ok = $false; Status = 'no-record'; Message = '没有可用的进程记录（内存与磁盘都没有），拒绝猜测并结束任何进程' }
  }

  $ownership = Get-WeFlowNativeProcessOwnership -State $Record
  if ($ownership.Status -eq 'not-running') {
    return [pscustomobject]@{ Attempted = $false; Ok = $true; Status = 'not-running'; Message = $ownership.Message }
  }
  if ($ownership.Status -ne 'owned') {
    return [pscustomobject]@{ Attempted = $false; Ok = $false; Status = $ownership.Status; Message = $ownership.Message }
  }

  Stop-WeFlowProcessById -Id ([int]$Record.Pid)

  $deadline = (Get-Date).AddSeconds($ExitWaitSeconds)
  while ((Get-Date) -lt $deadline) {
    if ($null -eq (Get-WeFlowProcessById -Id ([int]$Record.Pid))) {
      return [pscustomobject]@{ Attempted = $true; Ok = $true; Status = 'stopped'; Message = ("已结束 PID {0} 并确认退出（{1}）" -f $Record.Pid, $ownership.Message) }
    }
    Start-Sleep -Milliseconds 100
  }
  return [pscustomobject]@{
    Attempted = $true; Ok = $false; Status = 'still-running'
    Message = ("已要求结束 PID {0}，但 {1} 秒后该进程仍然存活：无法确认本轮进程已退出" -f $Record.Pid, $ExitWaitSeconds)
  }
}

function Stop-WeFlowNativeProcessIfOwned {
  <#
  .SYNOPSIS
    仅当 PID / 路径 / 启动时间三者都匹配本轮记账时才结束进程（磁盘记账入口）。
  .DESCRIPTION
    磁盘记账只是回退的**兜底来源之一**：调用方若能持有内存身份记录，
    应优先使用它（见 Stop-WeFlowOwnedProcess）。
  #>
  param([Parameter(Mandatory)][string]$StatePath)
  $state = Read-WeFlowNativeProcessState -StatePath $StatePath
  if ($null -eq $state) {
    return [pscustomobject]@{ Attempted = $false; Status = 'no-state'; Ok = $true; Message = '没有本轮状态记录，未结束任何进程' }
  }
  return Stop-WeFlowOwnedProcess -Record $state
}

function Restore-WeFlowContainerCaddy {
  <#
  .SYNOPSIS
    按切换前记录恢复容器 caddy；只恢复「本轮停止且原先运行」的服务。
  .DESCRIPTION
    原先未运行 → 不执行 start（不能凭空启动原本停止的服务）。
    恢复失败 → 返回 Ok=$false，调用方必须保留状态并以非零退出。
  #>
  param(
    [Parameter(Mandatory)][string]$ReleaseDir,
    [Parameter(Mandatory)][bool]$WasRunning
  )
  if (-not $WasRunning) {
    return [pscustomobject]@{ Attempted = $false; Ok = $true; Message = '原容器 caddy 此前未运行，不执行启动（只恢复本轮停止的服务）' }
  }
  $result = Invoke-WeFlowDocker -ComposeArgs @('start', 'caddy') -ReleaseDir $ReleaseDir
  if ($result.ExitCode -ne 0) {
    return [pscustomobject]@{
      Attempted = $true; Ok = $false
      Message = ("恢复容器 caddy 失败（docker compose start caddy 退出码 {0}）：{1}" -f $result.ExitCode, $result.StdErr.Trim())
    }
  }
  return [pscustomobject]@{ Attempted = $true; Ok = $true; Message = '已恢复原容器 caddy' }
}
