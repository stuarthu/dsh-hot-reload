# dsh-hot-reload

[English](README.md) | 中文

**无需重启 dsh** 即可热重载已升级的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）插件。

dsh 自带的热重载（`cordis-plugin-hmr`）刻意忽略 `node_modules`，所以升级一个已
安装的插件（`dsh plugin add pkg@x`）通常要整体重启 `dsh` 才能生效。本插件补上
这个缺口：它监听所在 profile 的 `pnpm-lock.yaml`，当一个**已加载**插件包的版本
变化时，就地把运行中的插件换成新版。

## 行为

插件包升级时，对每个受影响的插件：

- **就地热重载**：使模块缓存失效、重新导入新代码、并就地重建插件 fiber。dsh、
  你的会话、以及其它所有插件都不受影响、继续运行。
- **若重载失败**：你保留的是**可用的旧版本**，绝不会留下一个失效的插件，同时
  记录一条“需要手动重启 `dsh`”的提示来加载新代码。两种情况都已处理：
  - 新代码在**加载**阶段失败（错误的 import、语法错误）会在触及运行中的插件
    **之前**被捕获——旧插件完全不受打扰；
  - 新代码在**初始化**阶段失败（新的 `apply` 抛错，**同步或异步**）会被回滚——
    旧版本就地重新实例化。

它**绝不会替你重启 dsh**——重启交给你（以及你的守护进程，如果有的话）。

## 安装

```sh
dsh plugin --profile web add dsh-hot-reload
```

然后重启一次 dsh（bundle 补丁层在启动时加载）。此后升级即实时生效：

```sh
dsh plugin --profile web add some-plugin@newer   # 自动热重载
```

## 退出热重载（opt-out）

某个插件若知道自己不适合热重载，可在其**自己的** `package.json` 里声明，强制走
“需要重启”的路径（不做重载尝试）：

```json
{ "dsh": { "hotReload": false } }
```

## 配置

设置在所在 profile 的 `cordis.patch.yml` 里的 `hot-reload` 行上：

| 键 | 默认 | 含义 |
|---|---|---|
| `debounce` | `300` | lockfile 变化后等待多少毫秒再动作 |
| `profileDir` | 自动 | 要监听的 profile 目录绝对路径（省略时从 loader base URL 自动推断） |

## 局限——务必阅读

本插件是**乐观式**的，并非验证式。它尝试重载，且只在**抛出**错误时回退到
“需要重启”。它**无法**检测*静默*泄漏：

- 一个在 cordis 之外获取**裸资源**的插件——裸 `setInterval`、`net`/`http`
  服务器、`WebSocketServer`、`fs.watch`、`child_process`——**且没有用
  `ctx.effect` 注册清理**，可能重载时不抛错，却把该资源遗留下来（游离的定时器、
  重复的监听器、孤立的 watcher）。这些会随每次升级累积，只能靠最终一次重启清除。
- cordis 会自动回收插件**通过 `ctx`** 注册的一切（`ctx.effect`、`ctx.on`、
  `ctx.provide`、工具 schema、适配器），所以行为规范的插件都能干净地重载。风险
  仅限于绕过 `ctx` 的插件。拿不准时，让这类插件设 `dsh.hotReload: false`。
- 重载一个持有**活动连接**的插件（例如 WebSocket 桥接）会断开并重建这些连接；
  客户端需要重连。这是预期行为，不是错误。
- 重载路径依赖 cordis/loader 内部（`loader.internal.loadCache`、
  `registry.plugin`/`delete`、`fiber.entry`）——与 `cordis-plugin-hmr` 用的是同
  一套。若这些内部不可用（既无 `--expose-internals`，也无
  `node-addon-require-builtin` 原生插件），本插件会退化为对每次变化只报告
  “需要重启”，而不做重载。

范围说明：本插件处理的是**已加载插件的升级**。安装一个**全新**插件是另一回事
（把它的行加入 `cordis.patch.yml`，这个 dsh 本身已经会热应用）。

## 许可证

[MIT](LICENSE) © Stuart Hu
