# Arrête le bot et le tunnel
Get-CimInstance Win32_Process | Where-Object {
  $_.CommandLine -match 'lancer-bot\.cmd|lancer-tunnel\.cmd|cloudflared\\config\.yml|src\\server\.js'
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Write-Host "Bot et tunnel arrêtés."
