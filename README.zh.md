# DeepSeek Harness

[English](README.md) | 中文

DeepSeek Harness（`dsh`）是由 [DeepSeek AI](https://deepseek.com) 开发的开源 agent harness（智能体框架）。

它构建于**一切皆插件**的架构之上，由 [Cordis](https://github.com/cordiverse/cordis) 驱动，其设计参见论文 [_A Programming Paradigm for Spatiotemporal Composability_](https://arxiv.org/abs/2608.25512)。

文档：[https://deepseek-harness.github.io/deepseek-harness/](https://deepseek-harness.github.io/deepseek-harness/)

## 开发者预览

DeepSeek Harness 处于 _开发者预览_ 阶段，正在快速迭代。**未来将出现破坏兼容性的变更。**

运行本项目前，请阅读[安全说明](SAFETY.zh.md)。

<a id="run"></a>

## 运行

### 通过 `npm` 运行

安装 `Node.js`，然后运行：

```sh
npx @deepseek-ai/dsh web
```

该命令默认会在 `http://127.0.0.1:3080` 启动 Web UI，本机启动时还会用默认浏览器打开页面。通过 SSH 启动时只打印宿主机 URL，因为本地转发地址由 SSH 客户端或编辑器持有。传入 `--no-open` 可仅运行服务器而不打开浏览器。详见 [Web UI 指南](docs/user/guide/index.zh.md)。

要将 `dsh-plugins/knowledge-hub` 这样的插件添加到正在运行的 profile 中，参见下文的「安装插件」一节。

<a id="run-from-source"></a>

### 从源码运行

如需从仓库源码运行：

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

`pnpm run build` 会准备仓库产物。`pnpm dsh web` 会直接使用这些已构建产物，不会重新构建。

### 其他运行方式

```sh
pnpm dsh --profile <name>              # run a named profile
pnpm dsh --profile headless "some job" # run one job non-interactively, then exit
pnpm dsh web                           # shorthand for --profile web
```

`dsh --dump-config` 会打印某个 profile 完整组合后的插件配置，便于调试该 profile 实际加载了什么。

### 安装插件

插件——包括 [`dsh-plugins/`](dsh-plugins/) 下的所有内容，该目录刻意保持在本仓库的包工作区之外，使每个插件的安装方式与外部社区插件完全一致——通过以下方式添加到某个 profile：

```sh
pnpm dsh plugin --profile <name> add <path-or-package-or-git-spec>
pnpm dsh --profile <name>
```

例如，添加本仓库自带的 `dsh-plugins/` 中某个插件的本地检出：

```sh
pnpm dsh plugin --profile <name> add ../dsh-plugins/skillhub
```

`dsh plugin add` 会将包安装到该 profile，并将其声明的 bundle manifest 归并进该 profile 组合后的 Cordis 配置；插件自身需要的设置（例如它所需的文件系统路径）随后通过该 profile 的 `cordis.patch.yml` overlay 设置。完整的配置分层模型参见 [Web UI 指南](docs/user/guide/index.zh.md)和[架构文档](docs/architecture.zh.md)。

### 在「设置 → 模型」中配置本地 LLM

DSH 没有专门命名为「Ollama」/「LM Studio」的选项——取而代之的是一种通用的自定义 provider 机制，适用于任何自托管的 OpenAI 兼容服务器（Ollama、LM Studio、vLLM、llama.cpp server、text-generation-webui 等），因为它们都暴露了 OpenAI 兼容的 `/v1/chat/completions` API。

**Web UI 中的步骤：**

1. 设置 → 模型 → 添加自定义 provider。
2. 填写：Provider ID（小写，永久固定——用于请求/会话/凭据引用，例如 `my-ollama`）、显示名称、Base URL（例如 Ollama 的 `http://localhost:11434/v1`，或你的 LM Studio/vLLM/llama.cpp 服务器地址）、API 协议（`openai-completions`——本地服务器使用的协议）、API Key（可选；本地服务器通常不需要，可留空或填占位符，只要服务器本身不校验即可）。
3. 在「模型目录」下点击「获取可用模型」，会自动查询该服务器的 `/models` 端点（适用于 Ollama/LM Studio/vLLM），也可以手动输入模型 id（例如 `llama3.1`）。
4. 保存。你填写的任何 API Key 都会通过凭据服务以只写方式写入 `$DSH_HOME/.credentials.yaml`——`settings.yaml` 只保留对它的引用，绝不保存明文密钥。

**这在底层会生成什么：** 支撑这一功能的插件是 `dsh-llm-pi-ai`（`packages/llm/llm-pi-ai`），它会写入 `settings.yaml`：

```yaml
llm-pi-ai:
  providers:
    my-lmstudio:
      apiKeyEnv: LMSTUDIO_API_KEY      # optional credential reference, not the literal key
      api: openai-completions        # openai-completions | openai-responses | anthropic-messages
      baseURL: http://192.168.1.51:1234/v1
      models:
        - id: llama3.1
        - id: llava
          input: [text, image]       # vision models: no UI field for this yet, edit settings.yaml by hand
```

如果你更倾向于手动编辑配置而非使用 UI，上面这段配置就是你需要添加的内容。规范文档见 [docs/user/guide/providers.zh.md](docs/user/guide/providers.zh.md)（「添加自定义 provider」一节）。

## 附录

### 会话存储，以及重置/删除会话

目前 Web UI 中没有「删除会话」操作——只有**归档**（Archive），它通过客户端注册表标记将某个会话从列表视图中隐藏，但其事件日志仍完整保留在磁盘上（会话是仅追加的事件日志，这是 DSH 全系统统一采用的架构，用于保证可审计性）。相关存储层工作方式的背景参见 `dsh-plugins/README.md` 中的实机启动排查记录。

如果你确实想彻底清除某个会话（例如测试/一次性使用之后），由于 JSONL 持久化后端为每个会话单独存放一个目录，可以直接删除其文件：

```
$DSH_HOME/sessions/<sanitized-cwd>/session-<uuid>/session.jsonl[.zstd]
```

`$DSH_HOME` 默认是 `~/.dsh`。`<sanitized-cwd>` 这一段编码了该 profile 启动时所在的工作目录（例如 `--D-Github-deepseek-harness--`）。这个位置在同一台机器上**被所有 profile 共享**（`web`、`headless` 以及任何自定义 profile 都指向 `packages/bundle/base/cordis.patch.yml` 中同一个 `dshHomePath('sessions')` 根目录），因此在这里删除会影响该会话，无论它最初是被哪个 profile 创建的。

重置步骤：

1. 先停止正在运行的 `dsh` 进程——它持有文件锁以及活跃会话的内存态；在其运行时删除活跃文件可能导致报错或界面状态过期，直到重启为止。
2. 删除指定会话的文件夹（精细操作——只移除这一个会话），或删除整个 `sessions/` 文件夹（完全重置——移除所有 profile 下的全部会话）。
3. 重启 `dsh`。会话列表会反映磁盘上实际剩余的内容；无需清理单独的索引（会话搜索/查询状态会在下一次协调过程中根据持久化后端的文件列表自愈）。

目前确实没有受支持的方式可以在 UI 内删除会话，也没有对应的 CLI 命令——这是一个真实存在的缺口，而非隐藏功能。要添加真正的删除操作，需要新增存储层原语（当前所有后端都未暴露 delete/purge 操作）、新增 RPC/API 端点（归档不需要端点，因为它纯粹是客户端标记），以及针对「正在运行的会话」或「存活的派生子会话的父会话」的安全防护——这些目前都不存在。

## 社区与支持

- 通过 [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions) 提交反馈或 bug 报告。
- 为你的插件仓库添加 [`dsh-plugin`](https://github.com/topics/dsh-plugin) 话题，便于被发现。
- 欢迎加入 DeepSeek Harness 企微群：扫码添加企微小助手并填写入群问卷，完成后小助手会邀请你入群。

<table>
  <thead>
    <tr>
      <th align="center">企微小助手</th>
      <th align="center">入群问卷</th>
      <th align="center">微信公众号</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td align="center"><img src="https://cdn.deepseek.com/harness/readme/community-wecom-assistant.png" alt="DeepSeek Harness 企微小助手二维码" width="180" height="180"></td>
      <td align="center"><a href="https://trtgsjkv6r.feishu.cn/share/base/form/shrcnIt5twSVdLGD52KJBckGCgg"><img src="https://cdn.deepseek.com/harness/readme/community-wecom-survey.png" alt="DeepSeek Harness 入群问卷二维码" width="180" height="180"></a></td>
      <td align="center"><img src="https://cdn.deepseek.com/harness/readme/community-wechat-official-account.png" alt="DeepSeek Harness 团队微信公众号二维码" width="180" height="180"></td>
    </tr>
  </tbody>
</table>

## 参与贡献

参见 [CONTRIBUTING.md](CONTRIBUTING.zh.md)。

## 开发

请先阅读[开发指南](docs/development.zh.md)与[架构文档](docs/architecture.zh.md)。

面向 agent：请遵循 [AGENTS.md](AGENTS.md)。

## 许可证

[MIT](LICENSE)

第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
