"""Точка входа: python run.py (её же собирает PyInstaller)."""

import sys

from vkplayer.app import main

if __name__ == "__main__":
    sys.exit(main())
