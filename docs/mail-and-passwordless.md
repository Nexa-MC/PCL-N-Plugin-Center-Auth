# 飞书邮箱、模板回执与无密码登录

四个联系地址均为独立邮箱：support@pcln.top、privacy@pcln.top、security@pcln.top、legal@pcln.top。noreply@pcln.top 是第五个独立邮箱，仅用于验证码和账户通知，不参与收件自动回复。保留域名当前的飞书 MX、SPF、DKIM 和 DMARC 配置。网站公开入口为 /contact，页脚也链接四个联系地址。

## 配置飞书

为四个联系邮箱分别开启第三方客户端 SMTP 和 IMAP，为 noreply 开启 SMTP，分别生成客户端专用密码。使用飞书后台允许的登录名及专用密码，不使用网页登录密码。

默认参数：SMTP smtp.feishu.cn:465，隐式 TLS；IMAP imap.feishu.cn:993，TLS。服务器名称可用 SMTP_HOST / IMAP_HOST 覆盖。本实现不支持明文连接或 587 STARTTLS。

飞书桌面端进入头像 → 设置 → 邮箱 → 第三方邮箱客户端登录 → 立即设置，生成专用密码；需要管理员先允许第三方客户端登录。公共邮箱可在管理后台的邮箱地址管理中开启 IMAP/SMTP。官方说明：https://www.feishu.cn/hc/zh-CN/articles/902478147400-在第三方邮箱客户端登录飞书邮箱

在 F:\Nexa-Auth 逐项执行，密码只粘贴到命令提示中，不写入仓库或聊天：

```powershell
pnpm exec wrangler secret put SMTP_NOREPLY_PASSWORD
pnpm exec wrangler secret put SMTP_SUPPORT_PASSWORD
pnpm exec wrangler secret put SMTP_PRIVACY_PASSWORD
pnpm exec wrangler secret put SMTP_SECURITY_PASSWORD
pnpm exec wrangler secret put SMTP_LEGAL_PASSWORD
```

默认登录名分别等于五个邮箱地址。若飞书给出的实际登录名不同，另配置相应 SMTP_NOREPLY_USERNAME、SMTP_SUPPORT_USERNAME、SMTP_PRIVACY_USERNAME、SMTP_SECURITY_USERNAME、SMTP_LEGAL_USERNAME。四个联系邮箱默认使用各自同一专用密码连接 SMTP 和 IMAP；需要不同 IMAP 凭据时可使用 IMAP_ACCOUNTS 密钥，内容为最多四项的数组，每项包含 mailbox（support/privacy/security/legal）、username 和 password。

系统验证码和账户通知默认从独立的 noreply@pcln.top 发信；MAIL_FROM 可用于其他部署的显式覆盖，指定地址必须有相应 SMTP 配置。四个回执分别用各自邮箱身份发出。SMTP 优先；已有 Resend 配置保留兼容，但不会与 SMTP 同时重复发送。

SMTP_USERNAME / SMTP_PASSWORD 仍支持单邮箱及授权别名的既有部署；本次四个独立邮箱优先使用各自的配置。

## 自动回复

- 每分钟检查已配置邮箱的 INBOX。首次接入或 UIDVALIDITY 改变时从当时的最新 UID 开始，不给历史邮件批量补发回执。
- 只读取新邮件的发件人、收件人、邮件标识和防循环头，使用 BODY.PEEK，不读取正文和附件，不修改已读状态。
- src/mail-templates.mjs 保存四种中英文模板。回执只表示收到来信，不承诺已经退款、删号、修复漏洞或认可法律主张。
- 所有回执、验证码与账户通知统一采用 HTML 邮件布局。src/mail-layout.mjs 控制布局，图标来自 GitHub NexaMC 组织头像，使用 PNG CID 内嵌，不是 NexaCL 启动器图标，也不依赖远程图片请求；同时保留邮件协议的文本兼容部分。
- 过滤自动回复、群发列表、退信、无人值守发件地址和自身域名；同一发件人、同一联系邮箱每 24 小时最多一封回执，全局每天最多 500 封。
- 按当前飞书账户截图的限制，所有 SMTP 发信（验证码、账户通知和回执）在发送前原子预留额度：每个发件地址滚动 24 小时最多 100 封，所有发件地址合计每 100 秒最多 200 封。滚动窗口用于避免服务商日界线差异；连接失败也不自动退还预留额度，以免不明确的提交结果导致超发。超限不自动排队重试，回执保留 pending 待人工核查；验证码不会伪装成已送达。noreply 的验证码与账户通知共享其 100 封额度。
- 发送额度记录只保存随机标识、发件地址摘要和时间，24 小时后列入每日清理，不保存收件人或正文。
- 每次轮询每个邮箱最多处理五封新邮件，按 UID 推进。收件进度有租约，重复计划任务不会同时处理同一邮箱。
- SMTP 提交前预留去重记录。发送结果不明确时保留 pending，避免重复回执；需要人工核查，不自动重发。sent 表示 SMTP 服务已接受，并非保证最终投递到收件箱。
- 去重记录仅保留邮箱类别、发件人摘要、邮件标识摘要、状态、回执标识及时间，30 天清理。停止使用超过 30 天的轮询进度也会清理。
- IMAP_ENABLED=false 可暂停轮询；不影响飞书正常人工收件。缺少某邮箱凭据时，不轮询该邮箱。

## 邮箱验证码登录

GET /auth/v1/login/methods 返回实际配置状态。邮箱登录需可用发信配置，以及 EMAIL_OTP_SECRET 或已有 MFA_ENC_KEY；缺失时返回 503，不伪装成已发信。

POST /auth/v1/login/email/request 接收 email。仅向已完成注册、启用且当前邮箱唯一的账户发码。不存在、停用、未完成注册或邮箱重复时均返回相同的挑战结构，不自动注册或合并账户。

POST /auth/v1/login/email/verify 接收 challenge、code。六位验证码五分钟有效、最多五次尝试，MAC 带有服务端密钥及挑战/邮箱绑定，数据库不保存明文验证码。请求和校验分别限速。邮箱变更、禁用、过期或重放均不能登录。已有 MFA 因子时继续原有两步验证；无因子时建立会话。

## Passkey 直接登录

POST /auth/v1/login/passkey/direct/options 生成匿名可发现凭据挑战，要求 userVerification=required。POST /auth/v1/login/passkey/direct 校验来源、RP、签名、UV、用户句柄、账户状态、签名计数和一次性挑战后直接建立会话，不再追加密码、邮箱或 TOTP。

新注册要求可发现凭据和设备用户验证。旧凭据仍保留原有两步验证路径；旧凭据不支持可发现凭据或设备验证时，需在账户安全页重新注册兼容的 Passkey 后使用直接登录。

## 上线验证

先应用 D1 迁移，再部署 Auth 和 Web。真实密码不要用于本地自动测试。上线后逐邮箱从外部发送测试来信，核对对应模板和发件身份、重复来信限制以及人工回复；再用实际账户测试验证码、已有 MFA 的后续验证和真实设备 Passkey。自动测试使用真实 Worker/D1 与模拟邮件协议，不等同于真实飞书投递或物理认证器验证。

2026-10-23 上线记录：

- 两项迁移 0023 / 0024 已应用，正式服务条款与隐私政策记录为 1.2，历史接受记录保留。
- Auth：8b4accef-9af3-489e-9e57-c7b189c15882；Web：e3d942ad-3691-4838-bda4-784b6f3e067b；Manage：5d538f04-7971-40e8-a485-36df55a1683d。
- Auth 完整测试 261/261，最终空收件箱进度保留修正通过邮件与登录定向回归 15/15；Web 完整测试 56/56；类型检查和正式构建通过。
- 五个 SMTP 账号分别完成真实 TLS 登录；四个联系邮箱分别完成真实 IMAP 登录并只读打开 INBOX。该连接检查不发送邮件、不读取正文。
- 浏览器确认 /contact 的四个联系地址及 /login 的直接 Passkey、邮箱验证码入口，邮箱配置状态可用。
- 正式计划任务已为四个联系邮箱建立首次收件基线，避免给历史邮件补发回执。成功的空轮询同样更新运行时间，避免长期安静的邮箱被当作停用进度清理。
- 实际外部来信的回执投递、真实账户收码和物理设备 Passkey 登录仍需通过实际使用确认；SMTP 服务接受不代表保证最终进收件箱。
