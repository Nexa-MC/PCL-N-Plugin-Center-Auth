# 开发者与受信任开发者申请

开发者需要五项中至少两项；受信任开发者需要先具备 developer，再满足六项中至少三项。取消这两类申请的 Lv2/Lv3 与 popular_plugin 门槛，管理员申请仍保留 Lv4。既有已授予权限保持有效；旧的待审开发者申请注明规则更新后关闭，须按新条件重提。

1. NexaCL 核心贡献者：用户勾选申报，管理员明确勾选“已核实”才计入。不由公开贡献者列表自动推断核心身份，不允许自审。
2. GitHub 注册时间严格超过三个 UTC 日历年（不以 1095 天代替）。
3. 账号本人拥有一个 Star ≥ 10,000 的仓库，GitHub 识别出的主要语言不是 Markdown。无主要语言时不满足。使用 owner 关系，不以组织内任意仓库或贡献过的仓库代替。
4. GitHub followers > 500，500 不满足。
5. 当前是 Nexa-MC 组织成员。通过 OAuth read:org + viewerIsAMember 读取，支持隐藏成员；未接受的邀请不计入。
6. 受信任开发者独有：一个本人拥有的插件下载量 > 1,000 且评分 ≥ 3.0。按用户要求**暂时留空**，available=false / met=false，不以历史 popular_plugin 或客户端数值代替。

入口为登录后的 `GET /auth/v1/oauth/github/start?mode=link&intent=developer&return_to=/account?section=developer`。只有此显式核验流程额外申请 read:org；普通 GitHub 登录不扩大授权。回调用临时 OAuth access token 查询 GitHub GraphQL viewer 的稳定数字 ID、创建日期、followers、所属仓库、组织成员；ID 必须等于刚验证的 OAuth subject。按 Star 降序分页，直到找到合格仓库、列表结束或低于门槛，最多十页、总超时十秒，失败不保存部分核验。令牌不落库。

核验快照 24 小时内有效，并绑定当前 GitHub subject 与关联时间。`GET /auth/v1/account/developer-eligibility` 返回两类资格的条件状态。`POST /auth/v1/applications` 接受 `{kind,coreContributor:boolean}`；其余客户端提供的“核验结果”拒绝。自动已核验条件达到门槛，事务内批准并授予权限；只有依赖申报核心贡献者才进入人工待审。资料过期、解绑、换绑、会话在授权期间退出都会阻止相应写入或审批。

后台待审列表显示当下条件、申报内容及证据；审批时服务端重新检查快照和当前身份，并在 D1 事务里用 profile_version 保护最终授予，拒绝旧快照、重放和并发重复授予。批准核心贡献者后记录审核人和时间，资格与审核均写审计。账户导出包含相关核验资料，删除账户时清除快照。
