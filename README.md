# Marketing Content Workbench · 营销内容工作台

管理口播配音、事件镜头和可复用的叠加模板。保留素材总览、选题库、九种叠加动画的实时预览、拖拽、参数调整及视频导出。旧视频时间线、快速拼接和自动转写不包含在本项目中。

叠加模板保持 1080p、30 fps。每次选择 MP4 或 WebM 一种格式；素材和参数未变时直接复用成品。实时动画在浏览器执行，视频编码在服务器执行，每个应用进程只允许一个导出任务。

## 本地运行

需要 Python 3.12+、FFmpeg 和 ffprobe。

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
WORKBENCH_DATA_DIR="$PWD/data" .venv/bin/python server.py --port 8876
```

打开 <http://127.0.0.1:8876/library>。服务默认只监听本机。

## 私有数据

代码仓库不包含真实素材、案例截图、配音文件、密钥或选题内容。

- `WORKBENCH_DATA_DIR`：存放 outputs、event-library、overlays、config 等运行数据。
- `WORKBENCH_CONFIG_DIR`：可选，独立指定设置和配音历史目录。
- `WORKBENCH_EVENT_LIBRARY` / `WORKBENCH_OVERLAYS_DIR`：可选，独立指定素材目录。
- `FISH_API_KEY`：配音密钥，可用环境变量提供，也可在设置页填写。
- 私有选题：放入数据目录的 `topics-data.js`，格式与 `static/topics-data.js` 的结构一致；服务自动优先读取。

## 提交、检查、部署

1. 在独立工作区修改并执行本地检查。
2. `git add` / `git commit` / `git push`。
3. 等待 GitHub Actions 的 CI / verify 通过。
4. 在已配置 SSH 访问的电脑中执行：

```bash
python3 deploy/release.py --host YOUR_SSH_ALIAS
```

部署脚本要求工作区干净及当前提交的 GitHub CI 成功。服务器从 GitHub 下载该提交，验证后切换版本并重启独立服务；健康检查失败时自动恢复上一版本。**推送会自动运行检查，不会自动发布生产服务。**

脚本针对已初始化的 `/opt/marketing-workbench` 运行环境：独立 Python 环境和 FFmpeg/ffprobe、独立运行账号和数据目录，以及 `deploy/marketing-workbench.service`。依赖变化时先更新独立运行环境。新服务器也可以使用 Dockerfile，自行挂载私有数据卷。

服务配置上限为 1.5 核、2 GiB 内存，仅绑定 `127.0.0.1:8876`。对外使用还需设置 HTTPS 入口和身份验证；当前没有不同用户之间的素材隔离。

## 验证

```bash
python3 -m py_compile server.py overlay_store.py overlay_components.py
node --check static/overlay-components.js
node --check static/overlays.js
python3 -m unittest discover tests
```

## License

MIT，见 LICENSE。使用者自行管理上传素材和音色的使用授权。
