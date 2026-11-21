@echo off
title AquaSentinel Dashboard - Doi AquaVix (STEMPETITION 2026)
cd /d "%~dp0"
echo ========================================================
echo   AquaSentinel - He thong giam sat ho boi truong hoc
echo   Doi thi AquaVix - Cuoc thi STEMPETITION 2026
echo ========================================================
echo.
echo Dang khoi dong may chu tai http://localhost:3000 ...
start http://localhost:3000
node server.js
pause
