$ErrorActionPreference = 'SilentlyContinue'
# selfforge dashboard watchdog single-check (runs every ~30s via loop launcher)
# Preferred port 9220 (avoids QQ squatting 9210). If 9220 is taken by something
# non-selfforge, the daemon drifts up; this script keeps exactly one live daemon,
# remembers its port, and opens the browser when the canonical port first changes.
$Entry = 'C:\Users\xubin\.config\opencode\plugins\compiled\serve-daemon.js'
$Bun   = 'C:\Users\xubin\selfforge\node_modules\bun\bin\bun.exe'
if (-not (Test-Path $Bun)) { $Bun = 'bun' }
$State = Join-Path $env:USERPROFILE '.evolve\watchdog-port.txt'
$Notified = if (Test-Path $State) { [int](Get-Content $State -Raw) } else { 0 }
$Start = Get-Date

function Ping-Port($p, $timeoutMs) {
  try {
    $req = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:$p/api/ping")
    $req.Timeout = $timeoutMs; $req.Method = 'GET'
    $resp = $req.GetResponse()
    $sr = New-Object System.IO.StreamReader($resp.GetResponseStream())
    $body = $sr.ReadToEnd(); $sr.Close(); $resp.Close()
    if ($body -like '*pong*') {
      try { $j = $body | ConvertFrom-Json; return [pscustomobject]@{ Port = $p; Pid = [int]$j.pid } } catch { return $null }
    }
    return $null
  } catch { return $null }
}

# Probe preferred band 9220-9230 then old band 9211-9215 (back-compat).
$candidates = (9220..9230) + (9211..9215) + 9210
$found = @()
foreach ($p in $candidates) {
  if ((Get-Date) - $Start -gt [TimeSpan]::FromSeconds(25)) { break }
  $d = Ping-Port $p 500
  if ($d) { $found += $d }
}

if ($found.Count -eq 0) {
  # Down: spawn daemon preferring 9220; drifts up if occupied.
  $env:SELFFORGE_PORT = '9220'
  $env:EVOLVE_HOME = Join-Path $env:USERPROFILE '.evolve'
  Start-Process -FilePath $Bun -ArgumentList ('"' + $Entry + '"') -WindowStyle Hidden
} else {
  $sorted = $found | Sort-Object Port
  $canon = $sorted[0]
  foreach ($dup in $sorted | Select-Object -Skip 1) {
    Start-Process -FilePath 'taskkill.exe' -ArgumentList ('/F /PID ' + $dup.Pid) -WindowStyle Hidden
  }
  if ($canon.Port -ne $Notified) {
    $Notified = $canon.Port
    Set-Content -Path $State -Value $Notified -Encoding ascii
    Start-Process "http://127.0.0.1:$($canon.Port)/"
  }
}