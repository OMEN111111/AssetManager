# encoding: utf-8
# AssetManager · SketchUp 桥接插件 · 2026 系列（实现主体）
#
# 协议与 3ds Max / Blender 插件一致：
#   后台线程轮询 http://127.0.0.1:<port>/api/bridge/su/next
#   每 5 秒 POST /api/bridge/su/heartbeat 上报版本
#   任务在 SketchUp 主线程（UI.start_timer）里执行，结果 POST /api/bridge/su/result
#   SketchUp 的 API 不能在非主线程改模型，所以「线程只取任务、主线程干活」是硬约束。
#
# 能做的事（插件 0.1.0）：
#   import    模型导入（SketchUp 支持的格式；没有材质的模型用素材基础色贴图兜底）
#   material  用 SketchUp 原生 PBR 材质重建（baseColor / roughness / metallic / normal / AO）
#   texture   每张贴图建一个材质（命名=文件名），供油漆桶直接使用
#   hdri      把 HDRI 装进 SketchUp 的「环境」（天空盒 + 反射）
#
# 版本规则见 app/bridge/su/README.md：插件版本独立编号，只递增第三位。

require 'sketchup.rb'
require 'json'
require 'net/http'
require 'fileutils'
require 'tmpdir'

module AssetManager
  module Bridge
    TARGET = 'su'
    DEFAULT_PORT = 8787
    PORT_MIN = 8787
    PORT_MAX = 8805
    POLL_INTERVAL = 0.8
    HEARTBEAT_INTERVAL = 5.0
    LOCATOR_INTERVAL = 5.0

    VERSION = (defined?(AssetManager::AM_PLUGIN_VERSION) ? AssetManager::AM_PLUGIN_VERSION : '0.1.0').dup.freeze
    SERIES  = (defined?(AssetManager::AM_SERIES) ? AssetManager::AM_SERIES : '2026').dup.freeze
    SU_VERSION = Sketchup.version.to_s

    # ---------------------------------------------------------------- 各版本能力探测
    # SketchUp 2022 / 2023 / 2024 没有 PBR 材质槽，也没有「环境」（environments）；
    # 2025 起才有。2022 / 2023 还缺 GLB / GLTF / TRB / USDZ 导入器。
    # 各系列共用同一份实现，差异全部在这里按「有没有这个方法 / 有没有这个导入器」判断。
    #
    # **必须在主线程探测并缓存**：心跳在后台线程里发，而 `Sketchup.active_model` /
    # `Sketchup.find_support_file` 都是 SketchUp API，后台线程调用会抛异常
    # （2024 / 2025 实测：心跳永远发不出去 → 界面「刚连上几秒就断开」）。
    # 现在 `detect_caps!` 只在主线程（pump_once / 面板）里调，心跳只读 `caps` 里的缓存。
    IMPORT_EXT_BY_DLL = {
      '.skp' => nil, '.dae' => 'daeimporter', '.dwg' => 'dwgimporter', '.dxf' => 'dwgimporter',
      '.3ds' => '3dsimporter', '.ifc' => 'ifcimporter', '.kmz' => 'kmzimporter',
      '.stl' => 'stlimporter', '.glb' => 'glbimporter', '.gltf' => 'glbimporter',
      '.usdz' => 'usdzimporter', '.trb' => 'trbimporter'
    }.freeze

    SUPPORTED_IMPORT = %w[.skp .dae .dwg .dxf .3ds .glb .gltf .stl .ifc .kmz .usdz .trb].freeze

    # 兜底：还没探测过时按「保守」报（不调任何 SketchUp API，任何线程都安全）
    CAPS_FALLBACK = { pbr: false, env: false, glb: false, import: SUPPORTED_IMPORT, importers_dir: nil }.freeze

    # 主线程用：能力缓存过期（没算过 / 换了模型）就重探一次
    def self.ensure_caps!
      model = begin
        Sketchup.active_model
      rescue StandardError
        nil
      end
      key = model ? model.object_id : nil
      return if @caps && @caps_key == key
      @caps_key = key
      detect_caps!
    end

    def self.caps
      @caps || CAPS_FALLBACK
    end

    def self.pbr?
      caps[:pbr]
    end

    def self.env?
      caps[:env]
    end

    def self.importers_dir
      caps[:importers_dir]
    end

    def self.importer_present?(dll)
      return true if dll.nil?
      dir = caps[:importers_dir]
      return true if dir.nil? # 探不到安装目录就按支持处理，别把能用的格式藏起来
      File.exist?(File.join(dir, "#{dll}.dll")) || File.exist?(File.join(dir, "#{dll}.so"))
    end

    # 本版本实际能吃哪些扩展名
    def self.supported_import_exts
      caps[:import]
    end

    # **只在主线程调用**（pump_once / 面板 / 菜单）。探测结果缓存进 @caps。
    def self.detect_caps!
      dir = begin
        d = Sketchup.find_support_file('Importers')
        (d.is_a?(String) && File.directory?(d)) ? d : nil
      rescue StandardError
        nil
      end
      model = begin
        Sketchup.active_model
      rescue StandardError
        nil
      end
      exts = IMPORT_EXT_BY_DLL.select do |_ext, dll|
        dll.nil? || dir.nil? ||
          File.exist?(File.join(dir, "#{dll}.dll")) || File.exist?(File.join(dir, "#{dll}.so"))
      end.keys.freeze
      @caps = {
        pbr: begin
          Sketchup::Material.instance_methods.include?(:metallic_texture=)
        rescue StandardError
          false
        end,
        env: begin
          model ? model.respond_to?(:environments) : false
        rescue StandardError
          false
        end,
        glb: !dir.nil? && File.exist?(File.join(dir, 'glbimporter.dll')),
        import: exts,
        importers_dir: dir
      }.freeze
    rescue StandardError
      @caps = CAPS_FALLBACK
    end
    TEXTURE_EXT = %w[.png .jpg .jpeg .bmp .tif .tiff .psd].freeze
    HDR_EXT = %w[.hdr .exr].freeze
    MAP_MAX_PX = 1024 # 通道抽取时的最大边长（越大越慢，1024 够用）

    MAP_LABEL = {
      'baseColor' => '基础色', 'normal' => '法线', 'roughness' => '粗糙度',
      'metallic' => '金属度', 'ao' => '环境光遮蔽', 'opacity' => '透明度',
      'emissive' => '自发光', 'height' => '高度'
    }.freeze

    @state = {
      connected: false, port: DEFAULT_PORT, last: '', job: '', error: '',
      events: [], thread: nil, stop: false, dialog: nil, enabled: true, last_hb_at: 0.0
    }
    @jobs = Queue.new
    @timer_on = false

    class << self
      attr_reader :state

      # ------------------------------------------------------------ 事件日志

      def event(text, kind = :info)
        st = @state[:events]
        st << { at: Time.now.strftime('%H:%M:%S'), text: text.to_s[0, 180], kind: kind.to_s }
        st.shift while st.length > 8
        puts "[AssetManager] #{text}"
        # 排查用：设环境变量 AM_SU_LOG=1 后把事件写进 %TEMP%\am-su-debug.log
        if ENV['AM_SU_LOG'].to_s != ''
          begin
            File.open(File.join(ENV['TEMP'] || '.', 'am-su-debug.log'), 'a') do |f|
              f.write("#{Time.now.strftime('%H:%M:%S')} [#{Thread.current.object_id}] #{kind}: #{text}\n")
            end
          rescue StandardError
            nil
          end
        end
      rescue StandardError
        nil
      end

      # ------------------------------------------------------------ 基础 HTTP

      def http(port, path, data = nil, timeout = 4)
        # 第三个参数传 nil：不要走系统 http_proxy（本机回环代理会把请求吃掉）
        h = Net::HTTP.new('127.0.0.1', port.to_i, nil)
        h.open_timeout = timeout
        h.read_timeout = timeout
        req = if data
                r = Net::HTTP::Post.new(path, 'Content-Type' => 'application/json')
                r.body = JSON.generate(data)
                r
              else
                Net::HTTP::Get.new(path)
              end
        req['User-Agent'] = "AssetManager-SketchUp/#{VERSION} (#{SERIES})"
        res = h.request(req)
        return nil if res.code.to_i == 204
        body = res.body.to_s
        body.empty? ? nil : JSON.parse(body)
      end

      # 心跳内容（后台线程与主线程共用；只读 caps 缓存，不调 SketchUp API）
      def heartbeat_body
        {
          'version' => VERSION,
          'plugin' => VERSION,
          'series' => SERIES,
          'sketchup' => SU_VERSION,
          'host' => ENV['COMPUTERNAME'].to_s,
          'info' => { 'plugin' => VERSION, 'series' => SERIES, 'sketchup' => SU_VERSION,
                      'pbr' => pbr?, 'env' => env?, 'glb' => importer_present?('glbimporter'),
                      'import' => supported_import_exts }
        }
      end

      # 主线程兜底心跳
      #
      # SketchUp 2024 / 2025 上后台线程会被严重节流（实测心跳 30–40 秒才轮到一次，
      # 服务端 15 秒就判离线 → 界面「刚连上几秒就断开」）。主线程的 UI.start_timer 不受影响，
      # 所以在这里按需补发一次心跳；后台线程正常时它什么都不做。
      def main_heartbeat_if_stale
        port = @state[:port].to_i
        return if port <= 0
        return if @state[:stop] # 用户点了「暂停」就不再发心跳
        return if Time.now.to_f - @state[:last_hb_at].to_f < 6.0
        begin
          http(port, "/api/bridge/#{TARGET}/heartbeat", heartbeat_body, 1.5)
          @state[:last_hb_at] = Time.now.to_f
          unless @state[:connected]
            @state[:connected] = true
            @state[:error] = ''
            event("已连接 AssetManager（端口 #{port}）", :ok)
          end
        rescue StandardError => e
          # 先记时间再报错：否则主线程每 0.3 秒重试一次，界面会一直卡在 1.5 秒超时上
          @state[:last_hb_at] = Time.now.to_f
          if @state[:connected]
            @state[:connected] = false
            @state[:error] = e.message.to_s
            event("与 AssetManager 断开：#{e.message}", :err)
          end
        end
      end
      def locator_port
        base = ENV['LOCALAPPDATA'] || Dir.home
        path = File.join(base, 'AssetManager', 'bridge.json')
        return nil unless File.exist?(path)
        port = (JSON.parse(File.read(path))['port'] || 0).to_i
        return nil if port <= 0
        st = http(port, '/api/state', nil, 0.6)
        st.is_a?(Hash) && st.key?('appRoot') ? port : nil
      rescue StandardError
        nil
      end

      def detect_port
        found = locator_port
        return found if found
        (PORT_MIN..PORT_MAX).each do |port|
          begin
            st = http(port, '/api/state', nil, 0.3)
            return port if st.is_a?(Hash) && st.key?('appRoot')
          rescue StandardError
            next
          end
        end
        nil
      end

      def follow_locator
        found = locator_port
        return false unless found && found != @state[:port]
        event("端口跟随到 #{found}（软件换端口了）")
        @state[:port] = found
        true
      end

      # ------------------------------------------------------------ 后台轮询线程

      def worker
        last_hb = 0.0
        last_watch = Time.now.to_f
        idle = 0
        until @state[:stop]
          if Time.now.to_f - last_watch > LOCATOR_INTERVAL
            last_watch = Time.now.to_f
            begin
              last_hb = 0.0 if follow_locator
            rescue StandardError
              nil
            end
          end

          port = @state[:port]
          if Time.now.to_f - last_hb > HEARTBEAT_INTERVAL
            begin
              http(port, "/api/bridge/#{TARGET}/heartbeat", heartbeat_body)
              event("已连接 AssetManager（端口 #{port}）", :ok) unless @state[:connected]
              @state[:connected] = true
              @state[:error] = ''
              last_hb = Time.now.to_f
              @state[:last_hb_at] = last_hb
            rescue StandardError => e
              event("与 AssetManager 断开：#{e.message}", :err) if @state[:connected]
              @state[:connected] = false
              @state[:error] = e.message.to_s
              found = detect_port
              if found && found != port
                @state[:port] = found
                event("端口已切换到 #{found}")
              end
              last_hb = 0.0
              sleep 2.0
              next
            end
          end

          begin
            job = http(port, "/api/bridge/#{TARGET}/next")
            if job.is_a?(Hash)
              @state[:job] = job['title'] || job['mode'].to_s
              @jobs << job
              idle = 0
            else
              idle += 1
            end
          rescue StandardError => e
            @state[:connected] = false
            @state[:error] = e.message.to_s
            idle += 1
          end

          # 空闲久了放慢轮询，有活儿立刻恢复
          sleep(idle < 20 ? POLL_INTERVAL : 2.0)
        end
      rescue StandardError => e
        event("取任务线程异常：#{e.class}: #{e.message}", :err)
        if ENV['AM_SU_LOG'].to_s != ''
          begin
            File.open(File.join(ENV['TEMP'] || '.', 'am-su-debug.log'), 'a') do |f|
              f.write("#{Time.now.strftime('%H:%M:%S')} WORKER DEAD #{e.class}: #{e.message}\n")
              Array(e.backtrace).first(12).each { |l| f.write("    #{l}\n") }
            end
          rescue StandardError
            nil
          end
        end
      end

      def start_loop
        return if @state[:thread] && @state[:thread].alive?
        @state[:stop] = false
        @state[:thread] = Thread.new { worker }
        ensure_timer
      end

      def stop_loop
        @state[:stop] = true
        @state[:thread] = nil
        @state[:connected] = false
        @state[:job] = ''
        begin
          @jobs.clear
        rescue StandardError
          nil
        end
      end

      def reconnect
        port = detect_port
        @state[:port] = port if port
        @state[:stop] = true
        @state[:thread] = nil
        sleep 0.1
        start_loop
        event(port ? "已重连（端口 #{port}）" : '没找到 AssetManager 服务（先启动软件）', port ? :ok : :err)
        refresh_dialog
        port
      end

      # ------------------------------------------------------------ 主线程执行

      def ensure_timer
        return if @timer_on
        UI.start_timer(0.3, true) { pump }
        @timer_on = true
      rescue StandardError => e
        event("定时器启动失败：#{e.message}", :err)
        @timer_on = false
      end

      def pump
        ensure_caps!        # 主线程探测能力（换了模型时重探，比如新开/切换文档后 environments 才有）
        main_heartbeat_if_stale # 后台线程被节流时由主线程补心跳（2024/2025 必需）
        loop do
          job = begin
            @jobs.pop(true)
          rescue StandardError
            nil
          end
          break unless job

          run_job(job)
        end
        refresh_dialog if @state[:dialog]
      rescue StandardError => e
        event("执行循环异常：#{e.class}: #{e.message}", :err)
      end

      def run_job(job)
        @state[:job] = job['title'] || job['mode'].to_s
        ok = true
        msg = ''
        deferred = false
        begin
          # 导入要特殊处理：SketchUp 的 glTF 导入可能在本回调返回之后才把实例落进模型，
          # 所以数量统计与结果回传交给一次性 timer（见 import_model）
          if job['mode'].to_s == 'import'
            r = import_model(job, job['payload'] || {})
            if r.is_a?(Hash) && r[:deferred]
              deferred = true
            else
              msg = r.to_s
            end
          else
            msg = execute(job)
          end
        rescue StandardError => e
          ok = false
          msg = e.message.to_s
          msg = e.class.to_s if msg.strip.empty?
          @state[:error] = Array(e.backtrace).first(5).join("\n")
          puts "[AssetManager] 任务失败：#{e.class}: #{e.message}\n#{Array(e.backtrace).first(6).join("\n")}"
        end
        return if deferred
        report(job, ok, msg)
      end

      def report(job, ok, msg)
        begin
          http(@state[:port], "/api/bridge/#{TARGET}/result", {
                 'id' => job['id'], 'ok' => ok, 'message' => msg.to_s,
                 'detail' => { 'plugin' => VERSION, 'series' => SERIES, 'sketchup' => SU_VERSION }
               })
        rescue StandardError
          nil
        end
        @state[:last] = (ok ? 'OK ' : '失败 ') + msg.to_s
        event(@state[:last], ok ? :ok : :err)
        @state[:job] = ''
      end

      def execute(job)
        mode = job['mode'].to_s
        payload = job['payload'] || {}
        case mode
        when 'material' then apply_material(payload)
        when 'texture' then receive_textures(payload)
        when 'hdri' then apply_hdri(payload)
        else
          raise "不支持的任务类型：#{mode}（本插件支持 import / material / texture / hdri）"
        end
      end

      # ------------------------------------------------------------ 任务：导入模型

      def import_model(job, payload)
        model = Sketchup.active_model
        raise '没有打开的 SketchUp 模型' unless model

        path = payload['modelPath'].to_s
        raise '这个素材没有模型文件' if path.empty?
        raise "找不到模型文件：#{path}" unless File.exist?(path)

        ext = File.extname(path).downcase
        exts = supported_import_exts
        unless exts.include?(ext)
          hint = if %w[.glb .gltf].include?(ext) && importer_present?('glbimporter') == false
                   "SketchUp #{SU_VERSION} 没有 GLB/GLTF 导入器（2024 起才有）：请把素材换成 DAE/STL/SKP 版本，" \
                   '或升级到 SketchUp 2024 及以上再发送。'
                 else
                   'FBX/OBJ 不是 SketchUp 能直接读的格式：请发 GLB/DAE/STL 版本的模型，' \
                   '或者先用 Blender / 3ds Max 桥接打开再另存。'
                 end
          raise "SketchUp #{SU_VERSION} 不支持 #{ext.delete('.')} 导入" \
                "（本版本自带：#{exts.map { |e| e.delete('.') }.join('/')}）。#{hint}"
        end

        name = (payload['name'] || File.basename(path, ext)).to_s
        before = {}
        model.entities.each { |e| before[e.entityID] = true }
        t0 = Time.now
        Sketchup.status_text = "AssetManager：正在导入 #{name}…"

        model.start_operation("AssetManager 导入 #{name}", true)
        ok = false
        begin
          ok = model.import(path, { show_summary: false })
        rescue StandardError => e
          model.abort_operation
          raise "SketchUp 导入失败：#{e.message}"
        end
        unless ok
          model.abort_operation
          raise "SketchUp 导入失败（#{ext}）：文件可能损坏或版本过高"
        end
        model.commit_operation

        # 小文件当场就能数到；大文件（glTF）往往要等 SketchUp 回到事件循环才落地，
        # 这里先数一次，数不到就把「数 + 兜底贴图 + 回传结果」交给一次性 timer
        added = new_since(model, before)
        secs = (Time.now - t0).round(1)
        if added.size.to_i.zero?
          wait_and_finish_import(job, name, ext, before, t0, payload)
          return { deferred: true }
        end

        textured = false
        begin
          model.start_operation('AssetManager 导入贴图', true)
          textured = assign_fallback_material(added, payload)
          model.commit_operation
        rescue StandardError
          textured = false
        end
        Sketchup.status_text = ''
        msg = "已导入 #{name}（#{added.size.to_i} 个对象 · #{secs}s）"
        msg += '，无材质的面已套用素材的基础色贴图' if textured
        msg
      end

      # 导入之后延后收尾：等 SketchUp 把实例落进模型，再数对象、套兜底贴图、回传结果
      def wait_and_finish_import(job, name, ext, before, t0, payload)
        model = Sketchup.active_model
        tries = 0
        tick = nil
        tick = proc do
          tries += 1
          added = model ? new_since(model, before) : []
          if added.size.to_i.zero? && tries < 100 # 最多等约 10 秒
            UI.start_timer(0.1, false) { tick.call }
            next
          end
          secs = (Time.now - t0).round(1)
          Sketchup.status_text = ''
          textured = false
          if added.size.to_i.positive?
            begin
              model.start_operation('AssetManager 导入贴图', true)
              textured = assign_fallback_material(added, payload)
              model.commit_operation
            rescue StandardError
              textured = false
            end
          end
          n = added.size.to_i
          # 一个对象都没进来就是失败（以前一律报成功，DAE 空导入会被当成"还在后台完成"骗过去）
          msg = if n.zero?
                  "SketchUp 没有导入任何对象（#{ext}）：#{import_hint(ext)}"
                else
                  "已导入 #{name}（#{n} 个对象 · #{secs}s）"
                end
          msg += '，无材质的面已套用素材的基础色贴图' if textured
          report(job, n.positive?, msg)
          refresh_dialog if @state[:dialog]
        rescue StandardError => e
          report(job, false, "导入收尾失败：#{e.message}")
        end
        UI.start_timer(0.4, false) { tick.call }
      end

      # 导入失败/空导入时给用户看的原因与下一步
      def import_hint(ext)
        case ext.to_s.downcase
        when '.dae'
          '本机 SketchUp 的 DAE 导入器不稳定（实测 2022 连它自己导出的 DAE 都会空导入或崩溃）。' \
          '请改用 STL / SKP 版本的素材，或升级到 SketchUp 2024 及以上（那边走 GLB，实测正常）。'
        when '.glb', '.gltf'
          'GLB 文件可能损坏，或 SketchUp 导入器中途失败；可先在本机用其他软件打开确认文件完好。'
        else
          '文件可能损坏，或格式版本高于当前 SketchUp 能读的范围。'
        end
      end

      def new_since(model, before)
        out = []
        model.entities.each { |e| out << e unless before[e.entityID] }
        out
      end

      def all_faces(entities)
        out = []
        seen = {}
        stack = entities.to_a
        until stack.empty?
          e = stack.pop
          begin
            if e.is_a?(Sketchup::Face)
              out << e
            elsif e.is_a?(Sketchup::Group)
              stack.concat(e.entities.to_a)
            elsif e.is_a?(Sketchup::ComponentInstance)
              d = e.definition
              next if d.nil? || seen[d.entityID]
              seen[d.entityID] = true
              stack.concat(d.entities.to_a)
            end
          rescue StandardError
            next
          end
        end
        out
      end

      # 导入进来的几何往往没有材质：用素材的基础色贴图兜底（只改没材质的面）
      def assign_fallback_material(added, payload)
        spec = payload['material']
        return false unless spec.is_a?(Hash)
        maps = spec['maps'] || {}
        return false unless maps['baseColor']

        bare = all_faces(added).reject(&:material)
        return false if bare.empty?

        mat = build_material(spec)
        return false unless mat

        bare.each { |f| f.material = mat }
        true
      rescue StandardError => e
        puts "[AssetManager] 兜底贴图跳过：#{e.message}"
        false
      end

      # ------------------------------------------------------------ 任务：创建材质

      def apply_material(payload)
        model = Sketchup.active_model
        raise '没有打开的 SketchUp 模型' unless model

        maps = payload['maps'] || {}
        raise '这个材质没有可用的贴图' if maps.empty?

        mat, notes = build_material(payload)
        raise '材质创建失败' unless mat

        model.materials.current = mat
        msg = "材质「#{mat.name}」已就绪（#{maps.keys.map { |k| MAP_LABEL[k] || k }.join(' / ')}），已设为当前材质"
        msg += "；#{notes.join('；')}" unless notes.empty?
        msg
      end

      def ours?(mat)
        mat && (mat.get_attribute('assetmanager', 'mine', false) == true)
      end

      # 同名材质原地重建（不堆 .001），用户自己的同名材质不覆盖
      def material_slot(name)
        model = Sketchup.active_model
        base = name.to_s.strip
        base = 'AssetManager 材质' if base.empty?
        mat = model.materials[base]
        if mat && !ours?(mat)
          base = model.materials.unique_name(base)
          mat = nil
        end
        mat ||= model.materials.add(base)
        mat
      end

      def build_material(spec)
        model = Sketchup.active_model
        maps = spec['maps'] || {}
        mat = material_slot(spec['name'])
        notes = []
        mat.set_attribute('assetmanager', 'mine', true)

        # 基础色（SketchUp 一张材质只有一张「贴图」）
        if (e = maps['baseColor'])
          p = prepare_map(e, notes, 'baseColor')
          mat.texture = p if p
        end
        # PBR 槽（法线 / 粗糙度 / 金属度 / AO）只有 SketchUp 2025 起才有；
        # 2022–2024 只套基础色，其余通道在结果里说清楚
        if pbr?
          # 法线：normal_style 决定 GL/DX（SketchUp 默认 DIRECTX）
          if (e = maps['normal'])
            p = prepare_map(e, notes, 'normal')
            if p
              mat.normal_texture = p
              mat.normal_style = (e['normalSpace'].to_s == 'gl' ? Sketchup::Material::NORMAL_STYLE_OPENGL : Sketchup::Material::NORMAL_STYLE_DIRECTX)
              s = (e['intensity'] || 1).to_f
              mat.normal_scale = (s.zero? ? 1.0 : s) rescue nil
            end
          end
          # 粗糙度 / 金属度 / AO：单通道贴图，通道抽取后塞进 SketchUp 的原生 PBR 槽
          if (e = maps['roughness'])
            p = prepare_map(e, notes, 'roughness')
            if p
              mat.roughness_texture = p
              k = (e['intensity'] || 1).to_f
              mat.roughness_factor = (k > 1.0 ? 1.0 : k) rescue nil
            end
          end
          if (e = maps['metallic'])
            p = prepare_map(e, notes, 'metallic')
            if p
              mat.metallic_texture = p
              k = (e['intensity'] || 1).to_f
              mat.metallic_factor = (k > 1.0 ? 1.0 : k) rescue nil
            end
          end
          if (e = maps['ao'])
            p = prepare_map(e, notes, 'ao')
            if p
              mat.ao_texture = p
              mat.ao_strength = (e['intensity'] || 1).to_f rescue nil
            end
          end
        else
          dropped = %w[normal roughness metallic ao].select { |k| maps[k] }
          unless dropped.empty?
            notes << "本版本 SketchUp（#{SU_VERSION}）没有 PBR 材质槽，" \
                     "#{dropped.map { |k| MAP_LABEL[k] || k }.join('/')} 未套用（需要 2025 及以上）"
          end
        end
        # SketchUp 材质没有的槽：只提示，不假装做了
        unsupported = %w[opacity emissive height].select { |k| maps[k] }
        unless unsupported.empty?
          notes << "SketchUp 材质无 #{unsupported.map { |k| MAP_LABEL[k] || k }.join('/')} 通道（贴图路径已记在材质属性里）"
        end

        apply_uv(mat, spec['uv'], notes)

        begin
          mat.set_attribute('assetmanager', 'spec', JSON.generate(spec))
          mat.set_attribute('assetmanager', 'assetId', spec['assetId'].to_i)
          mat.set_attribute('assetmanager', 'assetName', spec['assetName'] || spec['name'].to_s)
          mat.set_attribute('assetmanager', 'appliedAt', Time.now.to_s)
        rescue StandardError
          nil
        end
        [mat, notes]
      end

      def apply_uv(mat, uv, notes)
        return unless uv.is_a?(Hash) && mat.texture
        ru = (uv['repeatU'] || 1).to_f
        rv = (uv['repeatV'] || 1).to_f
        ru = 1.0 if ru <= 0
        rv = 1.0 if rv <= 0
        # SketchUp 的贴图尺寸单位是英寸，默认 10×10；重复 N 次 = 尺寸除以 N
        if (ru - 1.0).abs > 0.001 || (rv - 1.0).abs > 0.001
          mat.texture.size = [10.0 / ru, 10.0 / rv]
        end
        rot = (uv['rot'] || 0).to_f
        if rot != 0.0 || (uv['offsetU'] || 0).to_f != 0.0 || (uv['offsetV'] || 0).to_f != 0.0
          notes << 'UV 旋转/偏移 SketchUp 材质不支持（只做了平铺次数）'
        end
      rescue StandardError => e
        notes << "UV 设置失败：#{e.message}"
      end

      # 单通道贴图 → 抽成灰度 PNG（缓存到临时目录），顺手把强度/反相烘进去
      def prepare_map(entry, notes, key)
        path = entry['path'].to_s
        return nil if path.empty? || !File.exist?(path)

        ch = (entry['channel'] || 'rgb').to_s
        invert = entry['invert'] ? true : false
        intensity = (entry['intensity'] || 1).to_f
        plain = %w[rgb].include?(ch) || ch.empty?

        if plain
          unless (intensity - 1.0).abs < 0.001 && !invert
            notes << "#{MAP_LABEL[key] || key}：整图贴图不做强度/反相处理"
          end
          return path
        end

        notes << "#{MAP_LABEL[key] || key}：已从打包图抽取 #{ch.upcase} 通道" if %w[r g b].include?(ch)
        dst = channel_cache_path(path, ch, invert, intensity)
        return dst if File.exist?(dst)

        extract_channel(path, ch, invert, intensity, dst)
        File.exist?(dst) ? dst : path
      rescue StandardError => e
        notes << "#{MAP_LABEL[key] || key}：通道处理失败（用原图）— #{e.message}"
        path
      end

      def channel_cache_path(path, ch, invert, intensity)
        dir = File.join(Dir.tmpdir, 'AssetManager', 'su_maps')
        FileUtils.mkdir_p(dir) unless File.directory?(dir)
        key = "#{path}|#{File.mtime(path).to_i}|#{ch}|#{invert}|#{(intensity * 100).round}"
        digest = begin
          require 'digest'
          Digest::MD5.hexdigest(key)
        rescue LoadError, StandardError
          key.hash.abs.to_s(36)
        end
        File.join(dir, "#{digest}.png")
      end

      def extract_channel(path, ch, invert, intensity, dst)
        src = Sketchup::ImageRep.new
        src.load_file(path)
        sw = src.width.to_i
        sh = src.height.to_i
        raise '图片读不出来' if sw <= 0 || sh <= 0

        scale = [MAP_MAX_PX.to_f / [sw, sh].max, 1.0].min
        w = [(sw * scale).round, 1].max
        h = [(sh * scale).round, 1].max
        idx = { 'r' => 0, 'g' => 1, 'b' => 2, 'a' => 3 }[ch] || 0

        buf = Array.new(w * h * 3)
        i = 0
        h.times do |y|
          v = (y + 0.5) / h
          w.times do |x|
            u = (x + 0.5) / w
            val = src.color_at_uv(u, v).to_a[idx].to_i
            val = 255 - val if invert
            val = (val * intensity).round
            val = 0 if val < 0
            val = 255 if val > 255
            buf[i] = val
            buf[i + 1] = val
            buf[i + 2] = val
            i += 3
          end
        end
        out = Sketchup::ImageRep.new
        out.set_data(w, h, 24, 0, buf.pack('C*'))
        out.save_file(dst)
      end

      # ------------------------------------------------------------ 任务：发送贴图

      def receive_textures(payload)
        model = Sketchup.active_model
        raise '没有打开的 SketchUp 模型' unless model
        files = Array(payload['files'])
        raise '这个素材没有贴图文件' if files.empty?

        made = []
        skipped = []
        files.each do |f|
          f = f.to_s
          ext = File.extname(f).downcase
          unless TEXTURE_EXT.include?(ext)
            skipped << "#{File.basename(f)}（SketchUp 贴图不支持 #{ext.delete('.')}）"
            next
          end
          name = File.basename(f, ext)
          begin
            existed = !model.materials[name].nil?
            mat = material_slot(name)
            mat.texture = f
            if mat.texture.nil?
              # 读不出来就把它撤回，别在材质面板里留空壳
              model.materials.remove(mat) unless existed
              skipped << "#{File.basename(f)}（读取失败）"
              next
            end
            mat.set_attribute('assetmanager', 'mine', true)
            made << mat.name
          rescue StandardError => e
            skipped << "#{File.basename(f)}（#{e.message}）"
          end
        end

        raise "全部失败：#{skipped.join('；')}" if made.empty?
        model.materials.current = model.materials[made.last] if made.last
        msg = "已建 #{made.length} 个材质：#{made.join(', ')}"
        msg += "；跳过 #{skipped.join('；')}" unless skipped.empty?
        msg
      end

      # ------------------------------------------------------------ 任务：HDRI / 环境

      def apply_hdri(payload)
        model = Sketchup.active_model
        raise '没有打开的 SketchUp 模型' unless model
        unless env?
          raise "SketchUp #{SU_VERSION} 没有「环境」（environments），不能应用 HDRI —— " \
                '这个功能需要 SketchUp 2025 及以上。当前版本可继续用模型 / 材质 / 贴图。'
        end
        files = Array(payload['files']).map(&:to_s)
        hdr = files.find { |f| HDR_EXT.include?(File.extname(f).downcase) && File.exist?(f) }
        raise 'SketchUp 的环境只认 .hdr / .exr，这个素材里没有' unless hdr
        name = (payload['name'] || File.basename(hdr, File.extname(hdr))).to_s

        envs = model.environments
        # environments.add 每次都新建一个（同一个文件会堆出好几份），先按文件名找现成的复用
        base = File.basename(hdr).downcase
        existing = nil
        begin
          envs.each { |e| existing = e if File.basename(e.path.to_s).downcase == base }
        rescue StandardError
          existing = nil
        end
        env = existing
        unless env
          env = begin
            # 参数形式各版本不同：2026/2027 是 add(path)；2025 是 add(name, path)
            envs.add(hdr)
          rescue ArgumentError
            begin
              envs.add(name, hdr)
            rescue StandardError => e
              raise "HDRI 载入失败：#{e.message}（SketchUp 环境只认 HDR/EXR）"
            end
          rescue StandardError => e
            raise "HDRI 载入失败：#{e.message}（SketchUp 环境只认 HDR/EXR）"
          end
        end
        begin
          env.name = name
        rescue StandardError
          nil
        end
        begin
          env.use_as_skydome = true
          env.use_for_reflections = true
        rescue StandardError
          nil
        end
        envs.current = env
        msg = "HDRI 已应用：#{name}（天空盒 + 反射，可在 环境 面板里调旋转/曝光）"
        msg += '（复用已有的同名环境，没有重复添加）' if existing
        msg
      end

      # ------------------------------------------------------------ 面板

      def status_payload
        {
          version: VERSION, series: SERIES, sketchup: SU_VERSION,
          connected: @state[:connected], port: @state[:port], error: @state[:error],
          job: @state[:job], last: @state[:last],
          pbr: pbr?, env: env?, import: supported_import_exts,
          queued: begin
            @jobs.size
          rescue StandardError
            0
          end,
          events: @state[:events].last(6).reverse
        }
      end

      # 一行能力说明（面板 / 关于对话框共用）
      def capability_summary
        parts = ['模型导入', '贴图']
        parts << (pbr? ? 'PBR 材质' : '基础色材质')
        parts << (env? ? 'HDRI 环境' : 'HDRI（需 2025+）')
        parts.join(' / ')
      end

      def show_dialog
        if @state[:dialog]
          begin
            @state[:dialog].bring_to_front
          rescue StandardError
            @state[:dialog] = nil
          end
          return @state[:dialog] if @state[:dialog]
        end
        dlg = UI::HtmlDialog.new(
          dialog_title: "AssetManager · SketchUp 桥接 v#{VERSION}",
          preferences_key: 'assetmanager_su_bridge',
          scrollable: true, resizable: true,
          width: 430, height: 540,
          style: UI::HtmlDialog::STYLE_DIALOG
        )
        dlg.set_html(dialog_html)
        dlg.add_action_callback('am_cmd') { |_ctx, arg| handle_cmd(arg) }
        begin
          dlg.set_on_closed { @state[:dialog] = nil }
        rescue StandardError
          nil
        end
        dlg.show
        @state[:dialog] = dlg
        refresh_dialog
        dlg
      end

      def refresh_dialog
        dlg = @state[:dialog]
        return unless dlg
        dlg.execute_script("amStatus(#{JSON.generate(status_payload)})")
      rescue StandardError
        nil
      end

      def handle_cmd(arg)
        case arg.to_s
        when 'reconnect' then reconnect
        when 'detect'
          p = detect_port
          if p
            @state[:port] = p
            event("探测到 AssetManager：#{p}", :ok)
            reconnect
          else
            event('没找到 AssetManager 服务（先启动软件）', :err)
          end
        when 'open_app' then UI.openURL("http://127.0.0.1:#{@state[:port]}/")
        when 'stop'
          stop_loop
          event('已停止接收任务')
        when 'start'
          start_loop
          event('已开始接收任务')
        end
        refresh_dialog
      rescue StandardError => e
        event("操作失败：#{e.message}", :err)
      end

      def dialog_html
        <<~HTML
          <!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
          <style>
            :root { color-scheme: dark; }
            body { margin:0; padding:14px 16px; background:#16181d; color:#d6dae1;
                   font:13px/1.55 "Segoe UI","Microsoft YaHei UI",sans-serif; }
            h1 { font-size:14px; margin:0 0 2px; color:#eef1f6; font-weight:600; }
            .sub { color:#7f8794; font-size:11.5px; margin-bottom:12px; }
            .card { background:#1d2027; border:1px solid #262a33; border-radius:8px;
                    padding:10px 12px; margin-bottom:10px; }
            .row { display:flex; align-items:center; gap:8px; margin:3px 0; }
            .dot { width:8px; height:8px; border-radius:50%; background:#5b6371; flex:0 0 auto; }
            .dot.on { background:#3ecf8e; box-shadow:0 0 0 3px rgba(62,207,142,.15); }
            .k { color:#8b939f; }
            .v { color:#e6eaf0; }
            .mono { font-family:Consolas,ui-monospace,monospace; }
            button { background:#232833; color:#dde2ea; border:1px solid #2f3644;
                     border-radius:6px; padding:6px 10px; font-size:12.5px; cursor:pointer; }
            button:hover { background:#2b3140; border-color:#3a4354; }
            button.primary { background:#2f6fed; border-color:#2f6fed; color:#fff; }
            button.primary:hover { background:#3d7bf5; }
            .btns { display:flex; gap:8px; flex-wrap:wrap; }
            .ev { font-size:11.5px; color:#98a0ad; display:flex; gap:8px; }
            .ev.err { color:#e3706c; } .ev.ok { color:#63c68d; }
            .ev .t { color:#5b6371; flex:0 0 auto; }
            .sec { color:#8b939f; font-size:11px; letter-spacing:.04em;
                   text-transform:uppercase; margin:0 0 6px; }
            .hint { color:#6d7583; font-size:11.5px; }
          </style></head><body>
          <h1>AssetManager 桥接</h1>
          <div class="sub" id="sub">插件 v&nbsp;·&nbsp;SketchUp</div>

          <div class="card">
            <div class="row"><span class="dot" id="dot"></span>
              <span class="v" id="conn">未连接</span>
              <span class="k mono" id="port" style="margin-left:auto"></span></div>
            <div class="row"><span class="k">队列</span><span class="v" id="queued">0</span>
              <span class="k" style="margin-left:12px">当前</span><span class="v" id="job">—</span></div>
            <div class="row" id="lastrow" style="display:none"><span class="k">最近</span>
              <span class="v" id="last">—</span></div>
          </div>

          <div class="card">
            <div class="sec">操作</div>
            <div class="btns">
              <button class="primary" onclick="amCmd('reconnect')">重连</button>
              <button onclick="amCmd('detect')">探测端口</button>
              <button onclick="amCmd('open_app')">打开 AssetManager</button>
              <button onclick="amCmd('stop')">暂停</button>
            </div>
          </div>

          <div class="card">
            <div class="sec">最近事件</div>
            <div id="events" class="hint">—</div>
          </div>

          <div class="hint">素材在 AssetManager 里右键「→ 发送到…」→ SketchUp：<br>
            #{capability_summary}。</div>

          <script>
            function amCmd(c){ if (window.sketchup && window.sketchup.am_cmd) window.sketchup.am_cmd(c); }
            function esc(s){ return String(s == null ? '' : s).replace(/[&<>]/g, function(c){
              return {'&':'&amp;','<':'&lt;','>':'&gt;'}[c]; }); }
            function amStatus(s){
              document.getElementById('sub').innerHTML =
                '插件 v' + esc(s.version) + ' · ' + esc(s.series) + ' 系列 · SketchUp ' + esc(s.sketchup);
              var dot = document.getElementById('dot');
              dot.className = 'dot' + (s.connected ? ' on' : '');
              document.getElementById('conn').textContent = s.connected ? '已连接' : '未连接';
              document.getElementById('conn').style.color = s.connected ? '#63c68d' : '#d6dae1';
              document.getElementById('port').textContent = s.port ? ('端口 ' + s.port) : '';
              document.getElementById('queued').textContent = s.queued || 0;
              document.getElementById('job').textContent = s.job || '—';
              var lr = document.getElementById('lastrow');
              if (s.last) { lr.style.display = 'flex'; document.getElementById('last').textContent = s.last; }
              else { lr.style.display = 'none'; }
              var box = document.getElementById('events');
              if (!s.events || !s.events.length) { box.textContent = '—'; }
              else {
                box.innerHTML = s.events.map(function(e){
                  return '<div class="ev ' + esc(e.kind) + '"><span class="t">' + esc(e.at) +
                         '</span><span>' + esc(e.text) + '</span></div>';
                }).join('');
              }
            }
          </script></body></html>
        HTML
      end

      # ------------------------------------------------------------ 菜单 / 工具栏

      def icon_png(size, path)
        return path if File.exist?(path)
        buf = Array.new(size * size * 3)
        i = 0
        size.times do |y|
          size.times do |x|
            # 深色底 + 左上到右下的斜向亮带（示意「导入」箭头）
            on = (x - y).abs < (size * 0.28)
            r, g, b = on ? [86, 164, 255] : [32, 38, 48]
            buf[i] = r; buf[i + 1] = g; buf[i + 2] = b
            i += 3
          end
        end
        rep = Sketchup::ImageRep.new
        rep.set_data(size, size, 24, 0, buf.pack('C*'))
        rep.save_file(path)
        path
      rescue StandardError
        nil
      end

      def build_menu
        dir = File.join(Dir.tmpdir, 'AssetManager', 'su_icons')
        FileUtils.mkdir_p(dir) unless File.directory?(dir)
        small = icon_png(16, File.join(dir, 'am16.png'))
        large = icon_png(24, File.join(dir, 'am24.png'))

        tb = UI.toolbar('AssetManager')
        cmd = UI::Command.new('AssetManager') { show_dialog }
        cmd.tooltip = "AssetManager 桥接 v#{VERSION}"
        cmd.status_bar_text = '打开 AssetManager 桥接面板'
        cmd.menu_text = 'AssetManager 桥接面板…'
        cmd.small_icon = small if small
        cmd.large_icon = large if large
        tb.add_item(cmd)

        tb_re = UI::Command.new('AssetManager 重连') { reconnect }
        tb_re.tooltip = '重新探测 AssetManager 端口'
        tb_re.status_bar_text = '重新探测 AssetManager 端口并重连'
        tb_re.small_icon = small if small
        tb_re.large_icon = large if large
        tb.add_item(tb_re)

        menu = UI.menu('Extensions').add_submenu('AssetManager')
        menu.add_item('桥接状态面板…') { show_dialog }
        menu.add_item('重新探测 / 重连') { reconnect }
        menu.add_item('暂停接收任务') { stop_loop; event('已暂停接收任务') }
        menu.add_separator
        menu.add_item("插件 v#{VERSION} · SketchUp #{SERIES} 系列") do
          UI.messagebox("AssetManager 桥接插件\n\n版本：#{VERSION}\n系列：SketchUp #{SERIES}（当前 #{SU_VERSION}）\n" \
                        "支持：#{capability_summary}\n端口：#{@state[:port]}（自动跟随软件）")
        end
      end

      def boot
        return unless @state[:enabled]
        ensure_caps! # 先在主线程把能力算好，后台线程的心跳只读缓存
        port = detect_port
        @state[:port] = port if port
        start_loop
        event("插件 #{VERSION} 已载入（SketchUp #{SU_VERSION} · 端口 #{@state[:port]}）")
      end
    end
  end
end

unless file_loaded?(__FILE__)
  AssetManager::Bridge.build_menu
  AssetManager::Bridge.boot
  file_loaded(__FILE__)
end
