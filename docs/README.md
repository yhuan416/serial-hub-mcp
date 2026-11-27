# serial-hub-mcp 文档

先看根目录的 [README](../README.md)（英文）或 [README.zh](../README.zh.md)（中文）了解项目，
再按下面的入口深入。

## 入门

| 文档                                  | 内容                                            |
| ------------------------------------- | ----------------------------------------------- |
| [Getting started](getting-started.md) | 环境要求、源码安装、客户端配置、第一次调用      |
| [Tools](tools.md)                     | 20 个 MCP 工具的完整参数、示例和只读/破坏性提示 |

## 参考

| 文档                                      | 内容                                                |
| ----------------------------------------- | --------------------------------------------------- |
| [Configuration](configuration.md)         | 全部环境变量、XDG 路径、v2/legacy 存储、HTTP 鉴权   |
| [Storage](storage.md)                     | 字节/日志模型、v2 segment + SQLite、保留与 dump     |
| [Protocol v1](remote-link-protocol-v1.md) | ESP32 / x86 hub 的二进制线格式契约                  |
| [Remotes](remotes.md)                     | `remotes.json`、`list_ports` 汇总、`open({remote})` |
| [Info page](info-page.md)                 | `/info` 自描述页：五段骨架、内容协商、复用模板      |

## 部署

| 文档                                | 内容                                                  |
| ----------------------------------- | ----------------------------------------------------- |
| [Deployment](deployment.md)         | stdio、Streamable HTTP、Docker、systemd、Harbor、回滚 |
| [x86 hub-server](x86-hub-server.md) | 多端口 Linux 串口服务、设备放行、热插拔               |
| [deploy/](deploy/)                  | systemd 单元和 env 样例                               |

## 开发

| 文档                                  | 内容                           |
| ------------------------------------- | ------------------------------ |
| [Development](development.md)         | 测试、lint、CI、发布与回滚流程 |
| [Troubleshooting](troubleshooting.md) | 常见错误、日志、容器和远端排障 |

## 约定

- 协议文档是线格式的唯一事实源；代码和文档冲突时先改代码，再同步文档。
- 文档里的相对链接以仓库根目录为基准。
- 环境变量和默认值以 `src/` 里的读取代码为准。
