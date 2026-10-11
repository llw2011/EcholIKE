# EcholIKE 后端控制面板落地计划

## 目标

为 EcholIKE 云后端补一个受保护的后端控制面板，用于运维、订阅、额度、审计、代理服务和备份状态管理。控制面板不是公开站点，必须通过认证和管理员授权后才能访问。

公网入口建议：

- 控制面板：`/echo-panel/`
- 管理 API：`/echo-api/admin/*`
- 现有业务 API：继续保持 `/echo-api/*`

## 非目标

- 不做无鉴权后台页面。
- 不把密钥、Token、数据库连接串、Provider API Key 明文展示到页面。
- 不改用 MySQL；继续使用当前 PostgreSQL/Drizzle 后端。
- 不替代桌面端设置页；桌面端仍负责本机配置，控制面板只管云后端。
- 第一阶段不做危险写操作，例如删除用户、删除备份、强制清空数据。

## 当前基础

- EcholIKE 后端已通过 `/echo-api/` 暴露。
- `echo-server.service` 已在 WSL systemd 中运行。
- PostgreSQL 容器 `postgres` 已运行，迁移已应用。
- nginx 已能反代 `/echo-api/`。
- 后端已有 Better Auth、Bearer session、订阅、quota、audit、backup、proxy、scene 等服务基础。

## 总体设计

### 1. 管理员授权

新增管理员授权层，不复用普通 Pro 用户权限。

第一阶段建议使用环境变量 allowlist：

```env
ADMIN_EMAILS=admin@example.com,owner@example.com
```

判定规则：

- 未登录：返回 `401`。
- 已登录但不是管理员：返回 `403`。
- 未配置 `ADMIN_EMAILS`：管理面板和管理 API fail closed。
- 所有管理请求写入 audit log。

后续可升级为数据库角色：`user.role = admin/operator/user`。

### 2. 路由规划

控制面板页面：

```txt
GET /echo-panel/
GET /echo-panel/assets/*
```

只读管理 API：

```txt
GET /echo-api/admin/summary
GET /echo-api/admin/system
GET /echo-api/admin/users
GET /echo-api/admin/users/:id
GET /echo-api/admin/subscriptions
GET /echo-api/admin/quotas
GET /echo-api/admin/audit-logs
GET /echo-api/admin/proxy-status
GET /echo-api/admin/backup-status
GET /echo-api/admin/jobs
```

后续写操作 API，第二阶段以后再加：

```txt
POST /echo-api/admin/users/:id/disable
POST /echo-api/admin/users/:id/enable
POST /echo-api/admin/users/:id/quota-adjustments
POST /echo-api/admin/jobs/prune-audit-logs/run
POST /echo-api/admin/jobs/reset-monthly-quota/run
```

所有写操作必须：

- 要求管理员授权。
- 校验 CSRF/origin。
- 记录 audit log。
- 返回结构化错误。
- 默认不允许批量危险操作。

### 3. 面板形态

第一阶段使用轻量管理面板，避免额外引入复杂依赖。

建议实现方式：

- Hono 服务端提供 `/echo-panel/` HTML shell。
- 静态 CSS/JS 放在 `server/src/admin-panel` 或 `server/admin-panel`。
- 前端使用原生 `fetch` 调 `/echo-api/admin/*`。
- 不先引入新的 React/Vite 子项目，除非后续面板复杂度明显升高。

页面结构：

- Overview：服务健康、数据库状态、版本、运行时间。
- Users：用户列表、登录来源、订阅摘要。
- Billing：Stripe 配置状态、订阅分布、webhook 最近事件。
- Quota：STT 秒数、LLM tokens、当月用量。
- Proxy：STT/LLM provider 配置状态、最近失败。
- Backup：备份是否启用、对象存储配置状态、最近备份。
- Audit：管理操作和业务路由审计日志。
- System：环境变量 set/missing、PostgreSQL readiness、任务状态。

### 4. 安全要求

必须满足：

- `/echo-panel/` 未登录不能看。
- `/echo-api/admin/*` 未登录返回 `401`。
- 非管理员返回 `403`。
- 所有 secret 只显示 `set/missing`，不显示值。
- 管理 API 不允许跨站随意调用，CORS/origin 必须收敛。
- 写操作必须有二次确认和 audit log。
- 不允许从面板执行任意 shell 命令。
- 不允许上传任意文件到服务器本地路径。

### 5. 测试要求

后端测试必须覆盖：

- admin route manifest 中每条路由都有 auth boundary。
- 未登录访问 `/echo-api/admin/*` 返回 `401`。
- 普通用户访问返回 `403`。
- allowlist 管理员访问返回 `200`。
- secret redaction：响应体不包含 API key、DB URL、Auth secret、Stripe secret。
- audit log 记录管理员访问和写操作。
- `/echo-panel/` 页面不绕过授权。

### 6. 实施阶段

#### Phase 1：管理员鉴权和只读 API

- 新增 `ADMIN_EMAILS` 环境变量解析。
- 新增 `requireAdmin` middleware。
- 新增 `/echo-api/admin/summary`、`/system`、`/proxy-status`。
- 补测试，保证 fail closed。

#### Phase 2：控制面板 UI

- 新增 `/echo-panel/` HTML shell。
- 新增概览页、用户页、审计页。
- 使用现有主题方向：密集、清晰、工具型，不做营销页。
- nginx 增加 `/echo-panel/` 反代。

#### Phase 3：数据页完善

- 用户/订阅/额度/备份/代理服务完整展示。
- 增加分页、搜索、过滤。
- 增加错误态和空态。

#### Phase 4：受控写操作

- 用户禁用/启用。
- quota 手动调整。
- 手动触发安全任务。
- 所有写操作 audit log。

#### Phase 5：部署和运维固化

- systemd service 文档固化。
- nginx `/echo-panel/` 和 `/echo-api/` 文档固化。
- 备份 PostgreSQL 数据卷策略。
- 健康检查和日志轮转。

## 验收标准

- 后端测试全部通过。
- `/echo-api/admin/*` 未授权不可访问。
- `/echo-panel/` 未授权不可访问。
- 管理员可以看到服务、用户、订阅、quota、proxy、backup、audit 状态。
- 页面不泄露 secret。
- nginx 下 `/echo-panel/` 和 `/echo-api/` 都可用。
- 不影响桌面客户端现有 `/echo-api/*` 业务链路。

## 推荐下一步

先做 Phase 1：管理员鉴权和只读管理 API。这个阶段风险最低，可以先把安全边界立住，再做 UI。

## 用户补充硬性要求

本计划按以下硬性要求执行：

1. 所有后端 API 必须有控制面板内的完整消费链路。
2. 管理 API 和控制面板页面必须完成 admin 鉴权，不能只做前端隐藏。
3. 控制面板必须有账号登录系统，账号、会话、管理员身份数据存 PostgreSQL。

这意味着后续新增 API 时，必须同步声明控制面板消费入口；没有页面消费、没有测试覆盖、没有鉴权边界的 API 不允许进入主干。

## API 消费链路约束

所有 API 路由必须维护消费矩阵：

| API                           | 控制面板入口             | 权限                                        | 测试                 |
| ----------------------------- | ------------------------ | ------------------------------------------- | -------------------- |
| /echo-api/healthz             | System / Health          | public/read-only                            | health route test    |
| /echo-api/readyz              | System / Health          | public/read-only                            | readiness test       |
| /echo-api/auth/\*             | Login / Session          | public/auth                                 | auth flow tests      |
| /echo-api/subscription/status | Users / Billing          | admin                                       | panel consumer test  |
| /echo-api/checkout/create     | Billing                  | admin action or hidden diagnostic           | panel consumer test  |
| /echo-api/subscription/portal | Billing                  | admin action or hidden diagnostic           | panel consumer test  |
| /echo-api/scenes              | Scenes                   | admin                                       | panel consumer test  |
| /echo-api/proxy/stt           | Proxy / STT              | admin/pro guarded                           | panel consumer test  |
| /echo-api/proxy/llm           | Proxy / LLM              | admin/pro guarded                           | panel consumer test  |
| /echo-api/backup/upload       | Backup                   | admin/pro guarded                           | panel consumer test  |
| /echo-api/backup/download     | Backup                   | admin/pro guarded                           | panel consumer test  |
| /echo-api/stripe/webhook      | Billing / Webhook status | internal webhook, read-only status in panel | webhook test         |
| /echo-api/admin/\*            | Control Panel            | admin                                       | admin boundary tests |

实现要求：

- 每个业务 API 在 route manifest 中声明 panel consumer，例如 panel section、页面 route、用途。
- 测试检查 route manifest 中没有 missing consumer。
- 控制面板页面必须实际调用对应 API，不允许只写静态占位。
- 内部 webhook 这类不能由面板直接调用的 API，需要提供对应只读状态页或事件记录消费链路。

## PostgreSQL 账号登录系统

控制面板登录复用 Better Auth 的 email/password/session 能力，数据继续进入 PostgreSQL 中现有 Better Auth 表。

新增 admin 授权模型建议使用独立表，而不是环境变量：

```txt
admin_account
- user_id references user(id)
- role: owner | admin | operator | viewer
- status: active | disabled
- created_by
- created_at
- updated_at
```

权限边界：

- 未登录访问 /echo-panel/：跳转登录页或返回 401。
- 已登录非 admin_account：403。
- disabled admin：403。
- owner/admin/operator/viewer 分层控制写操作。
- 所有 admin 登录、失败登录、写操作进入 audit log。

管理员初始化：

- 第一阶段提供一次性 bootstrap 脚本或命令创建首个 owner。
- bootstrap 不作为公开 HTTP 接口。
- bootstrap 完成后不允许重复覆盖已有 owner。
- 账号密码使用 Better Auth 标准哈希/会话，不自造密码存储。

## 更新后的 Phase 1

Phase 1 不再使用 ADMIN_EMAILS 作为正式方案，改为：

1. PostgreSQL 新增 admin_account schema 和 migration。
2. 复用 Better Auth email/password 登录。
3. 新增 /echo-panel/login 页面。
4. 新增 requireAdmin middleware。
5. 新增只读 /echo-api/admin/summary、/system、/proxy-status。
6. 为现有业务 API 增加 panel consumer 元数据。
7. 测试 fail closed、admin role、consumer matrix、secret redaction。
