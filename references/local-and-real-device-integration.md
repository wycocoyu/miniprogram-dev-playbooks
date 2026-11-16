# 小程序与本地后端单接口分流联调指南（含手机真机）

适用范围：后端改动尚未合入或未部署到远端 `dev` 环境（`<dev-api-base-url>` / `<admin-dev-url>`）、且本机无法直连远端测试数据库（`<remote-dev-rds-host>:5432` 受安全组限制）时，使用**本机 PostgreSQL + 本地后端（`127.0.0.1:8080`）+ 微信开发者工具按路径单接口分流（或手机真机局域网 / HTTPS 穿透）**完成端到端验收。

## 一句话结论

不要尝试从本机硬连远端受限 RDS，也不要把小程序全部接口一次性切到本机空库（本机空库通常缺少基础目录、配置包与第三方回调）。

正确做法是**「主页面继续走远端 `dev`，待测新接口单独分流到本机 `127.0.0.1:8080` + 本机 PostgreSQL」**：只要两端使用相同的无状态 JWT 签名密钥，模拟器或真机里的现有登录态 Token 可以直接被本地后端验签通过。

## 为什么这套方案能直接跑通

| 环节 | 机制 | 效果 |
| --- | --- | --- |
| **登录态验签互通** | `application-dev.properties` 与 `application-local.properties` 的 `auth.token.secret` 一致，鉴权过滤器只做无状态验签解析 `userId` 与 `role` | 端上登录远端 `dev` 拿到的 Token，发给本机 `127.0.0.1:8080` 直接通过鉴权，无需在本机库重造登录态 |
| **本地自动建表** | `application-local.properties` 开启 `spring.jpa.hibernate.ddl-auto=update` | 本机新建空库后，本地后端启动时自动建好全部 JPA 表 |
| **按接口路径分流** | 小程序 `miniprogram/utils/request.js` 中的统一请求发送函数集中拼装 URL | 只把本次新增或待测的 API 路径指向本地服务，其余接口仍走远端 `dev`，页面上下文不断裂 |

## 操作步骤（按顺序）

### 1. 准备本机 PostgreSQL 数据库

确认本机 PostgreSQL 在 `127.0.0.1:5432` 监听后，创建本地测试库（已存在则跳过）：

```bash
lsof -nP -iTCP:5432 -sTCP:LISTEN
psql -h 127.0.0.1 -d postgres -c "CREATE DATABASE app_local_dev;" || true
```

### 2. 启动本地后端服务（关闭后台调度任务）

启动前注意三个常见参数细节：

1. macOS Homebrew PostgreSQL 默认使用当前系统用户名、无密码连接，需覆盖本地配置文件里的默认用户名和密码。
2. 若配置文件引用了外部 API Key 占位符且无默认值，启动前先 `export` 占位环境变量，避免 Spring 启动报错。
3. 显式关闭本地不需要的定时轮询或异步消费者，防止空库刷错或抢占远端任务。

```bash
export JAVA_HOME="/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home"
export PATH="$JAVA_HOME/bin:$PATH"

cd /path/to/<backend-worktree>
./mvnw spring-boot:run -Dspring-boot.run.arguments="\
--spring.profiles.active=local \
--server.port=8080 \
--spring.datasource.url=jdbc:postgresql://127.0.0.1:5432/app_local_dev \
--spring.datasource.username=$USER \
--spring.datasource.password= \
--app.worker.enabled=false"
```

等待启动日志完成后，用健康检查确认接口就绪：

```bash
curl -s http://127.0.0.1:8080/actuator/health
# 预期输出：{"status":"UP"}
```

### 3. 从微信开发者工具读取当前测试账号的 `userId` 与 `token`

不要猜测测试账号 ID，直接用官方 CLI 从模拟器本地 Storage 读取：

```bash
W=/Applications/wechatwebdevtools.app/Contents/MacOS/wechatide
P=/path/to/<miniprogram-worktree>

"$W" -c Antigravity automation_evaluate --project "$P" --fn-source 'function(){
  var s = wx.getStorageSync("auth_state") || {};
  return { userId: s.userId, token: s.token };
}'
```

### 4. 往本机数据库写入最小待测业务数据

将上一步读到的真实 `userId` 与当前正在测试的业务主键写入本机库（以下 SQL 为示例表结构，按实际业务表调整）：

```bash
psql -h 127.0.0.1 -d app_local_dev -c "
INSERT INTO target_records (
  record_id,
  user_id,
  status,
  payload,
  created_at,
  updated_at
) VALUES (
  '<当前测试记录 ID>',
  '<步骤 3 读出的真实 userId>',
  'ACTIVE',
  '{\"items\":[{\"fileName\":\"test-sample.pdf\"}]}'::jsonb,
  NOW(),
  NOW()
)
ON CONFLICT (record_id) DO UPDATE
SET user_id = EXCLUDED.user_id,
    payload = EXCLUDED.payload,
    updated_at = NOW();
"
```

写入后先在命令行用步骤 3 的 `token` 调一次本机接口，确认返回 `200 OK`：

```bash
curl -s -i -H "Authorization: Bearer <步骤 3 读出的 token>" \
  "http://127.0.0.1:8080/api/target/detail?id=<recordId>"
```

### 5. 在小程序 `request.js` 临时分流待测接口并触发模拟器重编译

在 `miniprogram/utils/request.js` 的统一请求函数里，仅将待测接口路径指向 `http://127.0.0.1:8080`（**严禁提交到 Git**）：

```js
const targetUrl = typeof path === 'string' && path.startsWith('/api/target/')
  ? `http://127.0.0.1:8080${path}`
  : `${BASE_URL}${resolveApiPath(path)}`

return new Promise((resolve, reject) => {
  wx.request({
    url: targetUrl,
    // ...其余 header、data 与回调保持原样
```

修改 `request.js` 后，**必须调一次 `simulator_open_page` 或 `simulator_refresh` 触发微信开发者工具重新编译打包**，否则模拟器仍运行旧包：

```bash
"$W" -c Antigravity simulator_open_page \
  --project "$P" \
  --page "pages/target/detail" \
  --query "id=<recordId>"
```

### 6. 验收完成后的清理清单（必做）

本地联调结束后，按顺序执行以下四步恢复干净环境：

1. 还原小程序临时分流改动并确认 `git diff` 为空：
   ```bash
   git -C "$P" checkout -- miniprogram/utils/request.js
   git -C "$P" status -s
   ```
2. 停止本机 `8080` 端口的后端进程：
   ```bash
   lsof -tiTCP:8080 -sTCP:LISTEN | xargs kill
   ```
3. 清理本机 PostgreSQL 中本次联调插入的测试数据并确认残余行数为 0：
   ```bash
   psql -h 127.0.0.1 -d app_local_dev -c "DELETE FROM target_records WHERE record_id = '<recordId>'; SELECT count(*) FROM target_records;"
   ```
4. 若使用临时 worktree，验收合入后关闭工具窗口并清理 worktree 与临时分支。

## 7. 运营后台（后端 + 前端）本地 PostgreSQL 联调补充

当需求涉及管理端且未部署远端 `dev` 时，直接连本机 PostgreSQL 启动本地后台前后端：

1. **为什么管理端后端可能不能直接连空库**：
   - 若管理端配置 `spring.jpa.hibernate.ddl-auto=none` 不会自动建表。
   - 需先用开启 `ddl-auto=update` 的主业务后端连目标本地库启动一次建出基础表，再补齐管理端独有表的建表 SQL。
2. **启动本地管理端后端（`127.0.0.1:8081`）**：
   ```bash
   cd /path/to/<admin-backend-worktree>
   ./mvnw spring-boot:run -Dspring-boot.run.arguments="\
   --server.port=8081 \
   --spring.datasource.url=jdbc:postgresql://127.0.0.1:5432/app_local_dev \
   --spring.datasource.username=$USER \
   --spring.datasource.password= \
   --auth.admin.username=admin \
   --auth.admin.password-hash='<BCrypt哈希>' \
   --auth.admin.token-secret=local-admin-secret-key-at-least-32-chars"
   ```
3. **启动本地管理端前端（`127.0.0.1:5174`）**：
   ```bash
   cd /path/to/<admin-frontend-worktree>
   VITE_API_BASE_URL=http://127.0.0.1:8081/api/admin npx vite --host 127.0.0.1 --port 5174
   ```

## 8. 手机真机联调扩展（局域网 IP / HTTPS 穿透）

上面第 1~6 节以微信开发者工具模拟器（`127.0.0.1:8080`）为例。若需要在**手机微信真机**上连接本机启动的后端做联调，只需调整请求地址与域名校验，核心 Token 互通与单接口分流机制完全不变：

1. **获取 Mac 局域网 IP 或启用 HTTPS 内网穿透**：
   - 同局域网 Wi-Fi 下执行 `ipconfig getifaddr en0` 获取局域网 IP（例如 `192.168.1.25`），将 `request.js` 中临时分流目标从 `http://127.0.0.1:8080` 改为 `http://192.168.1.25:8080`。
   - 若真机环境限制明文 HTTP，使用 `cloudflared` / `ngrok` 等穿透工具把本机 `127.0.0.1:8080` 映射为临时 `https://...` 域名。
2. **手机真机开启「不校验合法域名」**：
   - 在微信开发者工具点击「预览」或「真机调试」生成二维码，手机扫码打开开发版。
   - 点击右上角 `···` -> 「打开调试」（开启 vConsole 后会自动重载），并在真机调试面板或微信开发者工具「详情 -> 本地设置」中勾选「不校验合法域名、web-view（业务域名）、TLS 版本以及 HTTPS 证书」。
3. **真机获取 `userId` 与 `token`**：
   - 真机不走 `wechatide automation_evaluate`，可在小程序端临时通过 vConsole 或在 `request.js` 调试日志中打印 `wx.getStorageSync("auth_state").userId`，再往本机数据库写入该 `userId` 的测试数据。
4. **验收后强制还原**：
   - 真机联调结束后同样必须执行 `git checkout -- miniprogram/utils/request.js`，严禁将临时 IP 或穿透地址提交到 Git。
