# Pi 任务监控

`@dianel/pi-hud` 是 Pi 的常驻桌面任务监控 HUD：在不打断终端工作的情况下，显示当前会话、模型、Token、上下文占用、缓存命中率和费用等信息。

## 安装

```bash
pi install npm:@dianel/pi-hud
```

安装后重启 Pi。默认会在 Pi 会话启动时显示监控窗口。

## 功能

- 多会话监控与切换
- 多显示器位置恢复
- 按 Provider 解析模型与上下文窗口
- `/reload` 安全复用已有 HUD，避免重复窗口
- OAuth 登录状态提示
- Token、上下文、缓存命中率和费用统计
- 主会话费用与已识别的子代理费用分开显示
- 矩形监控面板与可选圆形 Dock 模式
- 深色、白色、纸质米色主题
- **中文 / English 双语界面切换**，语言偏好会持久化保存

## 语言切换

右键 HUD，打开 **语言 / Language**，选择：

- **中文**：中文标题、菜单、状态、统计字段和圆形摘要
- **English**：英文标题、菜单、状态、统计字段和圆形摘要

语言设置保存在 `~/.pi/pi-hud-geom.json`，下次启动会自动恢复。语言切换不会改变数据源、快捷键或窗口位置。

## 快捷键

| 快捷键 | 操作 |
| --- | --- |
| 拖动标题栏 | 移动窗口 |
| 右键 | 打开操作菜单，切换矩形 / 圆形模式、主题和语言 |
| 拖动边缘或角落 | 调整矩形窗口大小 |
| `Ctrl+[` | 上一个会话 |
| `Ctrl+]` | 下一个会话 |
| 点击会话标签 | 切换自动跟随 |
| `Ctrl+T` | 切换置顶 |
| `Ctrl+A` | 切换透明度 |
| `Ctrl+H` | 最小化 |
| `Ctrl+Q` | 退出 |

## 矩形模式

矩形模式保留完整监控信息：

- 当前状态：运行中、思考中、空闲
- 当前工具调用和命令
- Provider、模型和思考等级
- 输入 / 输出 Token
- 缓存命中率
- 当前模型上下文占用
- Pi 会话费用与子代理费用

底部信息在窗口足够宽时显示为一行，空间不足时自动折为两行。长命令不会撑大面板，完整命令仍可在 Pi 终端中查看。

## 圆形 Dock 模式

右键选择 **切换为圆形窗口**。圆形模式是矩形面板之外的可选显示方式，不会替代完整监控面板。

圆形 UI 由三个层级组成：

1. **Pi Logo**：中心品牌标志
2. **缓存环**：内圈，绿色 → 琥珀 → 红色
3. **上下文环**：外圈，青色 → 蓝色 → 紫色

上下文环始终位于最外层。两条环线采用分段颜色，并在阶段交界处使用较长、平滑的渐变过渡。环线不会随 Agent 状态呼吸或旋转。

运行时只有中心区域显示较亮的柔和呼吸光：

- `THINKING`：紫色
- `RUNNING`：青色
- `IDLE`：不显示彩色呼吸灯

圆形模式还支持：

- 悬停高光
- 按压反馈
- 右键关闭 / 开启动态效果
- 靠近屏幕边缘时半隐藏停靠
- 点击停靠圆形窗口展开 / 收起
- 悬停显示不含当前命令的摘要信息

摘要区域使用较小字号、半透明磨砂材质和高对比度文字。Windows 上圆形窗口与摘要使用原生逐像素 Alpha 合成，以避免色键透明带来的黑边和锯齿；其他平台使用 Tk 兼容回退方案。

磨砂效果为本地绘制的材质层，不会截取、读取或模糊桌面背景，因此不会产生真正的桌面背景实时模糊。

预览：

![圆形主题与状态预览](assets/orb-preview.png)

![圆形动态预览](assets/orb-motion.gif)

## 主题

右键打开 **主题 / Theme**，可以选择：

- 深色 / Dark
- 白色 / White
- 纸质米色 / Paper Beige

主题和窗口形状、位置、停靠状态、圆形动态效果及语言设置都会保存。

## 数据来源

| 显示内容 | 数据来源 |
| --- | --- |
| 当前命令 | Session JSONL 中最新的 assistant tool call |
| Provider / 模型 | Session JSONL 与 Provider 对应的模型目录 |
| 思考等级 | `thinking_level_change` 事件 |
| Token 使用量 | Session JSONL 的 assistant usage |
| 主会话费用 | 主会话消息、工具结果、压缩、分支摘要和 Pi usage 条目 |
| 子代理费用 | 已识别的子代理工具结果和生命周期记录 |
| 活动状态 | `agent_start` / `agent_settled` 生命周期事件 |
| OAuth 状态 | `~/.pi/agent/auth.json` |
| 上下文窗口 | `models.json` → `models-store.json` → `~/.pi/model_config.json` |

## 模型兼容映射

如果运行时模型名称是别名，可以创建可选的 `~/.pi/model_config.json`：

```json
{
  "mappings": {
    "provider-a": {
      "gpt-5.6-luna-max": "gpt-5.6-luna"
    }
  },
  "contextWindows": {
    "provider-a": {
      "gpt-5.6-luna-max": 272000
    }
  }
}
```

`mappings` 和 `contextWindows` 都按 Provider 再按运行时模型组织。手动配置优先于自动模型目录映射。文件缺失或格式无效时会被忽略，也不会被打包进 npm 包。

## 开发

在包目录中手动启动：

```bash
python pi_hud.py
```

仓库根目录执行完整检查：

```bash
npm install --package-lock-only --ignore-scripts
npm ci
npm run check
```

## 许可证

MIT
