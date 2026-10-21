/*
  AssetManager · 拖放测试脚本
  ---------------------------------------------------------------------------
  用途：确认 3ds Max 会不会执行「拖进视口/工具栏的 .ms 文件」。
        会执行的话，AssetManager 就能把「素材拖进 Max」变成完全由插件接管，
        可以弹母版菜单、能拿到拖放位置。

  怎么测：
    1. 打开 3ds Max（图形界面）；
    2. 用资源管理器把这个文件拖进 Max 的视口里松手；
    3. 看结果：
       - 弹出提示框 / 视口里出现文字  → 会执行（把结果告诉开发者）；
       - 没有任何反应 / 提示无法识别  → 不会执行。
    另外，不管弹不弹框，只要执行了，下面这个文件就会出现：
      %TEMP%\amb-ms-drop-ok.txt
    内容里带时间戳，可以用记事本打开确认。

  这个文件不依赖 AssetManager 的任何代码，删掉也不影响桥接插件。
*/

(
  local stamp = (localTime as string)
  local path = (getDir #temp) + "\\amb-ms-drop-ok.txt"
  local ok = true
  try (
    local f = createFile path
    if f != undefined do (
      format "MAXScript drop executed at %\n" stamp to:f
      format "max=% , user=%\n" (maxVersion() as string) (sysInfo.username) to:f
      close f
    )
  ) catch (ok = false)

  local msg = "MAXScript 拖放生效了！\n\n时间：" + stamp + \
    "\n标记文件：" + path + "\n\n（把这个结果告诉开发者即可）"
  try (messageBox msg title:"AssetManager 拖放测试") catch (format "%\n" msg)
  if ok do format "AMB_DROP_TEST_OK %\n" stamp
)
