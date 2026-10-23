# B站签名绑定

生产采用 Cloudflare 受控浏览器读取当前公开签名。它取代普通 Worker fetch 的生产读取路径，不接受用户上传的 TLS 报告或客户端声称的资料。文学编码器与客户端 TLSNotary 仍是独立原型，当前挑战使用明确的 Nexa 账户标记和 128-bit 随机量，不依赖未经审校的词库。

## 接口与状态

所有接口要求当前 console Bearer 会话，并沿用本站 CORS / CSRF 保护。

1. `POST /auth/v1/connections/bilibili/challenges`，JSON `{uid:"123"}`，返回 201 `{id,uid,signature,accountLabel,expiresAt,maxAttempts}`。
2. 用户把其 B站个性签名完整替换为 `signature`，确认页面显示的当前 Nexa 账户。
3. `POST /auth/v1/connections/bilibili/challenges/{id}/verify`，JSON `{}`。成功返回 `{verified:true,uid}`。不接受客户端资料、签名或证明对象。
4. 取消时 `DELETE /auth/v1/connections/bilibili/challenges/{id}`，返回 204。

挑战有效期 15 分钟、最多 5 次尝试，绑定用户、目标 UID 和签发时的确切会话。数据库只保留签名 SHA-256。新挑战撤销该用户旧挑战；页面关闭会尽力撤销；刷新换取新会话后须重新开始。过期记录保留至每日维护清理（过期 24 小时后）。验证码和共享服务 Secret 不进入日志、审计或用户导出。

Auth 通过 `BILIBILI_VERIFIER` 服务绑定读取 `nexa-bilibili-verifier`，双方共享 `BILIBILI_VERIFIER_TOKEN`。核对请求随机 ID、来源标记、目标 UID、资料结构及读取时间，然后比较签名哈希。最终 D1 batch 同时消耗挑战、插入唯一绑定和审计；中途注销、取消、过期、禁用账户或其他请求先绑定都会阻止写入。数据库约束不允许覆盖已有 UID / 用户绑定。

创建限制为每用户 5 次/小时、每 IP 30 次/小时；核验为每用户 10 次/小时、每 IP 60 次/小时及全站 30 次/分钟。上游风控触发全站 10 分钟冷却，不使用旧资料或用户自报结果。签名尚未传播时提示用户稍后重试。

绑定只证明该用户在核验时控制目标 B站账户；页面显式标明将绑定的 Nexa 账户以降低转发验证码的误导风险。不要替他人发布带有陌生 Nexa 账户标记的验证签名。此功能不是 B站登录，不收集密码、Cookie 或 SESSDATA。

## 部署与回退

先部署 Server 仓库 `bilibili-verifier`，配置双方 Secret，再应用 `0018_bilibili_binding.sql`，部署具有服务绑定和 `BILIBILI_BINDING_ENABLED=true` 的 Auth，最后发布 Web。现有私有 Server GitHub Actions 已实现此顺序及 D1 恢复检查点。

`BILIBILI_BINDING_ENABLED=false` 或缺少服务绑定 / Secret 时，列表关闭新绑定入口；既有绑定仍可展示和解绑。B站 Lv6 与百万粉丝铭牌暂沿用现有管理员核验，不因绑定自动授予。

`tests/bilibili-binding.test.mjs` 在真实 workerd / D1 中覆盖正常绑定、客户端伪造、跨用户/会话、重放、过期、次数限制、上游不匹配/陈旧资料、风控冷却、注销/取消竞态和 UID 唯一性。
