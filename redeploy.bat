@echo off
REM Script de redeploy backend Donia sur Railway.
REM Double-clique sur ce fichier pour redeployer.
REM Cree le 05/06/2026.

echo.
echo =================================================
echo  Donia Backend — Redeploy sur Railway
echo =================================================
echo.

cd /d "%~dp0"

echo [1/2] Git pull (recupere les derniers commits)...
git pull
if errorlevel 1 (
    echo Erreur lors du git pull.
    pause
    exit /b 1
)

echo.
echo [2/2] Railway up — upload du code et redeploy...
echo.
call railway up
if errorlevel 1 (
    echo.
    echo Le redeploy a echoue. Verifie le message d'erreur ci-dessus.
    pause
    exit /b 1
)

echo.
echo =================================================
echo  Redeploy lance ! Suis les logs sur railway.app
echo =================================================
echo.
pause
