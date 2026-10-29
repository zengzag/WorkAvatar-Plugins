param(
  [Parameter(Mandatory = $true)][string]$Pptx,
  [Parameter(Mandatory = $true)][string]$OutDir
)
$ErrorActionPreference = "Stop"
$pptxPath = (Resolve-Path $Pptx).Path
if (!(Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir | Out-Null }
$ppt = New-Object -ComObject PowerPoint.Application
try {
  $pres = $ppt.Presentations.Open($pptxPath, $true, $false, $false)
  $pres.Export($OutDir, "PNG", 1280, 720)
  $pres.Close()
  Write-Output "Exported: $OutDir"
}
finally {
  $ppt.Quit()
  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($ppt) | Out-Null
}
