# Fish Audio 的 Mac 中转

当工作台服务器无法直接连接 Fish，而用户明确选择使用 Mac 网络时，可用本模块只中转 Fish 的加密连接。服务器仍执行原来的配音请求、验证 Fish TLS 证书并持有原密钥；Mac 不保存密钥，不生成声音，也不解密配音请求。

## 路径与边界

```
工作台 urllib HTTPS 请求
  → 服务器 127.0.0.1:18877 的固定目标 CONNECT 入口
  → 原有 SSH 命令通道
  → Mac 网络 → api.fish.audio:443
```

入口只允许 `CONNECT api.fish.audio:443`；拒绝其他域名和端口。TLS 仍由工作台与 Fish 建立。只改工作台服务的代理环境，不改服务器全局 DNS、Nginx、SSH 转发策略或其他应用。没有公网监听、代理凭据或新 SSH 密钥。现有 SSH 禁止端口转发时，本模块仍通过正常远程命令的标准输入和输出运行，不解除限制。

## 部署

新增模块与测试按仓库原发布流程提交、推送、等待 CI，再使用 `deploy/release.py` 部署已验证提交。不要把未提交文件直接复制进线上应用目录。

Mac 上使用独立的只读版本副本，由用户级 LaunchAgent 运行：

```
python3 fish_relay.py agent --host mainland-jump --state-dir <私有运行状态目录>
```

Agent 通过已有 SSH 执行服务器已发布的 `deploy/fish_relay.py bridge`。命令通道关闭时服务器监听随之结束；Agent 每8秒尝试重新连接，SSH有保活和主机校验。只在本机当前用户登录后自动运行，不要求网页、终端或 Codex 保持打开。

确认后台通道的 `/health` 已在线后，为工作台添加单独的 systemd drop-in：

```
[Service]
Environment=HTTPS_PROXY=http://127.0.0.1:18877
Environment=https_proxy=http://127.0.0.1:18877
Environment=NO_PROXY=localhost,127.0.0.1,::1
Environment=no_proxy=localhost,127.0.0.1,::1
```

只重启营销工作台，不能改其他服务或把代理配进全局 shell。通道离线时配音失败，不自动改走另一服务或更换密钥。

## 验证与日常使用

- `/health`只确认SSH中转在线，不证明Fish可用或密钥有效。
- 完整检查应复用工作台进程的实际代理环境和密钥，通过官方 `GET /wallet/self/api-credit` 取得200和账号ID。只返回允许的状态与ID，不输出密钥或完整账户财务信息。
- 检查恢复：终止一次Agent持有的SSH子进程，确认重新连接后上述官方只读查询再次成功。
- 用无密钥的HTTPS请求检查 `/v1/tts` 的访问与TLS可用，不向POST生成接口提交测试文案。
- 未指定本次音色和实际生成任务时，不用生成声音来测试。

用户仍按原配音流程指定每次音色。Mac必须开机、已登录、联网，且其当前访问Fish的网络线路可用。Mac休眠、关机或该线路失效时暂停配音；恢复后Agent自动重连。锁屏、关闭网页、终端或Codex不等于停止后台服务。不会为此擅自修改电源或休眠设置。

## 回退

先移除本次工作台systemd代理drop-in，重载配置并重启工作台，再卸载Mac的专用LaunchAgent。只处理本模块创建的文件，保留原音色、密钥、历史音频和其他服务。回退会恢复原服务器直连行为；如果原网络仍不通，配音仍不可用。应用代码回滚前也应先移除代理配置，以免依赖不存在的旧版模块。

测试：`python3 -m unittest discover tests -p 'test_fish_relay.py' -v`；然后执行仓库全部必要检查。
