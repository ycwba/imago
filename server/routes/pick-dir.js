/* /pick-dir：弹系统文件夹选择框（异步 spawn，客户端断开时收掉子进程）。 */
'use strict';

function createPickDirRoute(ctx) {
  const { spawn, log, cap120, firstLine, readBody, root } = ctx;
  const fs = require('fs'), path = require('path');

  function handlePickDir(req, res, dataPath) {
    if (dataPath === '/pick-dir' && req.method === 'POST') {
      const fail = (code, msg) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ error: { message: msg } })); };
      if (process.platform !== 'win32') return fail(501, '弹系统文件夹选择框目前只做了 Windows（这台机器是 ' + process.platform + '），还是手填路径吧');
      /* —— 前台锚定（2026-10 修复「选择框弹在窗口后面」）——
         病根是 Windows 前台锁：用户在设置页点「选择」时前台是浏览器，代理是后台进程，
         没人为它抢前台时对话框会被系统压在浏览器后面（框弹了，用户看不见、也敲不进去）。
         工序三步：① 一个 1x1 近乎全透明的隐形 owner 窗体（TopMost、不进任务栏）——
         ShowDialog 挂上它，owned 窗口的 z 序就永远在 owner 之上；② 一个 100ms 的 WinForms
         定时器，前 2 秒里把 owner 往前台拽（AttachThreadInput 借前台线程的输入队列 +
         SetForegroundWindow，这是前台锁的标准解法），一旦前台已经是本进程就收手；③ 对话框
         关闭时在 finally 里把定时器与 owner 一并收掉。
         整段跑不了一律降级成「不抢前台」（catch 吞掉、退回无 owner 的 ShowDialog()）——
         抢不了前台是小事，把本来能弹的框弄坏才是大事。 */
      const FG_CS =
        'using System;using System.Runtime.InteropServices;public class AiiFg{' +
        '[DllImport("user32.dll")]static extern IntPtr GetForegroundWindow();' +
        '[DllImport("user32.dll")]static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);' +
        '[DllImport("user32.dll")]static extern bool AttachThreadInput(uint a,uint b,bool f);' +
        '[DllImport("kernel32.dll")]static extern uint GetCurrentThreadId();' +
        '[DllImport("user32.dll")]static extern bool SetForegroundWindow(IntPtr h);' +
        /* 只用 C# 3 的语法（PS 5.1 的 Add-Type 编译器老，`out var` 这类新写法当场编不过） */
        'public static bool FgIs(IntPtr h,int pid){IntPtr fg=GetForegroundWindow();if(fg==IntPtr.Zero)return false;uint p;GetWindowThreadProcessId(fg,out p);return fg==h||(int)p==pid;}' +
        'public static bool Pull(IntPtr h){IntPtr fg=GetForegroundWindow();uint dummy;uint tid=0;if(fg!=IntPtr.Zero)tid=GetWindowThreadProcessId(fg,out dummy);uint cur=GetCurrentThreadId();if(tid!=0&&tid!=cur)AttachThreadInput(cur,tid,true);bool ok=SetForegroundWindow(h);if(tid!=0&&tid!=cur)AttachThreadInput(cur,tid,false);return ok;}}';
      const SCRIPT = [
        "$ErrorActionPreference = 'Stop'",
        /* 5.1 会把「Preparing modules for first use.」这类进度流经 CLIXML 写进 stderr——
           干净的成功不该带一坨垃圾，而要报错时 firstLine(err) 也别拿到 '#< CLIXML' 当错误原文。 */
        "$ProgressPreference = 'SilentlyContinue'",
        "try { Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop } catch { Write-Output 'NOFORMS'; exit 9 }",
        "try { Add-Type -TypeDefinition '" + FG_CS + "' -ErrorAction Stop } catch { }",
        "$d = New-Object System.Windows.Forms.FolderBrowserDialog",
        /* AutoUpgradeEnabled = 现代 IFileDialog（.NET Core 3.0+ 上 FolderBrowserDialog 的默认实现）。
           显式写出来是为了「这个框是哪个」不靠默认值：默认值哪天变了，这里弹出来的框就悄悄换了样子。
           ⚠ 这个属性 **.NET Framework（5.1 那条路）里根本没有** —— 直接赋值抛
           PropertyAssignmentException，被 $ErrorActionPreference='Stop' 拦成终止错误，
           整条 5.1 兜底路径（没装 pwsh 7 的机器）会连框都弹不出来。所以「有才设」。 */
        "if ($d.PSObject.Properties['AutoUpgradeEnabled']) { $d.AutoUpgradeEnabled = $true }",
        "$d.ShowNewFolderButton = $true",
        "$t = $env:AII_PICK_TITLE; if ($t) { $d.Description = $t }",
        "$s = $env:AII_PICK_START",
        "if ($s -and (Test-Path -LiteralPath $s -PathType Container)) { $d.SelectedPath = $s }",
        "$owner = $null",
        "try { $owner = New-Object System.Windows.Forms.Form; $owner.FormBorderStyle = 'None'; $owner.ShowInTaskbar = $false; $owner.TopMost = $true; $owner.Width = 1; $owner.Height = 1; $owner.Opacity = 0.01; $owner.Show(); $global:aiiFgN = 0; $tm = New-Object System.Windows.Forms.Timer; $tm.Interval = 100; $tm.Add_Tick({ $global:aiiFgN = $global:aiiFgN + 1; if ($global:aiiFgN -gt 20) { $tm.Stop(); return }; try { if ([AiiFg]::FgIs($owner.Handle, $PID)) { $tm.Stop() } else { [void][AiiFg]::Pull($owner.Handle) } } catch { $tm.Stop() } }); $tm.Start() } catch { $owner = $null }",
        "$r = $null",
        "try { if ($owner) { $r = $d.ShowDialog($owner) } else { $r = $d.ShowDialog() } } catch { Write-Output ('SHOWFAIL: ' + $_.Exception.Message); exit 4 } finally { try { if ($tm) { $tm.Stop() }; if ($owner) { $owner.Close() } } catch { } }",
        "if ($r -ne [System.Windows.Forms.DialogResult]::OK) { exit 3 }",
        "$p = $d.SelectedPath; if (-not $p) { Write-Output 'NOPATH'; exit 5 }",
        /* base64(UTF-8) 传路径：绕开「管道输出用重定向编码」这个坑（中文目录名会变乱码） */
        "[Console]::Out.WriteLine([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($p)))",
        "exit 0",
      ].join('; ');
      /* 优先 pwsh（现代框），退回 Windows PowerShell 5.1（老框）—— 两者都试过再报错 */
      /* ⚠ 顺序就是优先级：**pwsh 在前**（现代框），5.1 只在没有 pwsh 的机器上兜底。
         写成 5.1 在前的话这台机器明明装了 PowerShell 7，却还是弹出那个没有地址栏的老树形框
         —— 自检 `.tmp-pickdir.cjs` 里有一条就是钉这个顺序的（踩过）。 */
      const psCandidates = [
        { exe: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', modern: true },
        { exe: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), modern: false },
      ];
      const ps = psCandidates.find(c => { try { return fs.existsSync(c.exe); } catch (e) { return false; } });
      /* start 只是「对话框打开时停在哪」，可以为空；认不出来的（不存在 / 不是目录 / 太长）就当没给。
         title 只影响对话框顶上那行字，截到 60 个字符免得有人往里塞整段文章。 */
      readBody(req, res, 16 * 1024).then(raw => {
        if (raw == null) return;
        let title = '', start = '';
        try {
          const sp = JSON.parse(raw.toString('utf8')) || {};
          title = String(sp.title || '').trim().slice(0, 60);
          const s = String(sp.start || '').trim();
          if (s && s.length <= 400 && path.isAbsolute(s) && fs.existsSync(s) && fs.statSync(s).isDirectory()) start = s;
        } catch (e) { /* start / title 只影响对话框长什么样，读不到就用默认，不算错 */ }
        const env2 = Object.assign({}, process.env, {
          AII_PICK_TITLE: title || '选择要保存到的文件夹',
          AII_PICK_START: start,
        });
        try {
          if (!ps) return fail(501, '这台机器上既没有 PowerShell 7 也没有 Windows PowerShell，还是手填路径吧');
          /* ⚠ 必须用**异步** spawn，不能用 spawnSync：
             用户在文件夹选择框里慢慢翻目录可能一两分钟，而 spawnSync 是**堵死事件循环**的 ——
             那段时间里整个代理一条请求都答不了：正在跑的拍片任务轮询、配音、抽帧全卡住，
             表现是「点一下选择文件夹，整个应用都死了」。踩过一次。
             `-STA` 是硬要求（WinForms 对话框要单线程套间，MTA 下弹出来是空白或者直接抛），
             `-EncodedCommand` 见上面的注入防护。 */
          const p = spawn(ps.exe, ['-NoProfile', '-STA', '-WindowStyle', 'Hidden',
            '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')],
            { env: env2, windowsHide: false, cwd: root || process.cwd() });
          let out = '', err = '', over = false, timer = null;
          const done = fn => { if (over) return; over = true; if (timer) clearTimeout(timer); try { p.kill(); } catch (e) {} fn(); };
          /* 兜底上限：用户开着框忘了选，不能一直占着一个连接 */
          timer = setTimeout(() => done(() => fail(504, '5 分钟没人选，代理把它关掉了（选完点「选择…」再试一次）')), 300000);
          p.stdout.on('data', d => out += d.toString());
          p.stderr.on('data', d => { err += d.toString(); if (err.length > 8000) err = err.slice(-8000); });
          p.on('error', e => done(() => fail(500, '弹不出文件夹选择框：' + (e.message || e.code))));
          p.on('close', code => done(() => {
            /* 取消**不是失败**：回 200 + cancelled，页面据此安静收手，不弹红字 */
            if (code === 3) { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end(JSON.stringify({ ok: false, cancelled: true })); }
            if (code !== 0) {
              const say = firstLine(out) || firstLine(err);
              if (say === 'NOFORMS') return fail(500, '这台机器的 PowerShell 装不上窗体组件（System.Windows.Forms），弹不出选择框 —— 还是手填路径吧');
              return fail(500, '文件夹选择框没起来：' + cap120(say || ('退出码 ' + code)));
            }
            /* stdout 是 base64(UTF-8)。解不出来 / 解出来不是绝对路径时**退回按原文读** ——
               万一某台机器上脚本换了个版本，也不至于直接报「没回路径」把整条功能废掉。 */
            const rawLine = firstLine(out);
            let dir = '';
            try { dir = Buffer.from(rawLine, 'base64').toString('utf8'); } catch (e) { dir = ''; }
            if (!path.isAbsolute(dir)) dir = rawLine;
            if (!dir || !path.isAbsolute(dir)) return fail(500, '文件夹选择框没回路径（这是本机 PowerShell 的问题，不是设置的问题）');
            res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            /* modern=false 意味着弹出来的是 5.1 的老式树形框（没有地址栏、不能搜索）——
               页面据此把这件事说清楚，而不是让用户以为「系统就是这个样」。 */
            res.end(JSON.stringify({ ok: true, dir, modern: !!ps.modern }));
          }));
          /* 客户端自己走了（关了页面/切走）就把子进程收掉，别让一个没人要的框留在屏幕上 */
          res.on('close', () => { if (!over) { over = true; if (timer) clearTimeout(timer); try { p.kill(); } catch (e) {} } });
        } catch (e) {
          log('[pick-dir] ' + e.message);
          fail(500, '弹文件夹选择框时出错：' + e.message);
        }
      });
      return true;
    }
    return false;
  }

  return { handlePickDir };
}

module.exports = { createPickDirRoute };
