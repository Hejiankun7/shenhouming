// 身后名 Legacy Clean — 后台逻辑
// 网址池从 pool.js 加载（1080 个真实网站，8 大领域）
importScripts('pool.js');

// ---------- 伪造领域：每个领域一个真实网址池，触发时随机取 N 条 ----------
// cn: 1 = 国内可直接访问；0 = 需外网（开启"国内适配"时会被过滤）
const FAKE_AREAS = {};
for (const [key, meta] of Object.entries(FAKE_AREA_META)) {
  FAKE_AREAS[key] = { name: meta.name, emoji: meta.emoji, urls: FAKE_POOL[key] };
}

// 默认配置
const DEFAULTS = {
  enabled: true,          // 总开关
  days: 14,               // 未使用 N 天触发
  cnOnly: true,           // 国内网络适配：开 = 只写国内可访问网站；关 = 国内外全加
  dryRun: true,           // 干跑模式（默认开：只报告不真删！）
  fakeAreas: { news: 10, games: 6, study: 10, health: 5, shopping: 8, life: 6, charity: 3, music: 8 }, // 各领域伪造条数（0=不选）
  fakeUrls: [],           // 自定义网址（全部写入）
  lastActive: null,       // 最后活跃时间戳（ms）
  triggeredAt: null       // 上次触发时间
};

// 初始化
chrome.runtime.onInstalled.addListener(async () => {
  // ⚠️ 只补缺失的键，绝不覆盖用户已保存的配置！
  const existing = await chrome.storage.local.get(Object.keys(DEFAULTS));
  const toSet = {};
  for (const k of Object.keys(DEFAULTS)) {
    if (existing[k] === undefined || existing[k] === null) {
      toSet[k] = DEFAULTS[k];
    }
  }
  // 领域配置合并：老用户只有 6 领域时，补上新增领域（保留已有值）
  if (existing.fakeAreas && typeof existing.fakeAreas === 'object') {
    const merged = { ...DEFAULTS.fakeAreas, ...existing.fakeAreas };
    // 移除老领域里已不存在的键
    for (const k of Object.keys(merged)) {
      if (!(k in DEFAULTS.fakeAreas)) delete merged[k];
    }
    toSet.fakeAreas = merged;
  }
  if (existing.lastActive === undefined || existing.lastActive === null) {
    toSet.lastActive = Date.now();
  }
  if (Object.keys(toSet).length > 0) {
    await chrome.storage.local.set(toSet);
  }
  chrome.alarms.create('fmh-check', { periodInMinutes: 30 }); // 每 30 分钟检查一次
  console.log('[身后名] 初始化完成');
});

// ---------- 活跃检测：任何真实使用都会刷新 lastActive ----------
function touch() {
  chrome.storage.local.set({ lastActive: Date.now() });
}
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'complete') touch();
});
chrome.tabs.onActivated.addListener(() => touch());
chrome.history.onVisited.addListener(() => touch());

// ---------- 定时检查 ----------
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'fmh-check') return;
  await checkInactivity();
});

async function checkInactivity() {
  const cfg = await chrome.storage.local.get(Object.keys(DEFAULTS));
  if (!cfg.enabled) return;

  const now = Date.now();
  const threshold = (cfg.days || 14) * 24 * 60 * 60 * 1000;

  // lastActive 缺失（异常状态）时保守处理：视为刚活跃，绝不自动触发
  if (!cfg.lastActive) return;

  // 用户最近真实使用过 → 重置并跳过
  if (now - cfg.lastActive < threshold) return;

  // 触发！(干跑或真实)；若被重入锁拦截（并发中）返回 null，不重置计时
  const result = await trigger(cfg, now);
  if (!result) return null;
  // 触发后重置计时，避免重复触发
  await chrome.storage.local.set({ lastActive: now });
  return result;
}

// ---------- 按领域收集伪造 URL：每类随机取 N 条 + 自定义全部写入 ----------
function collectFakeUrls(fakeAreas, customUrls, cnOnly) {
  const urls = [];
  const areas = fakeAreas || {};
  for (const [key, area] of Object.entries(FAKE_AREAS)) {
    const count = areas[key] || 0;
    if (count <= 0) continue;
    // cnOnly 开启时只保留国内可访问的
    const pool = (cnOnly ? area.urls.filter(x => x.cn) : area.urls).slice();
    // Fisher–Yates 洗牌
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    for (const item of pool.slice(0, Math.min(count, pool.length))) {
      urls.push(item.u);
    }
  }
  // 自定义网址全量写入
  if (Array.isArray(customUrls)) {
    for (const u of customUrls) {
      const s = (u || '').trim();
      if (s) urls.push(s);
    }
  }
  return urls;
}

// ---------- 触发逻辑 ----------
let triggerRunning = false; // 重入锁：防止 alarm 与 PRETEND_DEAD 并发双触发
async function trigger(cfg, now) {
  if (triggerRunning) return null;
  triggerRunning = true;
  try {
    return await doTrigger(cfg, now);
  } finally {
    triggerRunning = false;
  }
}

async function doTrigger(cfg, now) {
  const report = {
    triggeredAt: new Date(now).toLocaleString('zh-CN'),
    reason: `已连续 ${cfg.days} 天未使用浏览器`,
    dryRun: cfg.dryRun !== false,
    cleared: 0,
    faked: [],
    fakedCount: 0,
    verified: 0
  };

  // 按领域收集要写的 URL（国内适配：开则过滤外网站）
  const urls = collectFakeUrls(cfg.fakeAreas, cfg.fakeUrls, cfg.cnOnly !== false);

  if (cfg.dryRun !== false) {
    // 干跑：只统计要清多少条，不真删
    try {
      const items = await chrome.history.search({ text: '', maxResults: 10000, startTime: 0 });
      report.cleared = items.length;
    } catch (e) { report.cleared = -1; }
    report.fakedCount = urls.length;
  } else {
    // 真实模式：清空 + 伪造
    try {
      const items = await chrome.history.search({ text: '', maxResults: 10000, startTime: 0 });
      report.cleared = items.length;
      await chrome.history.deleteAll();
    } catch (e) {
      report.cleared = -1;
    }
    // 注：addUrl 的 visitTime 被浏览器忽略，记录时间一律为"现在"，
    //     且同一 URL 多次写入在历史中会合并，所以每条网址只写一次
    for (const url of urls) {
      try {
        await chrome.history.addUrl({ url });
        report.faked.push(url);
      } catch (e) { /* 跳过失败项 */ }
    }
    report.fakedCount = report.faked.length;

    // 写入后立即验证：从历史里搜索，确认真的在
    try {
      const res = await chrome.history.search({ text: '', maxResults: 10000, startTime: 0 });
      const added = new Set(report.faked.map(u => u.replace(/\/$/, '')));
      report.verified = res.filter(item => added.has(item.url.replace(/\/$/, ''))).length;
    } catch (e) {
      report.verified = -1;
    }
  }

  await chrome.storage.local.set({ triggeredAt: now, lastReport: report });
  console.log('[身后名] 触发:', JSON.stringify(report, null, 2));
  return report;
}

// ---------- 供 popup 调用 ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case 'GET_STATE': {
        // ⚠️ lastReport 不在 DEFAULTS 里，必须显式取，否则 popup 永远看不到上次报告
        const keys = [...Object.keys(DEFAULTS), 'lastReport'];
        const cfg = await chrome.storage.local.get(keys);
        // 附带领域元信息（名称/emoji/池大小/国内可用数），供面板渲染
        const areasMeta = {};
        for (const [key, area] of Object.entries(FAKE_AREAS)) {
          areasMeta[key] = {
            name: area.name, emoji: area.emoji,
            poolSize: area.urls.length,
            poolCn: area.urls.filter(x => x.cn).length
          };
        }
        sendResponse({ ok: true, cfg, areasMeta });
        break;
      }
      case 'SET_CONFIG': {
        await chrome.storage.local.set(msg.patch);
        sendResponse({ ok: true });
        break;
      }
      case 'PRETEND_DEAD': {
        // 立即测试：不管实际活跃多久，直接触发一次
        const cfg = await chrome.storage.local.get(Object.keys(DEFAULTS));
        const report = await trigger(cfg, Date.now());
        await chrome.storage.local.set({ lastActive: Date.now() }); // 测试后重置
        sendResponse({ ok: true, report });
        break;
      }
      case 'TOUCH': {
        touch();
        sendResponse({ ok: true });
        break;
      }
      default:
        sendResponse({ ok: false, error: 'unknown msg' });
    }
  })();
  return true; // 异步响应
});
