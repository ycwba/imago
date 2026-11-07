/* 打开一个本机目录（提示词归档、FCPXML 工程目录都走这里）。
   以前两处各写一遍「按平台挑命令 + spawn」，同一个毛病要修两遍：
   代理是**后台进程**，用户在页面上点「打开」时前台是应用窗口，explorer.exe 由后台拉起，
   Windows 的前台锁会把它压在应用后面 —— 文件夹其实开了，用户只看见自己的窗口没动。
   解法与设置页「选择文件夹」同一套（见 routes/pick-dir.js）：先真把目录打开，
   再用 AttachThreadInput 借前台线程的输入队列 + SetForegroundWindow 把那个窗口拽到前面。
   抢不到只影响 z 序（目录照样已经打开），所以这一步失败一律静默，不往接口回错。
   ⚠ 先 explorer 再拽：万一 PowerShell 起不来，行为与修之前一样（只是没抢到前台），
     不会退化成「点了没反应」。 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { FG_CS } = require('./win-fg.js');

/* 与 routes/pick-dir.js 同一份候选与顺序：pwsh 在前，5.1 兜底（这台机器多半只有其中一个）。 */
const PS_CANDIDATES = [
  'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
  path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
];

function startDetached(cmd, args) {
  try {
    const p = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    p.on('error', () => {});
    p.unref();
  } catch (e) { /* 打不开目录不是致命错：调用方已经把路径回给页面，用户还能自己去翻 */ }
}

/* 把「路径 = dir 的那个资源管理器窗口」拽到前台。
   找窗口用 Shell.Application.Windows()（每个窗口的 Document.Folder.Self.Path 就是它开的位置），
   比按标题猜稳：同名文件夹可以有很多个，标题还会被系统截断。
   编译 C# 要几百毫秒，所以轮询 25 × 120ms 等窗口出现；找不到就安静退出。 */
function pullFront(dir) {
  let ps = null;
  try { ps = PS_CANDIDATES.find(f => fs.existsSync(f)) || null; } catch (e) { ps = null; }
  if (!ps) return;
  const SCRIPT = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$ProgressPreference = 'SilentlyContinue'",
    "try { Add-Type -TypeDefinition '" + FG_CS + "' -ErrorAction Stop } catch { exit 0 }",
    "$want = [string]$env:AII_OPEN_DIR; if (-not $want) { exit 0 }",
    "$sh = New-Object -ComObject Shell.Application",
    "$hwnd = [IntPtr]::Zero",
    "for ($i = 0; $i -lt 25 -and $hwnd -eq [IntPtr]::Zero; $i++) { Start-Sleep -Milliseconds 120; try { foreach ($w in $sh.Windows()) { try { $p = [string]$w.Document.Folder.Self.Path; if ($p -and $p.TrimEnd('\\') -ieq $want.TrimEnd('\\')) { $hwnd = [IntPtr]$w.HWND; break } } catch { } } } catch { } }",
    /* 先看它是不是已经在前台（用户本来就在看那个文件夹就不动 z 序）；
       不是才 Pull，Pull 之后仍不在前台再用 SwitchToThisWindow 兜底。 */
    "if ($hwnd -ne [IntPtr]::Zero) { try { [AiiFg]::Show($hwnd); if (-not [AiiFg]::FgIs($hwnd,0)) { [void][AiiFg]::Pull($hwnd); if (-not [AiiFg]::FgIs($hwnd,0)) { [AiiFg]::Force($hwnd) } } } catch { } }",
    "exit 0",
  ].join('; ');
  try {
    const p = spawn(ps, ['-NoProfile', '-WindowStyle', 'Hidden',
      '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')],
      { env: Object.assign({}, process.env, { AII_OPEN_DIR: path.resolve(dir) }),
        windowsHide: true, stdio: 'ignore', detached: true });
    p.on('error', () => {});
    p.unref();
  } catch (e) { /* 同上：只是没抢到前台 */ }
}

function openDir(dir) {
  const target = String(dir || '');
  if (!target) return false;
  if (process.platform !== 'win32') {
    startDetached(process.platform === 'darwin' ? 'open' : 'xdg-open', [target]);
    return true;
  }
  startDetached('explorer.exe', [target]);
  pullFront(target);
  return true;
}

module.exports = { openDir };
