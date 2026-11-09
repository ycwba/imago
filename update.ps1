# 成像 · AI 创作工作台 —— 仓库更新（由 更新.bat 调起）
# 只做四件事：自检 → fetch → 比较 → 拉取（脏工作区先 stash，冲突绝不丢）。
# 硬约束：不 reset --hard / 不 checkout . / 不 clean -fd / 不 stash drop ——
# 用户的未提交工作比更新重要；任何一步失败都给出下一步该敲什么命令。
# 编码：UTF-8 带 BOM + CRLF（PowerShell 5.1 要求）。
param(
  [switch]$Check,
  [switch]$Log,
  [switch]$Help
)
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root
$EnvFile = Join-Path $Root '.env'

# ---- 控制台主题：与 启动.bat 同源（WB_THEME=system|day|night；WB_NOCOLOR 优先） ----
$Theme = 'system'
if ($env:WB_THEME) { $Theme = $env:WB_THEME }
elseif (Test-Path $EnvFile) {
  $hit = Select-String -Path $EnvFile -Pattern '^\s*WB_THEME\s*=\s*(\S+)' | Select-Object -First 1
  if ($hit) { $Theme = $hit.Matches[0].Groups[1].Value.Trim() }
}
$Dark = ($Theme -eq 'night')
if ($Theme -eq 'system') {
  try {
    $v = (Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize' -Name AppsUseLightTheme -ErrorAction Stop).AppsUseLightTheme
    $Dark = ($v -eq 0)
  } catch { $Dark = $false }
}
$NoColor = [bool]$env:WB_NOCOLOR
function C([string]$Text, [string]$Color) {
  if ($NoColor) { Write-Host $Text } else { Write-Host $Text -ForegroundColor $Color }
}
$COk = if ($Dark) { 'Green' } else { 'DarkGreen' }
$CStep = if ($Dark) { 'Cyan' } else { 'DarkCyan' }
$CWarn = if ($Dark) { 'Yellow' } else { 'DarkYellow' }
$CDim = if ($Dark) { 'DarkGray' } else { 'Gray' }
$CBad = 'Red'
# 整屏底色跟主题走（PowerShell 控制台可以直接改；改不了就算了，不影响输出）
try {
  $host.UI.RawUI.BackgroundColor = if ($Dark) { 'Black' } else { 'White' }
  $host.UI.RawUI.ForegroundColor = if ($Dark) { 'White' } else { 'Black' }
} catch { }

function Step([string]$m) { C ('[ .. ] ' + $m) $CStep }
function Good([string]$m) { C ('[ OK ] ' + $m) $COk }
function Warn([string]$m) { C ('[注意] ' + $m) $CWarn }
function Fail([string]$m, [string]$hint) {
  C ('[失败] ' + $m) $CBad
  if ($hint) { C ('        ' + $hint) $CDim }
  exit 1
}
function Run-Git {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$GitArgs)
  $out = & git @GitArgs 2>&1
  $code = $LASTEXITCODE
  return [pscustomobject]@{ Code = $code; Out = @($out | ForEach-Object { [string]$_ }) }
}
$env:GIT_TERMINAL_PROMPT = '0'

if ($Help) {
  C '用法：更新.bat [check|log|help]' 'White'
  C '' $CDim
  C '  无参数   检测并拉取（脏工作区先 stash，拉完取回）' 'Gray'
  C '  check    只检测，不拉取' 'Gray'
  C '  log      看最近的提交' 'Gray'
  C '  help     这一页' 'Gray'
  exit 0
}

# ---- 1. 自检 ----
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Fail '没有找到 git' '先安装 Run-Git for Windows（https://git-scm.com），然后重开这个窗口'
}
$inside = Run-Git rev-parse --is-inside-work-tree
if ($inside.Code -ne 0 -or (($inside.Out -join '') -notmatch 'true')) {
  Fail '这里不是 git 仓库' '把 更新.bat / update.ps1 放回项目根目录再运行'
}
$branch = ((Run-Git rev-parse --abbrev-ref HEAD).Out -join '').Trim()
if ($branch -ne 'main') {
  Fail ('当前分支是「' + $branch + '」，不是 main') '本脚本只更新 main；别的分支请自己 git pull'
}
$remotes = ((Run-Git remote).Out -join ' ')
if ($remotes -notmatch '(^|\s)origin(\s|$)') {
  Fail '没有 origin 远端' '先执行：git remote add origin https://github.com/ycwba/imago.git'
}
Good ('仓库自检通过（分支 main）')

if ($Log) {
  C '最近的提交：' 'White'
  (Run-Git log --oneline -20).Out | ForEach-Object { Write-Host ('  ' + $_) }
  exit 0
}

# ---- 2. fetch（不挂死：最多等 120 秒） ----
Step '从 origin 取最新（最多等 120 秒）'
$job = Start-Job -ScriptBlock {
  param($d)
  Set-Location $d
  $o = & git fetch origin --prune 2>&1
  [pscustomobject]@{ Code = $LASTEXITCODE; Out = @($o | ForEach-Object { [string]$_ }) }
} -ArgumentList $Root
if (-not (Wait-Job $job -Timeout 120)) {
  Stop-Job $job -ErrorAction SilentlyContinue
  Remove-Job $job -Force -ErrorAction SilentlyContinue
  Fail 'git fetch 超时（120 秒）' '网络或代理不通：先确认能打开 https://github.com/ycwba/imago，再重试'
}
$fj = Receive-Job $job
Remove-Job $job -Force -ErrorAction SilentlyContinue
if ($fj.Code -ne 0) {
  $msg = ($fj.Out -join ' ')
  # 本机代理链在 GitHub 上偶发 TLS 握手失败：直连再试一次（临时绕开，不改任何 git 配置）。
  if ($msg -match 'schannel|SSL|TLS|unexpected eof|proxy') {
    Step '代理这条路握手失败：直连再试一次（不改 git 配置）'
    $out2 = & git -c http.proxy= -c https.proxy= fetch origin --prune 2>&1
    $code2 = $LASTEXITCODE
    if ($code2 -eq 0) {
      $fj = [pscustomobject]@{ Code = 0; Out = @() }
      Good '直连取回成功'
    } else {
      $fj = [pscustomobject]@{ Code = $code2; Out = @($out2 | ForEach-Object { [string]$_ }) }
    }
  }
}
if ($fj.Code -ne 0) {
  Fail ('git fetch 失败：' + ($fj.Out -join ' ')) '检查网络 / 代理设置；能打开 https://github.com/ycwba/imago 再重试'
}
Good '已取回远端信息'

# ---- 3. 比较 HEAD 与 origin/main ----
$head = ((Run-Git rev-parse HEAD).Out -join '').Trim()
$remoteHead = ((Run-Git rev-parse origin/main).Out -join '').Trim()
if (-not $remoteHead) { Fail '远端没有 main 分支' '先确认 origin 指向 https://github.com/ycwba/imago.git' }
if ($head -eq $remoteHead) {
  Good '已是最新（HEAD 与 origin/main 相同）'
  $aheadTxt = ((Run-Git rev-list --count 'origin/main..HEAD').Out -join '').Trim()
  if ($aheadTxt -and [int]$aheadTxt -gt 0) { Warn ('本地还有 ' + $aheadTxt + ' 个提交没推送到远端') }
  exit 0
}
$counts = ((Run-Git rev-list --left-right --count 'HEAD...origin/main').Out -join '').Trim()
$parts = $counts -split '\s+'
$aheadN = 0; $behindN = 0
if ($parts.Count -ge 2) { $aheadN = [int]$parts[0]; $behindN = [int]$parts[1] }
if ($behindN -le 0) { Good '没有需要拉取的提交'; exit 0 }
$extra = if ($aheadN -gt 0) { '；本地另有 ' + $aheadN + ' 个未推送提交（会尝试合并）' } else { '' }
C ('  本地落后 ' + $behindN + ' 个提交' + $extra) 'White'
C '  这次会带下来的前 5 个提交：' 'White'
if ($Dark) { $dateColor = 'Gray' } else { $dateColor = 'DarkGray' }
(Run-Git log -5 --pretty=format:'%h %ad %s' --date=short 'HEAD..origin/main').Out |
  ForEach-Object { C ('    ' + $_) $dateColor }

if ($Check) {
  C '' $CDim
  C '只检测（-Check）：没有拉取。' $CWarn
  exit 0
}

# ---- 4. 拉之前的保护：工作区脏先 stash（含未跟踪） ----
$status = @((Run-Git status --porcelain).Out | Where-Object { $_ -ne '' })
$Stashed = $false
$StashRef = ''
if ($status.Count -gt 0) {
  Step ('工作区有 ' + $status.Count + ' 处未提交改动：先 stash（含未跟踪）')
  $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  $r = Run-Git stash push -u -m ('imago-update ' + $stamp)
  if ($r.Code -ne 0) {
    Fail ('git stash 失败：' + ($r.Out -join ' ')) '先 git status 看清工作区，处理掉挡路的文件再重试'
  }
  $StashRef = ((Run-Git rev-parse 'stash@{0}').Out -join '').Trim()
  $Stashed = $true
  Good ('本地改动已存进 stash（' + $StashRef.Substring(0, [Math]::Min(7, $StashRef.Length)) + '），拉完会取回来')
}

function Restore-Stash {
  if (-not $Stashed) { return $true }
  Step '把刚才的本地改动取回来（git stash pop）'
  $pop = Run-Git stash pop
  if ($pop.Code -ne 0) {
    Warn 'stash pop 有冲突：本地改动还在 stash 里，一个字节都没丢'
    C ('  恢复命令：git stash pop   （stash: ' + $StashRef + '）') $CWarn
    $conf = @((Run-Git diff --name-only --diff-filter=U).Out | Where-Object { $_ -ne '' })
    if ($conf.Count -gt 0) {
      C '  冲突文件：' $CBad
      $conf | ForEach-Object { Write-Host ('    ' + $_) }
    }
    return $false
  }
  Good '本地改动已取回'
  return $true
}

# ---- 5. pull（冲突就 abort 回退，绝不硬来） ----
Step '拉取 origin/main'
$pull = Run-Git pull --no-edit origin main
if ($pull.Code -ne 0) {
  if (Test-Path (Join-Path $Root '.git\MERGE_HEAD')) {
    [void](Run-Git merge --abort)
    Warn '合并冲突：已 git merge --abort 回退到拉取之前'
  }
  $conf = @((Run-Git diff --name-only --diff-filter=U).Out | Where-Object { $_ -ne '' })
  if ($conf.Count -gt 0) {
    C '  冲突文件：' $CBad
    $conf | ForEach-Object { Write-Host ('    ' + $_) }
  }
  [void](Restore-Stash)
  Fail ('git pull 失败：' + ($pull.Out -join ' ')) '远端改动与本地冲突；按上面的文件清单处理后再运行 更新.bat'
}
$newHead = ((Run-Git rev-parse HEAD).Out -join '').Trim()
Good ('已更新到 ' + $newHead.Substring(0, 7))

$restored = Restore-Stash
if (-not $restored) {
  C '' $CDim
  Fail '代码已更新，但本地改动取回时有冲突' '按上面的文件清单手动合并；stash 仍然保留（git stash list 能看到）'
}

# ---- 6. 收尾：依赖与模板预编译 ----
$changed = @((Run-Git diff --name-only ($head + '..' + $newHead)).Out | Where-Object { $_ -ne '' })
if (($changed -contains 'package-lock.json') -or ($changed -contains 'package.json')) {
  Step '依赖有变化：npm ci'
  & npm ci
  if ($LASTEXITCODE -ne 0) {
    Warn 'npm ci 失败：代码已经更新，但依赖没装好'
    C '  重试：npm ci' $CWarn
  } else {
    Good '依赖已安装'
  }
}
Step '重新生成模板预编译产物（npm run build）'
& npm run build
if ($LASTEXITCODE -ne 0) {
  Warn '代码已更新，但模板预编译失败'
  C '  重试：npm run build' $CWarn
  exit 1
}
Good '构建通过'

# ---- 7. 代理还在跑就提醒重开（不替用户杀进程） ----
$port = 5175
if (Test-Path $EnvFile) {
  $hit = Select-String -Path $EnvFile -Pattern '^\s*PORT\s*=\s*(\d+)' | Select-Object -First 1
  if ($hit) { $port = [int]$hit.Matches[0].Groups[1].Value }
}
$running = $false
try {
  $running = [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop | Select-Object -First 1)
} catch { $running = $false }
if ($running) {
  Warn ('代理正在 ' + $port + ' 端口上运行：关掉启动器窗口，再双击 启动.bat 就会用上新代码')
  C '  （这里不替你杀进程：关掉启动器窗口会连同服务一起停）' $CDim
} else {
  Good '代理没有在跑；下次 启动.bat 会用上新代码'
}

# ---- 8. 这次更新了什么 ----
C '' $CDim
C '这次更新了什么：' 'White'
(Run-Git log --oneline ($head + '..' + $newHead)).Out | Select-Object -First 20 |
  ForEach-Object { Write-Host ('  ' + $_) }
C '' $CDim
C ('更新完成。本地改动' + $(if ($Stashed) { '已取回' } else { '一直都在' }) + '。') $COk
exit 0
