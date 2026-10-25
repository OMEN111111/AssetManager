# Maya 桥接插件集成测试：起临时服务 + 临时素材库 + 本机 mayapy 跑 test_maya.py
#
# 用法：
#   pwsh -File devtest\maya\run-test.ps1                 # 默认 Maya 2025
#   pwsh -File devtest\maya\run-test.ps1 -Series 2026     # 指定系列目录（要存在 bridge\maya\<年份>\）
#   pwsh -File devtest\maya\run-test.ps1 -NoRebuild       # 不重新打包 server.mjs（服务端没改时更快）
#
# 说明：
#   - 服务跑在 8790，数据目录在 devtest\maya\.data（临时，不动用户真实库）
#   - 用 mayapy（无界面）跑，不需要开 Maya 界面；所有断言都在 test_maya.py 里
#   - 结果：控制台 AMTEST PASS/FAIL 行 + devtest\maya\work\test_maya_result.json

param(
  [string]$Series = "2025",
  [int]$Port = 8790,
  [string]$MayaRoot = "D:\Software\01_DCC\01_Autodesk\Maya2025",
  [switch]$NoRebuild
)

$ErrorActionPreference = "Stop"
$root = "D:\Program\AssetManager"
$app = Join-Path $root "app"
$work = Join-Path $root "devtest\maya\work"
$data = Join-Path $root "devtest\maya\.data"
# 每次都从干净的临时数据目录开始：上一次没跑完的任务（running/pending）会被重新排队，
# 混进这一次的断言里（「任务一直 running」就是这么来的）
Remove-Item -Recurse -Force $data -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $work, $data | Out-Null
Remove-Item (Join-Path $work "test_maya_result.json") -Force -ErrorAction SilentlyContinue

$mayapy = Join-Path $MayaRoot "bin\mayapy.exe"
if (-not (Test-Path $mayapy)) { throw "找不到 mayapy：$mayapy" }
$seriesDir = Join-Path $app "bridge\maya\$Series"
if (-not (Test-Path $seriesDir)) { throw "缺少系列目录：$seriesDir" }
$test = Join-Path $app "bridge\maya\tools\test_maya.py"

# 1) 重新打包服务端（改了 src/server 或 src/core 就必须重新打包）
if (-not $NoRebuild) {
  Push-Location $app
  try {
    & node node_modules/esbuild/bin/esbuild src/server/index.ts --bundle --platform=node --format=esm --outfile=build/server.mjs
    if ($LASTEXITCODE -ne 0) { throw "esbuild 打包失败" }
    Write-Host "[test] 服务端已重新打包：app\build\server.mjs"
  } finally { Pop-Location }
}

# 2) 起临时服务（端口 + 独立数据目录）
$env:AM_DATA = $data
$env:PORT = "$Port"
$log = Join-Path $work "server.log"
$server = Start-Process -FilePath "node" -ArgumentList "build/server.mjs" -WorkingDirectory $app `
  -PassThru -WindowStyle Hidden -RedirectStandardOutput $log -RedirectStandardError ($log + ".err")
Write-Host "[test] 服务已启动 pid=$($server.Id) port=$Port"

$code = 2
try {
  $ready = $false
  for ($i = 0; $i -lt 60; $i++) {
    try {
      $r = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/state" -TimeoutSec 2
      if ($r.appRoot -or $r.app -eq "AssetManager") { $ready = $true; break }
    } catch { Start-Sleep -Milliseconds 300 }
  }
  if (-not $ready) { throw "服务没起来（看 $log）" }
  Write-Host "[test] 服务就绪，开始跑 mayapy 测试（Maya $Series）"

  & $mayapy $test $seriesDir "$Port" $work 2>&1 | Tee-Object -FilePath (Join-Path $work "mayapy.log")
  $code = $LASTEXITCODE
} finally {
  if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force }
  Write-Host "[test] 服务已关闭"
}

# 3) 摘要（从 AMTEST 输出里汇总，mayapy 的退出码已经说明结果）
$lines = Get-Content (Join-Path $work "mayapy.log") -ErrorAction SilentlyContinue
$pass = @($lines | Where-Object { $_ -like "AMTEST PASS*" })
$fail = @($lines | Where-Object { $_ -like "AMTEST FAIL*" })
$summary = ($lines | Where-Object { $_ -like "AMTEST SUMMARY*" } | Select-Object -Last 1)
[pscustomobject]@{
  series = $Series
  port = $Port
  ok = $pass.Count
  fails = $fail.Count
  summary = "$summary"
} | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $work "test_maya_result.json") -Encoding UTF8

Write-Host ""
Write-Host "================ Maya 桥接测试（$Series）================"
Write-Host ("通过 {0} 项，失败 {1} 项" -f $pass.Count, $fail.Count)
if ($fail.Count) { Write-Host ("失败：" + (($fail | ForEach-Object { ($_ -split " ", 3)[2] }) -join " / ")) -ForegroundColor Yellow }
Write-Host "日志：$work\mayapy.log"
Write-Host "======================================================="
exit $code
