# encoding: utf-8
# AssetManager · SketchUp 插件集成测试（在 SketchUp 内部跑）
#
# 用法：先把插件装好并让 SketchUp 起来，然后在 SketchUp 的 Ruby 控制台里
#   load "D:/Program/AssetManager/app/bridge/su/tools/test_su.rb"
# 测试全部自造素材（临时目录），不依赖真实素材库；HDRI 用例在没有样本时自动跳过。
#
# 结果打印在 Ruby 控制台里：每条 [OK]/[FAIL]，最后一行是「通过 N / 共 M」。

require 'sketchup.rb'
require 'fileutils'
require 'tmpdir'

module AMSuTest
  # 被测模块（模块级常量：方法体里不能做动态常量赋值）
  B = AssetManager::Bridge
  @results = []

  class << self
    attr_reader :results

    def check(name, cond, detail = '')
      # 进度打点：卡住时能看出停在哪一条（只在测试里用，插件本体不写文件）
      begin
        tag = (defined?(AssetManager::AM_SERIES) ? AssetManager::AM_SERIES : "20#{Sketchup.version.split('.')[0]}")
        File.open(File.join(ENV['TEMP'] || '.', "am-su-progress-#{tag}.txt"), 'w') do |f|
          f.write(name.to_s)
        end
      rescue StandardError
        nil
      end
      @results << { name: name, ok: !!cond, detail: detail.to_s }
      puts format('[%s] %s%s', cond ? 'OK' : 'FAIL', name, detail.to_s.empty? ? '' : "  — #{detail}")
      !!cond
    end

    def safe(name)
      yield
    rescue StandardError => e
      check(name, false, "#{e.class}: #{e.message}")
      nil
    end

    # 造一张纯色/渐变 PNG，返回路径
    def make_png(path, w, h, rgb)
      buf = Array.new(w * h * 3)
      i = 0
      h.times do |y|
        w.times do |x|
          k = (x.to_f / w)
          buf[i] = (rgb[0] * (0.4 + 0.6 * k)).round
          buf[i + 1] = (rgb[1] * (0.4 + 0.6 * k)).round
          buf[i + 2] = (rgb[2] * (0.4 + 0.6 * k)).round
          i += 3
        end
      end
      rep = Sketchup::ImageRep.new
      rep.set_data(w, h, 24, 0, buf.pack('C*'))
      rep.save_file(path)
      path
    end

    def write_file(path, text)
      File.open(path, 'wb') { |f| f.write(text) }
      path
    end

    def run
      model = Sketchup.active_model
      dir = File.join(Dir.tmpdir, 'am_su_test')
      FileUtils.mkdir_p(dir) unless File.directory?(dir)

      # ---------------------------------------------------------------- 1. 常量 / 环境
      pbr = B.pbr?     # SketchUp 2025+ 才有 PBR 材质槽
      env = B.env?     # 同上，2025+ 才有 environments
      check('插件版本号存在', AssetManager::AM_PLUGIN_VERSION =~ /\A\d+\.\d+\.\d+\z/,
            AssetManager::AM_PLUGIN_VERSION.to_s)
      check('系列号是年份', AssetManager::AM_SERIES.to_s =~ /\A20\d\d\z/, AssetManager::AM_SERIES.to_s)
      check('系列号与当前 SketchUp 主版本一致',
            Sketchup.version.to_s.split('.').first.to_i == (AssetManager::AM_SERIES.to_i - 2000),
            "#{AssetManager::AM_SERIES} vs #{Sketchup.version}")
      check('有打开的模型', !model.nil?)
      check('SketchUp 版本已知', Sketchup.version.to_s =~ /\A2\d\.\d+\.\d+\z/, Sketchup.version.to_s)
      check('HTTP 工具可用（不等服务）', B.respond_to?(:http))
      check('能力探测有结果（PBR/环境按版本不同）', [true, false].include?(pbr) && [true, false].include?(env),
            "pbr=#{pbr} env=#{env}")
      check('导入能力列表非空', B.supported_import_exts.length >= 5, B.supported_import_exts.join(' '))

      # ---------------------------------------------------------------- 2. 通道抽取
      packed = make_png(File.join(dir, 'packed.png'), 16, 16, [200, 120, 60])
      dst = File.join(dir, 'chan_g.png')
      File.delete(dst) if File.exist?(dst)
      safe('抽通道不报错') { B.extract_channel(packed, 'g', false, 1.0, dst) }
      ok = File.exist?(dst) && File.size(dst) > 0
      check('通道抽取写出 PNG', ok, ok ? "#{File.size(dst)} bytes" : '没生成文件')
      if ok
        rep = Sketchup::ImageRep.new
        rep.load_file(dst)
        px = rep.color_at_uv(0.5, 0.5).to_a
        check('抽的是 G 通道且是灰度', (px[0] - px[1]).abs <= 2 && (px[1] - px[2]).abs <= 2 && px[0] > 40,
              "rgba=#{px.inspect}")
      end
      # 反相 + 强度
      dst2 = File.join(dir, 'chan_inv.png')
      File.delete(dst2) if File.exist?(dst2)
      safe('反相抽取不报错') { B.extract_channel(packed, 'r', true, 1.0, dst2) }
      check('反相抽取写出 PNG', File.exist?(dst2))

      # ---------------------------------------------------------------- 3. 材质重建
      base = make_png(File.join(dir, 'mat_base.png'), 32, 32, [180, 140, 100])
      nrm = make_png(File.join(dir, 'mat_nrm.png'), 16, 16, [128, 128, 255])
      rgh = make_png(File.join(dir, 'mat_rgh.png'), 16, 16, [90, 90, 90])
      ao = make_png(File.join(dir, 'mat_ao.png'), 16, 16, [40, 40, 40])
      name = "AM_TEST_MAT_#{Time.now.to_i}"
      spec = {
        'name' => name, 'workflow' => 'MR', 'assetId' => 999, 'assetName' => name,
        'maps' => {
          'baseColor' => { 'path' => base, 'channel' => 'rgb', 'intensity' => 1 },
          'normal' => { 'path' => nrm, 'channel' => 'rgb', 'intensity' => 1, 'normalSpace' => 'dx' },
          'roughness' => { 'path' => rgh, 'channel' => 'r', 'intensity' => 1 },
          'ao' => { 'path' => ao, 'channel' => 'b', 'intensity' => 1 },
          'opacity' => { 'path' => ao, 'channel' => 'r', 'intensity' => 1 }
        },
        'uv' => { 'repeatU' => 2, 'repeatV' => 4, 'rot' => 0, 'offsetU' => 0, 'offsetV' => 0 }
      }
      msg = safe('创建材质不报错') { B.execute({ 'mode' => 'material', 'payload' => spec }) }
      check('返回了中文结果', msg.to_s.include?('材质'), msg.to_s[0, 60])
      mat = model.materials[name]
      check('材质已建立', !mat.nil?, mat ? mat.name : 'nil')
      if mat
        check('基础色贴图已上', !mat.texture.nil?, mat.texture ? File.basename(mat.texture.filename) : 'nil')
        check('UV 平铺 2×4 → 尺寸 5×2.5', mat.texture &&
              (mat.texture.width - 5.0).abs < 0.2 && (mat.texture.height - 2.5).abs < 0.2,
              mat.texture ? "#{mat.texture.width.round(2)}×#{mat.texture.height.round(2)}" : 'nil')
        if pbr
          check('法线贴图已上', !mat.normal_texture.nil?)
          check('法线空间按素材设成 DirectX',
                mat.normal_style == Sketchup::Material::NORMAL_STYLE_DIRECTX, mat.normal_style.to_s)
          check('粗糙度贴图已上（单通道抽取）', !mat.roughness_texture.nil?,
                mat.roughness_texture ? File.basename(mat.roughness_texture.filename) : 'nil')
          check('AO 贴图已上', !mat.ao_texture.nil?)
          check('PBR workflow 已切换', mat.workflow == Sketchup::Material::WORKFLOW_PBR_METALLIC_ROUGHNESS,
                mat.workflow.to_s)
        else
          # 2022–2024 没有 PBR 槽：应只套基础色，并在结果里点名哪些通道没套上
          check('无 PBR 版本：材质仍建立且只有基础色', !mat.texture.nil? && mat.materialType == Sketchup::Material::MATERIAL_TEXTURED,
                mat.materialType.to_s)
          check('无 PBR 版本：结果里说明法线/粗糙/金属/AO 未套用',
                msg.to_s.include?('PBR') && msg.to_s.include?('未套用'), msg.to_s[-60, 60].to_s)
        end
        check('打了 assetmanager 标记', mat.get_attribute('assetmanager', 'mine', false) == true)
        check('写入了材质规格', mat.get_attribute('assetmanager', 'spec').to_s.include?('baseColor'))
        check('透明度被明确告知不支持', msg.to_s.include?('透明度'), msg.to_s[-40, 40].to_s)
      end

      # 原地重建：再次发送不应产生 .001
      before = model.materials.map(&:name)
      safe('重复发送同素材') { B.execute({ 'mode' => 'material', 'payload' => spec }) }
      after = model.materials.map(&:name)
      check('原地重建（材质总数不变）', before.length == after.length, "#{before.length} → #{after.length}")
      check('没有产生 .001', after.grep(/#{Regexp.escape(name)}\.\d{3}/).empty?)
      check('同名材质只有一个', after.count(name) == 1)

      # 用户同名材质不被覆盖
      user_mat = model.materials.add("#{name}_USER")
      user_mat.color = Sketchup::Color.new(255, 0, 0)
      spec2 = spec.merge('name' => "#{name}_USER")
      safe('发送与用户同名材质') { B.execute({ 'mode' => 'material', 'payload' => spec2 }) }
      check('用户同名材质未被覆盖', model.materials["#{name}_USER"] &&
            model.materials["#{name}_USER"].materialType == Sketchup::Material::MATERIAL_SOLID,
            model.materials["#{name}_USER"] ? model.materials["#{name}_USER"].materialType.to_s : 'nil')
      check('用户同名材质另起了唯一名', model.materials.map(&:name).any? { |n| n != "#{name}_USER" && n.start_with?("#{name}_USER") })

      # ---------------------------------------------------------------- 4. 贴图
      t1 = make_png(File.join(dir, 'tex_one.png'), 8, 8, [10, 200, 10])
      t2 = make_png(File.join(dir, 'tex_two.png'), 8, 8, [200, 10, 10])
      bad = write_file(File.join(dir, 'tex_bad.png'), "\x89PNG not really")
      msg = safe('发送贴图不报错') do
        B.execute({ 'mode' => 'texture', 'payload' => { 'files' => [t1, t2, bad] } })
      end
      check('贴图建成材质', model.materials['tex_one'] && model.materials['tex_two'],
            model.materials['tex_one'] ? 'ok' : 'nil')
      check('坏图被跳过并说明', msg.to_s.include?('跳过'), msg.to_s[0, 80])
      check('坏图没留空材质', model.materials['tex_bad'].nil?)
      check('当前材质切到最后一张', model.materials.current && model.materials.current.name == 'tex_two',
            model.materials.current ? model.materials.current.name : 'nil')

      # ---------------------------------------------------------------- 5. 模型导入
      # 注意：导入走 B.import_model(job, payload)（run_job 里对小文件是同步返回消息，
      # 大文件会交给一次性 timer 延后收尾；这里用小 STL 所以是同步的）
      stl = write_file(File.join(dir, 'tri.stl'),
                       "solid t\nfacet normal 0 0 1\n outer loop\n" \
                       "  vertex 0 0 0\n  vertex 100 0 0\n  vertex 0 100 0\n endloop\nendfacet\nendsolid t\n")
      cnt0 = model.entities.length
      msg = safe('导入 STL 不报错') do
        B.import_model({ 'id' => -1, 'mode' => 'import' }, { 'name' => 'tri', 'modelPath' => stl })
      end
      check('STL 导入增加了对象', model.entities.length > cnt0, "#{cnt0} → #{model.entities.length}")
      check('导入结果有中文说明', msg.to_s.include?('已导入'), msg.to_s[0, 60])

      err = begin
        B.import_model({ 'id' => -1 }, { 'name' => 'x', 'modelPath' => write_file(File.join(dir, 'x.fbx'), 'fake') })
        ''
      rescue StandardError => e
        e.message
      end
      check('FBX 给出明确不支持提示', err.include?('不支持') && err.include?('fbx'), err[0, 80])
      check('不支持模式返回错误', begin
        B.execute({ 'mode' => 'pack', 'payload' => {} }); false
      rescue StandardError => e
        e.message.include?('不支持的任务类型')
      end)

      # ---------------------------------------------------------------- 6. HDRI（无样本则跳过）
      hdr = ENV['AM_TEST_HDRI'].to_s
      hdr = 'F:/02AssetLibrary/Asset/04_HDRI/Outdoor/Outdoor_Day_4k_002/Outdoor_Day_4k_002_Environment.exr' if hdr.empty?
      if File.exist?(hdr) && !env
        # 2022–2024 没有 environments：应给出明确提示而不是崩
        err = begin
          B.execute({ 'mode' => 'hdri', 'payload' => { 'name' => 'AM_TEST_ENV', 'files' => [hdr] } })
          ''
        rescue StandardError => e
          e.message
        end
        check('无环境支持的版本：HDRI 给出明确提示',
              err.include?('环境') && err.include?('2025'), err[0, 90])
      elsif File.exist?(hdr)
        before_count = model.environments.length
        msg = safe('应用 HDRI 不报错') do
          B.execute({ 'mode' => 'hdri', 'payload' => { 'name' => 'AM_TEST_ENV', 'files' => [hdr] } })
        end
        after_first = model.environments.length
        envs = model.environments
        cur = envs.current
        check('HDRI 成为当前环境', !cur.nil?, cur ? cur.name : 'nil')
        check('当前环境就是这块 HDRI',
              cur && File.basename(cur.path.to_s).downcase == File.basename(hdr).downcase,
              cur ? File.basename(cur.path.to_s) : 'nil')
        check('HDRI 天空盒 + 反射都开', cur && cur.use_as_skydome? && cur.use_for_reflections?,
              cur ? "#{cur.use_as_skydome?}/#{cur.use_for_reflections?}" : 'nil')
        check('HDRI 结果有说明', msg.to_s.include?('HDRI'), msg.to_s[0, 60])
        check('HDRI 最多新增一个环境', after_first - before_count <= 1, "#{before_count} → #{after_first}")
        # 再发一次同一个文件：应复用，不该再多一份
        safe('重复应用同一个 HDRI') do
          B.execute({ 'mode' => 'hdri', 'payload' => { 'name' => 'AM_TEST_ENV', 'files' => [hdr] } })
        end
        check('HDRI 重复发送不重复添加环境',
              model.environments.length == after_first,
              "#{after_first} → #{model.environments.length}")
      else
        puts '[SKIP] HDRI 用例（没有样本文件，可设 AM_TEST_HDRI 指定）'
      end

      # ---------------------------------------------------------------- 7. 面板 / 端口
      check('状态 payload 结构完整',
            %i[version series sketchup connected port queued events pbr env import].all? { |k| B.status_payload.key?(k) })
      check('面板 HTML 有 JS 钩子', B.dialog_html.include?('amStatus') && B.dialog_html.include?('am_cmd'))
      check('面板 HTML 是中文', B.dialog_html.include?('已连接') || B.dialog_html.include?('未连接'))

      # ---------------------------------------------------------------- 清理测试造出来的东西
      if env
        begin
          envs = model.environments
          keep = envs.to_a.find { |e| !e.name.to_s.start_with?('AM_TEST') }
          envs.current = keep if keep
          envs.to_a.each { |e| envs.remove(e) if e.name.to_s.start_with?('AM_TEST') }
        rescue StandardError
          nil
        end
      end
      begin
        model.materials.to_a.each do |mm|
          next unless mm.name.to_s.start_with?('AM_TEST') || %w[tex_one tex_two tex_bad].include?(mm.name)
          model.materials.remove(mm)
        end
      rescue StandardError
        nil
      end

      # ---------------------------------------------------------------- 汇总
      pass = @results.count { |r| r[:ok] }
      puts ''
      puts "=== AssetManager SketchUp 插件测试：通过 #{pass} / 共 #{@results.length} ==="
      @results.reject { |r| r[:ok] }.each { |r| puts "  FAIL: #{r[:name]} — #{r[:detail]}" }
      { pass: pass, total: @results.length, failed: @results.reject { |r| r[:ok] }.map { |r| r[:name] } }
    end
  end
end

AMSuTest.run
