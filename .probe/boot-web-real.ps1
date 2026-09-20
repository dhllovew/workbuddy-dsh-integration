# Boot the real `web` profile (the one the user actually uses) with the plugin
# linked in, detached from this shell so the server outlives one tool call.
Start-Process -FilePath cmd.exe -WindowStyle Hidden -ArgumentList '/c', 'dsh web --no-open --port 3099 > .probe\dsh-web-real.log 2>&1'
Write-Output 'spawned'
