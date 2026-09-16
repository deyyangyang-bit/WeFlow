<#
.SYNOPSIS
  原生 Windows Caddy —— 端点诊断（只读，不做任何系统变更）。

.DESCRIPTION
  对 /health 与 /ready 做「完整证书链 + 主机名」校验的 HTTPS 探测，全部为进程级信任：
    - 优先 curl.exe：--cacert <root.crt> --resolve <host>:443:<bindIp>；
    - 后端不适用（如 schannel 无法判定内部 CA 的吊销状态）时回落 python 标准库 ssl；
    - 两条后端都做完整校验，脚本没有、也不会提供跳过校验的开关（禁止 -k / --insecure）。

  本脚本不改 DNS、不改 hosts、不改 NRPT（旧版曾调用 Add-DnsClientNrptRule，已删除），
  域名解析只通过本次连接的 --resolve / server_hostname 完成。

  退出码（全部非零即失败。判定与 Start-NativeCaddy 的启动验收共用同一份实现）：
    0 = 两个端点均为 200 且响应契约匹配
    1 = 参数或配置错误
    3 = 既无 curl 也无 python，无法在不跳过校验的前提下探测
    4 = TLS 校验失败（链或主机名）
    5 = 连接失败
    6 = HTTP 状态不是 200
    7 = 响应体不符合既有契约（含 JSON 非法、缺字段、字段类型错误、协议版本不符）
    8 = 来源门禁拒绝（403）—— 不算通过
    9 = 响应协议错误（畸形 / 截断 / 超出大小上限）

.PARAMETER PackageRoot
  交付包解压根目录。
.PARAMETER NativeEnvPath
  native.env 路径，默认 $PackageRoot\native.env。
.PARAMETER CaCertPath
  本轮原生 CA 的公开根证书路径（root.crt）。只导出公开证书，私钥不出 PKI 目录。
.PARAMETER SelfTest
  仅显式用于测试：只加载函数定义，不执行任何探测。正常部署不要带此开关。
#>
[CmdletBinding()]
param(
  [string]$PackageRoot,
  [string]$NativeEnvPath,
  [string]$CaCertPath,
  [switch]$SelfTest
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'WeFlowNative.Common.ps1')

function Invoke-NativeCaddyEndpointDiagnostics {
  <#
  .SYNOPSIS
    执行完整端点诊断，返回退出码（0 = 全部通过）。
  #>
  param(
    [Parameter(Mandatory)][string]$PackageRoot,
    [Parameter(Mandatory)][string]$NativeEnvPath,
    [Parameter(Mandatory)][string]$CaCertPath
  )

  if (-not (Test-WeFlowPathExists -Path $CaCertPath -Leaf)) {
    Write-Host "找不到根证书：$CaCertPath" -ForegroundColor Red
    Write-Host '未完成证书导出的情况下无法做正常 TLS 校验；本脚本拒绝以跳过校验代替。' -ForegroundColor Red
    return 1
  }

  $templatePath = Join-Path $PackageRoot 'central\windows-caddy\Caddyfile.template'
  try {
    $config = Read-WeFlowNativeEnv -Path $NativeEnvPath -CaddyfileTemplatePath $templatePath
  } catch {
    Write-Host ("配置校验失败：{0}" -f $_.Exception.Message) -ForegroundColor Red
    return 1
  }

  Write-Host '== TLS 与端点诊断（完整校验，无跳过开关） ==' -ForegroundColor Cyan
  Write-Host "  目标     : https://$($config.Hostname):443"
  Write-Host "  绑定地址 : $($config.BindIp)（通过本次连接的 --resolve / server_hostname 映射，不改系统解析）"
  Write-Host "  根证书   : $CaCertPath"

  # 判定统一走 Invoke-WeFlowEndpointAcceptance：与 Start-NativeCaddy 的启动验收
  # 共用同一份「TLS 校验 + HTTP 200 + 响应契约」标准，这里不另立第二套阈值。
  $acceptance = Invoke-WeFlowEndpointAcceptance -Config $config -CaCertPath $CaCertPath

  foreach ($item in $acceptance.Items) {
    $probe = $item.Probe
    switch ($item.ExitCode) {
      0 {
        Write-Host ("  GET {0} -> HTTP 200，契约匹配（后端 {1}）" -f $item.Path, $probe.Backend) -ForegroundColor Green
      }
      3 {
        Write-Host ("  GET {0} -> 无法探测：{1}" -f $item.Path, $probe.Message) -ForegroundColor Red
      }
      4 {
        Write-Host ("  GET {0} -> TLS 校验失败：{1}" -f $item.Path, $probe.Message) -ForegroundColor Red
      }
      5 {
        Write-Host ("  GET {0} -> 连接失败：{1}" -f $item.Path, $probe.Message) -ForegroundColor Red
      }
      6 {
        Write-Host ("  GET {0} -> HTTP {1}（非 200）" -f $item.Path, $probe.HttpStatus) -ForegroundColor Red
      }
      7 {
        Write-Host ("  GET {0} -> HTTP 200 但响应契约不匹配：{1}" -f $item.Path, $item.Reason) -ForegroundColor Red
      }
      8 {
        Write-Host ("  GET {0} -> HTTP 403：来源门禁拒绝（remote_ip 未落在允许网段），不算通过" -f $item.Path) -ForegroundColor Red
        Write-Host ("            后端 {0}；证书链与主机名校验已通过（{1}）" -f $probe.Backend, $probe.Message) -ForegroundColor Yellow
      }
      9 {
        Write-Host ("  GET {0} -> 响应协议错误（畸形 / 截断 / 超出大小上限）：{1}" -f $item.Path, $probe.Message) -ForegroundColor Red
      }
      default {
        Write-Host ("  GET {0} -> 未通过：{1}" -f $item.Path, $item.Reason) -ForegroundColor Red
      }
    }
  }

  $worstExit = $acceptance.ExitCode

  Write-Host ''
  if ($worstExit -eq 0) {
    Write-Host '端点诊断通过：/health 与 /ready 均为 200 且契约匹配。' -ForegroundColor Green
  } else {
    Write-Host ("端点诊断失败（退出码 {0}）。" -f $worstExit) -ForegroundColor Red
  }
  Write-Host '说明：本机自测只代表 Windows 侧链路；第二台 LAN 客户端仍需单独验收。'
  return $worstExit
}

if ($SelfTest) {
  # 只加载函数定义，供隔离测试调用；不做任何探测。
  return
}

if (-not $PackageRoot) { throw '缺少 -PackageRoot 参数' }
if (-not $NativeEnvPath) { $NativeEnvPath = Join-Path $PackageRoot 'native.env' }
if (-not $CaCertPath) { throw '缺少 -CaCertPath 参数（本脚本不接受跳过证书校验的用法）' }

$exitCode = Invoke-NativeCaddyEndpointDiagnostics -PackageRoot $PackageRoot -NativeEnvPath $NativeEnvPath -CaCertPath $CaCertPath
exit $exitCode
