@echo off
rem ============================================================
rem  Super Time 启动器
rem
rem  为什么要用这个脚本而不是直接跑 electron：
rem  本机环境里 ELECTRON_RUN_AS_NODE=1 被注入到了系统环境变量，
rem  直接启动 electron.exe 会退化成纯 node 模式（报
rem  "Cannot find module" / 静默无输出 / 看不到窗口）。
rem  这里先清空该变量，再拉起 GUI 进程。
rem ============================================================

set "ELECTRON_RUN_AS_NODE="

set "APP_DIR=%~dp0"
if "%APP_DIR:~-1%"=="\" set "APP_DIR=%APP_DIR:~0,-1%"

set "ELECTRON=%APP_DIR%\node_modules\electron\dist\electron.exe"

if not exist "%ELECTRON%" (
  echo [ERROR] 未找到 Electron: %ELECTRON%
  echo         请先在项目目录执行: npm install
  pause
  exit /b 1
)

rem 前端产物缺失时自动构建一次
if not exist "%APP_DIR%\src\client\ui-dist\index.html" (
  echo [info] 未找到前端构建产物，正在执行 npm run build:ui ...
  pushd "%APP_DIR%"
  call npm run build:ui
  popd
)

echo [info] 正在启动 Super Time ...
start "Super Time" "%ELECTRON%" "%APP_DIR%"
exit /b 0
