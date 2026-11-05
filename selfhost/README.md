# 把 cloud-mail 从 Cloudflare 迁到自己的 Linux 服务器

`cloud-mail` 是围绕 Cloudflare 平台写的：Workers 运行时、D1 数据库、KV、R2 对象存储、Email Routing 收信、Workers AI 识别验证码、Cron Triggers。它**没有官方自建版本**，把代码直接 `rsync` 到 Linux 服务器是跑不起来的。

这个目录（`selfhost/`）提供的做法是：**保持 Workers 代码不变，用 Cloudflare 官方的 `workerd` 运行时（通过 Miniflare）在本机把 D1 / KV / R2 / 静态资源全部模拟出来**，只替换"平台"这一层。收信从 Email Routing 换成 SMTP 投递，发信继续用 Resend。

---

## 1. Cloudflare 依赖 → 自建替代

| Cloudflare 能力 | 代码里用在哪 | 自建后 |
| --- | --- | --- |
| Workers 运行时 | 全部后端 | `workerd`（Miniflare 4） |
| D1（SQLite） | `env.db`，drizzle ORM | 本地 SQLite 文件 `data/d1/*.sqlite` |
| KV | `env.kv`，登录 token、设置缓存、计数 | 本地 KV `data/kv` |
| R2 | `env.r2`，附件/背景图 | 本地对象目录 `data/r2`（后台也可切 S3/MinIO） |
| Assets | `env.assets.fetch` 返回 Vue 前端 | `mail-worker/dist` 目录 |
| Email Routing（收信） | `email()` 处理器 | 内置 SMTP 服务 或 Postfix 管道 → `/_internal/receive` |
| Cron Triggers | 每小时清理、日发送量重置 | `server.mjs` 内置定时器 → `/_internal/scheduled` |
| Workers AI | 验证码识别兜底 | **不可用**；正则识别照常工作（`code-service.js`） |
| 发信（Resend / CF Email） | 站外发信 | 保留 Resend（HTTP API），后台按域名配 token |

> 也就是说：**收信、Web、数据库、附件都能自建；只有 Workers AI 的"AI 兜底识别"会失去**。验证码本身仍由正则提取，日常够用。

---

## 2. 方案选择

| 方案 | 工作量 | 适合 |
| --- | --- | --- |
| **A. 本目录（推荐）** | 只加一层运行时，业务代码零改动 | 想保留现有数据和功能，快速搬下 Cloudflare |
| B. 改写为 Node 常驻服务 | 大：替换 D1/KV/R2 驱动、Email 处理 | 长期维护、想彻底摆脱 Workers 模型 |
| C. 继续用 Cloudflare | 无 | 收信、AI、免运维都是白送的，成本最低 |
| D. 换更轻的项目 | 小 | 只需要"收验证码"，见文末"如果只是要验证码收件箱" |

方案 A 已验证可跑通：注册、登录、收信、`/codes` 验证码页面、附件存储、定时任务。

---

## 3. 架构

```
                      ┌──────────────── 你的 Linux 服务器 ────────────────┐
  互联网 MX  ──25──▶  │  SMTP 收信（内置 smtp.mjs 或 Postfix）             │
                      │        │ POST 原始邮件 + 信封收件人                 │
                      │        ▼                                          │
  浏览器 ──443──▶ Nginx ──▶ 127.0.0.1:8787  server.mjs                  │
                      │        │                                          │
                      │        ▼                                          │
                      │  Miniflare / workerd（原 Workers 代码）            │
                      │   ├─ D1  → data/d1/*.sqlite                        │
                      │   ├─ KV  → data/kv                                 │
                      │   ├─ R2  → data/r2                                 │
                      │   └─ Assets → mail-worker/dist                     │
                      └───────────────────────────────────────────────────┘
                                    │
                                    └── HTTPS ──▶ Resend（站外发信）
```

---

## 4. 前置条件

1. 一台 Linux 服务器（Ubuntu 22.04/24.04、Debian 12 均可，x86_64 或 arm64）。
   - 内存 ≥ 1 GB（workerd 常驻约 100–200 MB）。
2. 一个域名，能改 DNS。
3. **入站 25 端口可用**（关键，见 §8）。
4. 发信：`resend.com` 免费额度，或你自己的 SMTP 中继。
5. 软件：Docker 24+（推荐），或者 Node.js 22 + pnpm。

---

## 5. Docker 部署（推荐）

```bash
# 1) 把项目放到服务器
sudo mkdir -p /opt/cloud-mail && cd /opt/cloud-mail
# 用 git clone，或把本地 cloud-mail 目录上传到 /opt/cloud-mail

# 2) 准备配置
cd /opt/cloud-mail/selfhost
cp .env.example .env
nano .env          # 至少改 JWT_SECRET / ADMIN_EMAIL / MAIL_DOMAINS / INGEST_SECRET

# 3) 构建（在容器内编译前端 + 打包 Worker，不访问 Cloudflare）
docker compose build

# 4) 启动 Web/API
docker compose up -d cloud-mail

# 5) 如果要内置 SMTP 收信（不用宿主机 Postfix）
docker compose --profile smtp up -d
```

`.env` 示例：

```dotenv
PORT=8787
HOST=127.0.0.1
DATA_DIR=data

JWT_SECRET=换成 32 位以上随机串
ADMIN_EMAIL=admin@example.com
MAIL_DOMAINS=example.com
INGEST_SECRET=再换一个随机串

CATCH_ALL_ADMIN=true
PUBLIC_CODES=true
CODE_ALL_RECIPIENT=all
CODE_ALLOWED_SENDERS=
AI_MODEL=
```

生成随机串：`openssl rand -hex 24`。

`docker-compose.yml` 里 `cloud-mail` 只绑定 `127.0.0.1:8787`，由宿主机 Nginx 反代；`smtp` 服务用 `profiles: ["smtp"]` 单独开启。

---

## 6. 不用 Docker（Node + systemd）

```bash
# Node 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
sudo corepack enable

sudo mkdir -p /opt/cloud-mail
# 上传 cloud-mail 目录到 /opt/cloud-mail
sudo useradd -r -s /usr/sbin/nologin cloudmail || true

cd /opt/cloud-mail
# 安装依赖（mail-worker 的 wrangler 用来离线打包）
(cd mail-worker && pnpm install --frozen-lockfile)
(cd mail-vue   && pnpm install --frozen-lockfile)
(cd selfhost   && pnpm install --frozen-lockfile)

# 构建产物：mail-worker/dist + selfhost/build/index.js
cd selfhost && pnpm run build

# 配置
cp .env.example .env && nano .env

# 权限
sudo chown -R cloudmail:cloudmail /opt/cloud-mail

# systemd
sudo cp cloud-mail.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now cloud-mail
sudo journalctl -u cloud-mail -f
```

> `pnpm run build` 只做两件事：编译 Vue 前端、用 `wrangler deploy --dry-run` **本地打包** Worker。全程不需要登录 Cloudflare。

---

## 7. 首次初始化与管理员

`server.mjs` 启动时会自动执行一次数据库初始化（等价于访问 `/api/init/<JWT_SECRET>`），日志里看到：

```
[cloud-mail] 数据库初始化：HTTP 200 success
```

然后用**管理员邮箱**注册账号，注册的同时会自动建好该邮箱的账号（收件箱）：

1. 浏览器打开 `http://服务器/`（或 Nginx 配置的域名）。
2. 点"注册"，邮箱填 `.env` 里的 `ADMIN_EMAIL`，设置密码（≥ 6 位）。
3. 注册成功后这个账号就是管理员（代码里用 `user.email === env.admin` 判定），可以看到所有用户和邮件。

如果注册被"人机验证"拦住（Turnstile 需要 CF 站点密钥，自建环境没有），在数据库里关掉：

```bash
sqlite3 /opt/cloud-mail/selfhost/data/d1/miniflare-D1DatabaseObject/*.sqlite \
  "UPDATE setting SET register_verify = 1;"   # 1 = 关闭
```

---

## 8. 收信配置

### 8.1 内置 SMTP（最简单）

`docker compose --profile smtp up -d` 已包含，或在 systemd 环境注意：`smtp.mjs` 是另一个进程，需要单独起一个 service（把 `ExecStart` 改成 `node smtp.mjs`，`SMTP_PORT=25`）。

要点：

- 只接受 `MAIL_DOMAINS` 里的域名，其他域一律 `550 Relay access denied`。
- 收下后立刻转给 Worker，Worker 返回失败时给对端 `451`（对方会重试），不会丢信。
- 没有反垃圾/反病毒；无自身 TLS 时需要在 `.env` 里给证书才启用 STARTTLS：

```dotenv
TLS_CERT_FILE=/certs/fullchain.pem
TLS_KEY_FILE=/certs/privkey.pem
SMTP_MAX_SIZE=31457280
```

证书可放在 `selfhost/smtp-certs/`（compose 已挂载到 `/certs`）。

### 8.2 宿主机 Postfix（更稳，有队列/重试/TLS）

```bash
sudo apt install -y postfix   # 选择 "Internet Site"，system mail name 填 example.com
```

`/etc/postfix/main.cf` 增加（`example.com` 换成你的域名）：

```
relay_domains = example.com
transport_maps = hash:/etc/postfix/transport
```

`/etc/postfix/transport`：

```
example.com   cloudmail:
```

`/etc/postfix/master.cf` 末尾增加自定义 transport（注意第二行开头是空格）：

```
cloudmail  unix  -       n       n       -       -       pipe
  flags=DRhu user=cloudmail argv=/usr/bin/node /opt/cloud-mail/selfhost/ingest.mjs
```

```bash
sudo postmap /etc/postfix/transport
sudo systemctl reload postfix
```

> 用 `relay_domains` + 自定义 transport 是为了让 Postfix 把整封邮件（含原始 MIME）通过管道交给脚本，并且保留队列重试能力。`user=cloudmail` 要能读到 node 和脚本，且 `ingest.mjs` 能连到 `127.0.0.1:8787`。

`ingest.mjs` 从 Postfix 拿 `$RECIPIENT` / `$SENDER`，把 stdin 的原始邮件 POST 给 Worker；返回码 `0`（收下/拒收）或 `75`（临时失败，Postfix 重试）。它的配置和后端一致：

```dotenv
WORKER_URL=http://127.0.0.1:8787
INGEST_SECRET=和 app 相同
```

测试投递：

```bash
echo -e "Subject: t\n\n验证码为:123456" | RECIPIENT=admin@example.com SENDER=a@b.com node ingest.mjs
```

> 两种方式选一个即可。**不要同时**让 Postfix 和内置 SMTP 抢 25 端口。

---

## 9. DNS 记录

以 `example.com`、服务器 IP `1.2.3.4` 为例：

| 类型 | 名称 | 值 | 说明 |
| --- | --- | --- | --- |
| A | `mail.example.com` | `1.2.3.4` | Web 入口 |
| A | `example.com` | `1.2.3.4` | 可选 |
| MX | `example.com` | `10 mail.example.com.` | 收信必须 |
| TXT | `example.com` | `v=spf1 mx ~all` | 允许本机发信；如果用 Resend 发信，用 Resend 给的那条 SPF（见后台） |
| TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:admin@example.com` | 先监控 |
| PTR | 1.2.3.4 | `mail.example.com` | 在 VPS 控制台设置，很多收件方会查 |

**DKIM**：自建发信才需要，本项目默认走 Resend 发信，DKIM 由 Resend 的域名验证提供（在 Resend 后台拿到 3 条 TXT/CNAME 记录填上）。

**关于 25 端口**：阿里云/腾讯云等国内云默认封禁入站 25，需要备案后提交"解封 25 端口"申请；国外 VPS（Hetzner、Oracle、Vultr 等）多数可用，但部分商家也封。如果 25 确实不可用，只能：

- 收信继续放在 Cloudflare Email Routing（免费转发），但那就还是"半 Cloudflare"方案；
- 或者用第三方收信服务把邮件转发到你的 HTTP 入口（自己写转发规则）。

先测端口是否通：

```bash
# 在服务器上
sudo ss -lntp | grep :25
# 在外部机器上
nc -vz 你的域名 25
```

---

## 10. 发信（可选）

自建后没有 Cloudflare 的 `send_email` 绑定，站外发信走 Resend：

1. 在 <https://resend.com> 建账号，添加并验证你的域名（按它给的 DNS 记录配置）。
2. 生成 API Key。
3. 登录 cloud-mail 后台 → 设置 → 找到 Resend Token（按域名配置）填入。

不配置也能用：站内邮箱互发不受影响；`/codes`、收信都不需要发信能力。

---

## 11. 从 Cloudflare 迁移现有数据

### 11.1 D1 数据库

```bash
# 本地（已登录 Cloudflare 的机器上）
npx wrangler d1 export cloud-mail --remote --output cloud-mail-dump.sql
# 上传到服务器后
sudo systemctl stop cloud-mail
cd /opt/cloud-mail/selfhost
sqlite3 data/d1/miniflare-D1DatabaseObject/*.sqlite < /tmp/cloud-mail-dump.sql
sudo systemctl start cloud-mail
```

> 数据库文件名是一串哈希，用通配符即可（只有一个）。导入的是完整 schema + 数据；`server.mjs` 启动时的初始化会自动跳过已存在的表和字段。
>
> 导入前建议先备份：`cp data/d1/miniflare-D1DatabaseObject/*.sqlite /tmp/backup.sqlite`。

### 11.2 R2 附件

Miniflare 的 R2 是 SQLite + 文件结构，**不能直接把导出文件丢进 `data/r2`**。两种做法：

- **推荐**：在后台把附件存储改成 S3（MinIO/腾讯 COS/阿里 OSS 等），然后用 `rclone` 把 Cloudflare R2 桶同步过去，key 不变，历史附件继续可下载。
- **省事**：验证码邮件基本没有附件，旧附件丢失可以接受，那就只迁数据库。

### 11.3 KV

不用迁。里面只有登录 token、设置缓存、每日发送计数，初始化时重建即可（`setting` 缓存由启动时的 init 重新写入）。

---

## 12. 运维

**备份**（数据全在 `selfhost/data`）：

```bash
sudo systemctl stop cloud-mail
tar czf /backup/cloud-mail-$(date +%F).tar.gz -C /opt/cloud-mail/selfhost data
sudo systemctl start cloud-mail
```

**升级**（拉取上游新代码后重新构建，数据不丢）：

```bash
git pull            # 或替换源码
cd selfhost && docker compose build && docker compose up -d cloud-mail
# systemd 方式：pnpm run build && systemctl restart cloud-mail
```

**日志**：

```bash
docker compose logs -f cloud-mail
# 或 journalctl -u cloud-mail -f
```

**常见问题**

| 现象 | 原因 |
| --- | --- |
| 页面 502 | `server.mjs` 没起或端口不对，看日志 |
| `数据库未初始化` | 初始化失败，检查 `JWT_SECRET` 是否一致、日志里的 init 报错 |
| 收信没有条目但 SMTP 返回 250 | 收件地址不在 `MAIL_DOMAINS` 里，或 `catch_all_admin` 找不到管理员账号（先注册 `ADMIN_EMAIL`） |
| 收信 451 / 反复重试 | Worker 返回 5xx，看 `docker compose logs` 里"邮件接收异常" |
| 附件 404 | 存储类型是 R2 但数据没迁，或 S3 配置不全 |
| 发送报"未配置发信服务" | 后台没填 Resend Token |

---

## 13. 与 Cloudflare 版的差异

- **没有 Workers AI**：验证码靠 `code-service.js` 里的正则；`AI_MODEL` 留空即可。
- **没有 Email Routing 的高级能力**：别名、catch-all、拒收策略要自己用 SMTP/Postfix 规则实现；项目内的"未注册地址归管理员"逻辑（`CATCH_ALL_ADMIN`）仍然有效。
- **单进程**：Miniflare 是单实例运行时，不要开多副本共享同一个 `data` 目录（SQLite 会锁）。
- **性能量级**：和 CF 边缘网络没法比，但个人/小团队验证码收件场景完全够用（本机实测收信→页面可见是毫秒级）。
- **Cloudflare 部署未被破坏**：`/_internal/*` 路由只有在设置了 `INGEST_SECRET` 时才存在，`mail-worker/wrangler.toml` 仍是原配置，随时可以 `wrangler deploy` 回 CF。

---

## 14. 如果只是要"验证码收件箱"

这个仓库根目录的 `app.py`（Flask + IMAP）本来就是干这件事的，不需要域名 MX、不需要 25 端口、不需要迁移，`systemd` + `nginx` 十分钟就能跑起来。如果你要的只是"网页上看验证码"，用那个更省事；`cloud-mail` 的价值在于多用户、多域名、可发信的完整邮箱平台。

---

## 附：本目录文件

| 文件 | 作用 |
| --- | --- |
| `server.mjs` | 生产运行时：Miniflare + HTTP 服务 + 每小时定时任务 + 启动时初始化 |
| `smtp.mjs` | 可选的内置 SMTP 收信服务（25 端口） |
| `ingest.mjs` | Postfix 管道收信脚本（读 stdin → POST 给 Worker） |
| `build.mjs` | 构建前端 + 离线打包 Worker |
| `Dockerfile` / `docker-compose.yml` | 容器化部署 |
| `nginx-cloud-mail.conf` | Nginx 反代示例（含 `/_internal/` 屏蔽） |
| `cloud-mail.service` | systemd 单元 |
| `.env.example` | 配置模板 |
| `../mail-worker/wrangler.selfhost.toml` | 自建打包用的 wrangler 配置（本地 D1/KV/R2 绑定） |
| `../mail-worker/src/selfhost/ingest.js` | Worker 内部的收信入口（`/_internal/receive`） |
