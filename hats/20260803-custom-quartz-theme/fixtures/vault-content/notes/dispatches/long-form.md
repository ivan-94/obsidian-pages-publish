---
publication:
  visibility: public
  title: 从凌晨到下一次部署：一份长篇调度记录
  slug: long-form
  tags: [dispatch, long-read, systems]
---
# 从凌晨到下一次部署：一份长篇调度记录

长文不是把短文复制十遍。它需要章节之间真正发生状态变化，让目录、阅读进度和反向链接都有工作可做。

## 00:40 / 发现

第一条信号来自一个很小的差异：本地预览的某个页面比上一次多了一个远程请求。没有用户报告，也没有构建失败，只有审计摘要里的数字从零变成了一。

我们没有立刻修改主题，而是先固定输入：同一个 Vault 快照、同一个 Quartz engine、同一个主题 integrity、同一组选项。只有输入稳定，比较才有意义。

## 01:10 / 缩小范围

问题被缩小到图谱组件。它在开发环境里会寻找 CDN，在正式 adapter 中本应改写为本地 vendor asset。我们分别检查 HTML、JavaScript 和 CSP，确认不是浏览器缓存造成的假象。

> [!question] 为什么不直接禁用图谱？
> 因为验收目标包括证明主题可以深度定制 Quartz 工具，而不是通过删除功能换取表面上的安全。

## 02:00 / 建立不变量

团队写下四条不变量：

1. private 内容不能进入任何输出。
2. unlisted 页面可以直达，但不能进入发现面。
3. 运行时资源必须本地化。
4. 主题不能改变 canonical route 和发布边界。

这些规则不属于视觉主题，因此必须由主题上层架构强制执行。

## 03:15 / 第一次修复

第一次修复让图谱恢复离线，但破坏了窄屏 overlay。这个结果提醒我们：组件不是孤立的函数，它同时处于布局、样式、客户端脚本和无障碍语义之间。

```text
fix A -> offline graph PASS
fix A -> 320px search FAIL
fix B -> both PASS
```

## 05:20 / 日出

天亮时，首页的 poster frame 看起来仍然很响亮。文章页却必须安静一些：更窄的正文、更清楚的 TOC、更低噪声的 backlinks。两者共享 token，但不共享同一个 shell。

这也是 A+B+C 组合方向的意义：海报负责入口，编辑部版式负责阅读，仪表语言负责工具状态。

## 08:30 / 内容回归

我们加入 [[reference/markdown-kitchen-sink|Markdown 压力样本]]、[[reference/media-layout|图文混排]] 和 [[dispatches/one-line|一行短文]]。主题不能只在设计师挑选的理想文章上成立。

### 表格回归

| 视口 | 首页 | 长文 | Search | Graph |
| ---: | :---: | :---: | :---: | :---: |
| 1440 | PASS | PASS | PASS | PASS |
| 768 | PASS | PASS | PASS | PASS |
| 390 | PASS | PASS | PASS | N/A |
| 320 | PASS | PASS | PASS | N/A |

## 11:45 / 信任边界

可执行主题不是 CSS 文件。安装提示必须告诉用户：构建期代码会在隔离 Quartz 进程中运行，clientScripts 会在读者浏览器中运行。发布者名称可以帮助识别，但精确 integrity 才是当前工件身份。

## 14:10 / 失败关闭

当主题缓存缺失时，系统拒绝构建，而不是悄悄回退到默认主题。回退会让用户以为自己发布了已经验收过的视觉结果，实际上部署了另一个站点。

> [!important] 恢复路径
> 用户始终可以显式移除 `site.theme`，保存后回到 Quartz default；这个动作不会自动部署。

## 17:30 / 局域网验收

iPad 验收不是桌面浏览器缩窄窗口的替代品。真实设备会暴露触控目标、系统字体、地址栏高度、横竖屏切换和移动 Safari 缓存等差异。

局域网链接只提供合成公开内容。private canary 已由输出审计确认不存在，预览结束后应关闭服务。

## 21:00 / 收束

一天结束时，我们没有得到一个“永远完成”的主题。得到的是一套可以重复构建、明确失败、能够恢复、并允许人类在真实设备上作判断的系统。

继续阅读 [[field-guide/expeditions/coastal/low-tide|低潮窗口]]，观察长文之后图文页面带来的节奏变化。
