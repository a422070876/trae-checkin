/**
 * Trae CN 每日自动签到 —— 云端版
 * 适用：GitHub Actions / 任意 Node 18+ 的常开设备（无需安装 Trae，也不读取本机数据）
 * 登录凭据来源：环境变量 TRAE_CREDENTIALS（JSON 字符串）或同目录 credentials.json
 * 只发请求，不解密、不打印 token
 */
const fs = require('fs');
const path = require('path');

const STATUS_URL = 'https://api.trae.cn/trae/api/v2/ug/checkin_credits/status';
const CLAIM_URL = 'https://api.trae.cn/trae/api/v2/ug/checkin_credits/claim';
const MAX_ATTEMPTS = 24;        // 每个阶段最多尝试次数
const RETRY_MIN_MS = 8000;      // 首次重试等待
const RETRY_MAX_MS = 90000;     // 单次等待上限
const RETRY_BUDGET_MS = 11 * 60 * 1000; // 总重试预算（workflow 超时 15 分钟）
const RETRYABLE_CODES = new Set([9074, 429, 500, 502, 503, 504]);

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// 指数退避 + 抖动：8s, 16s, 32s, 64s, 90s, 90s...
const backoff = (attempt) => {
  const base = Math.min(RETRY_MIN_MS * Math.pow(2, attempt - 1), RETRY_MAX_MS);
  return Math.round(base * (0.8 + Math.random() * 0.4));
};

function fail(msg) {
  log(`ERROR: ${msg}`);
  process.exit(1);
}

function loadCreds() {
  const raw = process.env.TRAE_CREDENTIALS;
  if (raw && raw.trim()) {
    try { return JSON.parse(raw); } catch (_) { fail('环境变量 TRAE_CREDENTIALS 不是合法 JSON'); }
  }
  const p = path.join(__dirname, 'credentials.json');
  if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  fail('未找到登录凭据：请设置 TRAE_CREDENTIALS 或在本目录放置 credentials.json');
}

function jwtExpireAt(token) {
  try {
    const p = token.split('.')[1];
    if (!p) return null;
    const json = Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const exp = JSON.parse(json).exp;
    return exp ? new Date(exp * 1000) : null;
  } catch (_) { return null; }
}

function isRetryable(res, j) {
  if (res && (res.status === 429 || res.status >= 500)) return true;
  if (j && RETRYABLE_CODES.has(j.code)) return true;
  if (j && typeof j.message === 'string' && /频繁|繁忙|稍后|busy|rate/i.test(j.message)) return true;
  return false;
}

async function postJson(url, headers, budgetMs = RETRY_BUDGET_MS) {
  const startedAt = Date.now();
  let lastErr = 'unknown';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify({}) });
      const j = await res.json();
      if (isRetryable(res, j)) {
        lastErr = `code=${j.code ?? res.status} ${j.message || ''}`.trim();
        const usedSec = Math.round((Date.now() - startedAt) / 1000);
        log(`服务器繁忙(${lastErr})，第 ${attempt}/${MAX_ATTEMPTS} 次，已等待 ${usedSec}s`);
      } else {
        return j;
      }
    } catch (e) {
      lastErr = e.message;
      log(`请求异常: ${e.message}，第 ${attempt}/${MAX_ATTEMPTS} 次`);
    }
    const wait = backoff(attempt);
    if (attempt >= MAX_ATTEMPTS || Date.now() - startedAt + wait > budgetMs) break;
    await sleep(wait);
  }
  throw new Error(`重试 ${MAX_ATTEMPTS} 次后仍失败: ${lastErr}`);
}

(async () => {
  log('=== 开始签到（云端） ===');
  log(`运行环境: ${process.platform} / node ${process.version}`);

  const creds = loadCreds();
  if (!creds.token) fail('凭据中缺少 token，请重新导出');

  const exp = jwtExpireAt(creds.token);
  if (exp) {
    const remainDays = (exp - Date.now()) / 86400000;
    if (remainDays <= 0) {
      fail(`登录态已于 ${exp.toISOString()} 过期，请在电脑上重新运行 export_credentials.cmd 并更新 Secret`);
    }
    log(`登录态有效期至 ${exp.toISOString()}，剩余 ${remainDays.toFixed(1)} 天`);
    if (remainDays < 7) log('警告: 登录态即将过期，请尽快重新导出并更新 Secret');
  }

  const headers = {
    'Authorization': `Cloud-IDE-JWT ${creds.token}`,
    'Content-Type': 'application/json',
    'X-Machine-Id': creds.machineId || '',
    'X-Device-Id': creds.deviceId || '',
  };
  if (creds.region) headers['X-User-Region'] = creds.region;

  // 1) 查询签到状态
  const status = await postJson(STATUS_URL, headers);
  const sd = status.data || status;
  if (status.code !== undefined && status.code !== 0 && sd.checked_in === undefined) {
    fail(`查询状态失败: ${JSON.stringify(status)}`);
  }
  if (sd.checked_in) {
    log(`今日已签到，当前积分: ${sd.credits ?? '未知'}`);
    return;
  }
  if (sd.enable === false) {
    log('账号未开启签到活动，跳过');
    return;
  }
  log(`今日尚未签到（预期积分: ${sd.credits ?? '200'}），开始领取...`);

  // 2) 领取积分
  const claim = await postJson(CLAIM_URL, headers);
  const cd = claim.data || claim;
  if (claim.code === 0 || cd.checked_in) {
    log(`签到成功！获得积分: ${cd.credits ?? 200}`);
  } else {
    fail(`签到失败: ${claim.message || JSON.stringify(claim)}`);
  }
})().catch(e => fail(e.message));
