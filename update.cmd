@echo off
rem Updates the emojitown bot to the latest version and starts it.
rem Stop the running bot first (Ctrl+C in its window), then run:  .\update.cmd
cd /d "%~dp0"
echo.
echo === 1/4  Downloading the latest version ===
git pull || goto :error
echo.
echo === 2/4  Installing packages ===
call npm ci --no-audit --no-fund || goto :error
echo.
echo === 3/4  Building ===
call npm run build || goto :error
echo.
echo === 4/4  Starting the bot (press Ctrl+C to stop it) ===
node --env-file=.env dist/src/index.js
goto :eof

:error
echo.
echo *** Update stopped because of the error above. Copy the red text and send it to Claude. ***
exit /b 1
