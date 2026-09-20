# Confirm the processes I started are gone.
$targets = @(10620)
foreach ($target in $targets) {
  if (Get-Process -Id $target -ErrorAction SilentlyContinue) { "STILL-RUNNING $target" }
  else { "GONE $target" }
}
$listeners = (Get-NetTCPConnection -LocalPort 3099 -State Listen -ErrorAction SilentlyContinue | Measure-Object).Count
"listeners on 3099: $listeners"
