// WorkBuddy（CodeBuddy 桌面端）每日签到
// 凭据来自环境变量 WORKBUDDY_CREDENTIALS：
//   { accessToken, uid, domain, expiresAt }
const API_BASE = 'https://www.codebuddy.cn/v2/billing/meter';
const STATUS_PATH = '/checkin-activity-status';
const CLAIM_PATH = '/daily-checkin';

function log(msg) {
  console.log(`[${new Date().toISOString()}] [WorkBuddy] ${msg}`);
}

function fail(msg) {
  log(`ERROR: ${msg}`);
  process.exit(1);
}

function loadCredentials() {
  const raw = process.env.WORKBUDDY_CREDENTIALS;
  if (!raw) fail('缺少 WORKBUDDY_CREDENTIALS');
  let cred;
  try {
    cred = JSON.parse(raw);
  } catch (e) {
    fail(`WORKBUDDY_CREDENTIALS 不是合法 JSON: ${e.message}`);
  }
  if (!cred.accessToken || !cred.uid) fail('凭据缺少 accessToken 或 uid');
  return cred;
}

async function api(path, cred, attempt = 1) {
  const headers = {
    Authorization: `Bearer ${cred.accessToken}`,
    'X-User-Id': String(cred.uid),
    'X-Domain': cred.domain || 'www.codebuddy.cn',
    'Content-Type': 'application/json',
  };
  try {
    const res = await fetch(API_BASE + path, {
      method: 'POST',
      headers,
      body: '{}',
      signal: AbortSignal.timeout(30000),
    });
    const text = await res.text();
    if (res.status === 401 || res.status === 403) {
      const err = new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      err.auth = true;
      throw err;
    }
    if (res.status >= 500 && attempt < 3) {
      log(`HTTP ${res.status}，第 ${attempt} 次重试`);
      await new Promise((r) => setTimeout(r, 3000 * attempt));
      return api(path, cred, attempt + 1);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text);
  } catch (e) {
    if (e.auth) throw e;
    if (attempt < 3 && (e.name === 'AbortError' || e.name === 'TypeError')) {
      log(`请求异常（${e.message}），第 ${attempt} 次重试`);
      await new Promise((r) => setTimeout(r, 3000 * attempt));
      return api(path, cred, attempt + 1);
    }
    throw e;
  }
}

async function main() {
  const cred = loadCredentials();
  if (cred.expiresAt && cred.expiresAt / 1000 <= Date.now()) {
    fail('accessToken 已过期，请确认本机 WorkBuddy 已刷新并同步 Secret');
  }

  let status;
  try {
    status = await api(STATUS_PATH, cred);
  } catch (e) {
    fail(`查询签到状态失败：${e.message}`);
  }
  if (status.code !== 0) fail(`查询签到状态异常：${status.msg || JSON.stringify(status)}`);

  const data = status.data || {};
  if (data.today_checked_in) {
    log(`今日已签到，当前连签 ${data.streak_days} 天`);
    return;
  }

  let claim;
  try {
    claim = await api(CLAIM_PATH, cred);
  } catch (e) {
    fail(`领取积分失败：${e.message}`);
  }
  if (claim.code === 0) {
    const c = claim.data || {};
    const bonus = c.streak_bonus_credit ? `，连签大奖 +${c.streak_bonus_credit}` : '';
    log(`签到成功，获得 ${c.today_credit ?? data.daily_credit ?? '?'} 积分，当前连签 ${c.streak_days ?? data.streak_days ?? '?'} 天${bonus}`);
    return;
  }
  if (claim.code === 10001) {
    log('今日已签到（接口幂等返回）');
    return;
  }
  fail(`签到失败：${claim.msg || JSON.stringify(claim)}`);
}

main().catch((e) => fail(e.message));
