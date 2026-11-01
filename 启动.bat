@echo off
chcp 65001 >nul
setlocal EnableExtensions DisableDelayedExpansion
cd /d "%~dp0"
title 成像 · AI 创作工作台

rem ============================================================================
rem 启动入口：双击只做「检查环境 -> 拉起 launcher.ps1 的图形界面」。
rem 起停 / 端口 / 日志 / 关窗停服务都在 launcher.ps1 里，这里不再写第二套。
rem 编码：本文件是 UTF-8（无 BOM）+ chcp 65001；改完请保持 UTF-8 与 CRLF。
rem 自检：set WB_LAUNCHER_DRYRUN=1 再运行，只打印检查结果、不启动界面。
rem ============================================================================

set "LAUNCHER=%~dp0launcher.ps1"
set "PROXY=%~dp0proxy.js"
set "NODE_VER="
set "FAIL="

echo.
echo  成像 · AI 创作工作台
echo  ----------------------------------------
echo  本机服务启动器
echo.

if not exist "%LAUNCHER%" (
  set "FAIL=找不到 launcher.ps1（它必须和 启动.bat 在同一个目录）"
  goto :check_failed
)
if not exist "%PROXY%" (
  set "FAIL=找不到 proxy.js（项目目录不完整，或这个 bat 被单独拷走了）"
  goto :check_failed
)
where node.exe >nul 2>nul
if errorlevel 1 (
  set "FAIL=没有找到 node.exe：先安装 Node.js，再双击本文件"
  goto :check_failed
)
for /f "delims=" %%v in ('node --version 2^>nul') do set "NODE_VER=%%v"
where powershell.exe >nul 2>nul
if errorlevel 1 (
  set "FAIL=没有找到 powershell.exe：这台机器起不了图形界面"
  goto :check_failed
)

echo  [1/3] Node.js  %NODE_VER%
echo  [2/3] 启动器   launcher.ps1
echo  [3/3] 服务入口 proxy.js
echo.

rem 先解析一遍 launcher.ps1：下面那句 -WindowStyle Hidden 一藏，解析不过就是
rem 「双击完全没反应」（窗口不出现、日志也没有），所以原因要留在看得见的这里。
rem 这次解析要另起一个 PowerShell（约半秒到一秒半），launcher.ps1 内容没变时不必每次都付：
rem 把「大小 + SHA1」记进上次的解析印记，一致就跳过；哈希算不出 / 印记缺失 / 内容变了必跑。
set "PARSE_KEY=%TEMP%\imago-launcher-parse.key"
set "SHA1="
set "LINFO="
for /f "delims=" %%h in ('certutil -hashfile "%LAUNCHER%" SHA1 2^>nul ^| findstr /v ":"') do if not defined SHA1 set "SHA1=%%h"
if not defined SHA1 goto :do_parse
set "SHA1=%SHA1: =%"
for %%F in ("%LAUNCHER%") do set "LINFO=%%~zF %SHA1%"
if not exist "%PARSE_KEY%" goto :do_parse
set /p KINFO=<"%PARSE_KEY%"
if "%KINFO%"=="%LINFO%" goto :parse_ok

:do_parse
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('%LAUNCHER%', [ref] $null, [ref] $e); if ($e.Count -gt 0) { $e | ForEach-Object { Write-Output $_.Message }; exit 1 }"
if errorlevel 1 (
  set "FAIL=launcher.ps1 解析不过（上面一句就是原因）"
  goto :check_failed
)
if defined LINFO >"%PARSE_KEY%" echo %LINFO%

:parse_ok

if defined WB_LAUNCHER_DRYRUN (
  echo  [自检] 环境检查通过；未启动界面。
  exit /b 0
)

echo  正在打开启动器窗口…
start "" powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%LAUNCHER%"
exit /b 0

:check_failed
echo  [错误] %FAIL%
echo.
echo  临时办法：在本目录直接运行   node proxy.js
echo  完整日志：同目录的 proxy.log
echo.
if defined WB_LAUNCHER_DRYRUN exit /b 1
pause
exit /b 1
