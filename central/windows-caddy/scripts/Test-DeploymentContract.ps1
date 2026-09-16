<#
.SYNOPSIS
  原生 Windows Caddy —— 自动化部署契约守卫（只读）。

.DESCRIPTION
  在 Windows 测试机上对「模板 + 参数 + 部署脚本 + 交付包（+ 可选运行态）」逐项断言。
  任何一项不满足即以非零退出，不静默兜底。

  本版修订（相对 975ced5 待修版）：
    - 所有变量在使用前完成定义（StrictMode Latest 下不再抛未初始化变量）；
    - Check 调用改为显式命名参数，修掉 `Check ... (表达式) -eq 0 -Detail` 这类参数绑定错误；
    - Compose 调用识别改为「先剥离注释与字符串、再合并续行」的真实代码扫描，
      不再把注释或守卫自身的规则字符串误当成执行代码，也不会漏掉变量化/多行调用；
    - 断言失败即非零退出；不存在恒真断言（每条正向断言都有对应的负例证明其可失败）。

  退出码：0 = 全部通过；1 = 存在失败项；2 = 参数错误。

.PARAMETER PackageRoot
  交付包解压根目录。
.PARAMETER NativeEnvPath
  native.env 路径，默认 $PackageRoot\native.env。
.PARAMETER ScriptsRoot
  被检查的脚本目录，默认 $PackageRoot\central\windows-caddy\scripts（测试可指向夹具）。
.PARAMETER TemplatePath
  Caddyfile 模板路径，默认 $PackageRoot\central\windows-caddy\Caddyfile.template。
.PARAMETER SkipRuntimeChecks
  只做静态与配置断言，不做端口/进程检查（用于尚未切换时预演）。
.PARAMETER SelfTest
  仅显式用于测试：只加载函数定义，不执行任何检查。
#>
[CmdletBinding()]
param(
  [string]$PackageRoot,
  [string]$NativeEnvPath,
  [string]$ScriptsRoot,
  [string]$TemplatePath,
  [switch]$SkipRuntimeChecks,
  [switch]$SelfTest
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'WeFlowNative.Common.ps1')

# =====================================================================
# 检查结果记录
# =====================================================================

$script:PassCount = 0
$script:FailCount = 0
$script:FailMessages = @()

function Check {
  <#
  .SYNOPSIS
    记录一条断言结果。Condition 必须是真正的布尔值（调用方负责求值）。
  #>
  param(
    [Parameter(Mandatory)][string]$Name,
    [Parameter(Mandatory)][bool]$Condition,
    [string]$Detail = ''
  )
  if ($Condition) {
    $script:PassCount++
    Write-Host ("  [PASS] {0}" -f $Name) -ForegroundColor Green
  } else {
    $script:FailCount++
    $script:FailMessages += $Name
    Write-Host ("  [FAIL] {0} {1}" -f $Name, $Detail) -ForegroundColor Red
  }
}

# =====================================================================
# 代码提取：剥离注释与字符串、合并续行，只留下真正会被执行的部分
# =====================================================================

function Get-WeFlowCodeOnly {
  <#
  .SYNOPSIS
    把 PowerShell 源码转成「仅代码」文本：注释与 here-string 被移除，续行被合并。
  .DESCRIPTION
    逐字符扫描，跟踪：普通代码、单引号串、双引号串、单/双引号 here-string、块注释。
    - 默认（不带 -StripStrings）：字符串字面量原样保留 —— 用于查看真实调用参数；
    - 带 -StripStrings：字符串内容被抹掉 —— 用于判断「有没有真的执行危险命令」，
      这样守卫自身的规则字符串与注释里的示例都不会造成误报。
    行尾反引号会被理解成续行并合并到一行，避免多行 Compose 调用被漏检。
  #>
  param(
    [Parameter(Mandatory)][AllowEmptyString()][string]$Text,
    [switch]$StripStrings
  )

  $builder = New-Object System.Text.StringBuilder
  $state = 'code'
  $index = 0
  $length = $Text.Length

  while ($index -lt $length) {
    $char = $Text[$index]
    $next = if ($index + 1 -lt $length) { $Text[$index + 1] } else { [char]0 }

    switch ($state) {
      'code' {
        if ($char -eq '<' -and $next -eq '#') { $state = 'block-comment'; $index += 2; continue }
        if ($char -eq '#') { $state = 'line-comment'; $index += 1; continue }
        if ($char -eq '@' -and ($next -eq "'" -or $next -eq '"')) {
          $afterHere = if ($index + 2 -lt $length) { $Text[$index + 2] } else { [char]0 }
          if ($afterHere -eq "`r" -or $afterHere -eq "`n") {
            if ($next -eq "'") { $state = 'here-single' } else { $state = 'here-double' }
            $index += 2
            continue
          }
        }
        if ($char -eq "'") { [void]$builder.Append($char); $state = 'single'; $index += 1; continue }
        if ($char -eq '"') { [void]$builder.Append($char); $state = 'double'; $index += 1; continue }
        [void]$builder.Append($char)
        $index += 1
        continue
      }
      'single' {
        if ($char -eq "'" -and $next -eq "'") { if (-not $StripStrings) { [void]$builder.Append("''") }; $index += 2; continue }
        if ($char -eq "'") { [void]$builder.Append("'"); $state = 'code'; $index += 1; continue }
        if (-not $StripStrings) { [void]$builder.Append($char) }
        $index += 1
        continue
      }
      'double' {
        if ($char -eq '`') { if (-not $StripStrings) { [void]$builder.Append($next) }; $index += 2; continue }
        if ($char -eq '"' -and $next -eq '"') { if (-not $StripStrings) { [void]$builder.Append('""') }; $index += 2; continue }
        if ($char -eq '"') { [void]$builder.Append('"'); $state = 'code'; $index += 1; continue }
        if (-not $StripStrings) { [void]$builder.Append($char) }
        $index += 1
        continue
      }
      'block-comment' {
        if ($char -eq '#' -and $next -eq '>') { $state = 'code'; $index += 2; continue }
        if ($char -eq "`n") { [void]$builder.Append("`n") }
        $index += 1
        continue
      }
      'line-comment' {
        if ($char -eq "`n") { [void]$builder.Append("`n"); $state = 'code' }
        $index += 1
        continue
      }
      'here-single' {
        if ($char -eq "`n") {
          $rest = $Text.Substring($index + 1)
          if ($rest.StartsWith("'@")) { $state = 'code'; $index += 3; continue }
          [void]$builder.Append("`n")
        }
        $index += 1
        continue
      }
      'here-double' {
        if ($char -eq "`n") {
          $rest = $Text.Substring($index + 1)
          if ($rest.StartsWith('"@')) { $state = 'code'; $index += 3; continue }
          [void]$builder.Append("`n")
        }
        $index += 1
        continue
      }
      default { $index += 1; continue }
    }
  }

  $code = $builder.ToString()
  # 合并续行：行尾反引号 + 换行 -> 空格
  $code = [regex]::Replace($code, '`[ 	]*
?
', ' ')
  return $code
}

function Get-WeFlowComposeCallSites {
  <#
  .SYNOPSIS
    在「保留字符串的仅代码」文本里找出所有 Compose 调用点。
  .DESCRIPTION
    识别两类写法：
      1) 经公共包装层：Invoke-WeFlowDocker -ComposeArgs @('stop','caddy')；
      2) 直接调用：docker compose ...
    逻辑行已由 Get-WeFlowCodeOnly 合并，因此多行/续行写法同样可见。
  #>
  param([Parameter(Mandatory)][AllowEmptyString()][string]$Code)

  $sites = @()
  foreach ($match in [regex]::Matches($Code, 'docker\s+compose\s+([^
;|]*)')) {
    $sites += [pscustomobject]@{ Kind = 'direct'; Arguments = $match.Groups[1].Value.Trim() }
  }
  foreach ($match in [regex]::Matches($Code, 'Invoke-WeFlowDocker\s+[^
]*?-ComposeArgs\s+@\(([^)]*)\)')) {
    $sites += [pscustomobject]@{ Kind = 'wrapper'; Arguments = $match.Groups[1].Value.Trim() }
  }
  return $sites
}

function Get-WeFlowComposeSubcommand {
  <#
  .SYNOPSIS
    从 Compose 参数片段中取出真正的子命令（跳过 -p / -f / --env-file 等带值选项）。
  .DESCRIPTION
    既能处理 @('stop','caddy') 这样的包装层数组写法，也能处理
    `docker compose -p X -f A -f B stop caddy` 这样的命令行写法；
    找不到子命令时返回空串（调用方按「不在白名单」处理）。
  #>
  param([Parameter(Mandatory)][AllowEmptyString()][string]$Arguments)

  $tokens = @()
  foreach ($raw in ($Arguments -split '[,\s]+')) {
    $token = $raw.Trim().Trim("'", '"')
    if ($token -ne '') { $tokens += $token }
  }
  $valueOptions = @('-p', '--project-name', '-f', '--file', '--env-file', '--profile')
  $skipNext = $false
  foreach ($token in $tokens) {
    if ($skipNext) { $skipNext = $false; continue }
    if ($token.StartsWith('-')) {
      if (($valueOptions -contains $token) -and (-not $token.Contains('='))) { $skipNext = $true }
      continue
    }
    return $token
  }
  return ''
}

# =====================================================================
# 主检查流程
# =====================================================================

function Invoke-WeFlowDeploymentContract {
  <#
  .SYNOPSIS
    执行全部契约断言，返回退出码（0 = 通过）。
  #>
  param(
    [Parameter(Mandatory)][string]$PackageRoot,
    [Parameter(Mandatory)][string]$NativeEnvPath,
    [Parameter(Mandatory)][string]$ScriptsRoot,
    [Parameter(Mandatory)][string]$TemplatePath,
    [Parameter(Mandatory)][bool]$SkipRuntime
  )

  $script:PassCount = 0
  $script:FailCount = 0
  $script:FailMessages = @()

  if (-not (Test-WeFlowPathExists -Path $TemplatePath -Leaf)) {
    Write-Host ("找不到模板：{0}" -f $TemplatePath) -ForegroundColor Red
    return 2
  }
  if (-not (Test-WeFlowPathExists -Path $ScriptsRoot)) {
    Write-Host ("找不到脚本目录：{0}" -f $ScriptsRoot) -ForegroundColor Red
    return 2
  }

  $template = Read-WeFlowTextFile -Path $TemplatePath

  Write-Host '== 模板安全语义 ==' -ForegroundColor Cyan
  Check -Name '模板显式 bind 到占位 IPv4（不是通配）' -Condition ($template -match 'bind\s+\{\$WEFLOW_NATIVE_BIND_IP\}')
  Check -Name '模板不出现 0.0.0.0 / :: 通配绑定' -Condition (-not ($template -match '(?m)^\s*bind\s+(0\.0\.0\.0|::|\[::\])\s*$'))
  Check -Name '模板使用 tls internal（无公网 ACME）' -Condition ($template -match '\btls\s+internal\b')
  Check -Name '模板未配置任何 ACME CA / 邮箱' -Condition (-not ($template -match '\bacme_ca\b|\bemail\b'))
  Check -Name '模板关闭 admin' -Condition ($template -match '(?m)^\s*admin\s+off\s*$')
  Check -Name '模板禁用 HTTP 重定向（不监听 80）' -Condition ($template -match '\bauto_https\s+disable_redirects\b')
  Check -Name '模板不自动安装根信任' -Condition ($template -match '\bskip_install_trust\b')
  Check -Name '来源限制使用直接 remote_ip 匹配器' -Condition ($template -match '@allowed_lan\s+remote_ip\s+\{\$WEFLOW_NATIVE_ALLOWED_CIDR\}')
  Check -Name '模板不使用 client_ip 兜底' -Condition (-not ($template -match '\bclient_ip\b'))
  Check -Name '模板不启用 trusted_proxies' -Condition (-not ($template -match '\btrusted_proxies\b'))
  Check -Name '模板不引用任何转发头' -Condition (-not ($template -match 'X-Forwarded-For|X-Real-IP'))
  Check -Name '上游固定为回环上的 127.0.0.1:8787' -Condition ($template -match 'reverse_proxy\s+127\.0\.0\.1:8787')
  Check -Name '模板不含其它 reverse_proxy 目标（如容器名 central:8787）' -Condition (-not ($template -match 'reverse_proxy\s+central:8787'))
  Check -Name '未匹配来源 fail closed 返回 403' -Condition ($template -match 'respond\s+"forbidden"\s+403')
  Check -Name 'PKI 存储指向显式 F 盘目录' -Condition ($template -match 'storage\s+file_system\s+"\{\$WEFLOW_NATIVE_PKI_DIR\}"')
  Check -Name '日志目录指向显式 F 盘目录' -Condition ($template -match 'output\s+file\s+"\{\$WEFLOW_NATIVE_LOG_DIR\}')
  Check -Name '日志级别为 ERROR（不记录请求载荷）' -Condition ($template -match '(?m)^\s*level\s+ERROR\s*$')
  $credentialPattern = 'Authorization|Cookie|BEGIN [A-Z ]*PRIVATE KEY|password\s*='
  Check -Name '模板不含明文凭据 / 令牌 / 私钥' -Condition (-not ($template -match $credentialPattern))

  Write-Host ''
  Write-Host '== native.env 取值 ==' -ForegroundColor Cyan
  $config = $null
  try {
    $config = Read-WeFlowNativeEnv -Path $NativeEnvPath -CaddyfileTemplatePath $TemplatePath
  } catch {
    Write-Host ("  [FAIL] native.env 无法通过校验：{0}" -f $_.Exception.Message) -ForegroundColor Red
    $script:FailCount++
    $script:FailMessages += 'native.env 校验'
    return 1
  }
  Check -Name '绑定地址是显式物理 IPv4 字面量' -Condition (Test-WeFlowIpv4Literal -Value $config.BindIp)
  Check -Name '绑定地址不是通配地址' -Condition (-not (Test-WeFlowWildcardAddress -Value $config.BindIp))
  Check -Name '允许网段是受限私有 CIDR' -Condition (Test-WeFlowPrivateCidr -Value $config.AllowedCidr)
  Check -Name '允许网段不是任意 CIDR' -Condition (@('0.0.0.0/0', '::/0') -notcontains $config.AllowedCidr)
  Check -Name '上游固定 127.0.0.1:8787' -Condition ($config.Upstream -eq '127.0.0.1:8787')
  Check -Name '测试域名是安全主机名' -Condition (Test-WeFlowHostname -Value $config.Hostname)

  $outsideRoot = @()
  foreach ($pathValue in @($config.ConfigDir, $config.LogDir, $config.PkiDir, $config.BinDir, $config.CaddyExe, $config.Caddyfile, $config.StateDir)) {
    if (-not (Test-WeFlowPathUnderRoot -Path $pathValue -Root $config.Root)) { $outsideRoot += $pathValue }
  }
  Check -Name '程序 / 配置 / 日志 / PKI / 状态路径均在部署根之下' -Condition ($outsideRoot.Count -eq 0) -Detail ("越界：{0}" -f ($outsideRoot -join ', '))

  Write-Host ''
  Write-Host '== 校验函数负例（证明守卫非恒真） ==' -ForegroundColor Cyan
  Check -Name '负例：0.0.0.0 被识别为通配地址' -Condition (Test-WeFlowWildcardAddress -Value '0.0.0.0')
  Check -Name '负例：:: 被识别为通配地址' -Condition (Test-WeFlowWildcardAddress -Value '::')
  Check -Name '负例：空串被识别为通配地址' -Condition (Test-WeFlowWildcardAddress -Value '')
  Check -Name '负例：0.0.0.0 在参数校验中被拒绝' -Condition (-not (Test-WeFlowIpv4Literal -Value '0.0.0.0') -or (Test-WeFlowWildcardAddress -Value '0.0.0.0'))
  Check -Name '负例：0.0.0.0/0 不是受限私有 CIDR' -Condition (-not (Test-WeFlowPrivateCidr -Value '0.0.0.0/0'))
  Check -Name '负例：::/0 不是受限私有 CIDR' -Condition (-not (Test-WeFlowPrivateCidr -Value '::/0'))
  Check -Name '负例：公网段 8.8.8.0/24 不是受限私有 CIDR' -Condition (-not (Test-WeFlowPrivateCidr -Value '8.8.8.0/24'))
  Check -Name '负例：主机位非零的 192.168.1.5/24 不是规范 CIDR' -Condition (-not (Test-WeFlowPrivateCidr -Value '192.168.1.5/24'))
  Check -Name '负例：含 999 的 IPv4 不是字面量' -Condition (-not (Test-WeFlowIpv4Literal -Value '10.999.1.1'))
  Check -Name '负例：相对路径不是绝对 Windows 路径' -Condition (-not (Test-WeFlowAbsoluteWindowsPath -Value 'pki\caddy'))
  Check -Name '负例：带 .. 的路径被识别为穿越' -Condition (Test-WeFlowPathTraversal -Value 'F:\WeFlow-Test\..\Windows')
  Check -Name '负例：F:\Windows 不在部署根之下' -Condition (-not (Test-WeFlowPathUnderRoot -Path 'F:\Windows' -Root 'F:\WeFlow-Test'))
  Check -Name '负例：含花括号的主机名被拒绝' -Condition (-not (Test-WeFlowHostname -Value 'evil.test{'))
  Check -Name '负例：含斜杠的主机名被拒绝' -Condition (-not (Test-WeFlowHostname -Value 'evil/../test'))

  Write-Host ''
  Write-Host '== 部署脚本安全边界（仅扫生产脚本；禁止项用去字符串视图） ==' -ForegroundColor Cyan
  $productionNames = @('WeFlowNative.Common.ps1', 'Install-NativeCaddy.ps1', 'Start-NativeCaddy.ps1',
                       'Stop-NativeCaddy.ps1', 'Test-NativeCaddyEndpoint.ps1')
  $scriptFiles = @(Get-ChildItem -LiteralPath $ScriptsRoot -Filter *.ps1 -File -ErrorAction SilentlyContinue |
    Where-Object { $productionNames -contains $_.Name })
  Check -Name '受检生产脚本集合完整（5 个）' -Condition ($scriptFiles.Count -eq $productionNames.Count) `
    -Detail ("实际：{0}" -f (($scriptFiles | ForEach-Object { $_.Name }) -join ', '))

  $codeWithStrings = ''
  $codeWithoutStrings = ''
  $composeSites = @()
  foreach ($file in $scriptFiles) {
    $raw = Get-Content -LiteralPath $file.FullName -Raw
    $withStrings = Get-WeFlowCodeOnly -Text $raw
    $withoutStrings = Get-WeFlowCodeOnly -Text $raw -StripStrings
    $codeWithStrings += "`n" + $withStrings
    $codeWithoutStrings += "`n" + $withoutStrings
    $composeSites += Get-WeFlowComposeCallSites -Code $withStrings
  }

  Check -Name '存在 Compose 调用点（包装层调用）' -Condition ($composeSites.Count -gt 0)

  $badSubcommands = @()
  foreach ($site in $composeSites) {
    $subcommand = Get-WeFlowComposeSubcommand -Arguments $site.Arguments
    if (-not (Test-WeFlowComposeSubcommandAllowed -Subcommand $subcommand)) {
      $badSubcommands += ("{0}:{1}" -f $site.Kind, $subcommand)
    }
  }
  Check -Name '所有 Compose 调用点仅使用 stop/start/ps/config' -Condition ($badSubcommands.Count -eq 0) -Detail ("违规：{0}" -f ($badSubcommands -join ', '))

  $commonPath = Join-Path $ScriptsRoot 'WeFlowNative.Common.ps1'
  $wrapperCode = ''
  if (Test-WeFlowPathExists -Path $commonPath -Leaf) {
    $wrapperCode = Get-WeFlowCodeOnly -Text (Get-Content -LiteralPath $commonPath -Raw)
  }
  Check -Name '包装层把项目名固定为 weflow-test' -Condition ($wrapperCode -match "'-p'\s*,\s*'weflow-test'")
  Check -Name '包装层固定两个 -f 配置文件' -Condition (
    ($wrapperCode -match "'docker-compose\.central\.yml'") -and ($wrapperCode -match "'docker-compose\.central\.tls\.yml'")
  )
  Check -Name '包装层固定 --env-file central/proxy.env' -Condition ($wrapperCode -match "'--env-file'\s*,\s*'central/proxy\.env'")
  Check -Name '包装层带 Compose 子命令白名单' -Condition ($wrapperCode -match 'Test-WeFlowComposeSubcommandAllowed')

  # 以下禁止项只看「去字符串」视图：注释里的示例与守卫自身的规则字符串都不算执行代码。
  Check -Name '脚本仅按记录 PID 结束进程（Stop-WeFlowProcessById）' -Condition ($codeWithoutStrings -match 'Stop-WeFlowProcessById')
  Check -Name '脚本从不按映像名宽泛杀进程' -Condition (-not ($codeWithoutStrings -match 'taskkill\s+/IM') -and -not ($codeWithoutStrings -match 'Stop-Process\s+-Name'))
  Check -Name '脚本不执行 compose down' -Condition (-not ($codeWithoutStrings -match 'docker\s+compose[^
]*down'))
  Check -Name '脚本不执行 compose rm / up / recreate' -Condition (-not ($codeWithoutStrings -match 'docker\s+compose\s+(rm|up|recreate)'))
  Check -Name '脚本不删除卷（down -v / volume rm）' -Condition (-not ($codeWithoutStrings -match 'down\s+-v') -and -not ($codeWithoutStrings -match 'volume\s+rm'))
  Check -Name '脚本不注册 Windows 服务或计划任务' -Condition (
    -not ($codeWithoutStrings -match 'New-Service') -and -not ($codeWithoutStrings -match 'Register-ScheduledTask') -and -not ($codeWithoutStrings -match 'sc\.exe\s+create')
  )
  Check -Name '脚本不修改防火墙 / 网络 / DNS 解析配置' -Condition (
    -not ($codeWithoutStrings -match 'Set-NetFirewallProfile') -and -not ($codeWithoutStrings -match 'netsh\s+advfirewall') -and
    -not ($codeWithoutStrings -match 'New-NetIPAddress') -and -not ($codeWithoutStrings -match 'Add-DnsClientNrptRule') -and
    -not ($codeWithoutStrings -match 'Set-DnsClientServerAddress')
  )
  Check -Name '脚本不写 hosts 文件' -Condition (-not ($codeWithoutStrings -match 'drivers\\etc\\hosts'))
  Check -Name '脚本不读取或导出根私钥' -Condition (-not ($codeWithoutStrings -match 'root\.key') -and -not ($codeWithoutStrings -match 'intermediate\.key'))
  Check -Name '诊断脚本不含跳过证书校验的开关' -Condition (-not ($codeWithoutStrings -match '--insecure') -and -not ($codeWithoutStrings -match '(?m)^\s*-k\s*$'))

  Write-Host ''
  Write-Host '== 本轮修复的不变量（静态断言） ==' -ForegroundColor Cyan
  # 1) 启动验收与端点诊断必须共用同一份判定，避免出现两套阈值。
  $acceptanceSites = ([regex]::Matches($codeWithoutStrings, 'Invoke-WeFlowEndpointAcceptance')).Count
  Check -Name '存在统一的端点验收函数（Common）' -Condition ($codeWithoutStrings -match 'function\s+Invoke-WeFlowEndpointAcceptance')
  Check -Name '启动脚本与诊断脚本都调用同一验收函数' -Condition ($acceptanceSites -ge 2) -Detail ("调用点 {0} 处" -f $acceptanceSites)
  Check -Name '验收默认覆盖 /health 与 /ready 两个端点' -Condition ($codeWithoutStrings -match "@\('/health',\s*'/ready'\)")
  Check -Name '403 来源门禁映射为非零退出码' -Condition ($codeWithoutStrings -match "'gate-403'\s*\{\s*return 8")

  # 2) 进程回收：内存身份 + 结束确认，不依赖磁盘记账。
  Check -Name '启动后立即采集内存身份（New-WeFlowProcessIdentityRecord）' -Condition ($codeWithoutStrings -match 'New-WeFlowProcessIdentityRecord')
  Check -Name '回退按记录结束进程并确认退出（Stop-WeFlowOwnedProcess）' -Condition ($codeWithoutStrings -match 'Stop-WeFlowOwnedProcess')
  Check -Name '结束进程后确认其确实消失（still-running 判定）' -Condition ($codeWithoutStrings -match 'still-running')
  Check -Name '回退失败保留诊断记录（rollback.json）' -Condition ($codeWithoutStrings -match 'native-caddy\.rollback\.json')

  # 3) 参数传递：必须构造单条命令行，不允许把数组直接交给 Start-Process。
  Check -Name '参数经 ConvertTo-WeFlowWindowsArgumentLine 构造' -Condition ($codeWithoutStrings -match 'ConvertTo-WeFlowWindowsArgumentLine')
  Check -Name 'Start-Process 不再直接接收参数数组' -Condition (-not ($codeWithoutStrings -match '-ArgumentList\s+\$Arguments\b'))

  # 4) Python 端点后端：标准库 http.client 解析，不允许手工分帧。
  $probePythonPath = Join-Path $ScriptsRoot 'WeFlowNative.HttpsProbe.py'
  if (Test-WeFlowPathExists -Path $probePythonPath -Leaf) {
    $probePython = Read-WeFlowTextFile -Path $probePythonPath
    Check -Name 'Python 后端使用标准库 http.client 解析响应' -Condition ($probePython -match 'import http\.client')
    Check -Name 'Python 后端不再手工切分响应（无 partition(）' -Condition (-not ($probePython -match 'partition\('))
    Check -Name 'Python 后端设置响应体大小上限' -Condition ($probePython -match 'MAX_BODY_BYTES')
    Check -Name 'Python 后端在关闭连接前取得 TLS 信息' -Condition ($probePython -match 'weflow_tls_version')
    Check -Name 'Python 后端不提供跳过校验的开关' -Condition (-not ($probePython -match 'CERT_NONE|_create_unverified_context'))
  } else {
    Check -Name '缺少 Python 端点后端（WeFlowNative.HttpsProbe.py）' -Condition $false -Detail $probePythonPath
  }

  Write-Host ''
  Write-Host '== 交付包内容 ==' -ForegroundColor Cyan
  $archive = Join-Path $PackageRoot 'caddy_2.11.4_windows_amd64.zip'
  Check -Name '官方归档存在于交付包根' -Condition (Test-WeFlowPathExists -Path $archive -Leaf)
  $secretExtensions = @('.crt', '.key', '.p12', '.pfx')
  $secretFiles = @(Get-ChildItem -LiteralPath $PackageRoot -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $secretExtensions -contains $_.Extension.ToLowerInvariant() })
  Check -Name '交付包不含任何 .crt / .key / .p12 / .pfx' -Condition ($secretFiles.Count -eq 0) -Detail (($secretFiles | ForEach-Object { $_.Name }) -join ', ')
  $dataExtensions = @('.db', '.sqlite', '.sqlite3')
  $dataFiles = @(Get-ChildItem -LiteralPath $PackageRoot -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $dataExtensions -contains $_.Extension.ToLowerInvariant() })
  Check -Name '交付包不含数据库文件' -Condition ($dataFiles.Count -eq 0)

  if (-not $SkipRuntime) {
    Write-Host ''
    Write-Host '== 运行态 ==' -ForegroundColor Cyan
    $listeners = @(Get-WeFlowNetTcpListener -Port 443)
    Check -Name '443 有监听' -Condition ($listeners.Count -gt 0)
    $wrongBind = @()
    foreach ($listener in $listeners) {
      if ($listener.LocalAddress -ne $config.BindIp) { $wrongBind += $listener.LocalAddress }
    }
    Check -Name '443 仅绑定在配置的物理 IPv4 上' -Condition ($wrongBind.Count -eq 0) -Detail ("实际：{0}" -f (($listeners | ForEach-Object { $_.LocalAddress }) -join ', '))
    Check -Name '80 未被监听（只在 443 提供服务）' -Condition (@(Get-WeFlowNetTcpListener -Port 80).Count -eq 0)
    Check -Name '2019 admin 端口未被监听' -Condition (@(Get-WeFlowNetTcpListener -Port 2019).Count -eq 0)

    $statePath = Join-Path $config.StateDir 'native-caddy.current.json'
    if (Test-WeFlowPathExists -Path $statePath -Leaf) {
      $state = Read-WeFlowTextFile -Path $statePath | ConvertFrom-Json
      $process = Get-WeFlowProcessById -Id ([int]$state.Pid)
      Check -Name '记录的 PID 仍在运行' -Condition ($null -ne $process)
      Check -Name '记录 PID 的可执行路径与本轮一致' -Condition ($null -ne $process -and $process.Path -eq $state.ExecutablePath)
    } else {
      Check -Name '运行态诊断需要本轮状态文件（未切换时请加 -SkipRuntimeChecks）' -Condition $false -Detail $statePath
    }
  }

  Write-Host ''
  Write-Host ("native Windows Caddy contract guard: {0} passed, {1} failed" -f $script:PassCount, $script:FailCount)
  if ($script:FailCount -gt 0) {
    Write-Host ("失败项：{0}" -f ($script:FailMessages -join ' | ')) -ForegroundColor Red
    return 1
  }
  return 0
}

if ($SelfTest) {
  # 只加载函数定义，供隔离测试调用；不执行任何检查。
  return
}

if (-not $PackageRoot) { throw '缺少 -PackageRoot 参数' }
if (-not $NativeEnvPath) { $NativeEnvPath = Join-Path $PackageRoot 'native.env' }
if (-not $ScriptsRoot) { $ScriptsRoot = Join-Path $PackageRoot 'central\windows-caddy\scripts' }
if (-not $TemplatePath) { $TemplatePath = Join-Path $PackageRoot 'central\windows-caddy\Caddyfile.template' }

$exitCode = Invoke-WeFlowDeploymentContract -PackageRoot $PackageRoot -NativeEnvPath $NativeEnvPath `
  -ScriptsRoot $ScriptsRoot -TemplatePath $TemplatePath -SkipRuntime ([bool]$SkipRuntimeChecks)
exit $exitCode
