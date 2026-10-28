# encoding: utf-8
# AssetManager · SketchUp 桥接插件 · 2024 系列（SketchUp 2024 / 24.x）
#
# 安装：把本文件与同名文件夹一起拷进 SketchUp 的 Plugins 目录
#   %APPDATA%\SketchUp\SketchUp 2024\SketchUp\Plugins\
#     assetmanager_su.rb          ← 本文件（加载器）
#     assetmanager_su\main.rb     ← 实现
# 也可以在 AssetManager 里点「安装/更新插件到 SketchUp」自动完成。
#
# 版本规则：插件与软件版本解耦。第一版 0.1.0，之后只递增第三位（0.1.1、0.1.2…）；
# 各 SketchUp 系列目录（su/2026、su/2025…）共用同一个插件版本号。
#
# 加载完显示在 扩展程序(Extensions) → AssetManager，以及一条工具栏。

require 'sketchup.rb'
require 'extensions.rb'

module AssetManager
  # 插件版本（唯一的版本号出处在加载器里，安装器也读这一行）
  AM_PLUGIN_VERSION = '0.1.3'
  AM_SERIES = '2024'

  AM_ROOT = File.join(File.dirname(__FILE__), 'assetmanager_su') unless defined?(AM_ROOT)

  unless file_loaded?(__FILE__)
    ext = SketchupExtension.new('AssetManager 桥接', File.join(AM_ROOT, 'main.rb'))
    ext.version      = AM_PLUGIN_VERSION
    ext.creator      = 'AssetManager'
    ext.copyright    = 'MIT'
    ext.description  = "把 AssetManager 素材库里的模型、材质、贴图与 HDRI 直接导入 SketchUp（插件 #{AM_PLUGIN_VERSION} · #{AM_SERIES} 系列）"
    Sketchup.register_extension(ext, true)

    file_loaded(__FILE__)
  end
end
