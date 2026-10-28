: "$((__stackbite_download_status=$?))"; if [ "$__stackbite_download_status" != 0 ]; then unset __stackbite_download_status; return 1; fi; unset __stackbite_download_status; sh -c 'file=$(mktemp "${TMPDIR:-/tmp}/stackbite-bootstrap.XXXXXXXX") || exit 1; trap '\''rm -f "$file"'\'' EXIT; trap '\''exit 1'\'' HUP INT TERM; curl -fsSL -o "$file" "https://raw.githubusercontent.com/Shinick-Han/stackbite/main/install.sh" && sh "$file"'; return $?
@echo off
setlocal
set "PSModulePath=%SystemRoot%\System32\WindowsPowerShell\v1.0\Modules"
if /I not "%~1"=="True" exit /b 1
shift
set "_STACKBITE_BOOTSTRAP_NORUN=0"
set "_STACKBITE_BOOTSTRAP_NOPATH=0"
:options
if "%~1"=="" goto install
if /I "%~1"=="--no-run" goto norun
if /I "%~1"=="--no-path-update" goto nopath
echo Unknown installation option. 1>&2
exit /b 2
:norun
set "_STACKBITE_BOOTSTRAP_NORUN=1"
shift
goto options
:nopath
set "_STACKBITE_BOOTSTRAP_NOPATH=1"
shift
goto options
:install
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -Command "$ErrorActionPreference = 'Stop'; try { $script = (Invoke-WebRequest -UseBasicParsing -Uri 'https://raw.githubusercontent.com/Shinick-Han/stackbite/main/install.ps1').Content; $block = [scriptblock]::Create($script); & $block -NoRun:($env:_STACKBITE_BOOTSTRAP_NORUN -eq '1') -NoPathUpdate:($env:_STACKBITE_BOOTSTRAP_NOPATH -eq '1') } catch { Write-Error $_; exit 1 }"
exit /b %errorlevel%
