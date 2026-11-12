@echo off
rem Двойной клик: собрать APK. Параметр (необязательно): адрес сервера, например build-apk.cmd https://tactic.example.com
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-apk.ps1" -Server "%~1"
pause
