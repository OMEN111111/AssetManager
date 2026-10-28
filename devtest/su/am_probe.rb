# encoding: utf-8
# 临时探针：探测 SketchUp 各版本的 Ruby / API 能力，结果写到 %TEMP%\am-su-probe-<主版本>.json
# 用法：拷进 <版本>\SketchUp\Plugins\ 后启动 SketchUp（带一个 .skp 跳过欢迎窗口）
# 注意：不要在这里调 model.import —— 老版本对无效文件会弹模态框，把脚本卡死
require 'json'

module AMProbe
  OUT = File.join(ENV['TEMP'] || '.', "am-su-probe-#{Sketchup.version.split('.')[0]}.json")

  def self.safe
    yield
  rescue Exception => e
    "ERR #{e.class}: #{e.message.to_s[0, 120]}"
  end

  def self.run
    r = {}
    r['sketchup_version'] = Sketchup.version
    r['version_number'] = Sketchup.version_number
    r['ruby'] = RUBY_VERSION
    r['platform'] = RUBY_PLATFORM
    r['locale'] = safe { Sketchup.get_locale }

    m = Sketchup.active_model
    r['model_ok'] = !m.nil?

    # ---- 材质 / PBR（用 operation 包住，别把模型弄脏）
    if m
      begin
        m.start_operation('AM probe', true)
        mat = m.materials.add('AM_PROBE_MAT')
        if mat.is_a?(Sketchup::Material)
          r['material_methods'] = mat.methods.grep(/textur|rough|metal|normal|ao_|workflow|materialType|alpha/).map(&:to_s).sort
          %w[metallic_texture= roughness_texture= normal_texture= ao_texture= normal_style= metallic_factor=
             roughness_factor= ao_strength= workflow materialType normal_style texture= alpha=].each do |meth|
            r["m_#{meth}"] = mat.respond_to?(meth.to_sym)
          end
          r['workflow_value'] = safe { mat.workflow }
          r['materialType_value'] = safe { mat.materialType }
          r['normal_style_value'] = safe { mat.normal_style }
        end
      rescue Exception => e
        r['material_probe'] = "ERR #{e.class}: #{e.message.to_s[0, 100]}"
      ensure
        m.abort_operation rescue nil
      end
    end
    r['mat_constants'] = Sketchup::Material.constants.map(&:to_s).sort

    # ---- 环境（HDRI）
    r['model_environments'] = m ? m.respond_to?(:environments) : nil
    r['environments_class'] = (defined?(Sketchup::Environments) ? Sketchup::Environments.instance_methods(false).map(&:to_s).sort : nil)
    r['environment_class'] = (defined?(Sketchup::Environment) ? Sketchup::Environment.instance_methods(false).map(&:to_s).sort : nil)

    # ---- ImageRep（通道抽取用）
    r['imagerep_methods'] = (defined?(Sketchup::ImageRep) ? Sketchup::ImageRep.instance_methods(false).map(&:to_s).sort : nil)
    r['set_data_arity'] = safe { Sketchup::ImageRep.instance_method(:set_data).arity }
    r['color_at_uv_arity'] = safe { Sketchup::ImageRep.instance_method(:color_at_uv).arity }

    # ---- 贴图
    r['texture_methods'] = Sketchup::Texture.instance_methods(false).map(&:to_s).sort

    # ---- UI
    r['html_dialog'] = safe { UI.const_defined?(:HtmlDialog) }
    r['ui_timer'] = UI.respond_to?(:start_timer)
    r['ui_webdialog'] = safe { UI.const_defined?(:WebDialog) }

    # ---- 导入能力：看安装目录里的 Importers（无副作用）
    imp_dir = safe { Sketchup.find_support_file('Importers') }
    if imp_dir.is_a?(String) && File.directory?(imp_dir)
      dlls = Dir.glob(File.join(imp_dir, '*')).map { |f| File.basename(f).downcase }.sort
      r['importers_dir'] = imp_dir
      r['importer_dlls'] = dlls.grep(/importer|\.dll$|\.so$/)
      r['has_fbx_importer'] = dlls.any? { |d| d.include?('fbx') }
      r['has_glb_importer'] = dlls.any? { |d| d.include?('glb') }
      r['has_obj_importer'] = dlls.any? { |d| d.include?('obj') }
    else
      r['importers_dir'] = imp_dir.to_s
    end

    # ---- 现有插件实现能否在本版本 Ruby 解析
    main = File.join(File.dirname(__FILE__), 'assetmanager_su', 'main.rb')
    r['main_exists'] = File.exist?(main)
    r['main_parse'] = if File.exist?(main)
                        safe do
                          RubyVM::InstructionSequence.compile(File.read(main))
                          'ok'
                        end
                      else
                        'no main.rb'
                      end
    r['probe_parse'] = safe do
      RubyVM::InstructionSequence.compile(File.read(__FILE__))
      'ok'
    end

    # ---- 线程 / 队列 / 其它
    r['thread'] = defined?(Thread) ? true : false
    r['queue'] = (defined?(Queue) ? Queue.instance_methods(false).map(&:to_s).sort : nil)
    r['net_http'] = safe { require 'net/http'; 'ok' }
    r['json'] = safe { require 'json'; 'ok' }

    File.open(OUT, 'w') { |f| f.write(JSON.pretty_generate(r)) }
  rescue Exception => e
    begin
      File.open(OUT, 'w') { |f| f.write(JSON.pretty_generate('fatal' => "#{e.class}: #{e.message}", 'bt' => Array(e.backtrace).first(8))) }
    rescue StandardError
      nil
    end
  end
end

AMProbe.run
