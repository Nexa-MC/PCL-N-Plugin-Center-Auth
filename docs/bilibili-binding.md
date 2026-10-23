# B站签名绑定

生产采用 Cloudflare 受控浏览器读取当前公开签名。它取代普通 Worker fetch 的生产读取路径，不接受用户上传的 TLS 报告或客户端声称的资料。客户端 TLSNotary 保留为独立原型。正式挑战采用确定性文学编码器：两句中文、两句英文，用户只选择其中一句生效；目标 Nexa 账户显示在页面中，不写入签名正文。

## 接口与状态

所有接口要求当前 console Bearer 会话，并沿用本站 CORS / CSRF 保护。

1. `POST /auth/v1/connections/bilibili/profile`，JSON `{uid:"123"}`，返回只读的昵称、头像、UID、等级、粉丝数及读取时间，不包含验证签名或所有权结论。用户先确认这是自己的账户。
2. `POST /auth/v1/connections/bilibili/challenges`，JSON `{uid:"123"}`，返回 201 `{id,uid,candidates,encoderVersion,accountLabel,expiresAt,maxAttempts}`。每个候选含 `{index,language,text}`，四项中两项中文、两项英文。
3. `POST /auth/v1/connections/bilibili/challenges/{id}/select`，JSON `{index:0}`。只允许选择一次；原子设置选中签名哈希，删除其他候选的哈希。未选择、重选或使用未选中的句子都不能验证成功。
4. 用户把 B站个性签名完整替换为选中的句子，然后 `POST /auth/v1/connections/bilibili/challenges/{id}/verify`，JSON `{}`。成功返回 `{verified:true,uid}`。不接受客户端资料、签名或证明对象。
5. 取消时 `DELETE /auth/v1/connections/bilibili/challenges/{id}`，返回 204。

挑战有效期 15 分钟、最多 5 次尝试，绑定用户、目标 UID 和签发时的确切会话。数据库只保留独立随机量的组合 SHA-256 和候选 / 选中签名 SHA-256，不保存明文随机量或句子。中文 nonce 为 80 bit，英文为 64 bit；均从操作系统密码学随机源独立生成。新挑战撤销该用户旧挑战；页面关闭会尽力撤销；刷新换取新会话后须重新开始。过期记录保留至每日维护清理（过期 24 小时后）。验证码和共享服务 Secret 不进入日志、审计或用户导出。

Auth 通过 `BILIBILI_VERIFIER` 服务绑定读取 `nexa-bilibili-verifier`，双方共享 `BILIBILI_VERIFIER_TOKEN`。核对请求随机 ID、来源标记、目标 UID、资料结构及读取时间，然后比较签名哈希。最终 D1 batch 同时消耗挑战、插入唯一绑定和审计；中途注销、取消、过期、禁用账户或其他请求先绑定都会阻止写入。数据库约束不允许覆盖已有 UID / 用户绑定。

创建限制为每用户 5 次/小时、每 IP 30 次/小时；核验为每用户 10 次/小时、每 IP 60 次/小时及全站 30 次/分钟。上游风控触发全站 10 分钟冷却，不使用旧资料或用户自报结果。签名尚未传播时提示用户稍后重试。

绑定只证明该用户在核验时控制目标 B站账户；页面显式标明将绑定的 Nexa 账户以降低转发验证码的误导风险。不要替他人发布带有陌生 Nexa 账户标记的验证签名。此功能不是 B站登录，不收集密码、Cookie 或 SESSDATA。

## 部署与回退

先部署 Server 仓库 `bilibili-verifier`，配置双方 Secret，再应用 `0018_bilibili_binding.sql` 与 `0019_bilibili_literary_candidates.sql`，部署具有服务绑定和 `BILIBILI_BINDING_ENABLED=true` 的 Auth，最后发布 Web。现有私有 Server GitHub Actions 已实现此顺序及 D1 恢复检查点。

`BILIBILI_BINDING_ENABLED=false` 或缺少服务绑定 / Secret 时，列表关闭新绑定入口；既有绑定仍可展示和解绑。B站 Lv6 与百万粉丝铭牌暂沿用现有管理员核验，不因绑定自动授予。

`tests/bilibili-binding.test.mjs` 在真实 workerd / D1 中覆盖正常绑定、客户端伪造、跨用户/会话、重放、过期、次数限制、上游不匹配/陈旧资料、风控冷却、注销/取消竞态和 UID 唯一性。

迁移 0019 会撤销早期明文验证码挑战。编码器版本固定为 `bili-zh80-en64-v2`；词库或规则变更必须换版本。英文按保守的 70 字符上限计数，采用规划书允许的最低 64 bit，不声称达到推荐的 80 bit。精确空间、证明和 1,000 条非生产样本见 [`bilibili-encoder.md`](bilibili-encoder.md)。

Auth 配置 `keep_vars=true` 保留管理台既有变量。爱发电创作者 ID 曾被配置为普通变量，部署时被清除；已从历史版本恢复为 `secret_text`，API Token 与其他 Secrets 保持原值。
