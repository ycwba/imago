@echo off
chcp 936 >nul
setlocal
cd /d "%~dp0"
title AI 创作工作台

rem ============================================================
rem 这一层只是「双击就有界面」的入口，真正做事的是同目录的 launcher.ps1。
rem 端口优先级、现找一个真能 bind 的号、只关 node 的进程、关窗自动停服务、
rem 服务日志 —— 全在那一个文件里，要改行为就改它，别在这里再写一套。
rem 本文件是 GBK（chcp 936），项目里其它文件都是 UTF-8：直接用编辑器写回本文件
rem 会把每一行中文写坏，改它要先写成 UTF-8 再 iconv -f utf-8 -t gbk 落回来。
rem ============================================================

if not exist "%~dp0launcher.ps1" (
  echo [错误] 找不到 launcher.ps1 —— 它必须和这个 启动.bat 在同一个目录里。
  echo        临时办法：在本目录直接运行   node proxy.js
  echo.
  pause
  exit /b 1
)

where powershell.exe >nul 2>nul
if errorlevel 1 (
  echo [错误] 这台机器上没有 powershell.exe，起不了界面。
  echo        临时办法：在本目录直接运行   node proxy.js
  echo.
  pause
  exit /b 1
)

rem 先把 launcher.ps1 解析一遍，再决定要不要把控制台藏掉：
rem 下面那句 -WindowStyle Hidden 一藏，launcher.ps1 解析不过就是「双击完全没反应」——
rem 那是最难查的一种坏法（窗口不出现、日志也没有），所以这一句把原因留在能看见的这里。
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('%~dp0launcher.ps1', [ref] $null, [ref] $e); if ($e.Count -gt 0) { $e | ForEach-Object { Write-Output $_.Message }; exit 1 }"
if errorlevel 1 (
  echo [错误] launcher.ps1 解析不过 —— 上面那一句就是原因。
  echo        临时办法：在本目录直接运行   node proxy.js
  echo        改回可见的控制台：把下面那行末尾的 -WindowStyle Hidden 去掉再双击。
  echo.
  pause
  exit /b 1
)

rem start 后面第一个引号串是「窗口标题」，所以那句空的 "" 不能省 ——
rem 省了它 powershell 会把 "%~dp0launcher.ps1" 当成标题，界面根本不出现。
rem -WindowStyle Hidden 是因为不藏的话桌面上会留一个空的「Windows PowerShell」控制台，
rem 而**关掉那个控制台是硬杀进程**（FormClosing 根本不走），端口上的服务就成了没人认领的孤儿，
rem 「关掉这个窗口会停掉服务」这句话只剩 GUI 那一个出口 —— 留一个更好按的出口在那儿就是坑。
start "" powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0launcher.ps1"
exit /b 0
