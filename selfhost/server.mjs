#!/usr/bin/env node
/**
 * cloud-mail 自建运行时。
 *
 * Cloudflare Workers 的代码本身没有改，这里用 Miniflare（Cloudflare 官方
 * workerd 运行时）在本地模拟 D1 / KV / R2 / Assets，替代 Cloudflare 平台。
 *
 *   D1  -> 本地 SQLite 文件（data/d1）
 *   KV  -> 本地键值存储（data/kv）
 *   R2  -> 本地对象目录（data/r2，也可在后台改成 S3/MinIO）
 *   Assets -> mail-worker/dist（Vue 前端）
 *
 * 收信不走 Cloudflare Email Routing，改由 selfhost/ingest.mjs 调用
 * /_internal/receive 注入。定时任务由本进程每小时触发 /_internal/scheduled。
 */
import http from 'node:http';
import path from 'node:path';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Miniflare, Log, LogLevel } from 'miniflare';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// 关闭 Miniflare 对 Request.cf 的联网探测，避免每次请求等待外部接口超时。
process.env.CLOUDFLARE_CF_FETCH_ENABLED = 'false';

/* ------------------------------------------------------------------ *
 * 1. 配置：环境变量优先，其次读取 selfhost/.env
 * ------------------------------------------------------------------ */
function loadDotEnv(file) {
	if (!existsSync(file)) return;
	for (const rawLine of readFileSync(file, 'utf8').split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith('#')) continue;
		const eq = line.indexOf('=');
		if (eq < 1) continue;
		const key = line.slice(0, eq).trim();
		let value = line.slice(eq + 1).trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		if (process.env[key] === undefined) process.env[key] = value;
	}
}

loadDotEnv(path.join(__dirname, '.env'));

const env = process.env;

function required(name) {
	const value = (env[name] || '').trim();
	if (!value) {
		console.error(`[cloud-mail] 缺少必需的环境变量 ${name}，请检查 selfhost/.env`);
		process.exit(1);
	}
	return value;
}

const PORT = Number(env.PORT || 8787);
const HOST = env.HOST || '127.0.0.1';
const DATA_DIR = path.resolve(__dirname, env.DATA_DIR || 'data');

const JWT_SECRET = required('JWT_SECRET');
const ADMIN_EMAIL = required('ADMIN_EMAIL');
const DOMAINS = required('MAIL_DOMAINS')
	.split(',')
	.map((item) => item.trim().replace(/^@/, '').toLowerCase())
	.filter(Boolean);

if (DOMAINS.length === 0) {
	console.error('[cloud-mail] MAIL_DOMAINS 不能为空');
	process.exit(1);
}

function csv(value) {
	return (value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function boolString(value, fallback) {
	if (value === undefined || value === '') return fallback;
	return String(value).toLowerCase() === 'true' ? 'true' : 'false';
}

const bindings = {
	// 业务变量（与 wrangler.toml 的 [vars] 对应）
	domain: DOMAINS,
	admin: ADMIN_EMAIL,
	jwt_secret: JWT_SECRET,
	catch_all_admin: boolString(env.CATCH_ALL_ADMIN, 'true'),
	public_codes: boolString(env.PUBLIC_CODES, 'true'),
	code_all_recipient: env.CODE_ALL_RECIPIENT || '',
	code_allowed_senders: csv(env.CODE_ALLOWED_SENDERS),
	ai_model: env.AI_MODEL || '',
	// 自建专用：收信/定时任务的共享密钥
	INGEST_SECRET: required('INGEST_SECRET')
};

// 注意：drizzle 的 logger 只接受布尔值或 Logger 对象，字符串会导致启动即报错。
if (String(env.ORM_LOG).toLowerCase() === 'true') {
	bindings.orm_log = true;
}

if (env.PROJECT_LINK) {
	bindings.project_link = env.PROJECT_LINK;
}

const WORKER_SCRIPT = path.join(__dirname, 'build', 'index.js');
const ASSETS_DIR = path.resolve(ROOT, 'mail-worker', 'dist');

if (!existsSync(WORKER_SCRIPT)) {
	console.error(`[cloud-mail] 找不到 Worker 构建产物：${WORKER_SCRIPT}\n请先执行 npm run build`);
	process.exit(1);
}

mkdirSync(DATA_DIR, { recursive: true });

/* ------------------------------------------------------------------ *
 * 2. 启动 Miniflare
 * ------------------------------------------------------------------ */
const mf = new Miniflare({
	modules: true,
	scriptPath: WORKER_SCRIPT,
	compatibilityDate: '2025-06-04',
	d1Databases: { db: 'cloud-mail' },
	kvNamespaces: { kv: 'cloud-mail-kv' },
	r2Buckets: { r2: 'cloud-mail-r2' },
	d1Persist: path.join(DATA_DIR, 'd1'),
	kvPersist: path.join(DATA_DIR, 'kv'),
	r2Persist: path.join(DATA_DIR, 'r2'),
	assets: {
		directory: ASSETS_DIR,
		binding: 'assets',
		routerConfig: {
			invoke_user_worker_ahead_of_assets: true,
			has_user_worker: true
		},
		assetConfig: {
			not_found_handling: 'single-page-application',
			html_handling: 'auto-trailing-slash'
		}
	},
	bindings,
	log: new Log(LogLevel.WARN)
});

/* ------------------------------------------------------------------ *
 * 3. 数据库初始化（等价于访问 /api/init/:secret）
 * ------------------------------------------------------------------ */
async function ensureDatabase() {
	const res = await mf.dispatchFetch(`http://localhost/api/init/${encodeURIComponent(JWT_SECRET)}`);
	const text = await res.text();
	console.log(`[cloud-mail] 数据库初始化：HTTP ${res.status} ${text.slice(0, 120)}`);
}

/* ------------------------------------------------------------------ *
 * 4. 定时任务（等价于 Cloudflare Cron Triggers）
 * ------------------------------------------------------------------ */
async function runCron() {
	try {
		const res = await mf.dispatchFetch('http://localhost/_internal/scheduled?cron=0+*+*+*+*', {
			method: 'POST',
			headers: { 'x-ingest-secret': bindings.INGEST_SECRET }
		});
		console.log(`[cloud-mail] 定时任务：HTTP ${res.status}`);
	} catch (e) {
		console.error('[cloud-mail] 定时任务失败：', e);
	}
}

function scheduleCron() {
	const now = new Date();
	const next = new Date(now);
	next.setMinutes(0, 0, 0);
	next.setHours(next.getHours() + 1);
	const delay = next - now;
	setTimeout(() => {
		runCron();
		setInterval(runCron, 60 * 60 * 1000);
	}, delay).unref();
	console.log(`[cloud-mail] 下一次定时任务：${next.toISOString()}`);
}

/* ------------------------------------------------------------------ *
 * 5. HTTP 服务
 * ------------------------------------------------------------------ */
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade']);

function headersToObject(headers) {
	const obj = {};
	headers.forEach((value, key) => {
		if (!HOP_BY_HOP.has(key.toLowerCase())) obj[key] = value;
	});
	return obj;
}

async function readBody(req) {
	const chunks = [];
	for await (const chunk of req) chunks.push(chunk);
	return chunks.length ? Buffer.concat(chunks) : undefined;
}

const server = http.createServer(async (req, res) => {
	try {
		const host = req.headers.host || `${HOST}:${PORT}`;
		const url = `http://${host}${req.url || '/'}`;
		const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);

		const response = await mf.dispatchFetch(url, {
			method: req.method,
			headers: req.headers,
			body,
			redirect: 'manual'
		});

		const outHeaders = {};
		response.headers.forEach((value, key) => {
			if (HOP_BY_HOP.has(key.toLowerCase())) return;
			if (key.toLowerCase() === 'set-cookie') return;
			outHeaders[key] = value;
		});

		const cookies = typeof response.headers.getSetCookie === 'function'
			? response.headers.getSetCookie()
			: [];
		if (cookies.length > 0) {
			outHeaders['set-cookie'] = cookies;
		} else {
			const single = response.headers.get('set-cookie');
			if (single) outHeaders['set-cookie'] = single;
		}

		res.writeHead(response.status, outHeaders);
		const buffer = Buffer.from(await response.arrayBuffer());
		res.end(buffer);
	} catch (e) {
		console.error('[cloud-mail] 请求处理失败：', e);
		if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
		res.end('Internal Server Error');
	}
});

server.requestTimeout = 0;
server.headersTimeout = 60_000;

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

async function shutdown() {
	console.log('[cloud-mail] 正在停止……');
	server.close();
	await mf.dispose();
	process.exit(0);
}

server.listen(PORT, HOST, async () => {
	console.log(`[cloud-mail] 监听 http://${HOST}:${PORT}`);
	console.log(`[cloud-mail] 数据目录 ${DATA_DIR}`);
	console.log(`[cloud-mail] 收件域名 @${DOMAINS.join(', @')}`);
	await ensureDatabase();
	scheduleCron();
});
