# 3ds Max 桥接插件集成测试：起临时服务 + 把系列插件装进该 Max 的 startup + 3dsmaxbatch 跑 test_max.ms
#
# 用法：
#   pwsh -File devtest\max\run-test.ps1                          # 默认 2027
#   pwsh -File devtest\max\run-test.ps1 -Series 2024             # 指定系列（要存在 bridge\max\<年份>\）
#   pwsh -File devtest\max\run-test.ps1 -Series all              # 2023/2024/2025/2026/2027 全跑
#   pwsh -File devtest\max\run-test.ps1 -NoRebuild -NoInstall     # 服务端没改 / 插件已装好时更快
#
# 说明：
#   - 服务跑在 8790，数据目录在 devtest\max\.data（临时，不动用户真实库）
#   - 插件按「软件安装到 3ds Max」同样的方式拷进
#     %LOCALAPPDATA%\Autodesk\3dsMax\<年份> - 64bit\<语言>\scripts\startup\，
#     因为 batch 模式下 fileIn 不会把插件里的 global 留下来（2024+ 实测），必须让 Max 启动时自己加载
#   - 结果：控制台 PASS/FAIL 摘要 + devtest\max\work\test_max_<年份>.txt（detail 明细）
param(
  [string]$Series = "2027",
  [int]$Port = 8790,
  [string]$MaxRootBase = "D:\Software\PluginMake",
  [switch]$NoRebuild,
  [switch]$NoInstall,
  [int]$TimeoutSec = 300
)

$ErrorActionPreference = "Stop"
$root = "D:\Program\AssetManager"
$app = Join-Path $root "app"
$work = Join-Path $root "devtest\max\work"
$data = Join-Path $root "devtest\max\.data"
$tmpOut = Join-Path $env:TEMP "AssetManager\max_test.txt"

$seriesList = if ($Series -eq "all") { @("2023", "2024", "2025", "2026", "2027") } else { @($Series) }

New-Item -ItemType Directory -Force -Path $work, $data | Out-Null

# 1) 重新打包服务端（改了 src/server 或 src/core 就必须重新打包）
if (-not $NoRebuild) {
  Push-Location $app
  try {
    & node node_modules/esbuild/bin/esbuild src/server/index.ts --bundle --platform=node --format=esm --outfile=build/server.mjs
    if ($LASTEXITCODE -ne 0) { throw "esbuild 打包失败" }
    Write-Host "[test] 服务端已重新打包：app\build\server.mjs"
  } finally { Pop-Location }
}

# 2) 每次清空临时数据目录（上次没跑完的任务会被重新排队，混进这一轮断言）
Remove-Item -Recurse -Force $data -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $data | Out-Null

$env:AM_DATA = $data
$env:PORT = "$Port"
$log = Join-Path $work "server.log"
$server = Start-Process -FilePath "node" -ArgumentList "build/server.mjs" -WorkingDirectory $app `
  -PassThru -WindowStyle Hidden -RedirectStandardOutput $log -RedirectStandardError ($log + ".err")
Write-Host "[test] 服务已启动 pid=$($server.Id) port=$Port"

$summary = @()
$exitCode = 0
try {
  $ready = $false
  for ($i = 0; $i -lt 60; $i++) {
    try {
      $r = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/state" -TimeoutSec 2
      if ($r.appRoot -or $r.app -eq "AssetManager") { $ready = $true; break }
    } catch { Start-Sleep -Milliseconds 300 }
  }
  if (-not $ready) { throw "服务没起来（看 $log）" }
  Write-Host "[test] 服务就绪（端口 $Port）"

  foreach ($v in $seriesList) {
    Write-Host ""
    Write-Host "======== 3ds Max $v ========"
    $seriesDir = Join-Path $app "bridge\max\$v"
    $plugin = Join-Path $seriesDir "AssetManagerBridge_0.2.1.ms"
    $batch = $null
    foreach ($base in @($MaxRootBase, "D:\Software\01_DCC\01_Autodesk")) {
      $cand = Join-Path (Join-Path $base "3ds Max $v") "3dsmaxbatch.exe"
      if (Test-Path $cand) { $batch = $cand; break }
    }
    if (-not $batch) { $batch = Join-Path (Join-Path $MaxRootBase "3ds Max $v") "3dsmaxbatch.exe" }
    if (-not (Test-Path $plugin)) { Write-Host "  跳过：缺插件 $plugin" -ForegroundColor Yellow; $exitCode = 1; continue }
    if (-not (Test-Path $batch)) { Write-Host "  跳过：找不到 $batch" -ForegroundColor Yellow; continue }

    # 2a) 装进该 Max 的用户 startup（和软件「安装到 3ds Max」同一路径规则）
    if (-not $NoInstall) {
      $cfgRoot = Join-Path $env:LOCALAPPDATA "Autodesk\3dsMax\$v - 64bit"
      $langDir = $null
      if (Test-Path $cfgRoot) {
        foreach ($l in Get-ChildItem $cfgRoot -Directory) {
          if (Test-Path (Join-Path $l.FullName "scripts")) { $langDir = $l.FullName; break }
        }
      }
      if (-not $langDir) { $langDir = Join-Path $cfgRoot "CHS" }
      $startup = Join-Path $langDir "scripts\startup"
      New-Item -ItemType Directory -Force -Path $startup | Out-Null
      Get-ChildItem $startup -Filter "AssetManagerBridge*.ms" -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -ne (Split-Path $plugin -Leaf) } | Remove-Item -Force
      Copy-Item $plugin (Join-Path $startup (Split-Path $plugin -Leaf)) -Force
      # 清掉旧宏（否则 Max 会用旧宏体，见 bridge.ts removeMaxMacroFiles）
      $mcr = Join-Path $langDir "usermacros"
      if (Test-Path $mcr) { Get-ChildItem $mcr -Filter "*sset*anager*.mcr" -ErrorAction SilentlyContinue | Remove-Item -Force }
      Write-Host "  插件已装到 $startup"
    }

    # 2b) 跑测试
    Remove-Item $tmpOut -Force -ErrorAction SilentlyContinue
    $perLog = Join-Path $work "test_max_$v.txt"
    Remove-Item $perLog -Force -ErrorAction SilentlyContinue
    $env:AMB_TEST_URL = "http://127.0.0.1:$Port"
    $batchOut = Join-Path $work "batch_$v.log"
    $p = Start-Process -FilePath $batch -ArgumentList "`"$app\bridge\max\tools\test_max.ms`"" -PassThru `
      -WindowStyle Hidden -RedirectStandardOutput $batchOut -RedirectStandardError ($batchOut + ".err")
    $finished = $p.WaitForExit($TimeoutSec * 1000)
    if (-not $finished) {
      Write-Host "  超时 ${TimeoutSec}s：杀掉 batch（多半是许可 / 对话框挡住）" -ForegroundColor Yellow
      try { Stop-Process -Id $p.Id -Force } catch { }
      # 只清 batch 拉起的无窗口 3dsmax 子进程；用户自己开着的 GUI Max（有窗口标题）绝对不动
      Get-Process 3dsmax -ErrorAction SilentlyContinue |
        Where-Object { -not $_.MainWindowTitle -and $_.StartTime -gt (Get-Date).AddMinutes(-10) } |
        ForEach-Object { try { Stop-Process -Id $_.Id -Force } catch { } }
    }

    if (Test-Path $tmpOut) {
      Copy-Item $tmpOut $perLog -Force
      $lines = Get-Content $perLog -Encoding UTF8
      $pass = @($lines | Where-Object { $_ -like "PASS*" }).Count
      $fail = @($lines | Where-Object { $_ -like "FAIL*" }).Count
      $skip = @($lines | Where-Object { $_ -like "SKIP*" })
      $ver = ($lines | Where-Object { $_ -like "---- 3ds Max*" } | Select-Object -Last 1)
      Write-Host ("  {0}" -f $ver)
      Write-Host ("  通过 {0} 项，失败 {1} 项" -f $pass, $fail) -ForegroundColor $(if ($fail) { "Yellow" } else { "Green" })
      if ($fail) { $lines | Where-Object { $_ -like "FAIL*" } | ForEach-Object { Write-Host "    $_" -ForegroundColor Yellow } }
      if ($skip) { $skip | ForEach-Object { Write-Host "    $_" } }
      $summary += [pscustomobject]@{ series = $v; pass = $pass; fail = $fail; log = $perLog }
      if ($fail -or $pass -eq 0) { $exitCode = 1 }
    } else {
      $tail = Get-Content $batchOut -Encoding Unicode -ErrorAction SilentlyContinue | Select-Object -Last 8
      Write-Host "  没有测试结果（%TEMP%\AssetManager\max_test.txt 不存在，多半没跑起来）" -ForegroundColor Yellow
      foreach ($t in $tail) { if ("$t".Trim()) { Write-Host "    $t" } }
      $summary += [pscustomobject]@{ series = $v; pass = 0; fail = -1; log = $batchOut }
      $exitCode = 1
    }
  }
} finally {
  if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force }
  Write-Host ""
  Write-Host "[test] 服务已关闭"
}

$summary | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $work "test_max_result.json") -Encoding UTF8
Write-Host ""
Write-Host "================ 3ds Max 桥接测试汇总 ================"
foreach ($s in $summary) {
  Write-Host ("  {0}: PASS={1} FAIL={2}" -f $s.series, $s.pass, $s.fail)
}
if ($summary.Count) { Write-Host ("明细：" + (Join-Path $work "test_max_<年份>.txt")) }
Write-Host "======================================================"
exit $exitCode
