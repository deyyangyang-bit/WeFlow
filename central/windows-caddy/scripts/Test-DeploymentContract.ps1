<#
.SYNOPSIS
  原生 Windows Caddy —— 自动化部署契约守卫（只读）。

.DESCRIPTION
  在 Windows 测试机上对「已渲染的生效配置 + 部署脚本 + 交付包」逐项断言。
  任何一项不满足即非零退出，不静默兜底。

  与 Mac 侧 `npm run test:central-native-tls` 的分工：
  - Mac 守卫证明模板与脚本的安全语义（跨平台配置验证）；
  - 本脚本证明 Windows 真机上的实际落点、实际监听与交付包完整性。

.PARAMETER PackageRoot
  交付包解压根目录。
.PARAMETER NativeEnvPath
  native.env 路径。
.PARAMETER SkipRuntimeChecks
  只做静态与配置断言，不做端口/进程检查（用于尚未切换时预演）。
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$PackageRoot,
  [string]$NativeEnvPath,
  [switch]$SkipRuntimeChecks
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'WeFlowNative.Common.ps1')

$script:Pass = 0
$script:Fail = 0

function Check {
  param([string]$Name, [bool]$Condition, [string]$Detail = '')
  if ($Condition) {
    $script:Pass++
    Write-Host "  ✅ $Name" -ForegroundColor Green
  } else {
    $script:Fail++
    Write-Host "  ❌ $Name $Detail" -ForegroundColor Red
  }
}

$templatePath = Join-Path $PackageRoot 'central\windows-caddy\Caddyfile.template'
$scriptRoot   = Join-Path $PackageRoot 'central\windows-caddy\scripts'
if (-not $NativeEnvPath) { $NativeEnvPath = Join-Path $PackageRoot 'native.env' }

$template = Get-Content -LiteralPath $templatePath -Raw

Write-Host '== 模板安全语义 ==' -ForegroundColor Cyan
Check '模板显式 bind 到占位 IPv4（不是通配）' ($template -match 'bind \{\$WEFLOW_NATIVE_BIND_IP\}')
Check '模板不出现 0.0.0.0 / :: 通配绑定' (-not ($template -match '(?m)^\s*bind\s+(0\.0\.0\.0|::|\[::\])\s*$'))
Check '模板使用 tls internal（无公网 ACME）' ($template -match '\btls\s+internal\b')
Check '模板未配置任何 ACME CA / 邮箱' (-not ($template -match '\bacme_ca\b|\bemail\b'))
Check '模板关闭 admin' ($template -match '(?m)^\s*admin\s+off\s*$')
Check '模板禁用 HTTP 重定向（不监听 80）' ($template -match '\bauto_https\s+disable_redirects\b')
Check '模板不自动安装根信任' ($template -match '\bskip_install_trust\b')
Check '来源限制使用直接 remote_ip 匹配器' ($template -match '@allowed_lan\s+remote_ip\s+\{\$WEFLOW_NATIVE_ALLOWED_CIDR\}')
Check '模板不使用 client_ip 兜底' (-not ($template -match '\bclient_ip\b'))
Check '模板不启用 trusted_proxies' (-not ($template -match '\btrusted_proxies\b'))
Check '模板不引用任何转发头' (-not ($template -match 'X-Forwarded-For|X-Real-IP'))
Check '上游固定为回环上的 127.0.0.1:8787' ($template -match 'reverse_proxy\s+127\.0\.0\.1:8787')
Check '模板不含其它 reverse_proxy 目标（如容器名 central:8787）' (-not ($template -match 'reverse_proxy\s+central:8787'))
Check '未匹配来源 fail closed 返回 403' ($template -match 'respond\s+"forbidden"\s+403')
Check 'PKI 存储指向显式 F 盘目录' ($template -match 'storage\s+file_system\s+"\{\$WEFLOW_NATIVE_PKI_DIR\}"')
Check '日志目录指向显式 F 盘目录' ($template -match 'output\s+file\s+"\{\$WEFLOW_NATIVE_LOG_DIR\}')
Check '日志级别为 ERROR（不记录请求载荷）' ($template -match '(?m)^\s*level\s+ERROR\s*$')
Check '模板不含明文凭据 / 令牌 / 私钥' (-not ($template -match $prohibitedCredentialPattern))

Write-Host ''
Write-Host '== native.env 取值 ==' -ForegroundColor Cyan
$config = Read-WeFlowNativeEnv -Path $NativeEnvPath -CaddyfileTemplatePath $templatePath
Check '绑定地址是显式物理 IPv4 字面量' (Test-WeFlowIpv4Literal -Value $config.BindIp)
Check '绑定地址不是通配地址' (-not (Test-WeFlowWildcardAddress -Value $config.BindIp))
Check '允许网段是受限私有 CIDR' (Test-WeFlowPrivateCidr -Value $config.AllowedCidr)
Check '允许网段不是任意 CIDR' ($config.AllowedCidr -notin @('0.0.0.0/0', '::/0'))
Check '上游固定 127.0.0.1:8787' ($config.Upstream -eq '127.0.0.1:8787')
Check '程序 / 配置 / 日志 / PKI 均在 F 盘前缀下' (
  @($config.Root, $config.ConfigDir, $config.LogDir, $config.PkiDir) |
    Where-Object { $_ -notmatch '^F:\\' } | Measure-Object | Select-Object -ExpandProperty Count
) -eq 0 -Detail '存在不在 F:\ 下的路径'

# 负例：危险取值必须被同一套校验函数拒绝，证明断言不是恒真。
Write-Host ''
Write-Host '== 校验函数负例（证明守卫非恒真） ==' -ForegroundColor Cyan
Check '负例：0.0.0.0 被识别为通配地址' (Test-WeFlowWildcardAddress -Value '0.0.0.0')
Check '负例：:: 被识别为通配地址' (Test-WeFlowWildcardAddress -Value '::')
Check '负例：空串被识别为通配地址' (Test-WeFlowWildcardAddress -Value '')
Check '负例：0.0.0.0 不被当作合法物理 IPv4 绑定' (-not (Test-WeFlowIpv4Literal -Value '0.0.0.0') -or (Test-WeFlowWildcardAddress -Value '0.0.0.0'))
Check '负例：0.0.0.0/0 不是受限私有 CIDR' (-not (Test-WeFlowPrivateCidr -Value '0.0.0.0/0'))
Check '负例：::/0 不是受限私有 CIDR' (-not (Test-WeFlowPrivateCidr -Value '::/0'))
Check '负例：公网段 8.8.8.0/24 不是受限私有 CIDR' (-not (Test-WeFlowPrivateCidr -Value '8.8.8.0/24'))
Check '负例：相对路径不是绝对 Windows 路径' (-not (Test-WeFlowAbsoluteWindowsPath -Value 'pki\caddy'))
Check '正例：当前绑定地址通过同一套物理 IPv4 校验' (Test-WeFlowIpv4Literal -Value $config.BindIp)
Check '正例：当前网段通过同一套私有 CIDR 校验' (Test-WeFlowPrivateCidr -Value $config.AllowedCidr)

Write-Host ''
Write-Host '== 部署脚本安全边界 ==' -ForegroundColor Cyan
$composeCommands = Get-ChildItem -LiteralPath $scriptRoot -Filter *.ps1 |
  Select-String -Pattern 'docker compose' -AllMatches | ForEach-Object { $_.Line.Trim() }
Check '脚本中存在 Compose 调用' ($composeCommands.Count -gt 0)
Check '所有 Compose 调用均带 -p weflow-test' (($composeCommands | Where-Object { $_ -notmatch '-p weflow-test' }).Count -eq 0)
Check '所有 Compose 调用均带同一组两个 -f 文件' (
  ($composeCommands | Where-Object {
    $_ -notmatch '-f docker-compose\.central\.yml' -or $_ -notmatch '-f docker-compose\.central\.tls\.yml'
  }).Count -eq 0
)
$allScriptText = (Get-ChildItem -LiteralPath $scriptRoot -Filter *.ps1 | Get-Content -Raw) -join "`n"
Check '脚本从不执行 compose down' (-not ($allScriptText -match 'compose[^\n]*\bdown\b'))
Check '脚本从不删除卷或容器' (
  -not ($codeUnderTest -match $prohibitedVolumeRemoval) -and -not ($codeUnderTest -match $prohibitedComposeRemoval)
)
$prohibitedProcessKill = 'task' + 'kill\s+/IM'
$prohibitedVolumeRemoval = 'down\s+' + '-v'
$prohibitedComposeRemoval = 'compose[^\n]*\b' + 'rm' + '\b'
$prohibitedCredentialPattern = 'Authorization|' + 'Cookie|' + 'BEGIN .*PRIVATE' + ' KEY|password'
$prohibitedServiceRegistration = @('New' + '-Service', 'Register' + '-ScheduledTask', 'sc\.exe\s+create')
$prohibitedNetworkChange = @('Set' + '-NetFirewallProfile', 'netsh\s+advfirewall', 'New' + '-NetIPAddress')
$codeUnderTest = ($allScriptText -split "`n" | ForEach-Object {
  $commentIndex = $_.IndexOf('#')
  if ($commentIndex -ge 0) { $_.Substring(0, $commentIndex) } else { $_ }
}) -join "`n"
$codeUnderTest = [regex]::Replace($codeUnderTest, '<#[\s\S]*?#>', '')
Check '脚本从不按映像名宽泛杀进程' (-not ($codeUnderTest -match $prohibitedProcessKill))
Check '脚本只按记录 PID 结束进程' ($codeUnderTest -match 'Stop-Process -Id')
Check '脚本不注册 Windows 服务或计划任务' (
  ($prohibitedServiceRegistration | Where-Object { $codeUnderTest -match $_ }).Count -eq 0
)
Check '脚本不修改 hosts 文件' (-not ($allScriptText -match 'drivers\\etc\\hosts|Add-Content.*hosts'))
$prohibitedPrivateKeyRead = 'root' + '\.key|BEGIN .*PRIVATE KEY'
Check '脚本不导出或读取根私钥' (-not ($codeUnderTest -match $prohibitedPrivateKeyRead))
Check '脚本从不停用防火墙或改网络配置' (
  ($prohibitedNetworkChange | Where-Object { $codeUnderTest -match $_ }).Count -eq 0
)

Write-Host ''
Write-Host '== 交付包内容 ==' -ForegroundColor Cyan
$archive = Join-Path $PackageRoot 'caddy_2.11.4_windows_amd64.zip'
Check '官方归档存在于交付包根' (Test-Path -LiteralPath $archive -PathType Leaf)
Check '交付包不含任何 .crt / .key / .p12 / .pfx' (
  (Get-ChildItem -LiteralPath $PackageRoot -Recurse -File -Include *.crt, *.key, *.p12, *.pfx -ErrorAction SilentlyContinue).Count -eq 0
)
Check '交付包不含 native.env 真实配置' (-not (Test-Path -LiteralPath (Join-Path $PackageRoot 'native.env.real')))
Check '交付包不含数据库或日志文件' (
  (Get-ChildItem -LiteralPath $PackageRoot -Recurse -File -Include *.db, *.log, *.sqlite, *.sqlite3 -ErrorAction SilentlyContinue).Count -eq 0
)

if (-not $SkipRuntimeChecks) {
  Write-Host ''
  Write-Host '== 运行态 ==' -ForegroundColor Cyan
  $listeners = Get-NetTCPConnection -LocalPort 443 -State Listen -ErrorAction SilentlyContinue
  Check '443 有监听' ($null -ne $listeners)
  Check '443 仅绑定在配置的物理 IPv4 上' (
    $null -ne $listeners -and ($listeners | Where-Object { $_.LocalAddress -ne $config.BindIp }).Count -eq 0
  ) -Detail "实际: $($listeners.LocalAddress -join ', ')"
  Check '443 未绑定 0.0.0.0' ($null -eq ($listeners | Where-Object { $_.LocalAddress -eq '0.0.0.0' }))
  Check '80 未被监听（只在 443 提供服务）' ($null -eq (Get-NetTCPConnection -LocalPort 80 -State Listen -ErrorAction SilentlyContinue))
  Check '2019 admin 端口未被监听' ($null -eq (Get-NetTCPConnection -LocalPort 2019 -State Listen -ErrorAction SilentlyContinue))

  $statePath = Join-Path $config.StateDir 'native-caddy.current.json'
  if (Test-Path -LiteralPath $statePath -PathType Leaf) {
    $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    $proc = Get-Process -Id $state.Pid -ErrorAction SilentlyContinue
    Check '记录的 PID 仍在运行' ($null -ne $proc)
    Check '记录 PID 的可执行路径与本轮一致' ($null -ne $proc -and $proc.Path -eq $state.ExecutablePath)
    Check '记录中不含 PID 以外的宽泛匹配依据' ($state.PSObject.Properties.Name -contains 'Pid')
  } else {
    Check '运行态诊断需要本轮状态文件（未切换时请加 -SkipRuntimeChecks）' $false $statePath
  }
}

Write-Host ''
Write-Host "native Windows Caddy contract guard: $($script:Pass) passed, $($script:Fail) failed"
if ($script:Fail -gt 0) { exit 1 }
exit 0
