// WorkBuddy（CodeBuddy 桌面端）每日签到，支持多账号
// 凭据来自环境变量 WORKBUDDY_CREDENTIALS，可以是单个对象或数组：
//   [{ accessToken, uid, domain, expiresAt, accountName }, ...]
const API_BASE = 'https://www.codebuddy.cn/v2/billing/meter';
const STATUS_PATH = '/checkin-activity-status';
const CLAIM_PATH = '/daily-checkin';

function log(tag, msg) {
  console.log(`[${new Date().toISOString()}] [WorkBuddy]${tag ? ` [${tag}]` : ''} ${msg}`);
}

function loadAccounts() {
  const raw = process.env.WORKBUDDY_CREDENTIALS;
  if (!raw) throw new Error('缺少 WORKBUDDY_CREDENTIALS');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`WORKBUDDY_CREDENTIALS 不是合法 JSON: ${e.message}`);
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  if (!list.length) throw new Error('WORKBUDDY_CREDENTIALS 为空');
  for (const c of list) {
    if (!c.accessToken || !c.uid) throw new Error('凭据缺少 accessToken 或 uid');
  }
  // 可选：WORKBUDDY_ACCOUNT_INDEX=1/2 时只处理指定序号的账号（用于账号错峰签到）
  const idx = process.env.WORKBUDDY_ACCOUNT_INDEX;
  if (idx) {
    const n = Number(idx);
    if (!Number.isInteger(n) || n < 1 || n > list.length) {
      throw new Error(`WORKBUDDY_ACCOUNT_INDEX=${idx} 越界（共 ${list.length} 个账号）`);
    }
    return [list[n - 1]];
  }
  return list;
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
      log('', `HTTP ${res.status}，第 ${attempt} 次重试`);
      await new Promise((r) => setTimeout(r, 3000 * attempt));
      return api(path, cred, attempt + 1);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text);
  } catch (e) {
    if (e.auth) throw e;
    if (attempt < 3 && (e.name === 'AbortError' || e.name === 'TypeError')) {
      log('', `请求异常（${e.message}），第 ${attempt} 次重试`);
      await new Promise((r) => setTimeout(r, 3000 * attempt));
      return api(path, cred, attempt + 1);
    }
    throw e;
  }
}

async function checkinOne(cred) {
  const tag = (cred.accountName || cred.uid || '').slice(0, 40);
  if (cred.expiresAt && cred.expiresAt <= Date.now()) {
    log(tag, 'accessToken 已过期，请确认本机 WorkBuddy 已刷新并同步 Secret');
    return false;
  }

  let status;
  try {
    status = await api(STATUS_PATH, cred);
  } catch (e) {
    log(tag, `查询签到状态失败：${e.message}`);
    return false;
  }
  if (status.code !== 0) {
    log(tag, `查询签到状态异常：${status.msg || JSON.stringify(status)}`);
    return false;
  }

  const data = status.data || {};
  if (data.today_checked_in) {
    log(tag, `今日已签到，当前连签 ${data.streak_days} 天`);
    return true;
  }

  let claim;
  try {
    claim = await api(CLAIM_PATH, cred);
  } catch (e) {
    log(tag, `领取积分失败：${e.message}`);
    return false;
  }
  if (claim.code === 0) {
    const c = claim.data || {};
    const bonus = c.streak_bonus_credit ? `，连签大奖 +${c.streak_bonus_credit}` : '';
    log(tag, `签到成功，获得 ${c.today_credit ?? data.daily_credit ?? '?'} 积分，当前连签 ${c.streak_days ?? data.streak_days ?? '?'} 天${bonus}`);
    return true;
  }
  if (claim.code === 10001) {
    log(tag, '今日已签到（接口幂等返回）');
    return true;
  }
  log(tag, `签到失败：${claim.msg || JSON.stringify(claim)}`);
  return false;
}

async function main() {
  const accounts = loadAccounts();
  log('', `共 ${accounts.length} 个 WorkBuddy 账号`);
  const results = [];
  for (const cred of accounts) {
    results.push(await checkinOne(cred));
  }
  const failed = results.filter((ok) => !ok).length;
  if (failed) {
    console.error(`[WorkBuddy] ${failed}/${accounts.length} 个账号签到失败`);
    process.exit(1);
  }
  log('', '全部账号处理完成');
}

main().catch((e) => {
  console.error(`[WorkBuddy] ERROR: ${e.message}`);
  process.exit(1);
});
