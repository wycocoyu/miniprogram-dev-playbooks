---
name: miniprogram-dev-playbooks
description: >-
  微信小程序本地/真机联调、自动化截屏脱敏标注与模拟器上传绕过方法库。
  当需要让小程序在开发者工具或手机真机上单接口分流直连本机后端、用 wechatide CLI 批量截屏脱敏并生成防遮挡图解手册、或在自动化测试中绕过自定义组件点击失效与原生文件选择窗阻塞时使用。
---

# 微信小程序联调与自动化测试方法（Miniprogram Dev Playbooks）

本 Skill 沉淀三套可复用的微信小程序工程化方法，按场景按需加载对应参考文档。

## 场景路由

1. **小程序连本机后端做联调（模拟器 / 手机真机）** -> 执行下方「方法一」，详参 [local-and-real-device-integration.md](references/local-and-real-device-integration.md)。
2. **批量截屏、物理脱敏与防遮挡图解标注** -> 执行下方「方法二」，脚本见 [annotate-screenshots.mjs](scripts/annotate-screenshots.mjs)，详参 [screenshot-annotation-and-redaction.md](references/screenshot-annotation-and-redaction.md)。
3. **模拟器点击失效或原生文件窗卡住自动化** -> 执行下方「方法三」，详参 [simulator-upload-and-method-injection.md](references/simulator-upload-and-method-injection.md)。

---

## 方法一：小程序 × 本地后端单接口分流联调（含手机真机）

**核心原理**：保留远端 `dev` 环境的基础配置与登录态，只把待测新接口临时切到本机后端。两端使用相同的无状态 JWT 签名密钥（如 `auth.token.secret`）即可直接复用模拟器/真机已有 Token。

### 1. 本机数据库与后端准备

```bash
# 启动本机 PostgreSQL 并建库
lsof -nP -iTCP:5432 -sTCP:LISTEN
psql -h 127.0.0.1 -d postgres -c "CREATE DATABASE app_dev;" || true

# 启动本地后端（开启 ddl-auto=update 自动建表，关闭后台轮询任务）
./mvnw spring-boot:run -Dspring-boot.run.arguments="--spring.profiles.active=local --server.port=8080"
curl -s http://127.0.0.1:8080/actuator/health
```

> 若运营后台服务的 `ddl-auto=none`，先用开启 `ddl-auto=update` 的主服务连该库自动建出基础表，再按需补齐管理端 SQL 表。

### 2. 读取当前测试账号 `userId` 并写入本地测试数据

```bash
W=/Applications/wechatwebdevtools.app/Contents/MacOS/wechatide
P=/path/to/miniprogram

"$W" -c Antigravity automation_evaluate --project "$P" --fn-source 'function(){
  var s = wx.getStorageSync("auth_state") || {};
  return { userId: s.userId, token: s.token };
}'
```

往本地库写入关联该 `userId` 的最小业务行后，先用读出的 `token` `curl` 一次 `http://127.0.0.1:8080/...` 确认返回 `200 OK`。

### 3. 小程序 `request.js` 单接口临时分流

在统一发请求的函数中，仅对本次待测路径做分流，改完调用 `simulator_open_page` 触发重新编译。

```js
const targetUrl = typeof path === 'string' && path.startsWith('/api/target-endpoint')
  ? `http://127.0.0.1:8080${path}`
  : `${BASE_URL}${resolveApiPath(path)}`
```

### 4. 手机真机联调切换

1. 把上面的 `http://127.0.0.1:8080` 换成同局域网 Mac IP（`ipconfig getifaddr en0` 获取）或 `cloudflared` / `ngrok` 生成的临时 HTTPS 域名。
2. 手机扫码打开预览/真机调试版，右上角菜单打开「调试」并在开发者工具勾选「不校验合法域名」。
3. 联调结束后**必须还原** `request.js`（`git checkout -- ...`）、停掉本机端口并清理临时测试数据，严禁把分流代码提交到 Git。

---

## 方法二：CLI 受控截屏、物理脱敏与零遮挡标注重测

**核心原理**：用 `wechatide` 固定窗口路由并注入假数据，经 Pillow 物理重绘清除敏感信息与元数据，最后通过 `manifest.json` 双通道渲染并跑三道自动化门禁。

```bash
CLI=/Applications/wechatwebdevtools.app/Contents/MacOS/wechatide
PROJ=/path/to/miniprogram

# 1. 复用已打开窗口跳页（禁重复调用 open_project_window 防止冷启动覆盖跳转）
"$CLI" -c Antigravity automation_navigate --project "$PROJ" --action navigateTo --url "/pages/detail/index"

# 2. 注入示例占位数据脱敏
"$CLI" -c Antigravity automation_evaluate --project "$PROJ" --fn-source "() => {
  const p = getCurrentPages().slice(-1)[0];
  if (p && p.setData) p.setData({ userDisplayName: '张同学（示例）', userEmail: 'demo@example.com' });
}"

# 3. 截屏并执行标准标注与门禁校验
"$CLI" -c Antigravity simulator_screenshot --project "$PROJ" --optimize=false
node scripts/annotate-screenshots.mjs --update-hashes --manifest annotations/manifest.json
node scripts/annotate-screenshots.mjs --build-images --manifest annotations/manifest.json
node scripts/annotate-screenshots.mjs --verify --manifest annotations/manifest.json
```

**视觉与安全红线**：
- 画布统一等比缩放到 `750px` 宽，顶部向上外扩 `72px` 深色引导条，绝不遮挡原生右上角胶囊。
- 敏感区域必须用背景纯色块覆写并重新粘贴到新 RGB 画布，彻底剥离 `EXIF`、`tEXt`、`iTXt`、`zTXt` 元数据。
- `--verify` 必须保证 **气泡矩形与目标控件框重叠面积严格等于 0**。

---

## 方法三：模拟器点击无效与原生文件选择窗绕过

**适用边界**：仅限已有明确授权的模拟器后台验收。不能替代手机真机手势或原生文件选择器 GUI 验收。

1. **自定义组件选择器失效时**：先在源码核对事件处理函数名与入参，再通过 `automation_evaluate` 取 `getCurrentPages().slice(-1)[0]`，校验 `route`、目标状态与 `typeof p.<handler> === 'function'` 后再调用。
2. **原生 `wx.chooseMessageFile` 弹窗阻塞时**：先把测试文件写入 `wx.env.USER_DATA_PATH`，在触发 handler 前一次性覆写 `wx.chooseMessageFile` 并在回调前立即恢复原函数。
3. **禁止跨页面 `await`**：`evaluate` 中若方法触发页面跳转会导致上下文超时，应同步触发后另起一次 `evaluate` 读新页面状态。
4. **分层判定结果**：文件选择注入成功不等于真实网络上传成功（需核对上传日志 `200` 与 `documentId`），更不等于业务审核通过。上传完成后只清理本次写入的临时文件，保持原有依赖与窗口不动。
