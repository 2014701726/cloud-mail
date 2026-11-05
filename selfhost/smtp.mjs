#!/usr/bin/env node
/**
 * 内置 SMTP 收信服务（可选，替代宿主机 Postfix）。
 *
 * 只做一件事：接收本域邮件 -> POST 原始邮件到 Worker 的 /_internal/receive。
 * 没有反垃圾、反病毒能力，适合个人/小规模验证码收件场景；
 * 对外的正式邮件服务建议仍使用 Postfix / Maddy / docker-mailserver。
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SMTPServer } from 'smtp-server';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

const PORT = Number(process.env.SMTP_PORT || 25);
const HOST = process.env.SMTP_HOST || '0.0.0.0';
const WORKER_URL = (process.env.WORKER_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
const SECRET = process.env.INGEST_SECRET || '';
const DOMAINS = (process.env.MAIL_DOMAINS || '')
	.split(',')
	.map((item) => item.trim().replace(/^@/, '').toLowerCase())
	.filter(Boolean);
const MAX_SIZE = Number(process.env.SMTP_MAX_SIZE || 30 * 1024 * 1024);

if (!SECRET) {
	console.error('[smtp] 缺少 INGEST_SECRET');
	process.exit(1);
}

const tls = (() => {
	const certFile = process.env.TLS_CERT_FILE;
	const keyFile = process.env.TLS_KEY_FILE;
	if (certFile && keyFile && existsSync(certFile) && existsSync(keyFile)) {
		return { cert: readFileSync(certFile), key: readFileSync(keyFile) };
	}
	return null;
})();

function log(...args) {
	console.log(`[smtp ${new Date().toISOString()}]`, ...args);
}

async function deliver(recipient, sender, raw) {
	const res = await fetch(`${WORKER_URL}/_internal/receive`, {
		method: 'POST',
		headers: {
			'content-type': 'message/rfc822',
			'x-ingest-secret': SECRET,
			'x-envelope-to': recipient,
			'x-envelope-from': sender
		},
		body: raw
	});

	let data = {};
	try {
		data = await res.json();
	} catch {
		// 忽略
	}

	if (res.ok && data.ok) return { ok: true, forward: data.forward || [] };
	if (res.ok && data.rejected) return { ok: true, rejected: data.rejected };

	const error = new Error(`worker HTTP ${res.status}: ${data.error || 'unknown'}`);
	// 4xx/5xx 都按临时失败处理，交给对端重试，避免丢信。
	error.responseCode = 451;
	throw error;
}

const server = new SMTPServer({
	name: 'cloud-mail',
	banner: 'cloud-mail self-hosted ESMTP',
	size: MAX_SIZE,
	authOptional: false,
	disabledCommands: ['AUTH'],
	hideSTARTTLS: !tls,
	...(tls || {}),
	logger: false,
	onRcptTo(address, session, callback) {
		const domain = (address.address.split('@').pop() || '').toLowerCase();
		if (DOMAINS.length > 0 && !DOMAINS.includes(domain)) {
			log('拒绝收件域', address.address);
			return callback(new Error('Relay access denied: unknown domain'));
		}
		callback();
	},
	onData(stream, session, callback) {
		const chunks = [];
		stream.on('data', (chunk) => chunks.push(chunk));
		stream.on('error', (e) => callback(e));
		stream.on('end', async () => {
			const raw = Buffer.concat(chunks);
			const sender = session.envelope.mailFrom?.address || '';
			const recipients = (session.envelope.rcptTo || []).map((item) => item.address);

			for (const recipient of recipients) {
				try {
					const result = await deliver(recipient, sender, raw);
					if (result.rejected) {
						log(`拒收 ${recipient}：${result.rejected}`);
					} else {
						log(`接收 ${recipient} <- ${sender || '(null)'} (${raw.length} bytes)${result.forward.length ? ' 转发 ' + result.forward.join(',') : ''}`);
					}
				} catch (e) {
					log(`投递失败 ${recipient}：${e.message}`);
					return callback(e);
				}
			}

			callback();
		});
	}
});

server.on('error', (e) => {
	console.error('[smtp] 服务异常：', e);
});

server.listen(PORT, HOST, () => {
	log(`监听 ${HOST}:${PORT}${tls ? ' (STARTTLS 已启用)' : ''}`);
	log(`接受域名：${DOMAINS.join(', ') || '（未限制）'}`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
