#!/usr/bin/env node
/**
 * 构建自建部署产物：
 *   1. 编译 Vue 前端 -> mail-worker/dist
 *   2. 用 wrangler 离线打包 Worker -> selfhost/build/index.js（不登录、不上传）
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MAIL_VUE = path.join(ROOT, 'mail-vue');
const MAIL_WORKER = path.join(ROOT, 'mail-worker');
const WRANGLER = path.join(MAIL_WORKER, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

// 兼容 npm / pnpm / yarn 触发 `run build` 的情况。
function packageManager() {
	const execPath = process.env.PNPM_SCRIPT || process.env.npm_execpath;
	if (execPath && existsSync(execPath) && /\.(c?js|mjs)$/i.test(execPath)) {
		return [process.execPath, execPath];
	}
	return ['pnpm', null];
}

function run(command, args, cwd) {
	console.log(`\n$ ${command} ${args.join(' ')}   (${cwd})`);
	const result = spawnSync(command, args, {
		cwd,
		stdio: 'inherit',
		shell: process.platform === 'win32' && !path.isAbsolute(command)
	});
	if (result.error) {
		console.error(`无法执行 ${command}：${result.error.message}`);
		process.exit(1);
	}
	if (result.status !== 0) {
		console.error(`命令失败（退出码 ${result.status}）：${command} ${args.join(' ')}`);
		process.exit(result.status ?? 1);
	}
}

if (!existsSync(WRANGLER)) {
	console.error(`找不到 wrangler：${WRANGLER}\n请先在 mail-worker 目录安装依赖`);
	process.exit(1);
}

const [pmCommand, pmScript] = packageManager();
const pmArgs = pmScript ? [pmScript] : [];

if (!existsSync(path.join(MAIL_VUE, 'node_modules'))) {
	run(pmCommand, [...pmArgs, 'install'], MAIL_VUE);
}

run(pmCommand, [...pmArgs, 'run', 'build'], MAIL_VUE);

run(process.execPath, [
	WRANGLER,
	'deploy',
	'--dry-run',
	'--config',
	path.join(MAIL_WORKER, 'wrangler.selfhost.toml'),
	'--outdir',
	path.join(__dirname, 'build')
], __dirname);

console.log('\n构建完成：');
console.log(`  Worker  ${path.join(__dirname, 'build', 'index.js')}`);
console.log(`  前端    ${path.join(MAIL_WORKER, 'dist')}`);
