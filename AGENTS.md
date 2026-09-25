# Marketing Content Workbench

本目录是独立项目。修改前读取当前文件，不依赖其他工作区的历史记忆。

保留：素材总览、选题库、配音、事件镜头、九种叠加模板和浏览器实时预览。
不包含：旧 Studio、快速拼接、Whisper 转写。图片快切模板 rapid_montage 仍保留。

代码：server.py、overlay_store.py、overlay_components.py、static/、renderers/。
运行数据：WORKBENCH_DATA_DIR，生产环境通过环境变量指定，不提交到 Git。
私有选题：数据目录内 topics-data.js；公开仓库只含空示例。

改动后执行：
```
python3 -m py_compile server.py overlay_store.py overlay_components.py
node --check static/overlay-components.js
node --check static/overlays.js
python3 -m unittest discover tests
```

保持 1080p 和 30 fps。每次只导出一种格式，内容未变化时复用成品。部署使用单进程，渲染并发为 1。不得将 API Key、用户素材、服务器私有配置提交到仓库。

生产发布：先推送 GitHub，等待 CI 通过，再用 deploy/release.py 从 GitHub 已推送提交部署。不得从含未提交改动的目录直接覆盖线上代码。发布保留上一版本以便回滚。
