@echo off
chcp 936 >nul
cd /d %~dp0
title AI 创作工作台

:menu
cls
echo ========================================
echo        AI 创作工作台
echo ========================================
echo.
echo   项目目录：%~dp0
echo.
echo    [1] 启动项目
echo    [2] 停止项目
echo    [3] 重启项目
echo    [4] 退出
echo.
set /p choice=请选择 (1/2/3/4):
if "%choice%"=="1" goto start
if "%choice%"=="2" goto stop
if "%choice%"=="3" goto restart
if "%choice%"=="4" exit /b 0
goto menu

:start
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [错误] 未找到 Node.js，请先安装：https://nodejs.org
  pause
  goto menu
)
netstat -ano | findstr ":5175" | findstr "LISTENING" >nul
if not errorlevel 1 (
  echo.
  echo [提示] 项目已经在运行中，正在打开页面…
  start "" "http://localhost:5175/"
  pause
  goto menu
)
echo.
echo 正在启动服务窗口…
start "SparkCine-proxy" cmd /k "cd /d %~dp0 && node proxy.js"
ping 127.0.0.1 -n 3 >nul
start "" "http://localhost:5175/"
echo 已启动：http://localhost:5175
echo 服务在独立窗口运行（窗口标题 SparkCine-proxy，关闭该窗口即停止服务）。
pause
goto menu

:stop
echo.
echo 正在停止占用 5175 端口的进程…
set found=0
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":5175" ^| findstr "LISTENING"') do (
  taskkill /PID %%p /F >nul 2>nul
  set found=1
)
if "%found%"=="1" (echo 已停止。) else (echo 没有正在运行的项目。)
pause
goto menu

:restart
echo.
echo 正在重启项目…
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":5175" ^| findstr "LISTENING"') do taskkill /PID %%p /F >nul 2>nul
ping 127.0.0.1 -n 2 >nul
goto start
