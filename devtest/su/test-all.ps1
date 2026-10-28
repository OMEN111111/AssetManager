# 在多个 SketchUp 版本上装插件 + 跑 tools/test_su.rb，收集结果
# 用法：pwsh -File devtest/su/test-all.ps1 [-Versions 2024,2025] [-Keep]
param([string[]]$Versions = @('2024', '2025', '2026', '2027'), [switch]$Keep)

$ErrorActionPreference = 'Continue'
if ($Versions.Count -eq 1 -and $Versions[0] -match '[,\[\]]') {
  $Versions = ($Versions[0] -replace '[\[\]]', '').Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ }
}
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$map = @{
  '2024' = @{ exe = 'D:\Software\PluginMake\SketchUp2024\SketchUp.exe';
              tpl = 'D:\Software\PluginMake\SketchUp2024\resources\en-US\Templates\Temp01a - Simple.skp' }
  '2025' = @{ exe = 'D:\Software\PluginMake\SketchUp2025\SketchUp\SketchUp.exe';
              tpl = 'D:\Software\PluginMake\SketchUp2025\SketchUp\resources\en-US\Templates\Temp01a - Simple.skp' }
  '2026' = @{ exe = 'D:\Software\01_DCC\99_Other\SketchUp2026\SketchUp\SketchUp.exe';
              tpl = 'D:\Software\01_DCC\99_Other\SketchUp2026\SketchUp\resources\en-US\Templates\Temp01a - Simple.skp' }
  '2027' = @{ exe = 'D:\Software\01_DCC\99_Other\SketchUp2027\SketchUp\SketchUp.exe';
              tpl = 'D:\Software\01_DCC\99_Other\SketchUp2027\SketchUp\resources\en-US\Templates\Temp01a - Simple.skp' }
}

$repo = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$workDir = Join-Path $env:TEMP 'am-su-test'
New-Item -ItemType Directory -Force -Path $workDir | Out-Null
$summary = @()

function Close-Popups([int]$procId) {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $cond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $procId)
  $buttons = @()
  try { $wins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond) } catch { return @() }
  foreach ($w in $wins) {
    try {
      foreach ($e in $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
        if ($e.Current.ControlType.ProgrammaticName -eq 'ControlType.Button') { $buttons += $e }
      }
    } catch { }
  }
  if (-not $buttons.Count) { return @() }
  # 「恢复版本」提示有 是/否：选否（不要打开恢复文件，否则模型不是干净的）
  $target = $buttons | Where-Object { $_.Current.Name -in @('否(N)', '否') } | Select-Object -First 1
  if (-not $target) { $target = $buttons | Where-Object { $_.Current.Name -in @('确定', 'OK') } | Select-Object -First 1 }
  if (-not $target) { return @() }
  try {
    $target.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    return @($target.Current.Name)
  } catch { return @() }
}

foreach ($v in $Versions) {
  if (-not $map.ContainsKey($v)) { Write-Host "[$v] 未知版本"; continue }
  $info = $map[$v]
  $plugins = Join-Path $env:APPDATA "SketchUp\SketchUp $v\SketchUp\Plugins"
  $json = Join-Path $env:TEMP "am-su-selftest-$v.json"

  Write-Host "`n===== SketchUp $v ====="
  Get-Process SketchUp -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Seconds 2
  Remove-Item $json -Force -ErrorAction SilentlyContinue

  # 装插件（该版本系列）+ 自测包装
  New-Item -ItemType Directory -Force -Path $plugins | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $plugins 'assetmanager_su') | Out-Null
  Copy-Item (Join-Path $repo "app\bridge\su\$v\assetmanager_su.rb") (Join-Path $plugins 'assetmanager_su.rb') -Force
  Copy-Item (Join-Path $repo "app\bridge\su\$v\assetmanager_su\main.rb") (Join-Path $plugins 'assetmanager_su\main.rb') -Force
  Copy-Item (Join-Path $PSScriptRoot 'am_selftest.rb') (Join-Path $plugins 'am_selftest.rb') -Force
  Remove-Item (Join-Path $plugins 'am_probe.rb') -Force -ErrorAction SilentlyContinue

  $blank = Join-Path $workDir ("blank-{0}-{1}.skp" -f $v, (Get-Date -Format 'HHmmss'))
  Copy-Item $info.tpl $blank -Force
  Start-Process -FilePath $info.exe -ArgumentList "`"$blank`""
  Start-Sleep -Seconds 3

  # 只轮询结果文件（频繁 UIA 会拖慢 SketchUp）；弹窗只在几个时间点尝试一次
  $done = $false
  $popupTries = @(75)   # 只兜底试一次：频繁 UIA 调用会明显拖慢 SketchUp 启动
  for ($i = 1; $i -le 120; $i++) {
    Start-Sleep -Seconds 1.5
    if (Test-Path $json) { $done = $true; break }
    $elapsed = [int]($i * 1.5)
    if ($elapsed % 15 -eq 0) {
      $pp = Get-Process SketchUp -ErrorAction SilentlyContinue
      Write-Host ("    [{0}s] procs={1} title='{2}'" -f $elapsed, $pp.Count, (($pp | ForEach-Object { $_.MainWindowTitle }) -join '|'))
    }
    if ($popupTries -contains $elapsed) {
      $p = Get-Process SketchUp -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($p) { $c = Close-Popups $p.Id; if ($c.Count) { Write-Host "  点了弹窗: $($c -join ',')" } }
    }
  }

  if ($done) {
    Start-Sleep -Seconds 1
    $d = Get-Content $json -Raw | ConvertFrom-Json
    if ($d.fatal) {
      Write-Host "  FATAL: $($d.fatal)"
      $summary += [pscustomobject]@{ Ver = $v; Pass = 0; Total = 0; Failed = "FATAL: $($d.fatal)" }
    } else {
      Write-Host ("  插件 {0} / 系列 {1} / ruby {2} → 通过 {3}/{4}" -f $d.plugin, $d.series, $d.ruby, $d.pass, $d.total)
      if ($d.failed.Count) { $d.failed | ForEach-Object { Write-Host "    ✘ $_" } }
      $summary += [pscustomobject]@{ Ver = $v; Pass = $d.pass; Total = $d.total; Failed = ($d.failed -join ' | ') }
    }
  } else {
    Write-Host "  !! 超时（没拿到自测结果）"
    $summary += [pscustomobject]@{ Ver = $v; Pass = 0; Total = 0; Failed = 'TIMEOUT' }
  }

  if (-not $Keep) {
    Get-Process SketchUp -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 2
  }
}

Write-Host "`n===== 汇总 ====="
$summary | Format-Table -AutoSize
