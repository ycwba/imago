/* 前台锚定用的 Win32 片段（C# 源码）。
   只有 PowerShell 的 Add-Type 会编译它，Node 侧不执行：
     · 文件夹选择框（server/routes/pick-dir.js）—— 框弹在应用窗口后面；
     · 「打开目录」（server/open-dir.js：提示词归档 / FCPXML 工程目录）—— 文件夹开在后面。
   两处是同一个病根（Windows 前台锁：由后台进程拉起的窗口拿不到前台），解法也是同一套，
   所以 P/Invoke 只留这一份 —— 各抄一遍的话，改 AttachThreadInput 那条时只会改到其中一处。
   只用 C# 3 的语法：PowerShell 5.1 的 Add-Type 编译器老，`out var` 这类新写法当场编不过。 */
'use strict';

const FG_CS =
  'using System;using System.Runtime.InteropServices;public class AiiFg{' +
  '[DllImport("user32.dll")]static extern IntPtr GetForegroundWindow();' +
  '[DllImport("user32.dll")]static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);' +
  '[DllImport("user32.dll")]static extern bool AttachThreadInput(uint a,uint b,bool f);' +
  '[DllImport("kernel32.dll")]static extern uint GetCurrentThreadId();' +
  '[DllImport("user32.dll")]static extern bool SetForegroundWindow(IntPtr h);' +
  '[DllImport("user32.dll")]static extern bool ShowWindow(IntPtr h,int n);' +
  /* SwitchToThisWindow 没进文档，但从 XP 到 11 都导出着：前一条 SetForegroundWindow 被
     前台锁挡下时，它是「真的切过去」的最后一道（只对**已经按路径认准**的那个窗口用）。 */
  '[DllImport("user32.dll")]static extern void SwitchToThisWindow(IntPtr h,bool alt);' +
  'public static bool FgIs(IntPtr h,int pid){IntPtr fg=GetForegroundWindow();if(fg==IntPtr.Zero)return false;uint p;GetWindowThreadProcessId(fg,out p);return fg==h||(int)p==pid;}' +
  'public static bool Pull(IntPtr h){IntPtr fg=GetForegroundWindow();uint dummy;uint tid=0;if(fg!=IntPtr.Zero)tid=GetWindowThreadProcessId(fg,out dummy);uint cur=GetCurrentThreadId();if(tid!=0&&tid!=cur)AttachThreadInput(cur,tid,true);bool ok=SetForegroundWindow(h);if(tid!=0&&tid!=cur)AttachThreadInput(cur,tid,false);return ok;}' +
  /* 最小化的窗口光 SetForegroundWindow 不会还原，先 SW_RESTORE(9) 再拽。 */
  'public static void Show(IntPtr h){ShowWindow(h,9);}' +
  'public static void Force(IntPtr h){SwitchToThisWindow(h,true);}}';

module.exports = { FG_CS };
