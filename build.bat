@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist .venv python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt pyinstaller || (pause & exit /b 1)
.venv\Scripts\pyinstaller --noconfirm --windowed --name VKPlayer --collect-all curl_cffi run.py || (pause & exit /b 1)
echo.
echo Готово: dist\VKPlayer\VKPlayer.exe
pause
