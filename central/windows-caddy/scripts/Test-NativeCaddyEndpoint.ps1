<#
.SYNOPSIS
  原生 Windows Caddy —— 端点诊断（只读，不做任何变更）。

.DESCRIPTION
  用 Windows 自带 Schannel 对 /health 与 /ready 做真实 TLS 校验。
  必须传 -CaCertPath 指向本轮导出的公开 root.crt；脚本不接受跳过校验的用法，
  因为跳过校验就无法证明证书链与主机名断言，等于没验收。

.PARAMETER PackageRoot
  交付包解压根目录。
.PARAMETER NativeEnvPath
  native.env 路径。
.PARAMETER CaCertPath
  本轮原生 CA 的公开根证书路径（root.crt）。只导出公开证书，私钥不出 PKI 目录。
.PARAMETER SkipDnsOverride
  默认会给本次请求临时加一条 `IP 域名` 的 DNS 映射（不改 hosts 文件）。
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$PackageRoot,
  [string]$NativeEnvPath,
  [Parameter(Mandatory)][string]$CaCertPath,
  [switch]$SkipDnsOverride
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'WeFlowNative.Common.ps1')

if (-not (Test-Path -LiteralPath $CaCertPath -PathType Leaf)) {
  throw "找不到根证书：$CaCertPath（未完成证书导出的情况下无法做正常 TLS 校验，拒绝以跳过校验代替）"
}

$templatePath = Join-Path $PackageRoot 'central\windows-caddy\Caddyfile.template'
if (-not $NativeEnvPath) { $NativeEnvPath = Join-Path $PackageRoot 'native.env' }
$config = Read-WeFlowNativeEnv -Path $NativeEnvPath -CaddyfileTemplatePath $templatePath

Write-Host "== TLS 与端点诊断 ==" -ForegroundColor Cyan
Write-Host "  目标     : https://$($config.Hostname):443"
Write-Host "  绑定地址 : $($config.BindIp)"
Write-Host "  根证书   : $CaCertPath"

# 不修改 hosts：只在本次 TCP 连接上把域名指向配置的物理 IPv4。
if (-not $SkipDnsOverride) {
  Add-DnsClientNrptRule -Namespace $config.Hostname -NameServers '127.0.0.1' -ErrorAction SilentlyContinue | Out-Null
  Write-Host '  已加临时 NRPT 规则；如端点仍不可达，请确认域名解析或改用 -SkipDnsOverride 配合已有 DNS。'
}

foreach ($path in @('/health', '/ready')) {
  try {
    $response = Invoke-WebRequest -Uri "https://$($config.Hostname)$path" `
      -CertificateThumbprint (Get-Item $CaCertPath).FullName `
      -TimeoutSec 10 -UseBasicParsing 2>$null
    Write-Host "  GET $path -> HTTP $([int]$response.StatusCode)" -ForegroundColor Green
  } catch {
    Write-Host "  GET $path -> 失败：$($_.Exception.Message)" -ForegroundColor Red
  }
}

Write-Host ''
Write-Host '说明：Schannel 的信任判定与 Python/curl 的 --cacert 是两条独立路径。'
Write-Host '本机自测通过只代表 Windows 侧链路可用；第二台 LAN 客户端仍需单独验收。'
Write-Host '若 -CertificateThumbprint 不接受该文件，请改用 curl.exe 并显式指定 --cacert；不得跳过证书校验。'
