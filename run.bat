@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist .venv (
  echo Первый запуск: устанавливаю зависимости...
  python -m venv .venv || (echo Нужен Python 3.10+ с python.org & pause & exit /b 1)
  .venv\Scripts\python -m pip install -r requirements.txt || (pause & exit /b 1)
)
start "" .venv\Scripts\pythonw.exe run.py
