@echo off
echo == candidates ==
for %%P in (
  "C:\Program Files\PowerShell\7\pwsh.exe"
  "C:\Program Files\PowerShell\7-preview\pwsh.exe"
  "D:\Program Files\PowerShell\7\pwsh.exe"
  "%LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe"
  "%USERPROFILE%\scoop\apps\pwsh\current\pwsh.exe"
  "C:\ProgramData\chocolatey\bin\pwsh.exe"
  "%LOCALAPPDATA%\Microsoft\WinGet\Links\pwsh.exe"
  "D:\Program Files\PowerShell\7.6\pwsh.exe"
) do if exist %%P (echo FOUND %%P) else (echo ---- %%P)
echo == windowsapps listing ==
dir /b "%LOCALAPPDATA%\Microsoft\WindowsApps" 2>nul | findstr /i pwsh
echo == done ==
