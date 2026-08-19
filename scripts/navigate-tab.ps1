# Navigate the Meituan login tab to the correct page
$cdpUrl = "http://127.0.0.1:18800"

try {
    $tabs = Invoke-RestMethod -Uri "$cdpUrl/json" -TimeoutSec 3
    $tab = $tabs | Where-Object { $_.url -match 'login' }
    if ($tab) {
        Write-Host "Found login tab: $($tab.id)"
        $body = @{url = "https://g.dianping.com/dzim-main-pc/index.html#/"} | ConvertTo-Json
        $headers = @{'Content-Type' = 'application/json'}
        Invoke-RestMethod -Uri "$cdpUrl/json/activate" -Method POST -Headers $headers -Body $body -TimeoutSec 5 | Out-Null
        Start-Sleep -Seconds 3
        Write-Host "Navigation triggered"
    } else {
        Write-Host "No login tab found"
    }
} catch {
    Write-Host "Error: $_"
}

# List tabs again
Start-Sleep -Seconds 2
try {
    $tabs2 = Invoke-RestMethod -Uri "$cdpUrl/json" -TimeoutSec 3
    Write-Host "`n=== Current Tabs ==="
    foreach ($t in $tabs2) {
        if ($t.type -eq 'page') {
            Write-Host "$($t.id): $($t.title) - $($t.url.Substring(0, [Math]::Min(60, $t.url.Length)))"
        }
    }
} catch {
    Write-Host "Error listing tabs: $_"
}
