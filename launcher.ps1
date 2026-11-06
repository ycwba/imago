# ============================================================================
# launcher.ps1 —— 成像 · AI 创作工作台的本机服务启动器（图形界面）
#
# 它是同目录「启动.bat」唯一拉起的东西；也可以右键「使用 PowerShell 运行」。
# 界面把服务状态、端口来源、启动进度与 proxy.js 的日志放在同一个窗口里，
# 并把 **「关掉这个窗口 = 停掉端口上的服务」** 做成一条路径（「退出」按钮走的也是它）。
#
# 编码：本文件必须是 UTF-8 **带 BOM**，行尾 CRLF。PowerShell 5.1 在没有 BOM 时按 ANSI
# 解码 .ps1，界面上每一句中文都会成乱码。正文里读的 .env 必须**显式按 UTF-8 解**
# （见 Get-EnvText）；启动.bat 则是 UTF-8 无 BOM + chcp 65001。
#
# 三条判据改之前先看清它们各自在防什么：
#   · 端口优先级（环境变量 PORT > .env 的 PORT > 5175）要和 proxy.js 一致，而且**说得出口来源**；
#   · 「这个号能不能用」只能真 bind 一次问系统 —— 系统保留段里的号根本没在监听，netstat 看不见它；
#   · 只杀 node 的进程 —— 这个号的监听者要是别的程序，顺手 kill 等于删了别人正在跑的东西。
# ============================================================================

param(
  # 下面四个口子只给自检与验证用，界面上不出现，双击时一律走默认值。
  # 为什么把「读哪份 .env / 写哪个状态文件 / 额外塞哪些环境变量」做成参数：自检必须能在
  # **不碰用户真实那一份**的前提下跑完整条起停链（旧版只能靠人眼看菜单，等于没测）。
  [switch]$SelfTest,
  [string]$StateFile,
  [string]$EnvFile,
  [string[]]$EnvAdd = @(),
  [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$Root = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
if (-not $StateFile) { $StateFile = Join-Path $Root '.proxy-port' }
if (-not $EnvFile)   { $EnvFile   = Join-Path $Root '.env' }
# 命令行递进来的 [string[]] 在 -File 那条路上只会绑到**一个** argv（本机实测四种写法：
# `-File x.ps1 -EnvAdd A=1 B=2 C=3` 只收到 "A=1"，后两个 PowerShell 根本没往下传；
# `-EnvAdd A=1,B=2,C=3` 收到一整串；带引号那串连引号一起进来；
# 只有 `-Command "& x -EnvAdd 'A=1','B=2','C=3'"` 才绑成三个 —— 而双击走的是 -File，那条路不算）。
# 不拆开的话 ASSETS_DIR / RENDER_DIR 根本没指出去，探针就往用户真实的 .assets / .renders 里写
# （那里没有 .data 那套 .bak 与对账保护），而「真实 .data 一个字节都没动」照样全绿。
function Normalize-EnvAdd([string[]]$Raw) {
  @($Raw | ForEach-Object { [string]$_ } | ForEach-Object { $_.Trim('"') } |
    ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
}
$EnvAdd = Normalize-EnvAdd $EnvAdd

$DefaultPort  = 5175      # 与 proxy.js:91 `PORT_ENV || 5175` 同一个兜底值
$FreeScanSpan = 8000      # Hyper-V / winnat 实测能连占 1000 个号，窗口开窄了必然空手而归
$LogTrimAt    = 4000      # 日志一多就别让文本框无限吃内存
$LogKeep      = 2000
$StartGiveUpSec = 25      # 与旧菜单等监听的那 20 轮同量级：等不到就照实说，别一直转
$NetEveryTick   = 3       # 界面一跳 350ms，这里 ≈1 秒问一次系统（哪些跳必须现问见 Need-Net）

# ---------- 这一轮的状态（起停只改这里，界面照着画） ----------
$script:Child = $null
$script:ActivePort = 0
$script:WantOpen = $false
$script:WantStart = $false
$script:Opened = $false
$script:StartingSince = $null
$script:StoppedByClose = $false
$script:LogBuf = New-Object System.Collections.ArrayList
$script:LogShown = 0
$script:LogBox = $null
$script:NetRows = $null
$script:NetTick = 0
$script:NetRunning = $false
$script:Bad = 0
$script:PortProbeCache = @{}   # 同一个 tick 里的直连探测结果（见 Test-PortListening）
$script:NetFailNoted = $false  # netstat 读不到时只提醒一次（见 Get-NetRows）
$script:UpSince = $null      # 界面上「已运行」的起点，停掉即清空
$script:JsonCookies = $null    # 读本机路由时复用同一份会话 Cookie（见 Get-JsonUtf8）
$script:JsonCookieOrigin = ''

function Get-NetRows([switch]$Fresh) {
  # 一次 netstat 要一两百毫秒，所以一个判断周期里只问一次、后面各条判据共用这一份快照。
  # 这份快照**不按时间自动过期**：第一版给它配了 400ms 的 TTL，于是「刚刚 bind 上的号」
  # 会被上一秒那份快照判成没人在听 —— 界面与自检同时报一批假「没起来」。
  # 现在只有 Ask-Net 会真的重新问系统，谁要新读数谁自己点名。
  #
  # **读不到也不能抛**：Refresh-View 每一跳都会走到这里，一抛异常整跳就断在 Ask-Net 上 ——
  # 状态机再也不往前推，界面永远停在「正在启动」，连 25 秒那条兜底都轮不到。
  # 那正是「日志里明明写着 proxy 已启动、顶上却一直正在启动」的一种成因。
  # 所以这里退回空表：端口判活由 Test-PortListening 里的**直连探测**兜底（它不依赖 netstat），
  # 只有「拿 PID 去杀」那一步还非要 netstat 不可。
  if ($Fresh -or -not $script:NetRows) {
    try { $script:NetRows = @(& netstat.exe -ano) }
    catch {
      $script:NetRows = @()
      if (-not $script:NetFailNoted) {
        $script:NetFailNoted = $true
        # 这一句**必须写成一行**：命令模式的参数里跨行的括号组在 PowerShell 5.1 上解析不了
        # （`F ('a' 换行 + 'b')` 会报 MissingEndParenthesisInExpression），实测纯 ASCII 也一样。
        Add-LogLine ('读不到 netstat 的端口表（' + $_.Exception.Message + '）：端口判活改走直连探测，「停止」只能停这个窗口自己起的那个实例。')
      }
    }
  }
  return $script:NetRows
}

function Ask-Net { $script:PortProbeCache = @{}; [void](Get-NetRows -Fresh) }

function Need-Net {
  # 界面每一跳都要判「端口上有没有人在听」，而一次 netstat 要一两百毫秒 —— 每 350ms 问一次
  # 窗口会明显发涩；可快照一旦按时间自动过期，就会出现「刚 bind 上的号被上一秒那份快照判成
  # 没人在听」（界面与自检同时报一批假「没起来」，第一版就栽在这）。所以不按时间过期，
  # 改成点名哪些状态必须现问：
  #   · 正在等监听起来 / 有按钮动作还没落地 → 每跳都问，这一段状态本来就在变；
  #   · 这个窗口起的那个 node 还活着、上一次也读到在听 → 不问。proxy.js 只在退出时释放端口，
  #     而「退出了」用 HasExited 这一跳就能看出（读的是进程句柄，不花钱），不必靠 netstat 去猜；
  #   · 其余（服务不是这个窗口起的、或者压根没起）→ 每 $NetEveryTick 跳问一次，
  #     状态灯最多滞后一秒，而按钮与关窗那条路径各自点名了 Ask-Net，不等这一档。
  if ($script:StartingSince -or $script:WantStart -or $script:WantOpen) { return $true }
  if ($script:Child -and -not $script:Child.HasExited -and $script:NetRunning) { return $false }
  return ($script:NetTick % $NetEveryTick) -eq 0
}

function Add-LogLine {
  param([string]$Text)
  # 启动器自己的话进同一块日志（分两路显示就等于「去哪看报错」又要猜一次）
  [void]$script:LogBuf.Add("[$((Get-Date).ToString('HH:mm:ss'))] [启动器] $Text")
}

function Get-NodeExe {
  # 现取，不在界面上写死一个安装路径
  $c = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  $c = Get-Command node -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  return $null
}

# ---------- 端口：读 .env、判监听、现找能 bind 的号 ----------

function Get-EnvText([string]$File) {
  if ([string]::IsNullOrEmpty($File)) { return $null }
  if (-not (Test-Path -LiteralPath $File)) { return $null }
  # 必须显式按 UTF-8 读：旧版在 chcp 936 的代码页下用 for /f 读这一份，cmd 把中文注释当
  # GBK 双字节、连换行一起吃掉（实测 29 行只看到 17 行），而 PORT 那一行往往就在后面，
  # 于是循环根本没见到它、端口悄悄停在默认值上。PS 里没有这一层，但编码仍要自己点名。
  return [System.IO.File]::ReadAllText($File, [System.Text.Encoding]::UTF8)
}

function Get-EnvPortRaw([string]$File) {
  # 返回 .env 里最后一个 PORT= 的原始值（后写的覆盖先写的），没有则 $null
  $text = Get-EnvText $File
  if ($null -eq $text) { return $null }
  $raw = $null
  foreach ($line in ($text -split "`r?`n")) {
    $m = [regex]::Match($line.Trim(), '^(?:export\s+)?PORT\s*=\s*([^\s#]+)', 'IgnoreCase')
    if ($m.Success) { $raw = $m.Groups[1].Value }
  }
  return $raw
}

function ToPort([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { return 0 }
  $n = 0
  if ([int]::TryParse($Value.Trim(), [ref]$n) -and $n -ge 1 -and $n -le 65534) { return $n }
  return 0
}

function Get-DesiredPort {
  # 优先级与 proxy.js:90~101 一致：已经 set 过的同名环境变量 > .env 里的 PORT > 默认。
  # 顺序错了就造出「.env 明明写了 6200，界面与启动却按 5175 走」那种自相矛盾。
  param([string]$File = $EnvFile, [string]$EnvOverride = $env:PORT)
  $evRaw = $EnvOverride
  $ev = ToPort $evRaw
  if ($ev -gt 0) { return @{ Port = $ev; Source = "环境变量 PORT=$ev（同名环境变量比 .env 优先）" } }
  $raw = Get-EnvPortRaw $File
  $fv = ToPort $raw
  if ($fv -gt 0) { return @{ Port = $fv; Source = ".env 里的 PORT=$fv" } }
  if ($evRaw) { return @{ Port = $DefaultPort; Source = "默认 $DefaultPort（环境变量 PORT=「$evRaw」不是数字）" } }
  if ($raw)   { return @{ Port = $DefaultPort; Source = "默认 $DefaultPort（.env 里写的 PORT=「$raw」不是数字）" } }
  return @{ Port = $DefaultPort; Source = "默认 $DefaultPort（.env 里没写 PORT）" }
}

function Read-StatePort {
  # 上一次**真跑起来**的端口。它和期望端口可能不一样（那次启动自动换过号），
  # 停止 / 重启 / 关窗都要按它去关，否则换了端口那次关的还是旧的那个。
  try {
    if (-not (Test-Path -LiteralPath $StateFile)) { return 0 }
    return (ToPort ([System.IO.File]::ReadAllText($StateFile, [System.Text.Encoding]::ASCII)))
  } catch { return 0 }
}

function Write-StatePort([int]$Port) {
  # 与旧版 `> .proxy-port echo %AP%` 同一份格式（一个号 + CRLF），旧文件读得进来
  try { [System.IO.File]::WriteAllText($StateFile, "$Port`r`n", [System.Text.Encoding]::ASCII) } catch {}
}

function Clear-StatePort {
  try { Remove-Item -LiteralPath $StateFile -Force -ErrorAction SilentlyContinue } catch {}
}

function Get-PortOwnerPids([int]$Port) {
  if ($Port -lt 1) { return @() }
  $out = New-Object System.Collections.Generic.List[int]
  # 先按 LISTENING 过一遍再切列。取列前必须去掉空元素：行首那段空白用 -split 会切出一个
  # 空字符串，不去掉的话所有下标整体后移一位，读回来的 PID 就成了空（第一版就栽在这）。
  foreach ($line in @(Get-NetRows)) {
    if ($line -notmatch 'LISTENING') { continue }
    $c = @($line -split '\s+' | Where-Object { $_ -ne '' })
    if ($c.Count -lt 5) { continue }
    if ($c[0] -ne 'TCP') { continue }
    if ($c[3] -ne 'LISTENING') { continue }
    # PID 那一格不是数字就跳过（`[int]` 直接转型会抛，而抛出去会打断整个 Refresh-View）
    if ($c[1] -match (':' + $Port + '$')) { $n = 0; if ([int]::TryParse($c[4], [ref]$n)) { [void]$out.Add($n) } }
  }
  # 同一个进程常在 IPv4 与 IPv6 各占一行，不去重就会把「已停止」同一句话打印两遍
  $uniq = @($out | Select-Object -Unique)
  if ($uniq.Count -gt 0) { return $uniq }
  # 有些 Windows 会话里 netstat 看不到本进程刚 bind 的号（自检就抓过：直连能通、
  # Get-NetTCPConnection 看得到，netstat 一行都没有）。这时用系统 API 再问一次；
  # 两条路都问不到就返回空 —— 调用方据此判定「不知道是谁」，绝不猜一个 PID 去杀。
  try {
    for ($try = 0; $try -lt 3 -and $out.Count -eq 0; $try++) {
      foreach ($item in @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop)) {
        $n = [int]$c.OwningProcess
        if ($n -gt 0) { [void]$out.Add($n) }
      }
      if ($out.Count -eq 0) { Start-Sleep -Milliseconds 80 }
    }
  } catch {}
  return @($out | Select-Object -Unique)
}

function Test-TcpConnect([int]$Port, [int]$TimeoutMs = 400) {
  # 不依赖 netstat 的「有没有人在听」：真连一次。
  # 为什么必须有这条兜底：实测有一类环境里 netstat.exe 读不到本进程刚 bind 上的号
  # （启动器的自检里「认得出刚占住的号」与「启动后端口上真的在监听」两条就是被它红的），
  # 而界面表现正是**永远停在「正在启动」** —— 服务明明起来了、页面却一直没人开。
  # 直连只答「有没有人在听」，要 PID 还是得问 netstat（那是另一件事，见 Stop-PortListener）。
  if ($Port -lt 1) { return $false }
  $c = $null
  try {
    $c = New-Object System.Net.Sockets.TcpClient
    $iar = $c.BeginConnect('127.0.0.1', $Port, $null, $null)
    if (-not $iar.AsyncWaitHandle.WaitOne($TimeoutMs, $false)) { return $false }
    $c.EndConnect($iar)     # 连不上会在这里抛（连接被拒 / 超时）
    return $true
  } catch { return $false }
  finally { if ($c) { try { $c.Close() } catch {} } }
}

function Test-PortListening([int]$Port) {
  if ($Port -lt 1) { return $false }
  # 一个 tick 里这条会被问好几次（WantOpen / StartingSince / Update-Status 各一次），
  # 结果按「端口 + 当前 tick」缓存一份；Ask-Net 会把它清掉，所以每个判断周期都是新读数。
  $k = [string]$Port + '@' + [string]$script:NetTick
  if ($script:PortProbeCache.ContainsKey($k)) { return [bool]$script:PortProbeCache[$k] }
  $ok = Test-TcpConnect $Port
  if (-not $ok) { $ok = @(Get-PortOwnerPids $Port).Count -gt 0 }
  $script:PortProbeCache[$k] = $ok
  return $ok
}

function Get-ProxyWhoami([int]$Port) {
  # /whoami 同时给出 app 与 pid：身份和“这个进程什么时候起的”都从这一份答话里取，
  # 不再依赖 netstat/CIM 能不能报出监听者（有的 Windows 会话就是报不出）。
  if ($Port -lt 1) { return $null }
  return (Get-JsonUtf8 "http://127.0.0.1:$Port/whoami")
}

function Get-ProxyPids([int]$Port) {
  # 停进程要 PID。netstat/CIM 在少数 Windows 会话里看不到本机刚 bind 的监听，
  # 这时用 /whoami 自报的 pid 兜底；调用方已先用 Test-OurProxy 验过身份。
  $pids = @(Get-PortOwnerPids $Port)
  if ($pids.Count -gt 0) { return $pids }
  $who = Get-ProxyWhoami $Port
  $whoPid = 0
  if ($who -and [int]::TryParse([string]$who.pid, [ref] $whoPid) -and $whoPid -gt 0) { return @($whoPid) }
  return @()
}

function Test-OurProxy([int]$Port) {
  # 「这个号上是不是本项目」—— 判据只此一份，问的是 proxy.js 自己的 /whoami。
  # 为什么必须有它：以前「有没有服务」只看「端口上有人在听」，而那个号上可能是**别的 node 程序**
  #（用户自己起的开发服务器、别的工具）。后果不是打不开页面，而是两件更糟的事：
  #   ① Start-Proxy 把别人的服务当成「本项目在跑」，直接开页面 —— 打开的是一个不相干的程序；
  #   ② Stop-PortListener 的闸只问「监听者是不是 node」，于是点「停止」会**杀掉别人机器上的 node**。
  # 判据要能被证伪，所以这里必须真的发一次请求并读 JSON，不靠端口号或进程名猜。
  # 读不出来 / 不是本项目 / 请求失败，一律当作「不是本项目的」—— 宁可多问一次启动器，也不要误杀。
  $j = Get-ProxyWhoami $Port
  if (-not $j) { return $false }
  return ("$($j.app)" -eq 'shiji-workbench')
}

function Get-NewestSourceTime {
  # 运行期源码的最新修改时间。只扫真正影响这一份服务的文件：
  # shell.html / proxy.js / web/ / server/。tests、docs、用户数据不参与，
  # 改测试或改文档不该逼着服务重启。
  $newest = [DateTime]::MinValue
  $paths = @(
    (Join-Path $Root 'shell.html'),
    (Join-Path $Root 'proxy.js'),
    (Join-Path $Root 'web'),
    (Join-Path $Root 'server')
  )
  foreach ($p in $paths) {
    if (-not (Test-Path -LiteralPath $p)) { continue }
    if (Test-Path -LiteralPath $p -PathType Leaf) {
      $t = (Get-Item -LiteralPath $p).LastWriteTime
      if ($t -gt $newest) { $newest = $t }
      continue
    }
    try {
      $f = Get-ChildItem -LiteralPath $p -Recurse -File -ErrorAction Stop |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
      if ($f -and $f.LastWriteTime -gt $newest) { $newest = $f.LastWriteTime }
    } catch {}
  }
  return $newest
}

function Get-ProxyStartedAt([int]$Port) {
  # 先信 /whoami 自己报的 pid（不依赖 netstat 能否看到 owner）；读不到再用 owner 兜底。
  # 变量不能叫 $pid：那是 PowerShell 的只读自动变量。
  $who = Get-ProxyWhoami $Port
  $whoPid = 0
  if ($who -and [int]::TryParse([string]$who.pid, [ref] $whoPid) -and $whoPid -gt 0) {
    try {
      $proc = Get-Process -Id $whoPid -ErrorAction Stop
      if ($proc -and $proc.StartTime) { return $proc.StartTime }
    } catch {}
  }
  foreach ($p in @(Get-PortOwnerPids $Port)) {
    try {
      $proc = Get-Process -Id $p -ErrorAction Stop
      if ($proc -and $proc.StartTime) { return $proc.StartTime }
    } catch {}
  }
  return $null
}

function Test-StaleByTimes([DateTime]$Started, [DateTime]$Newest) {
  # 2 秒容差：进程启动与文件时间在同一秒附近会有取整差。
  # 单独拆出来是为了自检能直接喂两组时间，不必真去制造一个旧进程。
  if ($Newest -eq [DateTime]::MinValue) { return $false }
  return ($Newest -gt $Started.AddSeconds(2))
}

function Test-ProxyStale([int]$Port) {
  # 旧服务不是“坏了”，是**它加载的是改代码前的静态路由**。启动器只按 /whoami
  # 认“是本项目”，于是会把旧进程当成“已经在跑”，直接开一个资源全 404 的白页。
  # 这里用进程启动时间与源码最新修改时间比一次；读不到任何一边就不动它（宁可让用户
  # 手动重启，也不猜一个 PID 去杀）。
  $started = Get-ProxyStartedAt $Port
  if (-not $started) { return @{ Stale = $false; Reason = '读不到服务启动时间' } }
  $newest = Get-NewestSourceTime
  if ($newest -eq [DateTime]::MinValue) { return @{ Stale = $false; Reason = '读不到源码修改时间' } }
  if (Test-StaleByTimes $started $newest) {
    $reason = '服务启动于 ' + $started.ToString('MM-dd HH:mm:ss') + '，最新源码改于 ' + $newest.ToString('MM-dd HH:mm:ss')
    return @{ Stale = $true; Reason = $reason; Started = $started; Newest = $newest }
  }
  return @{ Stale = $false; Reason = ''; Started = $started; Newest = $newest }
}

function Wait-Listening([int]$Port, [double]$Seconds) {
  # 等的是「它最终起来了 / 终于停了」，不是「这一瞬间的快照」。每一轮都重新问一次系统 ——
  # 不点名 Ask-Net 的话循环读到的还是同一份旧快照，等于原地干等（第一版的假红就在这）。
  $until = (Get-Date).AddSeconds($Seconds)
  while ($true) {
    Ask-Net
    if (Test-PortListening $Port) { return $true }
    if ((Get-Date) -ge $until) { return $false }
    Start-Sleep -Milliseconds 200
  }
}

function Wait-Gone([int]$Port, [double]$Seconds) {
  $until = (Get-Date).AddSeconds($Seconds)
  while ($true) {
    Ask-Net
    if (-not (Test-PortListening $Port)) { return $true }
    if ((Get-Date) -ge $until) { return $false }
    Start-Sleep -Milliseconds 200
  }
}

function Find-FreePort([int]$From) {
  # 这一步必须问系统，不能只看 netstat：系统保留段里的号根本没在监听，
  # 但它就是绑不上（proxy.js 报的是 listen EACCES），只有真 bind 一次才看得出来。
  for ($p = $From; $p -lt ($From + $FreeScanSpan); $p++) {
    $l = $null
    try {
      $l = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Any, $p)
      $l.Start()
      $l.Stop()
      $l = $null
      return $p
    } catch {
      if ($l) { try { $l.Stop() } catch {} }
    }
  }
  return $From
}

function Stop-PortListener([int]$Port) {
  # 返回值只用于日志与自检：界面上那句「为什么没关掉」必须照原话摆出来。
  # 强度与旧版 taskkill /F 完全一致（TerminateProcess）—— 所以 proxy.js 那个 SIGINT 兜底
  # （顺手收掉在跑的子进程，如 whisper-cli）不会跑。旧版也是这样，不是这一版新引入的；要改就连
  # proxy.js 的退出协议一起改，别只在这里装优雅。
  $killed = @()
  $messages = @()
  # 先问身份，再动进程 —— 「是不是 node」这道闸挡不住「就是 node，但不是本项目的」。
  # 以前这一段只按进程名判，于是用户自己起的 node 开发服务器会被点「停止」杀掉。
  if (-not (Test-OurProxy $Port)) {
    $who = @(Get-PortOwnerPids $Port | ForEach-Object {
      $n = (Get-Process -Id $_ -ErrorAction SilentlyContinue).ProcessName
      if ($n) { "$n(PID $_)" }
    })
    $messages += "端口 $Port 上不是本工作台的服务（$($who -join '、')），没有动它 —— 只停本项目起的进程。"
    return @{ Killed = $killed; Messages = $messages }
  }
  foreach ($p in @(Get-ProxyPids $Port)) {
    $name = (Get-Process -Id $p -ErrorAction SilentlyContinue).ProcessName
    if ($name -ne 'node') {
      $messages += "端口 $Port 被别的程序占着（PID $p 是「$name」，不是 node），没有动它。"
      continue
    }
    try {
      Stop-Process -Id $p -Force -ErrorAction Stop
      $killed += $p
      $messages += "已停止端口 $Port 上的服务（PID $p）。"
    } catch {
      $messages += "端口 $Port 上的 node（PID $p）没关掉：$($_.Exception.Message)"
    }
  }
  return @{ Killed = $killed; Messages = $messages }
}

# ---------- 服务的唯一一条起路 / 一条停路（界面与自检走的是同一份） ----------

function Proxy-Running {
  # 判「有没有服务」只有一条口径：**这个号上是本工作台**（不是「有人在听」）。
  # 进程还在但监听没起来（proxy.js 自己绑不上就 process.exit(1)，换号那一下也可能残留）时
  # 要说「没起来」，不能因为 HasExited 是 false 就画成运行中 —— 那正是让人对着一个
  # 打不开的页面干等的写法。
  # 加上身份这一层是防这一种：用户自己有个 node 程序占着这个号，
  # 界面曾经把它画成「运行中」，而「停止」会把它杀掉。现在两处问的是同一个 Test-OurProxy。
  if ($script:ActivePort -gt 0 -and (Test-PortListening $script:ActivePort) -and (Test-OurProxy $script:ActivePort)) { return $true }
  return $false
}

function Start-Proxy {
  if (-not $script:RunnerOk) { Add-LogLine '这一版的启动器起不了服务（编译读日志那一段失败）。'; return }
  if ($script:Child -and -not $script:Child.HasExited) { return }
  Ask-Net
  $d = Get-DesiredPort
  # 已经在跑就不要再起第二个实例：先看这个窗口起过的那个号，再看状态文件里的，最后看期望的。
  # 顺序反了的话，自动换过端口那一次会被当成「没在跑」，于是同一个项目起两份、第二份报 EADDRINUSE。
  $seen = @($script:ActivePort, (Read-StatePort), $d.Port) | Where-Object { $_ -gt 0 } | Select-Object -Unique
  foreach ($p in $seen) {
    if (Test-PortListening $p) {
      # 「有人在听」与「是本项目」是两件事：认错了会开出一个不相干的页面，
      # 而点「停止」时更会动到别人的进程。所以这里先问身份（判据见 Test-OurProxy）。
      if (-not (Test-OurProxy $p)) {
        Add-LogLine "端口 $p 上有人在听，但不是本工作台的服务 —— 这次改用一个空号启动，别去动它。"
        continue
      }
      # 同一份应用、但可能是改代码前起的旧进程：它的静态路由/启动参数与当前源码不一致，
      # 直接开页面就是白屏。先停掉再按当前源码起；停不掉就照实说，不假装已经是最新。
      $stale = Test-ProxyStale $p
      if ($stale.Stale) {
        Add-LogLine ("端口 $p 上的服务还是旧代码（" + $stale.Reason + "），先停掉再起新的。")
        $r = Stop-PortListener $p
        foreach ($m in $r.Messages) { Add-LogLine $m }
        if (@($r.Killed).Count -eq 0) {
          Add-LogLine "旧服务没能停掉；这次仍打开它。若页面白屏，请点「重启」或关掉启动器再开。"
          $script:ActivePort = $p
          $script:WantOpen = $true
          $script:StartingSince = $null
          return
        }
        $script:ActivePort = 0
        $script:WantOpen = $false
        $script:StartingSince = $null
        continue
      }
      $script:ActivePort = $p
      $script:WantOpen = $true
      $script:StartingSince = $null
      Add-LogLine "端口 $p 上已经有服务在跑（不是这一次起的），直接开页面：http://localhost:$p/"
      return
    }
  }
  $node = Get-NodeExe
  if (-not $node) {
    Add-LogLine '找不到 Node.js，请先安装后再运行（本项目靠它跑 proxy.js）。'
    return
  }
  $free = Find-FreePort $d.Port
  if ($free -ne $d.Port) {
    Add-LogLine "$($d.Port) 这个号现在绑不上：可能被别的进程占用，也可能落在 Windows 的系统保留段里。"
    Add-LogLine '查保留段：netsh interface ipv4 show excludedportrange protocol=tcp'
    Add-LogLine "这次改用 $free 启动。想以后都用它，就在 .env 里写一行 PORT=$free"
  }
  $envList = @("PORT=$free") + @($EnvAdd)
  try {
    $script:Child = [WorkbenchRunner]::Start($Root, $node, 'proxy.js', [string[]]$envList, [System.Text.Encoding]::UTF8)
  } catch {
    Add-LogLine "起不来：$($_.Exception.Message)"
    $script:Child = $null
    return
  }
  $script:ActivePort = $free
  $script:WantOpen = $true
  $script:Opened = $false
  $script:StartingSince = Get-Date
  Write-StatePort $free
  Add-LogLine "正在启动：proxy.js（端口 $free，来源：$($d.Source)）"
}

function Stop-Proxy {
  # 三个号都要看一遍：这个窗口起的、状态文件记录的、期望的 —— 它们可能互不相同，
  # 而旧版就是因为只按期望端口去关，换了端口那次停不掉、下次启动报 EADDRINUSE。
  Ask-Net
  $d = Get-DesiredPort
  $targets = @($script:ActivePort, (Read-StatePort), $d.Port) | Where-Object { $_ -gt 0 } | Select-Object -Unique
  $any = $false
  foreach ($p in $targets) {
    if (-not (Test-PortListening $p)) { continue }
    $r = Stop-PortListener $p
    foreach ($m in $r.Messages) { Add-LogLine $m }
    if (@($r.Killed).Count -gt 0) { $any = $true }
  }
  if ($script:Child) {
    # 上面那一圈通常已经把它收掉了（它就是端口上的那个 node）；这里只兜底，并让两条
    # 管道的读线程收在 EOF 上，不留一个还挂着死进程的读者。
    try { if (-not $script:Child.HasExited) { $script:Child.Kill() } } catch {}
    try { [void]$script:Child.WaitForExit(3000) } catch {}
    try { $script:Child.Dispose() } catch {}
    $script:Child = $null
  }
  Clear-StatePort
  Ask-Net
  $script:ActivePort = 0
  $script:WantOpen = $false
  $script:Opened = $false
  $script:StartingSince = $null
  if (-not $any) { Add-LogLine "没有正在运行的服务（端口 $($d.Port) 上没有监听）。" }
}

function Open-Page {
  if ($script:ActivePort -le 0) { return }
  $url = "http://localhost:$($script:ActivePort)/"
  if ($NoBrowser) { Add-LogLine "（这一轮不打开页面）本该开 $url"; return }
  try { Start-Process $url } catch { Add-LogLine "打不开页面：$($_.Exception.Message)" }
}

# ---------- 无界面的自检：跑的就是上面这一份真源码 ----------

function Check {
  param([string]$Name, [bool]$Ok, [string]$Detail = '')
  if ($Ok) { Write-Host "OK   $Name" }
  else { $script:Bad++; Write-Host "FAIL $Name  $Detail" }
}

function Get-JsonUtf8([string]$Url) {
  # PS 5.1 的 Invoke-RestMethod 在响应只写 Content-Type: application/json（不带 charset）时
  # 按 ANSI 解码，proxy.js 那些中文键名读回来就成了「ä»£ç」—— 字段取不到，看着像接口没返回。
  # 浏览器不受影响（它按 UTF-8 解），所以这不是产品的错，是读法得自己点名编码。
  #
  # 本机路由（/sys-status 等）还要会话 Cookie：先用同一个 CookieContainer 打一次根路径，
  # 收下代理种下的 wb_session，再问目标接口。没有这一步自检会读到 401 空响应。
  $origin = ([Uri]$Url).GetLeftPart([UriPartial]::Authority)
  if ($script:JsonCookieOrigin -ne $origin) {
    $script:JsonCookieOrigin = $origin
    $script:JsonCookies = New-Object System.Net.CookieContainer
    try {
      $pre = [System.Net.WebRequest]::Create($origin + '/')
      $pre.CookieContainer = $script:JsonCookies
      $pre.Timeout = 5000
      $pre.GetResponse().Close()
    } catch {}
  }
  $req = $null
  $resp = $null
  $sr = $null
  try {
    $req = [System.Net.WebRequest]::Create($Url)
    $req.CookieContainer = $script:JsonCookies
    $req.Timeout = 5000
    $resp = $req.GetResponse()
    $sr = New-Object System.IO.StreamReader($resp.GetResponseStream(), [System.Text.Encoding]::UTF8)
    return ($sr.ReadToEnd() | ConvertFrom-Json)
  } catch { return $null }
  finally {
    if ($sr) { try { $sr.Dispose() } catch {} }
    if ($resp) { try { $resp.Close() } catch {} }
  }
}

function Find-LauncherType([string]$n) {
  # -as [type] 就是 PowerShell 自己解析 [Foo] 用的那一条（连带认 int / string 这些加速器），
  # 但它不搜「已加载却没被引用」的程序集，所以再按 AppDomain 走一遍 —— 否则会假红。
  $t = $n -as [type]
  if ($t) { return $t }
  $base = $n -replace '\[\]$', ''
  foreach ($a in [AppDomain]::CurrentDomain.GetAssemblies()) {
    try {
      $x = $a.GetType($base)
      if ($x) { if ($base -ne $n) { $x = $x.MakeArrayType() }; return $x }
    } catch { }
  }
  return $null
}

function Get-TypeLiteralReport([string]$Path) {
  # 界面里每一个 [类型] 字面量都得真解析得到。类型名写错一个字母（踩过：MessageBoxIcons 多一个 s）
  # **语法自查一个字都不报**，AST 也照过 —— 它只在运行到那一条分支时才弹 WinForms 那面
  # 「未处理的异常」大字报，而那条分支（服务不是这个窗口起的 / Add-Type 用不了）平时根本走不到。
  # 所以这一档不测行为、只测名字：把整份文件的类型字面量点一遍名。
  $parseErrs = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseFile($Path, [ref] $null, [ref] $parseErrs)
  if (@($parseErrs).Count -gt 0) { return @{ Parse = @($parseErrs).Count; Total = 0; Bad = @('*AST 解析就失败*') } }
  # TypeAst 本身在 PS 5.1 里是 internal，写它的名字就会撞上这一档正要抓的那个错；
  # 要问的是它两个公开的子类（[Foo]$x 的转换包着 TypeConstraintAst，[Foo]::Bar 包着 TypeExpressionAst，
  # FindAll 会钻进转换节点里面，所以两个都收齐了）。
  $nodes = $ast.FindAll({ param($n)
    $n -is [System.Management.Automation.Language.TypeExpressionAst] -or
    $n -is [System.Management.Automation.Language.TypeConstraintAst]
  }, $true)
  $names = @($nodes | ForEach-Object { $_.TypeName } | Sort-Object -Unique)
  @{ Parse = 0; Total = @($names).Count; Bad = @($names | Where-Object { -not (Find-LauncherType $_) }) }
}

function Get-StartFlagOrder([string]$Path) {
  # 「正在启动」那一格什么时候该摘掉 —— 这一档查的是**顺序**：
  # 等监听那个块里，「端口上真有人在听」必须排在「等满了没有」前面。
  # 反过来的时候界面不会报错，只会**说谎**：日志里早写着「proxy 已启动：http://localhost:6500」、
  # 页面也开好了，顶上还挂着「正在启动 / 正在等服务监听上 6500」整整 25 秒（截图拍到过这一屏）。
  # 所以判据不能是「块里出现过 Proxy-Running 这个词」（注释里提一句也算过），
  # 也不能是「出现过 StartingSince = $null」（超时那一条也会清）—— 要比的是两处落地的行号。
  $errs = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseFile($Path, [ref] $null, [ref] $errs)
  if (@($errs).Count -gt 0) { return @{ Ok = $false; Why = 'AST 解析就失败' } }
  # 这一版 PS 的 IfStatementAst 只有 Clauses（每项是个 Tuple：Item1 条件、Item2 那一段），
  # 没有 Condition 这个属性 —— 拿它去读条件会得到 null，于是这一档永远报「找不到那块」。
  $outer = @($ast.FindAll({ param($n)
    $n -is [System.Management.Automation.Language.IfStatementAst] -and
    @($n.Clauses).Count -eq 1 -and @($n.Clauses)[0].Item1.Extent.Text -eq '$script:StartingSince'
  }, $true))
  if (@($outer).Count -ne 1) { return @{ Ok = $false; Why = ('这样的等待块有 ' + @($outer).Count + ' 处（应当只有 1 处，多了这条判据就不知道在说哪一块）') } }
  $run = @($outer[0].FindAll({ param($n)
    $n -is [System.Management.Automation.Language.CommandAst] -and $n.GetCommandName() -eq 'Proxy-Running'
  }, $true))
  # 只认「右操作数是 $StartGiveUpSec 的二元比较」：赋值不是 BinaryExpressionAst，
  # 所以字符串里提一句这个变量名不会冒充判据（踩过「判据落在符号名上」那一类）。
  $give = @($outer[0].FindAll({ param($n)
    $n -is [System.Management.Automation.Language.BinaryExpressionAst] -and
    $n.Right.Extent.Text -eq '$StartGiveUpSec'
  }, $true))
  if (@($run).Count -eq 0) { return @{ Ok = $false; Why = '这个块里一次都没问过「有没有人在听」，那它只能靠超时收场' } }
  if (@($give).Count -eq 0) { return @{ Ok = $false; Why = '这个块里没有超时那一条，等不到监听就永远挂着「正在启动」' } }
  $rl = @($run)[0].Extent.StartLineNumber
  $gl = @($give)[0].Extent.StartLineNumber
  @{ Ok = ($rl -lt $gl); Why = "问监听在第 $rl 行，问超时在第 $gl 行" }
}

function Invoke-SelfTest {
  $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('aii-launcher-' + ([Guid]::NewGuid().ToString('N')).Substring(0, 8))
  New-Item -ItemType Directory -Path $tmp | Out-Null
  # 下面一律用 $script: 赋值：函数里裸写 $EnvFile = … 只会造出一个函数局部变量，
  # Start-Proxy 那一边读到的还是**用户真实的 .env**（第一版就栽在这，自检会去动真实实例）。
  # 三个落盘目录放在 $tmp 下（跟着自检收尾一起删）：写成仓库根相对路径的话，自检每跑一次
  # 就在仓库里留 .data-probe / .assets-probe / .renders-probe 三组空壳，被硬杀时更没人清。
  $script:EnvAdd = @(('DATA_DIR=' + (Join-Path $tmp 'data-probe')), ('ASSETS_DIR=' + (Join-Path $tmp 'assets-probe')), ('RENDER_DIR=' + (Join-Path $tmp 'renders-probe')))
  $realStateFile = $StateFile
  $realEnvFile = $EnvFile
  $realPort = Read-StatePort
  Ask-Net
  $realWasUp = ($realPort -gt 0 -and (Test-PortListening $realPort))
  $dataBefore = @(Get-ChildItem -Path (Join-Path $Root '.data') -Filter '*.json' -ErrorAction SilentlyContinue |
    Sort-Object Name | ForEach-Object { (Get-FileHash -Path $_.FullName -Algorithm SHA1).Hash })

  # ⓪ 探针参数那一串到底拆成了几个 —— 这一档管的是「探针有没有真的躲开用户那三份目录」。
  # 期望值逐格手算（不是照上一格推）：一整串逗号 → 3 项；三个独立项（-Command 那条路）→ 3 项；
  # 带引号 → 3 项且引号被摘掉；空 → 0 项（双击时不许往里塞任何东西）。
  $e1 = Normalize-EnvAdd @('DATA_DIR=.a,ASSETS_DIR=.b,RENDER_DIR=.c')
  Check '命令行的一整串拆成三项（-File 只会绑到一个 argv）' (@($e1).Count -eq 3) (@($e1) -join '|')
  Check '拆出来的每一项都是 KEY=值（漏了等号就是拆错地方）' (@($e1 | Where-Object { $_ -notmatch '^[A-Z_]+=' }).Count -eq 0) (@($e1) -join '|')
  $e2 = Normalize-EnvAdd @('DATA_DIR=.a', 'ASSETS_DIR=.b', 'RENDER_DIR=.c')
  Check '-Command 那种三个独立项的写法也照样收（同一条判据，不认写法）' ((@($e2) -join '|') -eq 'DATA_DIR=.a|ASSETS_DIR=.b|RENDER_DIR=.c') (@($e2) -join '|')
  $e3 = Normalize-EnvAdd @('"DATA_DIR=.a,ASSETS_DIR=.b"')
  Check '带引号递进来的那串不会把引号留在键名上' ((@($e3) -join '|') -eq 'DATA_DIR=.a|ASSETS_DIR=.b') (@($e3) -join '|')
  Check '双击时（没给 -EnvAdd）拆出来是 0 项，不往子进程塞任何东西' (@(Normalize-EnvAdd @()).Count -eq 0) ''

  # ⓪-b 类型名字点一遍名（见 Get-TypeLiteralReport 那段注释：这一类错只在走到分支时才炸，
  # 所以不能靠「跑一遍界面」覆盖，只能整份文件点名）。Total 那一半是防尺子自己坏掉 ——
  # 扫出 0 个类型字面量和扫出 36 个全过，在前一种情况下也会照样报绿。
  $self = if ($PSCommandPath) { $PSCommandPath } else { Join-Path $Root 'launcher.ps1' }
  $tl = Get-TypeLiteralReport $self
  Check 'launcher.ps1 用 AST 解析得开' ($tl.Parse -eq 0) ("报错 " + $tl.Parse + " 条")
  Check '每一个 [类型] 字面量都解析得到（写错的只有走到那条分支才弹大字报）' `
    ($tl.Bad.Count -eq 0 -and $tl.Total -ge 20) ('认不出：' + (@($tl.Bad) -join ', ') + '｜共 ' + $tl.Total + ' 个')
  Check 'Native.Dpi 那段 P/Invoke 编译得动（不然界面按 DPI 换算会静默退回 100%）' ([bool]$script:DpiOk) ''
  # ⓪-c 状态灯与日志说的是不是同一件事（判据落在两处落地的先后上，见 Get-StartFlagOrder）
  $so = Get-StartFlagOrder $self
  Check '「正在启动」在真监听起来的那一跳就摘掉，不等超时' ($so.Ok) $so.Why

  # ① 端口来源：四格期望值逐格手算，不是照上一格的样子推
  $probeEnv = Join-Path $tmp 'env-probe.txt'
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($probeEnv, "# 本地代理端口`r`n# 中文注释第二行`r`nPORT=7301`r`nDATA_DIR=.data`r`n", $utf8)
  $d1 = Get-DesiredPort $probeEnv ''
  Check '.env 里中文注释之后的 PORT 读得到（旧 batch 版正是读不到这一行）' ($d1.Port -eq 7301) "读出来 $($d1.Port)"
  Check '端口来源说得出口（点名 .env）' ($d1.Source -like '*.env*7301*') $d1.Source
  $d2 = Get-DesiredPort $probeEnv '7402'
  Check '环境变量 PORT 盖过 .env（与 proxy.js 同序）' ($d2.Port -eq 7402) "读出来 $($d2.Port)"
  [System.IO.File]::WriteAllText($probeEnv, "KEY=abc`r`n", $utf8)
  $d3 = Get-DesiredPort $probeEnv ''
  Check '.env 没写 PORT 退默认 5175' ($d3.Port -eq 5175) "读出来 $($d3.Port)"
  [System.IO.File]::WriteAllText($probeEnv, "PORT=abc`r`n", $utf8)
  $d4 = Get-DesiredPort $probeEnv ''
  Check 'PORT 不是数字时不冒充「没写过」' ($d4.Port -eq 5175 -and $d4.Source -like '*不是数字*') $d4.Source

  # ② 监听查询 + 现找能 bind 的号：先自己占住一个号再问它
  $hold = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Any, 0)
  $hold.Start()
  $heldPort = $hold.LocalEndpoint.Port
  Ask-Net
  Check 'Test-PortListening 认得出刚占住的号' (Test-PortListening $heldPort) "端口 $heldPort"
  $ff = Find-FreePort $heldPort
  Check 'Find-FreePort 会跳过绑不上的号' ($ff -gt $heldPort) "从 $heldPort 找到 $ff"
  Check '找到的那个号确实没人在听' (-not (Test-PortListening $ff)) "端口 $ff"
  $mine = @(Get-PortOwnerPids $heldPort)
  # 少数 Windows 会话里 netstat 与 CIM 都不报告「本进程刚 bind 的监听」（直连能通、端口也能用，
  # 只是看不到 owner）。这时不把它判成产品坏：拿不到 owner 时产品本来就不会杀进程。
  # 只有「看得到端口、却读不到本进程」才是真缺陷；看不到端口直接跳过这一条。
  if ($mine.Count -eq 0) {
    Write-Host "SKIP Get-PortOwnerPids 报出的是本机这个进程  （当前 Windows 会话不报告该监听的 owner；拿不到 owner 时产品不会杀进程）"
  } else {
    Check 'Get-PortOwnerPids 报出的是本机这个进程' ($mine -contains $PID) "读到 $($mine -join ',')"
  }

  # ③ 「不是本项目就不动它」这条闸门。它坏掉的表现是**本进程被自己杀掉**（输出就此断掉，
  #    没有最后一行）—— 这是这一条能拿到的最强证据，也是它必须放在后面跑的原因。
  #    这里占着号的是 PowerShell 自己：它**不是 node**，身份也不是本项目，两道闸都该拦住。
  $g = Stop-PortListener $heldPort
  Check '监听者不是本项目时一个进程都不动' (@($g.Killed).Count -eq 0 -and (($g.Messages) -join ' ') -like '*不是本工作台*') (($g.Messages) -join ' / ')
  Check '上面那一圈确实没把自己停掉' (Test-PortListening $heldPort) ''
  # 身份判据单独验一次：占着一个号但答不出 /whoami，就该判成「不是本项目的」
  Check '占着号但不答 /whoami 时身份判false' (-not (Test-OurProxy $heldPort)) "端口 $heldPort"
  $hold.Stop()

  # ④ 状态文件与旧 bat 写的那份格式互通（旧文件只有一个号 + CRLF）
  $probeState = Join-Path $tmp 'proxy-port.probe'
  [System.IO.File]::WriteAllText($probeState, "5175`r`n", [System.Text.Encoding]::ASCII)
  $script:StateFile = $probeState
  Check '读得进旧 启动.bat 写下的 .proxy-port' ((Read-StatePort) -eq 5175) ''

  # ④-b 代码新鲜度：读得到运行期源码时间，旧服务才会被认出来
  # （读不到时 Test-ProxyStale 明确返回不 stale，不猜 PID 去杀）
  $nt = Get-NewestSourceTime
  Check '读得到运行期源码的最新修改时间' ($nt -gt [DateTime]::MinValue) ($nt.ToString('yyyy-MM-dd HH:mm:ss'))
  $now = Get-Date
  Check '旧代码判据：源码晚于服务启动算旧' (Test-StaleByTimes $now.AddMinutes(-5) $now) ''
  Check '旧代码判据：源码早于服务启动不算旧' (-not (Test-StaleByTimes $now $now.AddMinutes(-5))) ''

  # ⑤ 真起一份隔离实例（三个落盘目录全指出去：只换 DATA_DIR 的话探针素材会直接进用户资产库）
  $want = Find-FreePort 6400
  [System.IO.File]::WriteAllText($probeEnv, "PORT=$want`r`n", $utf8)
  $script:EnvFile = $probeEnv
  Add-LogLine '自检开始'
  Start-Proxy
  $startedPort = $script:ActivePort
  # node 从 spawn 到 bind 上一两秒，所以这里等的是「它最终起来了」，不是「spawn 那一瞬间已经在听」。
  $up = Wait-Listening $startedPort $StartGiveUpSec
  Check '启动后端口上真的在监听' $up "端口 $startedPort"
  Check '状态文件写的是实际跑起来的端口' ((Read-StatePort) -eq $startedPort) ''
  # 「是本项目」这条身份判据必须与「在监听」同时成立 —— 只在监听不认身份的话，
  # 停止按钮会连自己的服务都不敢停（另一头是认错人就会杀掉别人的 node）。
  Check '本项目的服务身份认得出来（/whoami）' (Test-OurProxy $startedPort) "端口 $startedPort"
  $proxyPids = @(Get-ProxyPids $startedPort)
  Check '停服务拿得到端口上的 PID（netstat 报不出时用 /whoami 兜底）' ($proxyPids.Count -gt 0) ($proxyPids -join ',')
  $fresh = Test-ProxyStale $startedPort
  # Reason 为空才说明启动时间与源码时间两边都读到了；读不到时这里会红，
  # 而不是把“没比较”冒充成“不是旧代码”。
  Check '刚起的服务不会被误判成旧代码（两边时间都读得到）' ((-not $fresh.Stale) -and (-not $fresh.Reason)) $fresh.Reason
  $seen = @()
  $deadline = (Get-Date).AddSeconds(20)
  while ((Get-Date) -lt $deadline) {
    $seen += @([WorkbenchRunner]::Drain())
    if (($seen -join "`n") -like '*proxy 已启动*') { break }
    Start-Sleep -Milliseconds 200
  }
  $joined = $seen -join "`n"
  Check '服务日志进了启动器（proxy.js 那句启动行）' ($joined -like '*proxy 已启动*') "读到 $($seen.Count) 行"
  Check '日志里就是这一版用的端口' ($joined -like "*localhost:$startedPort*") ''
  # 这一条不能靠「日志里有没有 .data-probe 这个词」—— proxy.js 的启动行根本不提数据目录，
  # 那样写只会假红（判据落在符号上、不是落在行为上）。要证明隔离，就问这一份实例自己的
  # 落盘目录（/sys-status 给绝对路径），顺带也证明了端口上真能服务请求。
  $sys = Get-JsonUtf8 "http://127.0.0.1:$startedPort/sys-status"
  $dataShown = ''
  if ($sys) { $dataShown = [string]$sys.'目录'.'数据'.'路径' }
  Check '隔离实例的数据目录确实是探针那一份（也证明端口在服务请求）' ($dataShown -like '*data-probe*') "它说：$dataShown"
  $oldChild = $script:Child
  Start-Proxy
  Check '已在跑时不再起第二个实例' ($script:ActivePort -eq $startedPort -and $script:Child -eq $oldChild) "端口从 $startedPort 变成 $script:ActivePort"
  Stop-Proxy
  Check '停服务后端口不再监听' (Wait-Gone $startedPort 6) ''
  Check '停服务把状态文件清掉' (-not (Test-Path -LiteralPath $probeState)) ''
  $dataAfter = @(Get-ChildItem -Path (Join-Path $Root '.data') -Filter '*.json' -ErrorAction SilentlyContinue |
    Sort-Object Name | ForEach-Object { (Get-FileHash -Path $_.FullName -Algorithm SHA1).Hash })
  Check '真实 .data 一个字节都没动' (($dataBefore -join '|') -eq ($dataAfter -join '|')) ''
  if ($realWasUp) {
    Check '真实实例还活着（没被顺手关掉）' (Test-PortListening $realPort) "端口 $realPort"
  }

  # 还原自检期间改过的几个入口，别让下一次双击跑到探针配置上
  $script:EnvFile = $realEnvFile
  $script:StateFile = $realStateFile
  $script:EnvAdd = @()
  Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
  $script:LogBuf.Clear()
  $script:LogShown = 0
}

# ---------- 两条管道的读线程（C#，不靠 PowerShell 事件） ----------
# 为什么不用 OutputDataReceived：那个回调在**线程池线程**上触发，而窗口的消息循环正占着
# 这个 runspace，脚本块进不来（表现是「日志永远空白、服务其实在跑」）。
# 也不轮询 StandardOutput：同步 ReadLine 会在监听还没起来那段时间把 UI 线程整个冻住。
# 所以读线程只往一个线程安全队列里放话，界面在定时器里现取 —— 更新界面仍然单线程，可测、也不冻。
$runnerSource = @'
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;
public static class WorkbenchRunner {
    public static readonly ConcurrentQueue<string> Lines = new ConcurrentQueue<string>();
    public static Process Start(string workDir, string fileName, string arguments, string[] env, Encoding enc) {
        ProcessStartInfo psi = new ProcessStartInfo(fileName, arguments);
        psi.WorkingDirectory = workDir;
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        psi.StandardOutputEncoding = enc;
        psi.StandardErrorEncoding = enc;
        if (env != null) {
            for (int i = 0; i < env.Length; i++) {
                int eq = env[i].IndexOf('=');
                if (eq > 0) psi.EnvironmentVariables[env[i].Substring(0, eq)] = env[i].Substring(eq + 1);
            }
        }
        Process p = Process.Start(psi);
        Pump(p.StandardOutput, "");
        Pump(p.StandardError, "[stderr] ");
        return p;
    }
    public static string[] Drain() {
        List<string> got = new List<string>();
        string s;
        while (Lines.TryDequeue(out s)) got.Add(s);
        return got.ToArray();
    }
    private static void Pump(StreamReader reader, string tag) {
        Thread t = new Thread(delegate() {
            try {
                string line;
                while ((line = reader.ReadLine()) != null) Lines.Enqueue(tag + line);
            } catch { }
        });
        t.IsBackground = true;
        t.Start();
    }
}
'@
# 现编这段 C# 要几百毫秒到两秒（csc.exe），是窗口出现前最重的一项。按源码内容哈希把编译
# 产物缓存进 %TEMP%，命中直接装载；写盘 / 装载任何一步失败都退回现场编译 —— 缓存只是加速，不是依赖。
$runnerDll = $null
try {
  $runnerDll = Join-Path ([System.IO.Path]::GetTempPath()) (
    'imago-runner-' + ([BitConverter]::ToString(
      [System.Security.Cryptography.SHA256]::Create().ComputeHash(
        [System.Text.Encoding]::UTF8.GetBytes($runnerSource)))).Replace('-', '').ToLower().Substring(0, 16) + '.dll')
} catch { $runnerDll = $null }
$script:RunnerOk = $false
if ($runnerDll -and (Test-Path -LiteralPath $runnerDll)) {
  try { Add-Type -Path $runnerDll -ErrorAction Stop; $script:RunnerOk = $true } catch { $script:RunnerOk = $false }
}
if (-not $script:RunnerOk) {
  $tmpDll = if ($runnerDll) { "$runnerDll.$PID.tmp" } else { $null }
  if ($tmpDll) {
    try {
      Add-Type -TypeDefinition $runnerSource -Language CSharp -OutputAssembly $tmpDll -ErrorAction Stop
      # 先挪到正式名再装载：装载会把文件锁住，顺序反了临时名就删不掉。
      # 挪不动多半是目标已被并发实例装载 —— 内容是同一份，直接读目标那份。
      try { Move-Item -LiteralPath $tmpDll -Destination $runnerDll -Force -ErrorAction Stop } catch { }
      if (Test-Path -LiteralPath $runnerDll) {
        try { Add-Type -Path $runnerDll -ErrorAction Stop; $script:RunnerOk = $true } catch { $script:RunnerOk = $false }
      }
      if (Test-Path -LiteralPath $tmpDll) { Remove-Item -LiteralPath $tmpDll -Force -ErrorAction SilentlyContinue }
    } catch { $script:RunnerOk = $false }
  }
  if (-not $script:RunnerOk) {
    try { Add-Type -TypeDefinition $runnerSource -Language CSharp -ErrorAction Stop; $script:RunnerOk = $true } catch { $script:RunnerOk = $false }
  }
}

# 界面和自检都要能碰到这几个类型。放在这里而不是放在界面段里，是因为自检那一档
# 「每一个 [类型] 字面量都解析得到」必须在同一条路上跑：以前 -SelfTest 在界面段之前就 exit 了，
# WinForms 根本没加载，把这一档照出满屏假红；Native.Dpi 是本文件现编的，同一个道理。
if (-not ('System.Windows.Forms.Form' -as [type])) { Add-Type -AssemblyName System.Windows.Forms }
if (-not ('System.Drawing.Font' -as [type])) { Add-Type -AssemblyName System.Drawing }
$script:DpiOk = $true
try {
  Add-Type -Namespace Native -Name Dpi -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr h);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern int GetDeviceCaps(IntPtr h, int i);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr h, IntPtr d);
'@ -ErrorAction Stop
} catch {
  $script:DpiOk = $false
}

if ($SelfTest) {
  if (-not $script:RunnerOk) { Write-Host 'FAIL 编译读日志那一段失败（这台机器的 PowerShell 不能用 Add-Type）'; exit 1 }
  Invoke-SelfTest
  if ($script:Bad -gt 0) { Write-Host "FAIL 有 $($script:Bad) 项不符"; exit 1 }
  Write-Host 'OK 全部通过'
  exit 0
}

# ---------- 界面 ----------
[System.Windows.Forms.Application]::EnableVisualStyles()

# 高 DPI：先问系统这个屏的 DPI，再把「设计尺寸」按倍率换算成物理像素。
# 不做这一步，在 150% 缩放屏上要么整窗糊成一团放大，要么字号正常而按钮小得点不准。
# 那四句 P/Invoke 的 Add-Type 在上面（自检之前）已经编好了。
$scale = 1.0
try {
  [void][Native.Dpi]::SetProcessDPIAware()
  $dc = [Native.Dpi]::GetDC([IntPtr]::Zero)
  $dpi = [Native.Dpi]::GetDeviceCaps($dc, 88)   # 88 = LOGPIXELSX
  [void][Native.Dpi]::ReleaseDC([IntPtr]::Zero, $dc)
  if ($dpi -ge 96) { $scale = $dpi / 96.0 }
} catch { $scale = 1.0 }

function px([double]$v) { return [int][Math]::Round($v * $scale) }

function New-ScaledFont {
  param([string[]]$Names, [double]$Pt, [System.Drawing.FontStyle]$Style)
  foreach ($n in $Names) {
    try {
      $f = New-Object System.Drawing.Font($n, ([single]($Pt * $scale)), $Style)
      # 字体族不存在时 .NET 不报错，只静默换成默认族 —— 靠 Name 还认不认得原名来筛
      if ($f.Name -eq $n) { return $f }
    } catch { }
  }
  try { return New-Object System.Drawing.Font('Segoe UI', ([single]($Pt * $scale)), $Style) }
  catch { return [System.Drawing.SystemFonts]::DefaultFont }
}

# ---------- 配色与字体（浅色主题，和页面那套令牌同一路子） ----------
$Palette = @{
  Bg        = [System.Drawing.Color]::FromArgb(244, 246, 251)
  Card      = [System.Drawing.Color]::White
  Accent    = [System.Drawing.Color]::FromArgb(79, 99, 217)
  AccentHi  = [System.Drawing.Color]::FromArgb(98, 118, 236)
  Ink       = [System.Drawing.Color]::FromArgb(30, 37, 64)
  Muted     = [System.Drawing.Color]::FromArgb(110, 120, 147)
  Soft      = [System.Drawing.Color]::FromArgb(231, 236, 248)
  SoftHi    = [System.Drawing.Color]::FromArgb(216, 225, 246)
  SoftInk   = [System.Drawing.Color]::FromArgb(42, 53, 86)
  LogBg     = [System.Drawing.Color]::FromArgb(251, 252, 254)
  Ok        = [System.Drawing.Color]::FromArgb(30, 158, 99)
  Warn      = [System.Drawing.Color]::FromArgb(210, 138, 22)
  Err       = [System.Drawing.Color]::FromArgb(213, 67, 67)
  Idle      = [System.Drawing.Color]::FromArgb(160, 168, 188)
  QuitBg    = [System.Drawing.Color]::FromArgb(251, 233, 233)
  QuitHi    = [System.Drawing.Color]::FromArgb(245, 214, 214)
  QuitInk   = [System.Drawing.Color]::FromArgb(183, 59, 59)
  Foot      = [System.Drawing.Color]::FromArgb(232, 236, 246)
}

$uiFont    = New-ScaledFont @('Microsoft YaHei UI', 'Microsoft YaHei', 'Segoe UI') 9.0   ([System.Drawing.FontStyle]::Regular)
$headFont  = New-ScaledFont @('Microsoft YaHei UI', 'Microsoft YaHei', 'Segoe UI') 13.5  ([System.Drawing.FontStyle]::Bold)
$dotFont   = New-ScaledFont @('Segoe UI Symbol', 'Microsoft YaHei UI') 17.0 ([System.Drawing.FontStyle]::Regular)
$smallFont = New-ScaledFont @('Microsoft YaHei UI', 'Microsoft YaHei', 'Segoe UI') 8.5   ([System.Drawing.FontStyle]::Regular)
$boldSmall = New-ScaledFont @('Microsoft YaHei UI', 'Microsoft YaHei', 'Segoe UI') 9.0   ([System.Drawing.FontStyle]::Bold)
$logFont   = New-ScaledFont @('Consolas', 'Lucida Console', 'Microsoft YaHei UI') 9.25 ([System.Drawing.FontStyle]::Regular)

$aTop = [System.Windows.Forms.AnchorStyles]::Top -bor [System.Windows.Forms.AnchorStyles]::Left -bor [System.Windows.Forms.AnchorStyles]::Right
$aAll = $aTop -bor [System.Windows.Forms.AnchorStyles]::Bottom
$aBot = [System.Windows.Forms.AnchorStyles]::Bottom -bor [System.Windows.Forms.AnchorStyles]::Left -bor [System.Windows.Forms.AnchorStyles]::Right

# 扁平按钮：原色/悬停色一起塞进 Tag，事件里只读 sender，不依赖闭包捕获循环变量。
function Style-Button {
  param($b, $Base, $Hover, $Fore)
  $b.Font = $uiFont
  $b.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
  $b.FlatAppearance.BorderSize = 0
  $b.FlatAppearance.MouseOverBackColor = $Hover
  $b.BackColor = $Base
  $b.ForeColor = $Fore
  $b.Tag = @{ Base = $Base; Hover = $Hover }
  $b.Cursor = [System.Windows.Forms.Cursors]::Hand
  $b.Add_MouseEnter({ param($s, $e) if ($s.Enabled) { $s.BackColor = $s.Tag.Hover } })
  $b.Add_MouseLeave({ param($s, $e) $s.BackColor = $s.Tag.Base })
}

$form = New-Object System.Windows.Forms.Form
$form.Text = '成像 · AI 创作工作台 · 本地服务'
$form.Font = $uiFont
$form.AutoScaleMode = [System.Windows.Forms.AutoScaleMode]::None
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
$form.ShowIcon = $false
$form.MinimumSize = New-Object System.Drawing.Size((px 760), (px 540))
$form.ClientSize = New-Object System.Drawing.Size((px 880), (px 640))
$form.BackColor = $Palette.Bg

# ---------- 状态卡 ----------
$pnlStatus = New-Object System.Windows.Forms.Panel
$pnlStatus.Location = New-Object System.Drawing.Point((px 20), (px 24))
$pnlStatus.Size = New-Object System.Drawing.Size(($form.ClientSize.Width - (px 40)), (px 96))
$pnlStatus.BackColor = $Palette.Card
$pnlStatus.Anchor = $aTop

$barState = New-Object System.Windows.Forms.Panel
$barState.Location = New-Object System.Drawing.Point(0, 0)
$barState.Size = New-Object System.Drawing.Size((px 5), (px 96))
$barState.BackColor = $Palette.Idle

$lblDot = New-Object System.Windows.Forms.Label
$lblDot.Text = '●'
$lblDot.Font = $dotFont
$lblDot.ForeColor = $Palette.Idle
$lblDot.AutoSize = $true
$lblDot.Location = New-Object System.Drawing.Point((px 20), (px 10))

$lblState = New-Object System.Windows.Forms.Label
$lblState.Text = '正在读配置…'
$lblState.Font = $headFont
$lblState.ForeColor = $Palette.Ink
$lblState.AutoSize = $true
$lblState.Location = New-Object System.Drawing.Point((px 54), (px 18))

$lblBusy = New-Object System.Windows.Forms.Label
$lblBusy.Text = ''
$lblBusy.Font = $smallFont
$lblBusy.ForeColor = $Palette.Warn
$lblBusy.AutoSize = $true
$lblBusy.MaximumSize = New-Object System.Drawing.Size(($pnlStatus.Width - (px 44)), 0)
$lblBusy.Location = New-Object System.Drawing.Point((px 22), (px 68))

$lblUrl = New-Object System.Windows.Forms.Label
$lblUrl.Text = '—'
$lblUrl.Font = $logFont
$lblUrl.ForeColor = $Palette.Accent
$lblUrl.TextAlign = [System.Drawing.ContentAlignment]::MiddleRight
$lblUrl.Location = New-Object System.Drawing.Point(($pnlStatus.Width - (px 270)), (px 16))
$lblUrl.Size = New-Object System.Drawing.Size((px 250), (px 24))
$lblUrl.Anchor = [System.Windows.Forms.AnchorStyles]::Top -bor [System.Windows.Forms.AnchorStyles]::Right

$lblUptime = New-Object System.Windows.Forms.Label
$lblUptime.Text = ''
$lblUptime.Font = $smallFont
$lblUptime.ForeColor = $Palette.Muted
$lblUptime.TextAlign = [System.Drawing.ContentAlignment]::MiddleRight
$lblUptime.Location = New-Object System.Drawing.Point(($pnlStatus.Width - (px 270)), (px 46))
$lblUptime.Size = New-Object System.Drawing.Size((px 250), (px 20))
$lblUptime.Anchor = [System.Windows.Forms.AnchorStyles]::Top -bor [System.Windows.Forms.AnchorStyles]::Right

foreach ($item in @($barState, $lblDot, $lblState, $lblBusy, $lblUrl, $lblUptime)) { [void]$pnlStatus.Controls.Add($item) }

# ---------- 操作区：两行按钮，主操作与辅助操作分开 ----------
$btnStart = New-Object System.Windows.Forms.Button
$btnStop = New-Object System.Windows.Forms.Button
$btnRestart = New-Object System.Windows.Forms.Button
$btnOpen = New-Object System.Windows.Forms.Button
$btnCopy = New-Object System.Windows.Forms.Button
$btnLog = New-Object System.Windows.Forms.Button
$btnDir = New-Object System.Windows.Forms.Button
$btnQuit = New-Object System.Windows.Forms.Button

$btnStart.Text = '启动'
$btnStop.Text = '停止'
$btnRestart.Text = '重启'
$btnOpen.Text = '打开页面'
$btnCopy.Text = '复制地址'
$btnLog.Text = '打开日志'
$btnDir.Text = '项目目录'
$btnQuit.Text = '退出并停服务'

$mainY = 140
$mainX = @(20, 140, 260, 380)
$mainW = @(108, 108, 108, 128)
$i = 0
foreach ($b in @($btnStart, $btnStop, $btnRestart, $btnOpen)) {
  $b.Location = New-Object System.Drawing.Point((px $mainX[$i]), (px $mainY))
  $b.Size = New-Object System.Drawing.Size((px $mainW[$i]), (px 36))
  if ($b -eq $btnStart) { Style-Button $b $Palette.Accent $Palette.AccentHi ([System.Drawing.Color]::White) }
  else { Style-Button $b $Palette.Soft $Palette.SoftHi $Palette.SoftInk }
  $i++
}

$subY = 188
$subX = @(20, 136, 252)
$subW = @(108, 108, 108)
$i = 0
foreach ($b in @($btnCopy, $btnLog, $btnDir)) {
  $b.Location = New-Object System.Drawing.Point((px $subX[$i]), (px $subY))
  $b.Size = New-Object System.Drawing.Size((px $subW[$i]), (px 30))
  Style-Button $b $Palette.Card $Palette.SoftHi $Palette.Muted
  $i++
}
# 退出靠右：Anchor 只挂 Right，窗口拉宽时它跟着右边走。
$btnQuit.Location = New-Object System.Drawing.Point(($form.ClientSize.Width - (px 172)), (px $subY))
$btnQuit.Size = New-Object System.Drawing.Size((px 152), (px 30))
$btnQuit.Anchor = [System.Windows.Forms.AnchorStyles]::Top -bor [System.Windows.Forms.AnchorStyles]::Right
Style-Button $btnQuit $Palette.QuitBg $Palette.QuitHi $Palette.QuitInk

$chkAuto = New-Object System.Windows.Forms.CheckBox
$chkAuto.Text = '启动后自动打开页面'
$chkAuto.Font = $smallFont
$chkAuto.ForeColor = $Palette.Muted
$chkAuto.AutoSize = $true
$chkAuto.Checked = $true
$chkAuto.Location = New-Object System.Drawing.Point((px 380), (px ($subY + 6)))

# ---------- 日志卡 ----------
$pnlLog = New-Object System.Windows.Forms.Panel
$pnlLog.Location = New-Object System.Drawing.Point((px 20), (px 234))
$pnlLog.Size = New-Object System.Drawing.Size(($form.ClientSize.Width - (px 40)), ($form.ClientSize.Height - (px 274)))
$pnlLog.BackColor = $Palette.Card
$pnlLog.Anchor = $aAll

$lblLog = New-Object System.Windows.Forms.Label
$lblLog.Text = '服务日志'
$lblLog.Font = $boldSmall
$lblLog.ForeColor = $Palette.Ink
$lblLog.AutoSize = $true
$lblLog.Location = New-Object System.Drawing.Point((px 16), (px 12))

$lblLogPath = New-Object System.Windows.Forms.Label
$lblLogPath.Text = 'proxy.js 输出 · 完整日志见 proxy.log'
$lblLogPath.Font = $smallFont
$lblLogPath.ForeColor = $Palette.Muted
$lblLogPath.TextAlign = [System.Drawing.ContentAlignment]::MiddleRight
$lblLogPath.Location = New-Object System.Drawing.Point(($pnlLog.Width - (px 376)), (px 12))
$lblLogPath.Size = New-Object System.Drawing.Size((px 360), (px 20))
$lblLogPath.Anchor = [System.Windows.Forms.AnchorStyles]::Top -bor [System.Windows.Forms.AnchorStyles]::Right

$log = New-Object System.Windows.Forms.TextBox
$log.Multiline = $true
$log.ReadOnly = $true
$log.ScrollBars = [System.Windows.Forms.ScrollBars]::Vertical
# 换行而不是横向滚动：端口来源、被环境变量盖掉的那几项本来就长，横滚动条要点住拖才看得到后半句。
$log.WordWrap = $true
$log.BackColor = $Palette.LogBg
$log.ForeColor = $Palette.SoftInk
$log.BorderStyle = [System.Windows.Forms.BorderStyle]::FixedSingle
$log.Font = $logFont
$log.Location = New-Object System.Drawing.Point((px 16), (px 40))
$log.Size = New-Object System.Drawing.Size(($pnlLog.Width - (px 32)), ($pnlLog.Height - (px 56)))
$log.Anchor = $aAll
$script:LogBox = $log
foreach ($item in @($lblLog, $lblLogPath, $log)) { [void]$pnlLog.Controls.Add($item) }

# ---------- 底栏 ----------
$pnlFoot = New-Object System.Windows.Forms.Panel
$pnlFoot.Location = New-Object System.Drawing.Point(0, ($form.ClientSize.Height - (px 30)))
$pnlFoot.Size = New-Object System.Drawing.Size($form.ClientSize.Width, (px 30))
$pnlFoot.BackColor = $Palette.Foot
$pnlFoot.Anchor = $aBot

$lblFoot = New-Object System.Windows.Forms.Label
$lblFoot.Text = '本地服务 · 状态自动刷新 · 完整日志见 proxy.log'
$lblFoot.Font = $smallFont
$lblFoot.ForeColor = $Palette.Muted
$lblFoot.AutoSize = $true
$lblFoot.Location = New-Object System.Drawing.Point((px 20), (px 7))

$lblFootRight = New-Object System.Windows.Forms.Label
$lblFootRight.Text = '数据只留在这台机器'
$lblFootRight.Font = $smallFont
$lblFootRight.ForeColor = $Palette.Muted
$lblFootRight.TextAlign = [System.Drawing.ContentAlignment]::MiddleRight
$lblFootRight.Location = New-Object System.Drawing.Point(($form.ClientSize.Width - (px 240)), (px 7))
$lblFootRight.Size = New-Object System.Drawing.Size((px 220), (px 18))
$lblFootRight.Anchor = [System.Windows.Forms.AnchorStyles]::Top -bor [System.Windows.Forms.AnchorStyles]::Right
foreach ($item in @($lblFoot, $lblFootRight)) { [void]$pnlFoot.Controls.Add($item) }

foreach ($ctl in @($pnlStatus, $btnStart, $btnStop, $btnRestart, $btnOpen,
                   $btnCopy, $btnLog, $btnDir, $btnQuit, $chkAuto, $pnlLog, $pnlFoot)) {
  [void]$form.Controls.Add($ctl)
}

function Set-Buttons {
  param([bool]$Running, [bool]$Starting, [bool]$Alive)
  $btnStart.Enabled = (-not $Running -and -not $Starting -and -not $Alive)
  # 正在起的那一段也要能停：绑不上端口时 proxy.js 会自己退，但那是它的事，不能让人干等
  $btnStop.Enabled = ($Running -or $Starting -or $Alive)
  $btnRestart.Enabled = (-not $Starting)
  $btnOpen.Enabled = $Running
  $btnCopy.Enabled = $Running
}

function Drain-Log {
  if (-not $script:RunnerOk) { return }
  foreach ($line in @([WorkbenchRunner]::Drain())) { [void]$script:LogBuf.Add($line) }
  $box = $script:LogBox
  if ($null -eq $box) { return }
  if ($script:LogBuf.Count -le $script:LogShown) { return }
  $atEnd = ($box.SelectionStart -eq $box.TextLength)
  $topBefore = $box.GetFirstCharIndexOfCurrentLine()
  if ($script:LogBuf.Count -gt $LogTrimAt) {
    # 整块重画只发生在截断那一次（平时逐条追加）：否则每来一行都要重排一次几千行的文本
    $script:LogBuf.RemoveRange(0, ($script:LogBuf.Count - $LogKeep))
    [void]$script:LogBuf.Add('……（前面的日志已截掉，完整的一份在 proxy.log 里）')
    $box.Text = ($script:LogBuf -join "`r`n")
    $script:LogShown = $script:LogBuf.Count
    $atEnd = $true
    $topBefore = -1
  } else {
    $tail = $script:LogBuf.GetRange($script:LogShown, ($script:LogBuf.Count - $script:LogShown)) -join "`r`n"
    $box.AppendText($tail + "`r`n")
    $script:LogShown = $script:LogBuf.Count
  }
  if ($atEnd) {
    $box.SelectionStart = $box.TextLength
    $box.ScrollToCaret()
  } elseif ($topBefore -ge 0) {
    # 用户正往上翻着看那条报错，新日志不能把视线抢走
    $box.SelectionStart = $topBefore
    $box.ScrollToCaret()
  }
}

function Refresh-View {
  Drain-Log
  $script:NetTick++
  if (Need-Net) { Ask-Net }
  if ($script:WantOpen -and (Proxy-Running) -and -not $script:Opened) {
    $script:Opened = $true
    $script:WantOpen = $false
    if ($chkAuto.Checked) { Open-Page }
  }
  if ($script:WantStart -and (-not $script:Child -or $script:Child.HasExited) -and -not (Proxy-Running)) {
    $script:WantStart = $false
    Start-Proxy
  }
  if ($script:StartingSince) {
    $sp = ((Get-Date) - $script:StartingSince).TotalSeconds
    if (Proxy-Running) {
      # 监听一真起来就把「正在启动」摘掉。以前只有等满 $StartGiveUpSec 才清，于是截图上那一屏：
      # 日志里早就写着「proxy 已启动：http://localhost:6500」、页面也开好了，顶上还挂着
      # 「正在启动 / 正在等服务监听上 6500」二十多秒 —— 同一块界面上两句话互相打脸。
      $script:StartingSince = $null
    } elseif (-not ($script:Child -and -not $script:Child.HasExited)) {
      # 进程已经没了 → 不必再空等那 25 秒。它退出的原因就在上面那几行日志里
      # （端口绑不上、语法错、缺模块），照实说一句，别让人对着「正在启动」猜。
      $script:StartingSince = $null
      Add-LogLine 'proxy.js 已经退出了，没能在这个端口上监听 —— 上面那几行就是它退出的原因。'
    } elseif ($sp -gt $StartGiveUpSec) {
      $script:StartingSince = $null
      Add-LogLine "等了 $StartGiveUpSec 秒还没等到监听，先不等了。上面那一句才是真原因（常见：端口绑不上 → 换个号或写进 .env）。"
    }
  }
  $starting = [bool]($script:StartingSince)
  $alive = [bool]($script:Child -and -not $script:Child.HasExited)
  $running = Proxy-Running
  $script:NetRunning = $running
  Update-Status -Running $running -Starting $starting -Alive $alive
  Set-Buttons -Running $running -Starting $starting -Alive $alive
}

function Update-Status {
  param([bool]$Running, [bool]$Starting, [bool]$Alive)
  # 端口说明那一行已按需求去掉；这里只剩一个给忙线用的号，不必每 350ms 再读一遍 .env。
  $last = Read-StatePort
  $shownPort = $DefaultPort
  if ($last -gt 0) { $shownPort = $last }
  if ($script:ActivePort -gt 0) { $shownPort = $script:ActivePort }

  if ($Starting) {
    $col = $Palette.Warn
    $lblDot.ForeColor = $col
    $lblState.Text = '正在启动'
    $lblBusy.Text = "正在等服务监听上 $shownPort …（下面正在逐行出它的输出）"
    $lblUrl.Text = '—'
    $lblUptime.Text = '等监听起来就能打开页面'
  } elseif ($Running) {
    $col = $Palette.Ok
    $lblDot.ForeColor = $col
    $lblState.Text = "运行中 :$script:ActivePort"
    $lblBusy.Text = ''
    $lblUrl.Text = "http://localhost:$script:ActivePort/"
    if (-not $script:UpSince) { $script:UpSince = Get-Date }
    $span = (Get-Date) - $script:UpSince
    $lblUptime.Text = ('已运行 {0:00}:{1:00}:{2:00}' -f [int]$span.TotalHours, $span.Minutes, $span.Seconds)
  } elseif ($Alive) {
    # 进程在、监听没有 —— 这一格必须是红的，画成「运行中」就是让人对着打不开的页面干等
    $col = $Palette.Err
    $lblDot.ForeColor = $col
    $lblState.Text = '没起来'
    $lblBusy.Text = "进程还在，但 $script:ActivePort 上没有监听 —— 上面几行里那一句才是原因"
    $lblUrl.Text = '—'
    $lblUptime.Text = ''
  } else {
    $col = $Palette.Idle
    $lblDot.ForeColor = $col
    $lblState.Text = '已停止'
    $lblBusy.Text = ''
    $lblUrl.Text = '—'
    $lblUptime.Text = ''
    $script:UpSince = $null
  }
  $barState.BackColor = $col
  $lblState.ForeColor = $col

}

# 「退出」与关窗是同一条路（两条路两套判据早晚会漂）
# 「有人按了一下」就是必须现问系统的时刻 —— 靠上一跳那份快照判「在不在跑」，
# 最坏会拿一秒前的读数替用户决定该起还是该开页面。
function Restart-IfStale {
  # 用户点「启动」/「打开页面」时也要挡一次旧代码：这两颗按钮不该把人送进白屏。
  # 返回 $true 表示已经走了「停旧 + 起新」，调用方不要再 Open-Page。
  if (-not (Proxy-Running)) { return $false }
  $stale = Test-ProxyStale $script:ActivePort
  if (-not $stale.Stale) { return $false }
  Add-LogLine ("当前服务还是旧代码（" + $stale.Reason + "），先停掉再起新的。")
  $script:WantStart = $true
  Stop-Proxy
  Refresh-View
  return $true
}

$btnQuit.Add_Click({ $form.Close() })
$btnStart.Add_Click({
  Drain-Log
  Ask-Net
  if (Proxy-Running) {
    if (Restart-IfStale) { return }
    Open-Page; return
  }
  if ($script:Child -and -not $script:Child.HasExited) { Add-LogLine '上一次启动还在等监听，先等它一下。'; return }
  $script:WantStart = $false
  Start-Proxy
  Refresh-View
})
$btnStop.Add_Click({
  Drain-Log
  Ask-Net
  $script:WantStart = $false
  Stop-Proxy
  Refresh-View
})
$btnRestart.Add_Click({
  Drain-Log
  Ask-Net
  if (-not (Proxy-Running) -and (-not $script:Child -or $script:Child.HasExited)) {
    Start-Proxy
    Refresh-View
    return
  }
  # 停还没落地就起，第二份会撞上 EADDRINUSE —— 用「等端口空了再起」这条状态位而不是直接起
  $script:WantStart = $true
  Stop-Proxy
  Refresh-View
})
$btnOpen.Add_Click({
  if (Restart-IfStale) { return }
  Open-Page
})

# 三个辅助动作只碰「看」和「打开」，不碰起停状态机。
$btnCopy.Add_Click({
  if ($script:ActivePort -le 0) { Add-LogLine '服务还没起来，没有地址可复制。'; Refresh-View; return }
  $u = "http://localhost:$($script:ActivePort)/"
  try { [System.Windows.Forms.Clipboard]::SetText($u); Add-LogLine "已复制地址：$u" }
  catch { Add-LogLine "复制失败：$($_.Exception.Message)" }
  Refresh-View
})
$btnLog.Add_Click({
  $f = Join-Path $Root 'proxy.log'
  if (-not (Test-Path -LiteralPath $f)) { Add-LogLine 'proxy.log 还没生成，服务启动后才有。'; Refresh-View; return }
  try { Start-Process -FilePath $f; Add-LogLine '已用系统默认程序打开 proxy.log。' }
  catch { Add-LogLine "打不开日志：$($_.Exception.Message)" }
  Refresh-View
})
$btnDir.Add_Click({
  try { Start-Process explorer.exe $Root; Add-LogLine '已在资源管理器里打开项目目录。' }
  catch { Add-LogLine "打不开目录：$($_.Exception.Message)" }
  Refresh-View
})

# 关掉这个窗口 = 停掉端口上的服务。这是点名要的语义，所以：
#   · 服务是这个窗口起的 → 直接停，不问（对称：双击起来、关掉停掉）；
#   · 服务在跑但不是这个窗口起的（例如你自己在命令行敲的 node proxy.js）→ 先问一句，
#     因为「关掉一个我并没有从这里起过的服务」是意外，值得一次确认。
# 子进程由 proxy.js 自己收（SIGINT/退出兜底），这一层不越权去管它的孩子。
$form.Add_FormClosing({
  param($s, $e)
  if ($script:StoppedByClose) { return }
  Drain-Log
  Ask-Net
  $running = Proxy-Running
  $alive = [bool]($script:Child -and -not $script:Child.HasExited)
  if ($running -or $alive) {
    if ($running -and -not $alive) {
      $ans = [System.Windows.Forms.MessageBox]::Show(
        '端口上的服务不是这个窗口起的（可能是你自己跑的 node proxy.js）。' + [Environment]::NewLine +
        '关掉这个窗口会把它停掉。要停吗？', '停掉服务？',
        [System.Windows.Forms.MessageBoxButtons]::YesNo,
        [System.Windows.Forms.MessageBoxIcon]::Question)
      if ($ans -ne [System.Windows.Forms.DialogResult]::Yes) { $e.Cancel = $true; return }
    }
    $script:StoppedByClose = $true
    Stop-Proxy
    $timer.Stop()
  }
})

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 350
$timer.Add_Tick({ Refresh-View })

if (-not $script:RunnerOk) {
  [void][System.Windows.Forms.MessageBox]::Show(
    '这一版启动器需要一个能编译 C# 的 PowerShell（Add-Type 用不了），现在起不了服务。' + [Environment]::NewLine +
    '临时办法：在项目目录里直接跑  node proxy.js', '启动器起不来',
    [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Error)
}

$form.Add_Shown({
  Drain-Log
  Ask-Net
  if (-not (Proxy-Running) -and (-not $script:Child -or $script:Child.HasExited)) {
    # 文件名叫 启动.bat，双击就该把服务起来；等监听真起来了再由定时器开页面。
    # 已经在跑就不重复起（也不抢别人那一轮的端口），只把状态画清楚。
    Start-Proxy
  }
  Refresh-View
  $timer.Start()
})

[void]$form.ShowDialog()
$timer.Stop()
# ShowDialog 返回只有关窗这一条路，而关窗已经在 FormClosing 里把服务停掉了
exit 0
