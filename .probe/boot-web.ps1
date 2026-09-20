# Boot the isolated web profile detached from this shell.
# ASCII-only on purpose: Windows PowerShell 5.1 decodes .ps1 as ANSI, which
# mangles the non-ASCII project path, so the caller cd's here first and this
# script uses relative paths only.
Start-Process -FilePath cmd.exe -WindowStyle Hidden -ArgumentList '/c', 'dsh --profile wbtest --no-open --port 3099 > .probe\dsh-web.log 2>&1'
Write-Output 'spawned'
