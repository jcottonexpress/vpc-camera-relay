$config = Join-Path $PSScriptRoot "relay-config.json"
if (-not (Test-Path $config)) {
    $data = [ordered]@{
        rtspUser  = "admin"
        rtspPass  = "GetLogicandFuck!23"
        onvifPass = "GetLogicandFuck!23"
    }
    $json = $data | ConvertTo-Json
    # Use WriteAllText — writes UTF-8 WITHOUT a BOM (Set-Content -Encoding UTF8 adds a BOM
    # which breaks Node.js JSON.parse).
    [System.IO.File]::WriteAllText($config, $json)
    Write-Host "  relay-config.json created successfully."
    Write-Host "  Edit rtspPass / onvifPass if your camera password is different."
} else {
    Write-Host "  relay-config.json already exists (not overwritten)."
}
