---
publication:
  visibility: public
  title: 一份中等长度的维护记录
  slug: medium-note
  tags: [dispatch, maintenance]
---
# 一份中等长度的维护记录

站点主题不是一次性装饰。它要随着内容、Quartz 和浏览器一起维护。

## 本轮检查

我们先确认构建身份固定：精确主题版本、完整性摘要和 options 都写进本地配置。随后检查输出是否只引用本地资源，并验证相同输入生成相同结果。

接着转向阅读体验。桌面端需要清楚的三栏结构，iPad 需要在横竖屏之间平稳切换，手机端则必须退化为单栏。Search overlay、Graph、Explorer 和 TOC 不只是能出现，还要在键盘与触控下可用。

## 下一步

- 对照 [[reference/markdown-kitchen-sink|全格式样本]] 检查元素覆盖。
- 对照 [[dispatches/long-form|长篇记录]] 检查滚动和目录。
- 对照 [[reference/media-layout|图文页面]] 检查本地资源。
