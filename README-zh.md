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

  失败的版本**不会自动重试**——重试会在此后每次 lockfile 写入时再次拆除正在
  正常工作的插件。请安装另一个版本，或重启 dsh，以加载新代码。

有两种情况按设计不做重载：

- **已禁用（disabled）的插件行会被静默跳过。** 已禁用的插件本就没在运行，没有
  可替换的对象；重新启用时 dsh 自然会加载新代码。
- **尚未挂上 fiber 的插件**（仍在导入中，或此前加载失败）会被报告为
  `no live fiber to reload right now` 并原样保留。由于什么都没有被拆除，之后
  每次 lockfile 变化都**会**重新检查它；一旦出现正在运行的副本，它会自己完成
  重载。提示是**每个版本只给一次**，不是每次检查都给——所以，如果该插件已有
  足够时间启动，你却仍看到同一个版本被报告，请重启 dsh。

它**绝不会替你重启 dsh**——重启交给你（以及你的守护进程，如果有的话）。

## 你如何知道发生了什么

插件会把每个结果写进 dsh 的日志。但 dsh 不会把日志打印到你的终端，所以这些内容
很容易被忽略。另有两个地方会告诉你发生了什么。

**1. 每次重载成功，在你的终端里输出一行。** 任意 profile 都有：

```
dsh-hot-reload: hot-reloaded some-plugin@1.2.0 (1 module(s))
```

**2. dsh web 应用里的一条短提示。** 重载成功时会出现一条。凡是新代码*没有*加载、
旧代码仍在运行的情况，也都会出现一条：

- 重载失败，已换回旧版本
- 该插件没有正在运行的副本可供替换
- 该插件用 `dsh.hotReload: false` 关闭了热重载
- dsh 没有提供重载所需的内部接口

其中第二种情况是**每个版本只提示一次**，而不是每次检查都提示。这种情况在此后
每次 lockfile 写入时都会重试——包括为别的包发生的写入——所以若不加这个限制，
同一条提示会反复出现，而且没有办法关掉它。另外三种情况每次发生都会提示。

提示会滑入，停留数秒，然后淡出。如果一次升级重载了多个插件，提示会排队逐条显示。

web 那一部分只在运行 web 服务器的 profile 中加载，并通过
`GET /dsh-hot-reload/events` 发送提示。没有 web 服务器的 profile（例如 `tui`）
仍然有终端那一行和日志。

提示不会被保存。如果重载发生时没有打开任何浏览器标签页，那条提示就没有了。
日志里仍有记录。

如果你在标签页开着的时候重启 dsh，标签页会自己重新建立通道，提示继续可用。
它大约会尝试三分钟。若仍然连不上，就在浏览器控制台写一行提示并停止重试；
刷新页面即可重新开始。

### 如果你想在终端里看到全部内容

上面那一行只覆盖成功的重载。若想看到本插件写进日志的全部内容（包括失败），请把
dsh 的控制台日志插件加进你的 profile。它是一个独立的包：

```sh
dsh plugin --profile web add @deepseek-ai/cordis-plugin-logger-console
```

然后在该 profile 的 `cordis.patch.yml` 中加入一行，并重启 dsh：

```yaml
- insert:
    - id: logger-console
      name: '@deepseek-ai/cordis-plugin-logger-console'
```

这会打印 dsh 的所有日志，而不只是本插件的。

> **全屏界面 profile 的注意事项。** 终端那一行是直接写到屏幕上的。在绘制全屏
> 界面的 profile（例如 `tui`）中，这一行可能落在画面中间，让屏幕看起来乱掉。
> 这只会持续到屏幕下一次重绘为止。

## 安装

```sh
dsh plugin --profile web add dsh-hot-reload
```

然后重启一次 dsh（bundle 补丁层在启动时加载）。此后升级即实时生效：

```sh
dsh plugin --profile web add some-plugin@newer   # 自动热重载
```

适用于**任意 profile**——把 `web` 换成你用的 profile 即可；它监听自己被加载进的
那个 profile。

## 兼容性

基于并测试于 **dsh `0.1.0-rc.6`**（Node 22 / 24）。它会用到 cordis/loader 的内部
接口——大多与 `cordis-plugin-hmr` 相同——因此未来若某个 dsh 版本改动了其中任何
一项，可能需要更新本插件：

| 内部接口 | 用途 |
|---|---|
| `loader.internal.loadCache` | 使 ESM 模块缓存失效 |
| `loader.internal.resolve` / `resolveSync` | 把 specifier 解析为 URL（按 `internal.version` 分派） |
| `loader.import` / `loader.unwrapExports` | 重新导入新模块，并取出其中的插件导出 |
| `registry.plugin` / `registry.delete` | 替换插件实例 |
| `fiber.entry`、`fiber.runtime` | 把新插件重新挂到运行中的行上 |
| `entry.disabled` | 跳过已禁用的行（继承式 getter） |
| `entry.options.group` | 跳过 group 容器行 |

web 应用里的提示（且仅这一部分）还用到：

| dsh 的部件 | 用途 |
|---|---|
| `ctx.webServer.register` | 提供提示通道 |
| `window.__ModuleLoader__` | 加载浏览器侧那一半 |
| `shell.overlay` 插槽 | 把提示放到应用之上 |
| `@deepseek-ai/dsh-client-ui-primitives` 的 `Toast` | 绘制提示 |

本插件是失败安全的。若所需部件缺失，它会报告“需要重启”，而不会弄坏 dsh。提示
也一样：缺少 web 服务器、浏览器模块加载不了、插槽名未知、重复注册、或 dsh 构建
中没有 `Toast`，代价都只是没有提示。重载照常工作，web 应用也照常启动。

有一个例外：浏览器侧那一半会向 dsh 索取名为 `slots` 的服务。只要有任何插件始终
没有就绪，dsh 的 web 应用就会拒绝启动。所以，假如将来某个 dsh 构建完全没有
`slots` 服务，这一部分就会一直等待，并出现在 dsh 的启动错误列表里。上面列出的
其他失败都会被捕获，只是什么都不做。

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

本插件是**乐观式**的，并非验证式。它尝试重载，且仅在**抛出**错误时（或没有可
替换的活动 fiber 时）回退到“需要重启”。它**无法**检测*静默*泄漏：

- 一个在 cordis 之外获取**裸资源**的插件——裸 `setInterval`、`net`/`http`
  服务器、`WebSocketServer`、`fs.watch`、`child_process`——**且没有用
  `ctx.effect` 注册清理**，可能重载时不抛错，却把该资源遗留下来（游离的定时器、
  重复的监听器、孤立的 watcher）。这些会随每次升级累积，只能靠最终一次重启清除。
- cordis 会自动回收插件**通过 `ctx`** 注册的一切（`ctx.effect`、`ctx.on`、
  `ctx.provide`、工具 schema、适配器），所以行为规范的插件都能干净地重载。风险
  仅限于绕过 `ctx` 的插件。拿不准时，让这类插件设 `dsh.hotReload: false`。
- 重载一个持有**活动连接**的插件（例如 WebSocket 桥接）会断开并重建这些连接；
  客户端需要重连。这是预期行为，不是错误。
- 重载路径依赖[兼容性](#兼容性)一节列出的 cordis/loader 内部接口。若这些内部
  不可用（既无 `--expose-internals`，也无 `node-addon-require-builtin` 原生
  插件），本插件会退化为对每次变化只报告“需要重启”，而不做重载。
- lockfile 只是**触发器**。版本号是从每个包已安装的 `package.json` 读取的，因为
  只有这个文件才说明一次 import 实际会拿到什么。在 pnpm 11 上（实测 11.21.0），
  磁盘上的文件**先**写、lockfile **最后**写，所以本插件动作时读到的版本已经稳定。
  但插件并不会去*核实*这一点。如果将来某个 pnpm 版本改成先写 lockfile，一次检查
  就可能读到旧版本、跳过它，而且不再回头看——被监听的只有 lockfile，那次升级就会
  被**静默**漏掉，不给任何提示，直到你安装另一个版本或重启 dsh。`debounce` 帮不上
  忙：实测这个间隔有 2.5–4 秒，远超任何合理的 debounce 取值。
- 提示通道（`GET /dsh-hot-reload/events`）**不做任何密码校验**，与 dsh 自带的
  `/plugins/events` 相同。它发送的是插件名和版本号。dsh 的插件列表本来就会显示
  这些内容，所以并没有多暴露什么秘密。但如果你把 dsh 绑定到 `0.0.0.0`，请把它
  算作局域网里任何人都能打开的又一个地址。

范围说明：本插件处理的是**已加载插件的升级**。安装一个**全新**插件是另一回事
（把它的行加入 `cordis.patch.yml`，这个 dsh 本身已经会热应用）。

## 许可证

[MIT](LICENSE) © Stuart Hu
