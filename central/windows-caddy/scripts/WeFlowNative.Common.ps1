<#
.SYNOPSIS
  原生 Windows Caddy 部署脚本的公共参数校验与配置渲染。

.DESCRIPTION
  被 install / start / stop / diagnostics / contract-guard 五个脚本共用。
  本文件只做两件事：把 native.env 读成强类型配置，以及在写盘前拒绝危险值。
  所有校验失败一律 `throw`，由调用方以非零退出，绝不静默兜底。
#>

Set-StrictMode -Version Latest

# 允许的私有 IPv4 网段：只接受 RFC1918 内的显式 CIDR。
$script:PrivateCidrPattern = '^(10\.\d{1,3}\.\d{1,3}\.\d{1,3}/(8|9|1[0-9]|2[0-9]|3[0-2])|' +
  '172\.(1[6-9]|2[0-9]|3[01])\.\d{1,3}\.\d{1,3}/(1[2-9]|2[0-9]|3[0-2])|' +
  '192\.168\.\d{1,3}\.\d{1,3}/(1[6-9]|2[0-9]|3[0-2]))$'

function Test-WeFlowIpv4Literal {
  <#
  .SYNOPSIS
    判断字符串是否为合法的点分十进制 IPv4 字面量。
  .DESCRIPTION
    只接受四段 0-255，不做主机名解析。IPv6 字面量一律返回 $false。
  #>
  param([Parameter(Mandatory)][AllowEmptyString()][string]$Value)
  if ([string]::IsNullOrWhiteSpace($Value)) { return $false }
  $parsed = $null
  if (-not [System.Net.IPAddress]::TryParse($Value, [ref]$parsed)) { return $false }
  return $parsed.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork
}

function Test-WeFlowWildcardAddress {
  <#
  .SYNOPSIS
    判断字符串是否为通配监听地址（0.0.0.0 / :: / * / 空串）。
  .DESCRIPTION
    这些值会让 Caddy 监听全部接口，必须显式拒绝而不是当成"默认值"。
  #>
  param([Parameter(Mandatory)][AllowEmptyString()][string]$Value)
  if ([string]::IsNullOrWhiteSpace($Value)) { return $true }
  return @('0.0.0.0', '::', '[::]', '*', '0.0.0.0/0', '::/0') -contains $Value.Trim()
}

function Test-WeFlowPrivateCidr {
  <#
  .SYNOPSIS
    判断字符串是否为受约束的私有 IPv4 CIDR。
  .DESCRIPTION
    拒绝 0.0.0.0/0、::/0 以及任何非私有段，防止"任意 CIDR"被写进配置。
  #>
  param([Parameter(Mandatory)][AllowEmptyString()][string]$Value)
  if ([string]::IsNullOrWhiteSpace($Value)) { return $false }
  return [regex]::IsMatch($Value.Trim(), $script:PrivateCidrPattern)
}

function Test-WeFlowAbsoluteWindowsPath {
  <#
  .SYNOPSIS
    判断字符串是否为绝对 Windows 路径（形如 F:\...）。
  .DESCRIPTION
    相对路径会让落点随工作目录漂移，PKI 可能被写进交付目录，必须拒绝。
  #>
  param([Parameter(Mandatory)][AllowEmptyString()][string]$Value)
  if ([string]::IsNullOrWhiteSpace($Value)) { return $false }
  return [regex]::IsMatch($Value.Trim(), '^[A-Za-z]:\\')
}

function Read-WeFlowNativeEnv {
  <#
  .SYNOPSIS
    读取并校验 native.env，返回强类型配置哈希表。
  .PARAMETER Path
    native.env 的绝对路径。
  .PARAMETER CaddyfileTemplatePath
    Caddyfile.template 的绝对路径。
  #>
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][string]$CaddyfileTemplatePath
  )

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "缺少部署参数文件：$Path（先复制 central\windows-caddy\native.env.example 并逐项确认）"
  }
  if (-not (Test-Path -LiteralPath $CaddyfileTemplatePath -PathType Leaf)) {
    throw "缺少 Caddyfile 模板：$CaddyfileTemplatePath"
  }

  $values = @{}
  foreach ($line in Get-Content -LiteralPath $Path) {
    $trimmed = $line.Trim()
    if ($trimmed -eq '' -or $trimmed.StartsWith('#')) { continue }
    $parts = $trimmed.Split('=', 2)
    if ($parts.Count -ne 2) { throw "native.env 存在无法解析的行：$trimmed" }
    $values[$parts[0].Trim()] = $parts[1].Trim()
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

  $bindIp = $values['WEFLOW_NATIVE_BIND_IP']
  if (Test-WeFlowWildcardAddress -Value $bindIp) {
    throw "WEFLOW_NATIVE_BIND_IP 不允许是通配地址或空值：'$bindIp'（必须是本机物理 IPv4）"
  }
  if (-not (Test-WeFlowIpv4Literal -Value $bindIp)) {
    throw "WEFLOW_NATIVE_BIND_IP 必须是点分十进制 IPv4 字面量：'$bindIp'"
  }

  $cidr = $values['WEFLOW_NATIVE_ALLOWED_CIDR']
  if (-not (Test-WeFlowPrivateCidr -Value $cidr)) {
    throw "WEFLOW_NATIVE_ALLOWED_CIDR 必须是受限私有 IPv4 CIDR（拒绝 0.0.0.0/0、::/0、公网段）：'$cidr'"
  }

  $upstream = $values['WEFLOW_NATIVE_UPSTREAM']
  if ($upstream -ne '127.0.0.1:8787') {
    throw "WEFLOW_NATIVE_UPSTREAM 只允许 127.0.0.1:8787（不得指向 LAN 或容器网络）：'$upstream'"
  }

  foreach ($name in @('WEFLOW_NATIVE_ROOT', 'WEFLOW_NATIVE_CONFIG_DIR', 'WEFLOW_NATIVE_LOG_DIR',
                      'WEFLOW_NATIVE_PKI_DIR', 'WEFLOW_NATIVE_BIN_DIR', 'WEFLOW_NATIVE_CADDY_EXE',
                      'WEFLOW_NATIVE_CADDYFILE', 'WEFLOW_NATIVE_STATE_DIR')) {
    if (-not (Test-WeFlowAbsoluteWindowsPath -Value $values[$name])) {
      throw "$name 必须是绝对 Windows 路径（形如 F:\WeFlow-Test\...）：'$($values[$name])'"
    }
    if ($values[$name].StartsWith('\\')) {
      throw "$name 不允许是 UNC 路径：'$($values[$name])'"
    }
  }

  return @{
    BindIp            = $bindIp
    AllowedCidr       = $cidr
    Hostname          = $values['WEFLOW_NATIVE_HOSTNAME']
    Root              = $values['WEFLOW_NATIVE_ROOT']
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
    只替换已知占位符；渲染后若仍残留 `{$` 占位符则直接失败，避免把模板当配置启动。
  #>
  param(
    [Parameter(Mandatory)][hashtable]$Config,
    [Parameter(Mandatory)][string]$Destination
  )

  $template = Get-Content -LiteralPath $Config.CaddyfileTemplate -Raw
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

  $directory = Split-Path -Parent $Destination
  if ($directory -and -not (Test-Path -LiteralPath $directory)) {
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
  }
  Set-Content -LiteralPath $Destination -Value $template -Encoding ASCII
  return $Destination
}
