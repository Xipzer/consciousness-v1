# Prints one JSON line per second with CPU package temperature (C) and power (W) from HWiNFO shared memory.
# Requires HWiNFO64 running with "Shared Memory Support" enabled. Prints {"error":...} when unavailable.
$ErrorActionPreference = 'Stop'
while ($true) {
  try {
    $mmf = [System.IO.MemoryMappedFiles.MemoryMappedFile]::OpenExisting('Global\HWiNFO_SENS_SM2', [System.IO.MemoryMappedFiles.MemoryMappedFileRights]::Read)
    $v = $mmf.CreateViewAccessor(0, 0, [System.IO.MemoryMappedFiles.MemoryMappedFileAccess]::Read)
    $off = $v.ReadUInt32(32); $size = $v.ReadUInt32(36); $n = $v.ReadUInt32(40)
    $temp = $null; $power = $null
    for ($i = 0; $i -lt $n; $i++) {
      $base = $off + $i * $size
      $type = $v.ReadUInt32($base)
      $bytes = New-Object byte[] 128
      [void]$v.ReadArray($base + 12, $bytes, 0, 128)
      $label = [System.Text.Encoding]::ASCII.GetString($bytes).Split([char]0)[0]
      $value = $v.ReadDouble($base + 284)
      if ($type -eq 1 -and $null -eq $temp -and $label -match '^CPU Package$') { $temp = $value }
      if ($type -eq 5 -and $null -eq $power -and $label -match '^CPU Package Power$') { $power = $value }
    }
    $v.Dispose(); $mmf.Dispose()
    if ($null -eq $temp) { Write-Output '{"error":"CPU Package temperature not found"}' }
    else {
      $ic = [cultureinfo]::InvariantCulture
      $p = if ($null -eq $power) { 'null' } else { $power.ToString($ic) }
      Write-Output ('{"cpuTempC":' + $temp.ToString($ic) + ',"cpuPowerW":' + $p + '}')
    }
  } catch {
    Write-Output ('{"error":"' + ($_.Exception.Message -replace '"', "'") + '"}')
  }
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds 1000
}
