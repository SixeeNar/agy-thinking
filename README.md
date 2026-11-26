<div align="center">
  <img src="assets/logo.svg" alt="AGY Thinking Logo" width="88" height="88" />
  <h1>AGY Thinking · 思考流</h1>
  <p>为 <strong>Google Antigravity</strong> 打造的低功耗实时流式思考插件：支持<strong>会话内嵌 + 侧边栏双模式</strong>与<strong>零主模型消耗的实时中文翻译</strong>。</p>
  <p>
    <img alt="Node.js >= 22" src="https://img.shields.io/badge/Node.js-%E2%89%A522-339933?logo=node.js&logoColor=white" />
    <img alt="Zero Dependencies" src="https://img.shields.io/badge/dependencies-0-8b5cf6" />
    <img alt="Platforms" src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-06b6d4" />
    <img alt="License MIT" src="https://img.shields.io/badge/license-MIT-blue" />
  </p>
</div>

---

## 核心特性

- **双模式清爽布局**
  - **会话内嵌模式（Inline Shadow DOM）**：直接将折叠/展开思考卡片挂载在主对话窗口每轮回复上方，样式隔离不污染宿主页面；折叠显示首行摘要、展开自动隐藏重复首行，阅读体验干净利落。
  - **双 Tab 侧边栏控制台（Aux Pane）**：默认打开舒展的「控制中心」直接管理状态、样式密度、字号与翻译选模，不再与主窗口重复刷屏；需要检索历史或按「仅看思考 / 全部步骤 / 仅看工具」查看时可一键切到「思考记录」。
- **极低资源占用**
  - 语言服务器（LS）请求**单飞去重 + 动态 TTL 缓存**，空闲时自动降频或休眠（0 轮询），避免长时运行 CPU 飙升。
  - 30fps 精准局部跟字动画（支持关闭直出），切到后台标签页自动停止动画帧。
- **实时流式中文翻译 & 智能选模（不消耗主模型额度）**
  - **Key 自动识别可用模型 + 三维推荐评分**：填完 API Key 后自动请求 `/models` 过滤非文本模型，按「**综合推荐** / **性价比优先** / **自然感优先**」三个维度评分并展示分级徽章与短评，点选或一键 Top 3（可再点取消）即可组成顺延队列。
  - **去机翻味多风格**：支持「自然口语 / 精准技术 / 极简直白」三种译文风格，及「直接中文 / 中英双语 / 仅原文」三种视图，原样保留 Markdown、代码、路径与标识符。
  - 译文自动持久化缓存至本机，支持多模型容错顺延（限流 / 超时自动切下一个模型）。
  - 内置**硅基流动（免费）**、**DeepSeek（自然度首选）**、**智谱 GLM（免费）**、**阿里云百炼**、**OpenRouter** 与 **本地 Ollama（免 Key）** 快捷预设。
- **零第三方依赖**：纯 Node.js ESM 标准库实现，无需 `npm install`。

---

## 环境要求

- **Google Antigravity**（支持 Sidecar Web UI 插件）
- **Node.js ≥ 22**（会话内嵌模块使用 Node 内置全局 `WebSocket`；若低于 Node 21，侧边栏仍可正常使用，内嵌通道会提示需升级 Node.js）

---

## 安装方式

将本仓库放到 Antigravity 插件目录中（或通过 Antigravity 插件管理从本地目录安装）：

### Windows (PowerShell)

```powershell
git clone https://github.com/SixeeNar/agy-thinking.git "$HOME\.gemini\config\plugins\agy-thinking"
```

### macOS / Linux

```bash
git clone https://github.com/SixeeNar/agy-thinking.git ~/.gemini/config/plugins/agy-thinking
```

安装完成后，在 Antigravity 的 **Plugins Manager** 中启用 **AGY 思考流（agy-thinking）**，并在右侧栏打开 **思考过程** 面板即可。

> **macOS 提示**：如果你使用 `nvm` / `fnm` 管理 Node.js，从 Dock 启动 GUI 应用时可能读取不到终端里的 `PATH`。请确保系统默认 `node` 可执行文件在宿主可见路径中（且版本 ≥ 22）。

---

## 翻译配置指南

1. 打开右侧栏的 **思考过程** 面板，点击右上角 **设置**。
2. 在「实时中文翻译」区域选择一个快捷预设（推荐 **硅基流动 · 免费极速** 或本机 **Ollama**）。
3. 填入你的 `API Key`（本机无鉴权网关如 Ollama 可留空），点击 **保存并测速** 即可查看首字延迟（TTFT）与试译效果。

所有配置与译文缓存仅保存在你本机用户目录，不会写入插件目录：

- 配置文件：`~/.gemini/config/agy-thinking/settings.json`
- 译文缓存：`~/.gemini/config/agy-thinking/translation-cache.json`

---

## 目录结构

```text
agy-thinking/
├── plugin.json                            # 插件清单
├── assets/
│   └── logo.svg                           # 插件图标
└── sidecars/
    └── thinking_stream/
        ├── sidecar.json                   # Sidecar 启动与 Aux Pane 视图配置
        ├── server.mjs                     # 本地 HTTP/SSE 服务与单飞缓存层
        ├── trajectory.mjs                 # 会话轨迹与工具步骤解析
        ├── translator.mjs                 # 流式分段翻译与本地磁盘缓存
        ├── inline_injector.mjs            # 主窗口 CDP Shadow DOM 内嵌注入器
        ├── shared_render.mjs              # 侧边栏与内嵌端共用的 Markdown 渲染器
        ├── settings.mjs                   # 本机配置读写与密钥脱敏
        └── ui.html                        # 侧边栏前端界面
```

---

## 隐私与兼容性说明

- **数据流向**：插件仅监听 `127.0.0.1` 并与本机 Antigravity 服务通信；除你主动开启并填写的第三方翻译 API 外，不会向任何外部服务器发送数据。
- **非官方增强声明**：
  - 本插件依赖 Antigravity 本地 Language Server 接口读取当前对话轨迹。
  - **会话内嵌模式**通过读取宿主 `DevToolsActivePort` 文件连接本地 CDP 调试端口，向主窗口注入独立的 Shadow DOM 节点。
  - 若未来 Antigravity 更新调整内部 DOM 结构或关闭远程调试端口，内嵌功能可能失效；此时可在设置中关闭「在会话中间嵌入展示」，继续单独使用侧边栏面板。

---

## License

[MIT](./LICENSE)
