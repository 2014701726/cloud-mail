# 验证码查询 API 对接文档（MD5 版）

## 1. 地址和规则

- 服务地址示例：`https://mail.jx3saas.cn`。
- 查询接口：`GET /api/codes`，返回 JSON；无需登录和 Authorization 请求头。
- 浏览器页面：`GET /codes`，参数与 API 一致，支持复制、手机访问和自动刷新。
- 仅返回最近 **5 分钟**内、未删除且已接收的验证码，按收件时间倒序，最多 **5 条**。
- 已配置发件人白名单时，还须匹配白名单。网站域名与实际收件域名可以不同。
- 这是不兼容旧链接的更新：`recipient=xlcvt` 等明文值返回 HTTP 400。请同步更新调用方。

## 2. recipient 计算规范

1. 从完整邮箱中取 `@` 前的部分，例如 `xlcvt@bingtangzhanghao.cn` 取 `xlcvt`。
2. 去除前缀首尾空白，并转换为小写；不要删除中间字符、`+` 或其后内容。
3. 对规范化后的字符串按 **UTF-8** 编码，计算一次 **MD5**。
4. 输出 **32 位十六进制**，推荐小写；服务端也接受大写十六进制。

不加盐、不加域名、不加换行，不使用 Base64 或所谓 16 位 MD5，也不要再次哈希摘要。
以项目支持的常规 ASCII 邮箱前缀为推荐接入格式；不要让调用端自行套用其他邮箱别名归并规则。

| 前缀 | 规范化输入 | recipient |
|---|---|---|
| `xlcvt` | `xlcvt` | `4b19a9ed08986b4ab177375cbbafacc5` |
| ` XLCVT ` | `xlcvt` | `4b19a9ed08986b4ab177375cbbafacc5` |

MD5 是哈希而非可解密的加密算法，只隐藏链接中的明文，不提供身份认证或防猜测能力；传输仍使用 HTTPS。
服务端使用 [Cloudflare Workers 的 MD5 扩展](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)，普通浏览器不能直接用 `crypto.subtle.digest('MD5', ...)`。

## 3. 查询参数

| 参数 | 类型 | 说明 |
|---|---|---|
| `recipient` | 字符串 | 前缀的 32 位 MD5。缺省或空字符串返回空列表，不查询邮件数据库。只能传一次。 |
| `domain` | 字符串，可选 | 实际收件域名，例如 `bingtangzhanghao.cn`。省略时查询全部配置域名下匹配前缀的地址。只能传一次。 |

`domain` 仍为明文，必须是服务端配置的收件域名，不要填 `https://`、路径、完整邮箱或直接填网站域名。
多域名同前缀使用同一个 MD5，建议传 `domain` 避免混合结果。

```text
https://mail.jx3saas.cn/api/codes?recipient=4b19a9ed08986b4ab177375cbbafacc5&domain=bingtangzhanghao.cn
https://mail.jx3saas.cn/codes?recipient=4b19a9ed08986b4ab177375cbbafacc5&domain=bingtangzhanghao.cn
```

## 4. 返回结果

HTTP 200，`Content-Type: application/json`，`Cache-Control: no-store`。
下面数据仅为字段格式示例，不代表实时邮件：

```json
{
  "server_time": "2026-09-23T03:00:00.000Z",
  "messages": [
    {
      "id": 123,
      "code": "008005",
      "received_at": "2026-09-23T02:59:30.000Z",
      "expires_at": "2026-09-23T03:04:30.000Z"
    }
  ]
}
```

- `id`：邮件记录 ID，可用于轮询去重；不要仅用验证码字符串去重。
- `code`：字符串，必须保留前导零，不要转换为整数。
- `received_at`：收件时间，ISO 8601 UTC。
- `expires_at`：验证码显示截止时间（收件后 5 分钟）。这是网站显示规则，不代表发码方的实际有效期。
- `server_time`：服务端时间，可用于纠正设备时间偏差。客户端也应移除过期记录。
- 没有匹配、已过期、白名单不匹配或不存在的哈希均返回 `messages: []`，不是报错。
- 不返回邮件正文、明文收件地址或哈希的逆向结果。

## 5. 错误及轮询

| HTTP 状态 | 原因/处理 |
|---|---|
| 400 | recipient 格式不正确、参数重复或域名未配置。读取 JSON `error` 并修正参数。 |
| 404 | `public_codes` 未开启，或者尚未部署相应版本。 |
| 405 | 使用了非 GET 方法。 |
| 503 | 数据库读取暂时失败；响应为 `{"error":"验证码暂时无法读取，请稍后重试"}`。 |

Cloudflare 等上游还可能返回 HTML/纯文本的 403、429 或 5xx；先检查 HTTP 状态和 Content-Type，不能假设所有错误都是 JSON。
建议正常每 3～5 秒查询一次，同一调用方避免重叠请求；超时设为 10 秒。连续空结果逐步降至 15 秒，失败逐步退避到 60 秒；503 优先遵守 Retry-After 秒数。400/404/405 停止自动重试，修正配置或链接后重新打开页面。
为单次验证码操作设定等待截止时间，成功取得所需验证码后停止轮询。部署改动不会改变 Cloudflare 自身的配额。

## 6. 调用示例

### Python 3（标准库）

```python
import hashlib
import json
from urllib.parse import urlencode
from urllib.request import urlopen

email = "xlcvt@bingtangzhanghao.cn"
prefix, domain = email.strip().rsplit("@", 1)
recipient = hashlib.md5(prefix.strip().lower().encode("utf-8")).hexdigest()
query = urlencode({"recipient": recipient, "domain": domain.lower()})
with urlopen("https://mail.jx3saas.cn/api/codes?" + query, timeout=10) as response:
    result = json.load(response)
messages = result["messages"]
if messages:
    print(messages[0]["code"])  # 保持字符串，保留前导零
```

### Node.js 18+

```javascript
import { createHash } from 'node:crypto';

const prefix = 'xlcvt';
const recipient = createHash('md5').update(prefix.trim().toLowerCase(), 'utf8').digest('hex');
const query = new URLSearchParams({ recipient, domain: 'bingtangzhanghao.cn' });
const response = await fetch('https://mail.jx3saas.cn/api/codes?' + query, {
  signal: AbortSignal.timeout(10000)
});
if (!response.ok) throw new Error('HTTP ' + response.status);
const result = await response.json();
console.log(result.messages[0]?.code ?? '暂无验证码');
```

### curl

```sh
curl --get --max-time 10 'https://mail.jx3saas.cn/api/codes' \
  --data-urlencode 'recipient=4b19a9ed08986b4ab177375cbbafacc5' \
  --data-urlencode 'domain=bingtangzhanghao.cn'
```

浏览器跨站 JavaScript fetch 未开放 CORS；推荐从对接方服务器调用 API，或直接打开验证码页面。Node.js 示例不能直接当作浏览器脚本使用。

## 7. 管理员全量查询及部署

`code_all_recipient` 保持配置**原始自定义值**，不要提前改为 MD5。
调用者对该值按同一规则（trim → 小写 → UTF-8 → MD5）计算后传给 `recipient`，即可查询所有配置域名的最新 5 条；此模式下 `domain` 不缩小查询范围，但若传入仍须是合法配置域名。
空值禁用全量查询。不要把这个全量参数值与真实邮箱前缀设成相同值。

MD5 索引优化版需要先执行 `mail-worker/sql/code-hash-upgrade.sql`，再部署 Worker；不改变 MD5 链接格式。详见 [D1读取优化升级说明](D1读取优化升级说明.md)。历史邮件不回填哈希，升级前五分钟窗口内的旧邮件可能暂时查不到，新收到的邮件正常查询。
后台邮箱页面保持原样；只修改 `/codes` 与 `/api/codes` 的 recipient 协议。
