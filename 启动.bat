@echo off
chcp 936 >nul
setlocal enabledelayedexpansion
cd /d %~dp0
title AI 创作工作台

rem ============================================================
rem 端口从哪儿来（和 proxy.js 的优先级保持一致）：
rem   1) 命令行里已经 set 过的 PORT
rem   2) 项目目录 .env 里的 PORT=xxxx
rem   3) 默认 5175
rem 端口要是绑不上（被别的进程占用，或者被 Windows 的 Hyper-V / winnat 开机时
rem 保留走了 —— 后面这种报的是 listen EACCES，不是常见的 EADDRINUSE，netstat
rem 上根本看不见它），就从那个号往上找一个真能 bind 的端口，并说清换成了哪个。
rem 实际跑起来的端口记在 .proxy-port 里：停止 / 重启 / 退出都按它去关，
rem 否则换了端口，关的还是旧的那个。
rem ============================================================

set WANT=5175
set PSRC=默认值
rem 读 .env 里的 PORT 必须用 findstr，不能用 for /f 直接读那个文件 ——
rem 这一个文件开头有 chcp 936（本文件是 GBK），而 .env 是 UTF-8：
rem 936 代码页下 cmd 会把中文注释当成 GBK 双字节、连换行一起吃掉（实测 29 行只看到 17 行），
rem PORT 那一行往往就在那之后，于是循环根本没见到它，端口悄悄停在默认值上。
rem findstr 按字节找 ASCII 前缀，不受代码页影响；再套一层 for 把行内注释与空格切掉。
if exist "%~dp0.env" for /f "tokens=2 delims==" %%a in ('findstr /r /c:"^[ ]*PORT[ ]*=" "%~dp0.env" 2^>nul') do (
  for /f "tokens=1" %%b in ("%%a") do (
    set WANT=%%b
    set PSRC=来自 .env
  )
)
rem 同名环境变量比 .env 优先（proxy.js 就是这个顺序），所以它也盖在 .env 上面。
if defined PORT (
  set WANT=%PORT%
  set PSRC=来自环境变量 PORT（它比 .env 优先）
)

:menu
cls
echo ========================================
echo        AI 创作工作台
echo ========================================
echo.
echo   项目目录：%~dp0
echo   期望端口：%WANT%   （!PSRC!；想固定就在 .env 里写一行 PORT=端口号）
set LAST=
if exist "%~dp0.proxy-port" for /f "usebackq delims=" %%p in ("%~dp0.proxy-port") do set LAST=%%p
set LASTINFO=（没有记录）
if defined LAST set LASTINFO=!LAST!
echo   上次跑在：!LASTINFO!
echo.
echo    [1] 启动项目
echo    [2] 停止项目
echo    [3] 重启项目
echo    [4] 退出（退出前停掉服务）
echo.
set choice=
set /p choice=请选择 (1/2/3/4):
if "%choice%"=="1" goto start
if "%choice%"=="2" goto stop
if "%choice%"=="3" goto restart
if "%choice%"=="4" goto quit
goto menu

:start
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [错误] 未找到 Node.js，请先安装后再运行本脚本。
  pause
  goto menu
)
rem 已经在跑就不要再起第二个实例：先看上次真正用的端口，再看期望的端口
set AP=%WANT%
if defined LAST set AP=%LAST%
call :isrun %AP%
if "%IR%"=="1" goto already
set AP=%WANT%
rem 期望端口绑不上时现找一个能绑的（这一步要问系统，慢一秒左右）
set FREE=
call :findfree %WANT%
if not defined FREE set FREE=%WANT%
set AP=%FREE%
if "%AP%"=="%WANT%" goto launch
echo.
echo [端口换了] %WANT% 这个号现在绑不上：可能被别的进程占用，也可能落在 Windows 的系统保留段里。
echo            查保留段：netsh interface ipv4 show excludedportrange protocol=tcp
echo            这次改用 %AP% 启动。想以后都用它，就在 .env 里写一行 PORT=%AP%
:launch
echo.
echo 正在启动服务窗口（http://localhost:%AP%/ ）…
start "SparkCine-proxy" cmd /k "set PORT=%AP%&& node proxy.js"
rem 等服务真的监听上再开浏览器：以前是干等两秒就去开页面，启动失败时开出来的是
rem 一个打不开的 localhost，看着像页面坏了。
set tries=0
:waitloop
ping -n 2 127.0.0.1 >nul
call :isrun %AP%
if "%IR%"=="1" goto opened
set /a tries+=1
if %tries% lss 20 goto waitloop
echo.
echo [没起来] 端口 %AP% 上没有服务。切到标题为 SparkCine-proxy 的窗口看那句报错：
echo            · listen EACCES     = 这个号在系统保留段里 → 选 1 让它另找一个，或在 .env 里写 PORT=别的号
echo            · listen EADDRINUSE = 这个号被别的进程占了 → 选 2 停掉它，或换个号
echo            · 其余报错（比如 .env 里某行写法不对）也在那一个窗口里
pause
goto menu

:opened
> "%~dp0.proxy-port" echo %AP%
start "" "http://localhost:%AP%/"
echo 已启动：http://localhost:%AP%/
echo 服务在独立窗口运行（窗口标题 SparkCine-proxy，关闭那个窗口也就停止了服务）。
pause
goto menu

:already
echo.
echo [提示] 项目已经在端口 %AP% 上运行中，正在打开页面…
start "" "http://localhost:%AP%/"
pause
goto menu

:stop
echo.
call :stopone
pause
goto menu

:restart
echo.
echo 正在重启项目…
call :stopone
ping -n 2 127.0.0.1 >nul
goto start

:quit
rem 退出前把服务关掉：以前选这一项只是把菜单窗口关掉，node 那个窗口一直留在后台
rem 占着端口，下次启动就报 EADDRINUSE，而且人还不知道是谁占的。
echo.
call :stopone
echo 已退出。
ping -n 2 127.0.0.1 >nul
exit /b 0

rem ---------- 子过程 ----------
rem 端口上有没有监听
:isrun
set IR=0
netstat -ano | findstr "LISTENING" | findstr /c:":%~1 " >nul && set IR=1
goto :eof

rem 关掉「上次记录的端口」与「期望端口」上的服务进程，并把记录清掉。
rem 两个号可能不一样（那次启动是自动换过端口的），所以两个都要看一遍；相同就不重复。
:stopone
set KILLED=0
if defined LAST call :killport %LAST%
if not defined LAST call :killport %WANT%
if defined LAST if not "%LAST%"=="%WANT%" call :killport %WANT%
del "%~dp0.proxy-port" >nul 2>nul
set LAST=
if "%KILLED%"=="1" goto stopone_ok
echo 没有正在运行的项目（端口 %WANT% 上没有服务）。
goto :eof
:stopone_ok
echo 端口上的服务已经停掉了；标题为 SparkCine-proxy 的那个窗口可以直接关掉。
goto :eof

rem 只杀 node 的进程：这个号的监听者要是别的程序（例如别的开发服务器），
rem 关菜单就顺手 taskkill 掉它等于删了别人正在跑的东西，所以先认一遍镜像名。
rem KPD_%%p 那一张临时表是为了去重：同一个进程常常在 IPv4 与 IPv6 各占一行，
rem 不去重就会把「已停止」同一句话打印两遍。
:killport
set KP=%~1
if not defined KP goto :eof
for /f "delims==" %%v in ('set KPD_ 2^>nul') do set %%v=
for /f "tokens=5" %%p in ('netstat -ano ^| findstr "LISTENING" ^| findstr /c:":%KP% "') do (
  if not defined KPD_%%p (
    set KPD_%%p=1
    tasklist /FI "PID eq %%p" /NH 2>nul | findstr /i "node.exe" >nul
    if errorlevel 1 (
      echo 端口 %KP% 被别的程序占着（PID %%p 不是 node），没有动它。
    ) else (
      taskkill /PID %%p /F >nul 2>nul
      set KILLED=1
      echo 已停止端口 %KP% 上的服务（PID %%p）。
    )
  )
)
goto :eof

rem 从 %~1 往上找一个真能 bind 到 0.0.0.0 的端口。
rem 这一步必须问系统，不能只看 netstat：系统保留段里的号根本没在监听，
rem 但它就是绑不上（EACCES），只有真试一次 bind 才看得出来。
rem 窗口要开得够宽：Hyper-V / winnat 那一段实测能占到 1000 个号（本机 5174~6173 整段没了），
rem 只往上找几十个必然空手而归。整段试下来不到一秒。
rem 没有 PowerShell 时这条会失败，调用方退回原端口号（proxy.js 那边还会把原因说清楚）。
:findfree
set FREE=
for /f "delims=" %%p in ('powershell -NoProfile -Command "for($p=%~1;$p -lt %~1+8000;$p++){try{$l=[System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Any,$p);$l.Start();$l.Stop();$p;break}catch{}}"') do set FREE=%%p
goto :eof
