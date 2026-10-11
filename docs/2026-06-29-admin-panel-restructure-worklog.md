# 管理面板重构 Worklog

**日期**: 2026-06-29
**范围**: `server/src/routes/admin-panel.ts`、`server/src/app.ts`、`server/src/tests/admin.test.ts`

## 背景

原 `echo-panel` 管理台把后端能力按「数据库表名」平铺为表单（Provider Registry、OTA Release、Desktop Policy、usage_ledger 等），非技术人员无法理解。本次重构按「运营任务」重新组织导航和区块，隐藏内部字段名，用人话标签 + 引导文案。

## 改动内容

### 1. 导航重组（7 个板块）

| 旧导航 | 新导航 |
|---|---|
| 总览 | 概览 |
| 用户权限 | 用户与额度 |
| 额度调整 | （合并进「用户与额度」） |
| 场景下发 | 场景模板 |
| 桌面配置 / OTA | 版本发布 |
| — | 云端服务（新增独立板块） |
| 运行诊断 | 运维诊断 |
| API 链路 | 接口清单 |

### 2. 区块合并与拆分

- **用户权限 + 额度调整 → 合并为「用户与额度管理」**：一个板块内完成查看用户、设角色、调配额三个任务。
- **桌面配置 / OTA → 拆分为「版本发布」+「云端服务」**：
  - 版本发布：OTA Release + Desktop Policy（面向客户端版本管理）
  - 云端服务：Provider Registry（面向 Pro 代理服务商配置），新增「当前云端服务状态」可视化状态卡片。
- **运行诊断 → 分层**：基础健康检查 / Pro 代理链路测试 / 计费与备份链路 / 系统内部状态（原始数据折叠到底部）。

### 3. 人话化标签

所有表单标签从内部字段名改为运营术语：
- `providerId` → 服务商标识（英文）
- `mode: proxy` → 云端代理（Pro 用户走服务端密钥）
- `features JSON: {}` → 功能开关（通常留空）
- `写入管理员授权` → 保存角色设置
- `Save OTA` → 保存版本信息
- 等约 100 处标签重写

### 4. 引导文案

每个区块和表单组添加了 `subheading`（小标题）和 `field-hint`（操作提示），说明该区域做什么、填什么、改了影响什么。

### 5. 高级选项折叠

Desktop Policy 的 `features/services/policy` JSON 编辑器用 `<details>` 折叠，标注「高级选项，通常不需要修改」。

### 6. 配套修改

- `app.ts`：`/admin/quota-adjustments` 的 panelConsumer route 从 `#quota` 改为 `#users`。
- `admin.test.ts`：9 处硬编码面板文案断言同步更新。
- `admin-panel.ts`：CSS 新增 `.subheading`、`.field-hint`、`.advanced-toggle` 样式。

## 不变的部分

- 所有 API 调用路径、请求体、鉴权逻辑完全不变。
- 所有表单字段的 `name` 属性不变（后端兼容）。
- `data-control` 权限标记不变。

## 验证

- TypeScript 编译通过（`tsc --noEmit` 零错误）
- 全部 103 个测试通过（20 个测试文件）
- 原文件备份：`admin-panel.ts.bak.20260629`

## 备份

- `server/src/routes/admin-panel.ts.bak.20260629` — 原始文件完整备份
