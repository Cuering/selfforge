@echo off
rem selfforge watchdog launcher (startup/loop). Runs the single-check script
rem every 30s. A mutex file prevents concurrent instances (cmd + possible task).
setlocal
set "LOCK=C:\Users\xubin\.evolve\watchdog.lock"
if exist "%LOCK%" (
  rem check lock age: if older than 2 min, stale -> take over
  for %%F in ("%LOCK%") do set "AGE="& for /f "delims=" %%T in ('powershell -NoProfile -Command "(Get-Item '%LOCK%').LastWriteTime.AddMinutes(2) -lt (Get-Date)"') do set "AGE=%%T"
  if /i "%AGE%"=="False" exit /b
)
> "%LOCK%" echo %date% %time%

:loop
powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0selfforge-watchdog-once.ps1"
timeout /t 30 /nobreak >nul
goto loop