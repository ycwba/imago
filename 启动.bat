@echo off
chcp 65001 >nul
setlocal EnableExtensions DisableDelayedExpansion
cd /d "%~dp0"
title 成像 · AI 创作工作台

rem ============================================================================
rem  启动.bat —— 成像 · AI 创作工作台的本机服务入口
rem
rem  双击 = 环境自检 -> 预解析 launcher.ps1 -> 隐藏控制台拉起图形启动器 -> 退出。
rem  「起停 / 端口 / 日志 / 关窗停服务」全在 launcher.ps1 里，这里不写第二套。
rem
rem  用法：启动.bat [命令]
rem    无参数    直接启动工作台（默认，双击走这条）
rem    menu      功能菜单       check     环境详细自检
rem    log       日志末尾       dir       打开项目目录
rem    page      打开页面       selftest  启动器自检
rem    clean     清解析缓存     help      帮助
rem  开关：WB_LAUNCHER_DRYRUN=1  只检查不启动   WB_NOCOLOR=1  关掉彩色输出
rem
rem  编码：UTF-8 无 BOM + CRLF + chcp 65001；下面 ESC 那一行是真的 0x1B 字节。
rem  必须保留的两条契约：
rem    · start ... -WindowStyle Hidden —— 否则桌面上多一个控制台，关掉它是硬杀，服务成孤儿；
rem    · launcher.ps1 的 size+SHA1 预解析缓存（印记在 %TEMP%\imago-launcher-parse.key），
rem      隐藏前不解析就只会「双击完全没反应」；解析失败绝不写印记。
rem ============================================================================

set "LAUNCHER=%~dp0launcher.ps1"
set "PROXY=%~dp0proxy.js"
set "LOGFILE=%~dp0proxy.log"
set "ENVFILE=%~dp0.env"
set "STATEFILE=%~dp0.proxy-port"
set "PARSE_KEY=%TEMP%\imago-launcher-parse.key"
set "NODE_VER="
set "PORT_TXT="
set "LAST_PORT="
set "FAIL="
set "WARN=0"
set "MODE=auto"
set "SHA1="
set "LINFO="
set "KINFO="
set "SEL="

rem ---------- 颜色：Win10/11 的控制台默认认 ANSI；老系统或 WB_NOCOLOR 自动降级 ----------
set "ESC="
set "C0="
set "CDIM="
set "CT="
set "CA="
set "CG="
set "CY="
set "CR="
set "CB="
set "USE_COLOR=1"
if defined WB_NOCOLOR set "USE_COLOR="
rem 只起一个 cmd 子进程读 ver，比 ver | findstr 少一个外部进程；10.x 认 ANSI，老系统自动降级。
for /f "tokens=2 delims=[]" %%v in ('ver') do for /f "tokens=2" %%w in ("%%v") do set "WINVER=%%w"
if not "%WINVER:~0,3%"=="10." set "USE_COLOR="
if not defined USE_COLOR goto :color_ready
set "C0=%ESC%[0m"
set "CDIM=%ESC%[90m"
set "CT=%ESC%[1;97m"
set "CA=%ESC%[1;36m"
set "CG=%ESC%[1;32m"
set "CY=%ESC%[1;33m"
set "CR=%ESC%[1;91m"
set "CB=%ESC%[1;94m"
:color_ready

rem ---------- 命令分发 ----------
if /i "%~1"=="menu"     set "MODE=menu"
if /i "%~1"=="-m"       set "MODE=menu"
if /i "%~1"=="/m"       set "MODE=menu"
if /i "%~1"=="check"    set "MODE=check"
if /i "%~1"=="自检"     set "MODE=check"
if /i "%~1"=="log"      set "MODE=log"
if /i "%~1"=="dir"      set "MODE=dir"
if /i "%~1"=="page"     set "MODE=page"
if /i "%~1"=="selftest" set "MODE=selftest"
if /i "%~1"=="clean"    set "MODE=clean"
if /i "%~1"=="help"     set "MODE=help"
if /i "%~1"=="/?"       set "MODE=help"
if /i "%~1"=="-h"       set "MODE=help"
if not "%~1"=="" if "%MODE%"=="auto" goto :bad_arg

if not "%MODE%"=="menu" call :banner
if "%MODE%"=="menu"     goto :menu
if "%MODE%"=="help"     goto :help
if "%MODE%"=="log"      goto :do_log
if "%MODE%"=="dir"      goto :do_dir
if "%MODE%"=="page"     goto :do_page
if "%MODE%"=="selftest" goto :do_selftest
if "%MODE%"=="clean"    goto :do_clean
if "%MODE%"=="check"    goto :do_check_only

rem ---------- 默认：自检 -> 预解析 -> 拉起图形启动器 ----------
call :check_core
if defined FAIL goto :check_failed
call :parse_launcher
if defined FAIL goto :check_failed
call :port_info
call :status_port
if defined WB_LAUNCHER_DRYRUN goto :dry_ok
call :footer
echo(
echo(%CA%   ▸%CT%  正在打开工作台…%C0%
echo(%CDIM%     关掉启动器窗口会同时停掉服务   ·   更多命令：启动.bat menu%C0%
echo(
rem 这一句的 -WindowStyle Hidden 不能去掉：见文件头注释
start "" powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%LAUNCHER%"
exit /b 0

:dry_ok
echo(
echo(%CG%   ✓%C0%  自检通过；WB_LAUNCHER_DRYRUN 已设置，未启动界面。
echo(
exit /b 0

rem ============================================================================
rem  启动画面
rem ============================================================================
:banner
echo(
echo(%CA%  ██%C0%  %CT%成像 · AI 创作工作台%C0%
echo(%CA%  ██%CDIM%  本地服务启动器   ·   LOCAL-FIRST AI STUDIO%C0%
echo(
echo(%CDIM%  ─────────────────────────────────────────────────────────────────────%C0%
exit /b 0

rem ============================================================================
rem  硬性检查：缺一样就别往下走
rem ============================================================================
:check_core
if not exist "%LAUNCHER%" set "FAIL=找不到 launcher.ps1，它必须和 启动.bat 在同一个目录"
if not exist "%PROXY%"    set "FAIL=找不到 proxy.js，项目目录不完整，或这个 bat 被单独拷走了"
if not exist "%~dp0shell.html" set "FAIL=找不到 shell.html，项目目录不完整"
if defined FAIL exit /b 1

rem node 的存在性由下面这一次 node --version 顺带判掉，不再多跑一次 where；
rem powershell 直接看系统目录里的 exe —— where 要遍历整个 PATH，比被查的程序还慢。
if not exist "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" set "FAIL=没有找到 powershell.exe：这台机器起不了图形界面"
if defined FAIL exit /b 1
for /f "delims=" %%v in ('node --version 2^>nul') do set "NODE_VER=%%v"
if not defined NODE_VER set "FAIL=没有找到 node.exe：先安装 Node.js，再双击本文件"
if defined FAIL exit /b 1

echo(%CG%   ✓%C0%  项目文件   %CDIM%proxy.js · launcher.ps1 · shell.html%C0%
echo(%CG%   ✓%C0%  运行环境   %CDIM%Node.js %NODE_VER%  ·  PowerShell 可用%C0%
exit /b 0

rem ============================================================================
rem  预解析 launcher.ps1：按 size + SHA1 缓存，内容没变就不付这一次 PowerShell
rem ============================================================================
:parse_launcher
set "SHA1="
set "LINFO="
for /f "delims=" %%h in ('certutil -hashfile "%LAUNCHER%" SHA1 2^>nul ^| findstr /v ":"') do if not defined SHA1 set "SHA1=%%h"
if not defined SHA1 goto :do_parse
set "SHA1=%SHA1: =%"
for %%F in ("%LAUNCHER%") do set "LINFO=%%~zF %SHA1%"
if not exist "%PARSE_KEY%" goto :do_parse
set "KINFO="
set /p KINFO=<"%PARSE_KEY%"
if "%KINFO%"=="%LINFO%" goto :parse_cached

:do_parse
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('%LAUNCHER%', [ref] $null, [ref] $e); if ($e.Count -gt 0) { $e | ForEach-Object { Write-Output $_.Message }; exit 1 }"
if errorlevel 1 (
  set "FAIL=launcher.ps1 解析不过，上面一句就是原因"
  exit /b 1
)
if defined LINFO >"%PARSE_KEY%" echo %LINFO%
echo(%CG%   ✓%C0%  启动脚本   %CDIM%语法解析通过，本轮已重新校验%C0%
exit /b 0

:parse_cached
echo(%CG%   ✓%C0%  启动脚本   %CDIM%语法解析通过，内容未变，跳过本轮解析%C0%
exit /b 0

rem ============================================================================
rem  端口信息：只做展示，真正能不能 bind 由 launcher.ps1 问系统
rem ============================================================================
:port_info
rem 原生 for /f 读 .env：不再为一行 PORT 单独起一个 findstr 进程。
if exist "%ENVFILE%" for /f "usebackq eol=# tokens=1,* delims==" %%a in ("%ENVFILE%") do if /i "%%a"=="PORT" set "PORT_TXT=%%b"
if defined PORT_TXT set "PORT_TXT=%PORT_TXT: =%"
if exist "%STATEFILE%" set /p LAST_PORT=<"%STATEFILE%"
exit /b 0

:status_port
set "PORT_SHOW=%PORT_TXT%"
if not defined PORT_SHOW set "PORT_SHOW=5175"
if defined PORT_TXT (
  echo(%CB%   ·%C0%  服务端口   %CDIM%%PORT_SHOW%  来自 .env%C0%
) else (
  echo(%CB%   ·%C0%  服务端口   %CDIM%%PORT_SHOW%  默认，可在 .env 里写 PORT=端口号%C0%
)
if defined LAST_PORT echo(%CDIM%              上次运行记录在 %LAST_PORT%，启动器会自动复用或另挑一个空号%C0%
exit /b 0

:footer
echo(%CDIM%  ─────────────────────────────────────────────────────────────────────%C0%
exit /b 0

rem ============================================================================
rem  详细自检：多查几项，但不改任何东西
rem ============================================================================
:do_check_only
call :check_core
if defined FAIL goto :check_failed
call :parse_launcher
if defined FAIL goto :check_failed
call :port_info
call :status_port
call :detail_items
echo(
if "%WARN%"=="0" (
  echo(%CG%   ✓  全部检查通过，可以启动工作台。%C0%
) else (
  echo(%CY%   !  有 %WARN% 项提醒，不阻断启动；详见上面几行。%C0%
)
echo(%CDIM%  ─────────────────────────────────────────────────────────────────────%C0%
echo(
if defined WB_LAUNCHER_DRYRUN exit /b 0
pause
if "%MODE%"=="menu" goto :menu
exit /b 0

:detail_items
echo(
echo(%CA%  ── 详细检查 ──────────────────────────────────────────────────────%C0%
if exist "%~dp0node_modules\" echo(%CG%   ✓%C0%  依赖目录   %CDIM%node_modules 已就位%C0%
if not exist "%~dp0node_modules\" echo(%CY%   !%C0%  依赖目录   %CDIM%node_modules 缺失，菜单 8 可执行 npm install%C0%
if not exist "%~dp0node_modules\" set /a WARN+=1

if exist "%~dp0web\render\" echo(%CG%   ✓%C0%  页面产物   %CDIM%web\render 已生成%C0%
if not exist "%~dp0web\render\" echo(%CY%   !%C0%  页面产物   %CDIM%web\render 缺失，改过模板要跑 npm run build%C0%
if not exist "%~dp0web\render\" set /a WARN+=1

if exist "%ENVFILE%" echo(%CG%   ✓%C0%  配置文件   %CDIM%.env 已就位%C0%
if not exist "%ENVFILE%" echo(%CY%   !%C0%  配置文件   %CDIM%没有 .env，可参考 .env.example 新建%C0%
if not exist "%ENVFILE%" set /a WARN+=1

node --check "%PROXY%" >nul 2>nul
if errorlevel 1 goto :syntax_bad
echo(%CG%   ✓%C0%  服务入口   %CDIM%proxy.js 语法通过%C0%
goto :syntax_done
:syntax_bad
echo(%CR%   ✗%C0%  服务入口   %CDIM%proxy.js 语法有误，运行 node proxy.js 看具体报错%C0%
set /a WARN+=1
:syntax_done

rem 版本号要冷起一个 PowerShell 才问得到，为这一行付 400ms 不值；存在性上面已查过。
echo(%CG%   ✓%C0%  脚本宿主   %CDIM%Windows PowerShell 可用%C0%

if exist "%LOGFILE%" for %%F in ("%LOGFILE%") do echo(%CB%   ·%C0%  服务日志   %CDIM%proxy.log  %%~zF 字节，菜单 3 可看末尾%C0%
if not exist "%LOGFILE%" echo(%CDIM%              还没有 proxy.log，首次启动后会生成%C0%
exit /b 0

rem ============================================================================
rem  功能菜单
rem ============================================================================
:menu
cls
call :banner
echo(%CT%  功能菜单%C0%
echo(
echo(%CA%    1%C0%  启动工作台        %CDIM%默认动作，和双击一样%C0%
echo(%CA%    2%C0%  环境详细自检      %CDIM%文件、依赖、配置、语法逐项查%C0%
echo(%CA%    3%C0%  查看服务日志      %CDIM%proxy.log 末尾 25 行%C0%
echo(%CA%    4%C0%  打开项目目录      %CDIM%在资源管理器里打开%C0%
echo(%CA%    5%C0%  打开工作台页面    %CDIM%从 .proxy-port 取端口%C0%
echo(%CA%    6%C0%  启动器自检        %CDIM%launcher.ps1 -SelfTest，真起一份隔离实例%C0%
echo(%CA%    7%C0%  清除解析缓存      %CDIM%下次启动重新校验 launcher.ps1%C0%
echo(%CA%    8%C0%  重装依赖          %CDIM%npm install，需二次确认%C0%
echo(%CA%    0%C0%  退出
echo(
echo(%CDIM%  ─────────────────────────────────────────────────────────────────────%C0%
set "SEL="
set /p "SEL=  请选择 [0-8，回车退出]："
if not defined SEL goto :bye
if "%SEL%"=="0" goto :bye
if "%SEL%"=="1" goto :menu_launch
if "%SEL%"=="2" goto :menu_check
if "%SEL%"=="3" goto :menu_log
if "%SEL%"=="4" goto :menu_dir
if "%SEL%"=="5" goto :menu_page
if "%SEL%"=="6" goto :menu_selftest
if "%SEL%"=="7" goto :menu_clean
if "%SEL%"=="8" goto :menu_install
echo(%CY%  没有这个选项，再选一次。%C0%
goto :menu

:menu_launch
call :check_core
if defined FAIL goto :check_failed
call :parse_launcher
if defined FAIL goto :check_failed
call :port_info
call :status_port
call :footer
echo(
echo(%CA%   ▸%CT%  正在打开工作台…%C0%
echo(%CDIM%     关掉启动器窗口会同时停掉服务%C0%
echo(
start "" powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%LAUNCHER%"
exit /b 0

:menu_check
call :do_check_only
goto :menu

:menu_log
call :do_log
goto :menu

:menu_dir
call :do_dir
goto :menu

:menu_page
call :do_page
goto :menu

:menu_selftest
call :do_selftest
goto :menu

:menu_clean
call :do_clean
goto :menu

:menu_install
echo(
echo(%CY%  将在本目录执行 npm install，会联网下载开发依赖。%C0%
set "ANS="
set /p "ANS=  确认执行请输入 YES："
if /i not "%ANS%"=="YES" echo(%CDIM%  已取消。%C0%
if /i not "%ANS%"=="YES" goto :menu_pause
call npm install
:menu_pause
echo(
pause
goto :menu

rem ============================================================================
rem  菜单动作
rem ============================================================================
:do_log
echo(
if not exist "%LOGFILE%" (
  echo(%CY%  还没有 proxy.log，先启动一次工作台。%C0%
  goto :after_log
)
echo(%CA%  ── proxy.log 末尾 25 行 ──────────────────────────────────────────%C0%
powershell.exe -NoProfile -Command "Get-Content -LiteralPath '%LOGFILE%' -Tail 25 -Encoding UTF8"
echo(%CDIM%  ─────────────────────────────────────────────────────────────────────%C0%
:after_log
echo(
pause
exit /b 0

:do_dir
echo(
echo(%CB%   ▸%C0%  正在打开项目目录…
start "" explorer.exe "%~dp0"
echo(
pause
exit /b 0

:do_page
echo(
call :port_info
set "OPEN_PORT=%PORT_TXT%"
if exist "%STATEFILE%" set /p OPEN_PORT=<"%STATEFILE%"
if not defined OPEN_PORT set "OPEN_PORT=5175"
echo(%CB%   ▸%C0%  正在打开  %CT%http://localhost:%OPEN_PORT%/%C0%
echo(%CDIM%     如果页面打不开，先用菜单 1 启动工作台。%C0%
start "" "http://localhost:%OPEN_PORT%/"
echo(
pause
exit /b 0

:do_selftest
echo(
echo(%CA%  ── 启动器自检（会起一份隔离实例，结束后自动停掉）──────────────────%C0%
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%LAUNCHER%" -SelfTest
echo(%CDIM%  ─────────────────────────────────────────────────────────────────────%C0%
echo(
pause
exit /b 0

:do_clean
echo(
if exist "%PARSE_KEY%" del /f /q "%PARSE_KEY%" >nul 2>nul
echo(%CG%   ✓%C0%  已清除解析缓存，下次启动会重新校验 launcher.ps1。
echo(%CDIM%     缓存位置：%PARSE_KEY%%C0%
echo(
pause
exit /b 0

:help
echo(%CT%  用法%C0%
echo(
echo(%CDIM%    双击            环境自检后直接打开工作台%C0%
echo(%CA%    启动.bat menu%C0%   %CDIM%功能菜单%C0%
echo(%CA%    启动.bat check%C0%  %CDIM%环境详细自检%C0%
echo(%CA%    启动.bat log%C0%    %CDIM%看 proxy.log 末尾 25 行%C0%
echo(%CA%    启动.bat dir%C0%    %CDIM%打开项目目录%C0%
echo(%CA%    启动.bat page%C0%   %CDIM%打开工作台页面%C0%
echo(%CA%    启动.bat selftest%C0% %CDIM%跑启动器自检%C0%
echo(%CA%    启动.bat clean%C0%  %CDIM%清 launcher.ps1 解析缓存%C0%
echo(
echo(%CDIM%    开关  WB_LAUNCHER_DRYRUN=1  只检查不启动%C0%
echo(%CDIM%          WB_NOCOLOR=1          关掉彩色输出%C0%
echo(
echo(%CDIM%    起停、端口、日志、关窗停服务都在图形启动器窗口里；%C0%
echo(%CDIM%    临时办法：本目录直接运行 node proxy.js%C0%
echo(
echo(%CDIM%  ─────────────────────────────────────────────────────────────────────%C0%
echo(
pause
exit /b 0

rem ============================================================================
rem  失败与收尾
rem ============================================================================
:check_failed
call :footer
echo(
echo(%CR%  ▌  启动前检查没过%C0%
echo(%CR%  ▌  %FAIL%%C0%
echo(
echo(%CDIM%    临时办法：在本目录直接运行   node proxy.js%C0%
echo(%CDIM%    完整日志：同目录的 proxy.log%C0%
echo(%CDIM%    功能菜单：启动.bat menu  ·  详细自检：启动.bat check%C0%
echo(
if defined WB_LAUNCHER_DRYRUN exit /b 1
set "ER="
set /p "ER=  输入 M 打开功能菜单，回车退出："
if /i "%ER%"=="M" goto :menu
exit /b 1

:bad_arg
call :banner
echo(%CY%  不认识这个参数：%~1%C0%
echo(%CDIM%  运行  启动.bat help  看用法。%C0%
echo(
pause
exit /b 1

:bye
echo(
echo(%CDIM%  已退出，没有改动任何东西。%C0%
echo(
exit /b 0
