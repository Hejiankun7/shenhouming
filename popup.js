// 身后名 Legacy Clean — 控制面板逻辑
const $ = (id) => document.getElementById(id);

// 面板渲染用的领域顺序（8 大领域）
const AREA_ORDER = ['news', 'games', 'study', 'health', 'shopping', 'life', 'charity', 'music'];

function setStatus(text, cls) {
  const el = $('status');
  el.textContent = text;
  el.className = 'status' + (cls ? ' ' + cls : '');
}

function fmtTime(ts) {
  if (!ts) return '从未';
  return new Date(ts).toLocaleString('zh-CN');
}

// 加载状态
async function loadState() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
    if (!res || !res.ok || !res.cfg) {
      setStatus('⚠️ 无法连接后台服务，请重新加载扩展', 'warn');
      return;
    }
    const cfg = res.cfg;
    const areasMeta = res.areasMeta || {};
  $('enabled').checked = cfg.enabled !== false;
  $('days').value = cfg.days || 14;
  $('cnOnly').checked = cfg.cnOnly !== false;
  $('dryRun').checked = cfg.dryRun !== false;
  $('fakeUrls').value = (cfg.fakeUrls || []).join('\n');

  // 渲染领域行
  const areasBox = $('areas');
  areasBox.innerHTML = '';
  const areas = cfg.fakeAreas || {};
  for (const key of AREA_ORDER) {
    const meta = areasMeta[key] || { name: key, emoji: '📄', poolSize: 0, poolCn: 0 };
    const count = areas[key] || 0;
    const cnText = meta.poolCn > 0 ? `国内${meta.poolCn}/${meta.poolSize}` : `池${meta.poolSize}`;
    const row = document.createElement('div');
    row.className = 'area-row';
    row.innerHTML = `
      <div class="area-name">${meta.emoji} ${meta.name}<span class="area-note">${cnText}</span></div>
      <div class="area-controls">
        <input type="checkbox" data-area="${key}" ${count > 0 ? 'checked' : ''}>
        <input type="number" data-area="${key}" min="0" max="${meta.poolSize}" value="${count}" style="width:52px;background:#171a22;border:1px solid #2a2f3e;color:#e8e8e8;border-radius:6px;padding:4px 6px;font-size:12px;">
      </div>`;
    areasBox.appendChild(row);
  }

  const last = cfg.lastActive || null;
  const lastReport = cfg.lastReport || null;
  const now = Date.now();
  let inactiveDays = 0;
  if (last) inactiveDays = Math.floor((now - last) / 86400000);

  let lines = [
    `上次活跃：${fmtTime(last)}`,
    `已静默：${inactiveDays} 天`,
    `状态：${cfg.enabled !== false ? '🟢 检测中（每 30 分钟检查一次）' : '⚪ 已停用'}`
  ];
  if (lastReport) {
    lines.push(`— 上次触发 ${fmtTime(lastReport.triggeredAt)} —`);
    if (lastReport.dryRun) {
      lines.push(`[干跑] 本可清除 ${lastReport.cleared} 条历史，将写入 ${lastReport.fakedCount} 条（未实际执行）`);
    } else {
      lines.push(`[真实] 已清除 ${lastReport.cleared} 条历史，写入 ${lastReport.fakedCount} 条，验证存在 ${lastReport.verified} 条`);
    }
  } else {
    lines.push('尚未触发过（可用下方按钮立即测试）');
  }
  setStatus(lines.join('\n'), 'ok');
  } catch (e) {
    console.error('[身后名] loadState 失败:', e);
    setStatus('⚠️ 加载失败：' + (e && e.message ? e.message : '未知错误'), 'warn');
  }
}

// 保存
$('save').addEventListener('click', async () => {
  try {
    const urls = $('fakeUrls').value.split('\n').map(s => s.trim()).filter(Boolean);
    const days = Math.max(1, Math.min(365, parseInt($('days').value) || 14));

    // 收集领域配置：勾选 + 条数（未勾选一律 0；上限取输入框 max=池大小）
    const fakeAreas = {};
    for (const key of AREA_ORDER) {
      const cb = document.querySelector(`input[type=checkbox][data-area="${key}"]`);
      const num = document.querySelector(`input[type=number][data-area="${key}"]`);
      if (cb && cb.checked) {
        const max = parseInt(num.max) || 100;
        fakeAreas[key] = Math.max(1, Math.min(max, parseInt(num.value) || 1));
      } else {
        fakeAreas[key] = 0;
      }
    }

    await chrome.storage.local.set({
      enabled: $('enabled').checked,
      days: days,
      cnOnly: $('cnOnly').checked,
      dryRun: $('dryRun').checked,
      fakeAreas: fakeAreas,
      fakeUrls: urls
    });
    setStatus('✅ 已保存。' + ($('dryRun').checked ? '当前为干跑模式，不会真删历史。' : '⚠️ 当前为真实模式，触发时会真删历史！'), 'ok');
  } catch (e) {
    console.error('[身后名] 保存失败:', e);
    setStatus('⚠️ 保存失败：' + (e && e.message ? e.message : '未知错误'), 'warn');
  }
});

// 假装我已死
$('pretend').addEventListener('click', async () => {
  setStatus('测试中...', '');
  const res = await chrome.runtime.sendMessage({ type: 'PRETEND_DEAD' });
  if (res && res.ok && res.report) {
    const r = res.report;
    if (r.dryRun) {
      setStatus(
        `⚰️ [干跑] 模拟触发成功！\n本可清除 ${r.cleared} 条历史\n将写入 ${r.fakedCount} 条（未实际执行）\n原因：${r.reason}`,
        'ok'
      );
    } else {
      setStatus(
        `⚰️ [真实] 已触发！\n已清除 ${r.cleared} 条历史\n写入 ${r.fakedCount} 条，验证存在 ${r.verified} 条\n原因：${r.reason}`,
        'warn'
      );
    }
  } else {
    setStatus('测试失败：' + (res && res.error ? res.error : '未知错误'), 'warn');
  }
});

loadState();
