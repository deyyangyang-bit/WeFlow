# WeFlow Mini Design Spec（UI 美化地基）

> 状态：2026-08-24 用户拍板启动；**观察期 UI 例外 #2**（#1 = P0-4.4 `e0736b3`）。
> 视觉基准：P0-4.4 双漏斗视觉体系——本轮是把它**系统化**，不是重新设计。
> Token 真源：`src/styles/main.scss` 尾部「前进视觉 tokens」块（light 默认 + `[data-mode="dark"]` 全量覆盖）。

## 颜色
- **前进 token 族 `--color-*`**（新 UI 唯一消费入口）：
  - 表面：`bg-page / bg-page-deep / bg-surface / bg-surface-muted / bg-elevated / bg-inset / bg-inset-strong / bg-hover / glass / overlay / tooltip-bg / tooltip-text`
  - 文本：`text-primary / text-secondary / text-tertiary / text-on-accent`
  - 线条：`border / divider`
  - 品牌：`accent / accent-hover / accent-bg / accent-border / focus`
  - 语义：`success / warning / danger` ×（基色 / `-bg` / `-border`）
  - 图表中性：`chart-neutral`（漏斗「流失/未知」TS 侧出口 = `shared/funnelPalette.ts`）
- **品牌 alias**：`--color-accent: var(--primary)` 等定义一次，light/dark/8 套旧主题自动继承；默认 Apple 蓝 `#0071E3`（dark `#0A84FF`）。回绿只改主题层。
- **字面白**：彩色面（漏斗梯形）上的文字保持字面 `#fff`，不随模式反转。
- **旧族 `--bg-*/--text-*`**：留给未迁移页面，按波次切换；新代码禁止引用。

## 字体
`--font-app` = -apple-system / SF Pro Display / PingFang SC。数字一律 `tabular-nums`。
层级：主数字 26px/700 · 页标题 16px/700 · 正文 13-14px · 辅助 12px · 元信息 11px。

## 间距 / 圆角 / 阴影
页面 padding 24；卡间距 14；圆角 `radius-card 16 / radius-control 10 / radius-small 8`；
阴影 `shadow-card`（静置卡）/ `shadow-control`（分段选中项）/ `shadow-menu`（菜单/tooltip）/ `shadow-pop`（弹层）。

## 控件惯例
- 分段控件：`bg-inset` 灰底 + 选中项 `bg-surface` 浮起 + `shadow-control` + accent 文字。
- 卡片：`bg-surface-muted` 弱底、默认无边框；hover 才 `accent-border + shadow-card`。
- 弹层：`overlay` + blur(3px) + `shadow-pop` + 入场动效；必须带 `prefers-reduced-motion` 关闭。
- 滚动条 6-8px，颜色走 `scrollbar-thumb(-hover)`。

## 暗色
`[data-mode="dark"]` 全量覆盖表面/文本/线条/语义/滚动条/阴影；灰阶与旧页面同坡
（`#171717 / #212121 / #2F2F2F / #383838`），新旧页面暗色无接缝。品牌 alias 自动继承。

## 主题
保留旧 8 套主题（只改 `--primary` 品牌色），经 alias 自动进入新体系；
本轮**不**给主题做独立视觉，也不砍主题。

## 红线（验收逐条核）
1. UI 波次不得修改业务逻辑 / 口径 / 事件 / 判断链（纯视觉）。
2. 不得新增第三套视觉 token。
3. 页面不得直接硬编码品牌色；漏斗图表色板收 `shared/funnelPalette.ts` 单一真源。
4. 所有新组件必须同时验证 light / dark。
5. 不改变现有交互结构、按钮位置、行动任务可见性和可点击性（观察期指标归因不被污染）。

## 波次
W1 地基（本次：token 双套 + 品牌拍板 + 主题映射 + 已打磨页清理 + 本规范）→
W2 Chrome（TitleBar / Dialog / DateRangePicker / 全局滚动条 / 焦点环 / 空态）→
W3 高频页（聊天 / CRM 工作台 / 今日行动 / 见解收件箱）→
W4 低频页与独立窗口（报表 / 年报 / 导出窗）。
