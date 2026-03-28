@echo off
setlocal
powershell -ExecutionPolicy Bypass -File "%~dp0setup.ps1" %*
