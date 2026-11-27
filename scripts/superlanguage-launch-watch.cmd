@echo off
rem ============================================================================
rem  SuperLanguage 局域网启动器
rem
rem  ★ 这一份由 SuperTime「应用托管 → 部署」**自动复制到实例目录**，不要手工移动。
rem
rem  为什么需要它：SuperTime 在 A 电脑，SuperLanguage 在 B 电脑。A 无法直接拉起
rem  B 上的进程，所以改成「A 往共享目录写一个请求文件，B 的启动器看到就启动 exe」。
rem  这条路不新增任何网络监听 —— A 需要的权限，与它能写共享目录完全相同
rem  （而它本来就必须能写，否则部署也做不了）。
rem
rem  用法（在目标电脑上）：
rem    1. 双击运行本文件，或把它放进「启动」文件夹（shell:startup）让开机常驻。
rem    2. 它会先把实例拉起来（若还没跑），然后每 2 秒看一次 .start-request。
rem    3. 关掉窗口就停止监护；已在运行的实例不受影响。
rem
rem  行为：
rem    · 启动时若 exe 未运行，先拉一次（票据由 A 随后推送，不需要等待）；
rem    · 每 2 秒检查 .start-request，发现就删掉；exe 不在运行才启动，
rem      避免重复触发单实例锁；
rem    · 只用 ping 做延时（某些会话里 timeout 需要控制台输入）。
rem ============================================================================
setlocal enabledelayedexpansion
cd /d "%~dp0"

if not exist "SuperLanguage.exe" (
  echo [启动器] 错误：当前目录没有 SuperLanguage.exe
  echo [启动器]       目录：%CD%
  echo [启动器]       请先在 SuperTime 里完成「部署」，再运行本启动器。
  pause
  exit /b 1
)

echo [启动器] 监视目录：%CD%

rem ---- 首次拉起（若实例还没跑）----------------------------------------------
tasklist /FI "IMAGENAME eq SuperLanguage.exe" 2>nul | find /I "SuperLanguage.exe" >nul
if errorlevel 1 (
  echo [启动器] 实例未运行，先拉起一次…
  start "" /b "%~dp0SuperLanguage.exe" --tray
) else (
  echo [启动器] 实例已在运行，直接进入监护。
)

echo [启动器] 每 2 秒检查 .start-request（Ctrl+C 退出监护）

:loop
if exist ".start-request" (
  del /q ".start-request" >nul 2>&1
  tasklist /FI "IMAGENAME eq SuperLanguage.exe" 2>nul | find /I "SuperLanguage.exe" >nul
  if errorlevel 1 (
    echo [启动器] %DATE% %TIME% 收到启动请求，正在拉起实例…
    start "" /b "%~dp0SuperLanguage.exe" --tray
  ) else (
    echo [启动器] %DATE% %TIME% 收到启动请求，但实例已在运行（单实例锁），忽略
  )
)
rem 20 × 100ms ≈ 2 秒
ping -n 21 127.0.0.1 >nul
goto loop
