/*
================================================================================
 AssetManager · 3ds Max 桥接插件 · 集成测试（在 3dsmaxbatch 里跑）
--------------------------------------------------------------------------------
 用法：
   3dsmaxbatch.exe "D:\Program\AssetManager\app\bridge\max\tools\test_max.ms" ^
       -log "D:\...\test_max.log"
   或 (batch 里) fileIn @"...\tools\test_max.ms"
   结果同时写到 %TEMP%\AssetManager\max_test.txt

 前提：插件已在 startup 目录（或先 fileIn 过 2026/ 2027/ 的 AssetManagerBridge.ms），
      即 AMB_SCRIPT_VERSION 已存在。脚本自身不做网络请求以外的副作用，
      会在临时目录里建一个 Box 做 UUID 往返测试（结束后删除）。
================================================================================
*/

(
  global AMBT_LINES = #()
  global AMBT_PASS = 0
  global AMBT_FAIL = 0
  global AMBT_DIR = ""

  fn ambt_log s = ( append AMBT_LINES s )
  fn ambt_ok name cond = (
    if cond then ( AMBT_PASS += 1; ambt_log ("PASS  " + name) )
    else ( AMBT_FAIL += 1; ambt_log ("FAIL  " + name) )
  )
  fn ambt_info name val = ( ambt_log ("      " + name + " = " + (val as string)) )

  fn ambt_main = (
    local ticks = ((dotNetClass "System.DateTime").Now.Ticks) as string
    local tmp = (sysInfo.tempdir + "\\amb-max-test\\" + (substring ticks (ticks.count - 5) 6))
    makeDir tmp all:true
    AMBT_DIR = tmp

    -- 0) 插件是否已加载
    local loaded = (AMB_SCRIPT_VERSION != undefined)
    ambt_ok "插件已加载（AMB_SCRIPT_VERSION）" loaded
    if not loaded do (
      ambt_log "      提示：先把对应年份的 bridge/max/<年份>/AssetManagerBridge_*.ms 放进 Max 的 startup 目录（软件「安装到 3ds Max」会做）"
      return false
    )
    ambt_info "AMB_SCRIPT_VERSION" AMB_SCRIPT_VERSION
    ambt_info "AMB_PROTOCOL" AMB_PROTOCOL

    -- 1) Max 版本识别
    local mv = amb_max_version()          -- #(年份, build)
    ambt_ok "amb_max_version 返回年份" ((mv.count >= 2) and ((mv[1] as integer) >= 2023))
    ambt_info "amb_max_version" mv

    -- 2) 关键函数都在
    local fns = #("amb_poll_once", "amb_process", "amb_do_import", "amb_build_material", "amb_write_slots",
                  "amb_export_back", "amb_export_pack", "amb_collect_uuid", "amb_tag_asset", "amb_nodes_deep",
                  "amb_maps_target", "amb_heartbeat", "amb_http_get", "amb_http_post", "amb_parse")
    local missing = #()
    for n in fns do ( if (execute ("classOf " + n)) != MAXScriptFunction do append missing n )
    ambt_ok ("关键函数齐全（缺 " + (missing.count as string) + " 个）") (missing.count == 0)
    if missing.count != 0 do ambt_info "缺失" missing

    -- 3) 自带 JSON 解析
    local j = amb_parse "{\"a\": 1, \"b\": \"x\", \"c\": [1, 2]}"
    ambt_ok "amb_parse 解析对象" (j != undefined)
    ambt_ok "amb_jget 取字符串" ((amb_jget j "b") == "x")
    ambt_ok "amb_jget 取数组" (((amb_jget j "c") as string).count > 0)

    -- 4) UUID 打标 / 收集（导回功能的基础）
    local b = Box length:10 width:10 height:10 name:"AMB_TEST_BOX"
    local tagged = amb_tag_asset #(b) "test-uuid-1234" "TestAsset" tmp (tmp + "\\test.fbx")
    ambt_ok "amb_tag_asset 返回成功" (tagged == true or tagged == ok)
    ambt_ok "对象带上 ambUuid" ((amb_obj_uuid b) == "test-uuid-1234")
    local hits = amb_collect_uuid "test-uuid-1234"
    ambt_ok "amb_collect_uuid 能找到该对象" ((hits.count) == 1)
    local deep = amb_nodes_deep #(b)
    ambt_ok "amb_nodes_deep 遍历（>=1）" (deep.count >= 1)

    -- 5) 贴图目录 / 命名清理
    local mtNoMaps = amb_maps_target tmp          -- 没有 maps 子目录时返回原目录
    ambt_ok "amb_maps_target 无 maps 时回原目录" ((findString (toLower (mtNoMaps as string)) "maps") == undefined)
    makeDir (tmp + "\\maps") all:true
    local mt = amb_maps_target tmp                 -- 有 maps 时用它
    ambt_ok "amb_maps_target 有 maps 时用它" ((findString (toLower (mt as string)) "maps") != undefined)
    ambt_ok "amb_sanitize_name 非法字符换下划线" ((amb_sanitize_name "a:b?c*d") == "a_b_c_d")

    -- 5b) 真实材质构建：PhysicalMaterial + 各通道贴图 + UV 平铺 + 单通道输出
    --     （移植到新版本时这块最能暴露版本差异）
    local tex = tmp + "\\amb_tex.png"
    local texOk = false
    try (
      local bmm = bitmap 32 32 color:red
      bmm.filename = tex
      save bmm
      close bmm
      texOk = doesFileExist tex
    ) catch ( texOk = false )
    ambt_ok "生成测试贴图 png" texOk
    if texOk do (
      local tp = "\"" + (amb_esc tex) + "\""
      local specTxt = "{\"name\":\"AMB_TEST_MAT\",\"uv\":{\"repeatU\":2,\"repeatV\":3},\"maps\":{" \
        + "\"baseColor\":{\"path\":" + tp + ",\"channel\":\"rgb\"}," \
        + "\"roughness\":{\"path\":" + tp + ",\"channel\":\"r\"}," \
        + "\"metallic\":{\"path\":" + tp + ",\"channel\":\"g\"}," \
        + "\"normal\":{\"path\":" + tp + ",\"channel\":\"rgb\",\"normalSpace\":\"dx\"}," \
        + "\"height\":{\"path\":" + tp + ",\"channel\":\"b\"}," \
        + "\"opacity\":{\"path\":" + tp + ",\"channel\":\"a\"}" \
        + "}}"
      local sp = amb_parse specTxt
      ambt_ok "材质 spec 能解析" (sp != undefined)
      local built = undefined
      try ( built = amb_build_material sp ) catch ( ambt_log ("      构建异常：" + (getCurrentException() as string)) )
      ambt_ok "amb_build_material 有返回" (built != undefined and (built.count >= 3))
      if built != undefined do (
        local m = built[1]
        ambt_info "贴图接入数" built[2]
        if built[3].count > 0 do ambt_info "未用通道" built[3]
        ambt_ok "材质母版是 PhysicalMaterial" ((classof m) == PhysicalMaterial)
        ambt_ok ("贴图接入 6 个通道（实际 " + (built[2] as string) + "）") (built[2] >= 6)
        ambt_ok "base_color_map 已接" ((try (m.base_color_map != undefined) catch false))
        ambt_ok "roughness_map 已接" ((try (m.roughness_map != undefined) catch false))
        ambt_ok "metalness_map 已接" ((try (m.metalness_map != undefined) catch false))
        ambt_ok "bump_map 是 Normal_Bump" ((try ((classof m.bump_map) == Normal_Bump) catch false))
        ambt_ok "displacement_map 已接" ((try (m.displacement_map != undefined) catch false))
        ambt_ok "transparency_map 已接" ((try (m.transparency_map != undefined) catch false))
        ambt_ok "UV 平铺写进 coords" ((try ((m.base_color_map.coords.U_Tiling == 2) and (m.base_color_map.coords.V_Tiling == 3)) catch false))
        ambt_ok "单通道输出 r → monoOutput=2" ((try (m.roughness_map.monoOutput == 2) catch false))
        try ( m = undefined ) catch ()
      )
    )

    -- 6) 网络：有本地服务时验证心跳
    local testUrl = ""
    try ( testUrl = (dotNetClass "System.Environment").GetEnvironmentVariable "AMB_TEST_URL" ) catch ( testUrl = "" )
    if testUrl == undefined do testUrl = ""
    if testUrl != undefined and testUrl.count > 0 do (
      local st = amb_http_get (testUrl + "/api/state")
      ambt_ok "GET /api/state 有响应" (st != undefined and (st as string).count > 0)
      local code = amb_http_get (testUrl + "/api/bridge/max/next")   -- 无任务时应 204
      ambt_info "GET /api/bridge/max/next" (if code == undefined then "undefined" else (code as string))
      ambt_ok "队列接口可访问（返回非空）" (code != undefined and (code as string).count > 0)
      local hbBody = "{\"version\":\"" + AMB_SCRIPT_VERSION + "\",\"host\":\"max-batch-test\",\"protocol\":" + (AMB_PROTOCOL as string) + "}"
      local hb = amb_post_json (testUrl + "/api/bridge/max/heartbeat") hbBody
      ambt_ok "POST /api/bridge/max/heartbeat 成功" (hb != undefined)
    )
    local port = (try (amb_config_port()) catch (0))
    if port != undefined and port > 0 do (
      local alive = amb_probe_port port
      ambt_ok "amb_probe_port 探测到端口文件里登记的服务" alive
    )
    if (testUrl == undefined or testUrl.count == 0) and port == 0 do (
      ambt_log "SKIP  没有可用的本地服务（设置 AMB_TEST_URL 或运行 AssetManager 后再跑）"
    )

    -- 清理
    try ( delete b ) catch ()
    ambt_log ""
    ambt_log ("结果：PASS=" + (AMBT_PASS as string) + "  FAIL=" + (AMBT_FAIL as string))
    (AMBT_FAIL == 0)
  )

  local okAll = false
  try ( okAll = ambt_main() ) catch (
    ambt_log ("EXCEPTION: " + (getCurrentException()))
    ambt_log ("  位置: " + (getCurrentExceptionLine()))
  )

  ambt_log ("---- 3ds Max " + ((maxVersion())[8] as string) + " / 插件 " + (if AMB_SCRIPT_VERSION == undefined then "未加载" else AMB_SCRIPT_VERSION) + " ----")
  local txt = ""
  for l in AMBT_LINES do txt += l + "\r\n"
  local outFile = (sysInfo.tempdir + "\\AssetManager\\max_test.txt")
  makeDir (sysInfo.tempdir + "\\AssetManager") all:true
  try ( (dotNetClass "System.IO.File").WriteAllText outFile txt (dotNetObject "System.Text.UTF8Encoding" false) ) catch ()
  format "%\n" txt
  if okAll then format "ALL PASS\n" else format "HAS FAILURES\n"
)
