param([int]$Port = 3099)
# Free the port so the next boot is unambiguous. ASCII-only: Windows PowerShell
# 5.1 decodes .ps1 as ANSI, which would mangle a non-ASCII path.
Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
Write-Output "cleared $Port"
