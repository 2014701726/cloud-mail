#!/usr/bin/env node
/**
 * 收信桥接：由 MTA（Postfix）把整封原始邮件通过管道喂给本脚本，
 * 再转交给 cloud-mail Worker 的 /_internal/receive。
 *
 * Postfix 配置示例（virtual_alias_maps）：
 *   @example.com   pipe
 * pipe 的命令：
 *   /usr/bin/node /opt/cloud-mail/selfhost/ingest.mjs
 *
 * 退出码：0 表示已接收/已拒收（不再重试），75 表示临时失败（Postfix 会重试）。
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

const workerUrl = (process.env.WORKER_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
const secret = process.env.INGEST_SECRET || '';
const recipient = (process.env.RECIPIENT || process.env.ORIGINAL_RECIPIENT || '').trim();
const sender = (process.env.SENDER || '').trim();

if (!secret) {
	console.error('[ingest] 缺少 INGEST_SECRET');
	process.exit(75);
}

if (!recipient) {
	console.error('[ingest] 缺少 RECIPIENT（Postfix 未传收件人）');
	process.exit(75);
}

async function readStdin() {
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(chunk);
	return Buffer.concat(chunks);
}

function forwardBySendmail(rawBuffer, from, targets) {
	const binary = ['/usr/sbin/sendmail', '/usr/lib/sendmail'].find((p) => existsSync(p));
	if (!binary) {
		console.error('[ingest] 找不到 sendmail，跳过转发', targets.join(','));
		return;
	}
	const child = spawn(binary, ['-i', '-f', from || 'postmaster@localhost', ...targets]);
	child.on('error', (e) => console.error('[ingest] 转发失败：', e.message));
	child.stdin.end(rawBuffer);
}

const raw = await readStdin();

if (raw.length === 0) {
	console.error('[ingest] 空邮件，丢弃');
	process.exit(0);
}

let response;
try {
	response = await fetch(`${workerUrl}/_internal/receive`, {
		method: 'POST',
		headers: {
			'content-type': 'message/rfc822',
			'x-ingest-secret': secret,
			'x-envelope-to': recipient,
			'x-envelope-from': sender
		},
		body: raw
	});
} catch (e) {
	console.error(`[ingest] 无法连接 ${workerUrl}：${e.message}`);
	process.exit(75);
}

let data = {};
try {
	data = await response.json();
} catch {
	// 忽略：下面按状态码处理
}

if (response.ok && data.ok) {
	if (Array.isArray(data.forward) && data.forward.length > 0) {
		forwardBySendmail(raw, sender, data.forward);
	}
	process.exit(0);
}

if (response.ok && data.rejected) {
	console.warn(`[ingest] 已按业务规则拒收 ${recipient}：${data.rejected}`);
	process.exit(0);
}

console.error(`[ingest] 接收失败 HTTP ${response.status}`, data.error || '');
process.exit(75);
