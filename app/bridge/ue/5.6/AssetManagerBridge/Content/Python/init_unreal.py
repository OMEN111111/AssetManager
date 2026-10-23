# -*- coding: utf-8 -*-
"""AssetManager Bridge · UE 启动钩子

UE 的 PythonScriptPlugin 会在编辑器启动时执行所有已启用插件
`Content/Python/init_unreal.py`，这里把桥接模块拉起来并开始轮询。
"""

import unreal

try:
    import assetmanager_ue as _am
    _am.auto_start()
except Exception as _e:  # 绝不让插件把编辑器拖挂
    unreal.log_error("[AssetManager] init_unreal 失败: %s" % _e)
    import traceback
    unreal.log_error(traceback.format_exc())
