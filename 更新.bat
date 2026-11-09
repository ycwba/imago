@echo off
chcp 65001 >nul
setlocal EnableExtensions DisableDelayedExpansion
cd /d "%~dp0"
title 成像 · 检查更新

rem ============================================================================
rem  更新.bat —— 成像 · AI 创作工作台：检测仓库更新并拉取
rem
rem  双击 = 检测 + 有更新就拉（脏工作区先 stash，拉完取回；冲突绝不丢）。
rem  真正的活全在 update.ps1 里；这里只做入口与主题（与 启动.bat 同款）。
rem
rem  用法：更新.bat [命令]
rem    无参数    检测并拉取
rem    check     只检测不拉      log       看最近的提交
rem    help      帮助
rem  开关：WB_THEME=system|day|night  WB_NOCOLOR=1（优先级最高）
rem
rem  编码：UTF-8 无 BOM + CRLF + chcp 65001
rem ============================================================================

set "THEME=system"
if exist "%~dp0.env" for /f "usebackq eol=# tokens=1,* delims==" %%a in ("%~dp0.env") do if /i "%%a"=="WB_THEME" set "THEME=%%b"
set "THEME=%THEME: =%"
set "DARK="
if /i "%THEME%"=="night" set "DARK=1"
if /i "%THEME%"=="system" (
  for /f "tokens=2,*" %%a in ('reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize" /v AppsUseLightTheme 2^>nul ^| findstr /i AppsUseLightTheme') do if /i "%%b"=="0x0" set "DARK=1"
)
if defined WB_NOCOLOR goto :run
if defined DARK (
  color 0F
  title 成像 · 检查更新 · 夜间
) else (
  color F0
  title 成像 · 检查更新 · 日间
)

:run
if not exist "%~dp0update.ps1" (
  echo 找不到 update.ps1：它必须和 更新.bat 在同一个目录。
  if "%~1"=="" pause
  exit /b 1
)

set "ARG="
if /i "%~1"=="check" set "ARG=-Check"
if /i "%~1"=="log"   set "ARG=-Log"
if /i "%~1"=="help"  set "ARG=-Help"
if /i "%~1"=="/?"    set "ARG=-Help"
if not "%~1"=="" if not defined ARG goto :bad_arg

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0update.ps1" %ARG% %2 %3
set "RC=%ERRORLEVEL%"
echo(
if "%RC%"=="0" (
  echo 更新流程结束。
) else (
  echo 更新没有完成（退出码 %RC%）。本地未提交的改动没有被丢弃；按上面的提示处理。
)
if "%~1"=="" pause
exit /b %RC%

:bad_arg
echo(
echo 用法：更新.bat [check^|log^|help]
echo   无参数 = 检测并拉取；check 只检测；log 看最近提交。
echo(
if "%~1"=="" pause
exit /b 1
