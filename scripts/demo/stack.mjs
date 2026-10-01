// 本機展示：mock（假的 LINE／Threads／Claude）＋ wrangler dev，不用任何帳號、不花錢。
// 用法：npm run demo（Ctrl+C 結束）。資料放 app/.demo/，加 --fresh 會清掉重來。
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockServer } from '../../test/mocks/mock-server.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(DIR, '..', '..');
const WR = path.join(APP, 'node_modules', '.bin', 'wrangler');
const DEMO = path.join(APP, '.demo');
fs.mkdirSync(DEMO, { recursive: true });
const STATE = path.join(DEMO, 'state');
const DEV_VARS = path.join(DEMO, '.dev.vars');
const MOCK_PORT = Number(process.env.MOCK_PORT || 18931);
const DEV_PORT = Number(process.env.DEV_PORT || 18930);
const INSPECT = Number(process.env.INSPECT_PORT || 18932);
const fresh = process.argv.includes('--fresh');

const SECRETS = {
  LINE_CHANNEL_SECRET: 'rv-line-secret-0123456789',
  LINE_CHANNEL_ACCESS_TOKEN: 'rv-line-token-0123456789',
  LINE_ADMIN_USER_ID: 'U_admin',
  THREADS_APP_ID: '1234567890',
  THREADS_APP_SECRET: 'rv-threads-secret-0123456789',
  ANTHROPIC_API_KEY: 'sk-ant-rv-0123456789',
  DASH_PASSWORD: 'correct-horse-battery',
  SESSION_SECRET: 'rv-session-secret-0123456789abcdef0123456789',
  TOKEN_ENC_KEY: Buffer.alloc(32, 7).toString('base64'),
};
if (fresh) fs.rmSync(STATE, { recursive: true, force: true });
fs.mkdirSync(STATE, { recursive: true });
fs.writeFileSync(DEV_VARS, Object.entries(SECRETS).map(([k, v]) => `${k}="${v}"`).join('\n') + '\n', { mode: 0o600 });

const env = { ...process.env, WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1' };
const mock = await startMockServer({ host: '127.0.0.1', port: MOCK_PORT });
mock.setConfig({ line: { channelAccessToken: SECRETS.LINE_CHANNEL_ACCESS_TOKEN }, anthropic: { apiKey: SECRETS.ANTHROPIC_API_KEY }, threads: { appId: SECRETS.THREADS_APP_ID } });

execFileSync(WR, ['d1', 'migrations', 'apply', 'patrol-db', '--local', '--persist-to', STATE], { cwd: APP, env, stdio: 'inherit' });

const BASE = `http://127.0.0.1:${DEV_PORT}`;
const vars = { PUBLIC_BASE_URL: BASE, LINE_API_BASE: mock.url, LINE_DATA_API_BASE: mock.url, THREADS_API_BASE: mock.url, THREADS_AUTH_URL: `${mock.url}/oauth/authorize`, CLAUDE_API_BASE: mock.url };
const args = ['dev', '--local', '--ip', '127.0.0.1', '--port', String(DEV_PORT), '--inspector-port', String(INSPECT), '--persist-to', STATE, '--env-file', DEV_VARS, '--test-scheduled', '--show-interactive-dev-session=false', '--log-level', 'info', ...Object.entries(vars).flatMap(([k, v]) => ['--var', `${k}:${v}`])];
const log = fs.createWriteStream(path.join(DEMO, 'dev.log'));
const dev = spawn(WR, args, { cwd: APP, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
dev.stdout.pipe(log); dev.stderr.pipe(log);
fs.writeFileSync(path.join(DEMO, 'info.json'), JSON.stringify({ base: BASE, mock: mock.url, secrets: SECRETS, pid: process.pid, devPid: dev.pid }, null, 2));
let stopping = false;
const stop = () => { stopping = true; try { process.kill(-dev.pid, 'SIGTERM'); } catch {} setTimeout(() => process.exit(0), 1500); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
dev.on('exit', (c) => { if (stopping) return; console.log('wrangler dev 意外結束（代碼 ' + c + '），細節看 .demo/dev.log'); process.exit(1); });
console.log('STACK_STARTED', BASE, mock.url);
console.log(`後台：${BASE}/login　密碼：${SECRETS.DASH_PASSWORD}（這是展示用的假密碼）`);
console.log('模擬 LINE：另開一個終端機，跑 npm run demo:line -- text "/說明"');
