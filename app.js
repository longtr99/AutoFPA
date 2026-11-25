/* FP&A AutoModel v3.1 - Core Engine (Defensive & Idempotent) */
(function () {
  'use strict';

  const STORAGE_KEY_DATA = 'fpa_automodel_data_v3';
  const STORAGE_KEY_META = 'fpa_automodel_meta_v3';
  const STORAGE_KEY_BUDGET = 'fpa_automodel_budget_v3';
  const STORAGE_KEY_CUSTOM_PROFILES = 'fpa_automodel_custom_profiles_v31';

  const state = {
    meta: null,
    data: [],
    budget: null,
    charts: {},
    forecast: [],
    staging: [],
    abortController: null
  };

  // --- Utilities ---
  const toBn = (v) => (Number(v) || 0) / 1e9;
  const fmtBn = (v, dec = 1) => {
    const num = toBn(v);
    return num.toLocaleString('vi-VN', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  };
  const fmtNum = (v, dec = 1) => (Number(v) || 0).toLocaleString('vi-VN', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  const fmtPct = (v, dec = 1) => `${(Number(v) || 0).toFixed(dec)}%`;
  const fmtDeltaPct = (curr, prev) => {
    if (!prev) return 'N/A';
    const d = ((curr - prev) / Math.abs(prev)) * 100;
    return `${d >= 0 ? '+' : ''}${d.toFixed(1)}%`;
  };

  function setStatus(msg, type = 'ok', targetId = 'globalStatus') {
    const el = document.getElementById(targetId);
    if (!el) return;
    el.textContent = msg;
    el.className = `status-msg ${type}`;
  }

  function destroyChart(key) {
    if (state.charts[key]) {
      try { state.charts[key].destroy(); } catch (_) {}
      delete state.charts[key];
    }
  }

  function loadState() {
    try {
      const savedData = localStorage.getItem(STORAGE_KEY_DATA);
      const savedMeta = localStorage.getItem(STORAGE_KEY_META);
      const savedBudget = localStorage.getItem(STORAGE_KEY_BUDGET);
      state.data = savedData ? JSON.parse(savedData) : JSON.parse(JSON.stringify(window.FPA_DEFAULT_DATA || []));
      state.meta = savedMeta ? JSON.parse(savedMeta) : JSON.parse(JSON.stringify(window.FPA_DEFAULT_META || { companyName: 'Doanh nghiệp' }));
      state.budget = savedBudget ? JSON.parse(savedBudget) : JSON.parse(JSON.stringify(window.FPA_DEFAULT_BUDGET || {}));
      state.data.sort((a, b) => a.year - b.year);
    } catch (err) {
      state.data = JSON.parse(JSON.stringify(window.FPA_DEFAULT_DATA || []));
      state.meta = JSON.parse(JSON.stringify(window.FPA_DEFAULT_META || { companyName: 'Doanh nghiệp' }));
      state.budget = JSON.parse(JSON.stringify(window.FPA_DEFAULT_BUDGET || {}));
      setStatus('Đã khôi phục dữ liệu mặc định do lỗi đọc localStorage: ' + err.message, 'warn');
    }
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY_DATA, JSON.stringify(state.data));
      localStorage.setItem(STORAGE_KEY_META, JSON.stringify(state.meta));
      localStorage.setItem(STORAGE_KEY_BUDGET, JSON.stringify(state.budget));
    } catch (err) {
      setStatus('Cảnh báo: Không thể lưu vào localStorage (' + err.message + ')', 'warn');
    }
  }

  function syncHeaderAndSelectors() {
    const years = state.data.map(d => d.year);
    const minY = years[0] || '';
    const maxY = years[years.length - 1] || '';
    const sub = document.getElementById('headerCompanySubtitle');
    if (sub) sub.textContent = `${state.meta.companyName} · Dữ liệu BCTC ${minY}–${maxY} (${years.length} năm)`;
    const nameInput = document.getElementById('companyNameInput');
    if (nameInput) nameInput.value = state.meta.companyName || '';

    const fillSelect = (id, defaultVal) => {
      const sel = document.getElementById(id);
      if (!sel) return;
      sel.innerHTML = '';
      years.slice().reverse().forEach(y => {
        const opt = document.createElement('option');
        opt.value = y;
        opt.textContent = `Năm ${y}`;
        sel.appendChild(opt);
      });
      if (defaultVal && years.includes(defaultVal)) sel.value = defaultVal;
    };

    fillSelect('overviewYearSelect', maxY);
    fillSelect('varActualYear', maxY);
    fillSelect('varBaseYear', years.length >= 2 ? years[years.length - 2] : maxY);

    const bRev = document.getElementById('budgetRevInput');
    const bNet = document.getElementById('budgetNetInput');
    if (bRev && state.budget.net_rev) bRev.value = Math.round(toBn(state.budget.net_rev));
    if (bNet && state.budget.net_profit) bNet.value = Math.round(toBn(state.budget.net_profit));
  }

  // --- Navigation ---
  function switchTab(tabId) {
    try {
      document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tabId);
      });
      document.querySelectorAll('.tab-panel').forEach(panel => {
        panel.classList.toggle('active', panel.id === `tab-${tabId}`);
      });
      if (tabId === 'overview') renderOverview();
      if (tabId === 'step1') { runIntegrityChecks(); renderCleanTable(); }
      if (tabId === 'step2') renderVariance();
      if (tabId === 'step3') renderDrivers();
      if (tabId === 'step4') runScenarioModel();
    } catch (err) {
      setStatus('Lỗi chuyển tab: ' + err.message, 'err');
    }
  }

  // --- TAB 0: OVERVIEW ---
  function renderOverview() {
    try {
      const sel = document.getElementById('overviewYearSelect');
      const targetYear = Number(sel && sel.value) || state.data[state.data.length - 1].year;
      const idx = state.data.findIndex(d => d.year === targetYear);
      const cur = state.data[idx >= 0 ? idx : state.data.length - 1];
      const prev = idx > 0 ? state.data[idx - 1] : null;

      const gm = (cur.gross_profit / cur.net_rev) * 100;
      const prevGm = prev ? (prev.gross_profit / prev.net_rev) * 100 : gm;
      const nm = (cur.net_profit / cur.net_rev) * 100;
      const ebitda = cur.op_profit - cur.fin_inc + cur.fin_exp + (cur.depreciation || 0);
      const fcf = (cur.cfo || 0) - Math.abs(cur.capex || 0);
      const totalCash = (cur.cash || 0) + (cur.st_invest || 0);
      const roe = (cur.net_profit / cur.equity) * 100;

      const badgeHtml = (c, p) => {
        if (!p) return '<span class="badge badge-info">Năm gốc</span>';
        const d = ((c - p) / Math.abs(p)) * 100;
        return `<span class="badge ${d >= 0 ? 'badge-pos' : 'badge-neg'}">${d >= 0 ? '▲' : '▼'} ${Math.abs(d).toFixed(1)}% YoY</span>`;
      };

      const kpiEl = document.getElementById('overviewKpis');
      kpiEl.innerHTML = `
        <div class="kpi-card">
          <div class="kpi-label">Doanh thu thuần (${cur.year})</div>
          <div class="kpi-value">${fmtBn(cur.net_rev)} tỷ</div>
          <div class="kpi-sub">${badgeHtml(cur.net_rev, prev && prev.net_rev)}</div>
        </div>
        <div class="kpi-card teal">
          <div class="kpi-label">Lợi nhuận gộp &amp; Biên gộp</div>
          <div class="kpi-value">${fmtBn(cur.gross_profit)} tỷ</div>
          <div class="kpi-sub"><span>Biên gộp: <strong>${gm.toFixed(1)}%</strong> (${(gm - prevGm >= 0 ? '+' : '') + (gm - prevGm).toFixed(1)}đ%)</span></div>
        </div>
        <div class="kpi-card green">
          <div class="kpi-label">Lợi nhuận sau thuế</div>
          <div class="kpi-value">${fmtBn(cur.net_profit)} tỷ</div>
          <div class="kpi-sub">${badgeHtml(cur.net_profit, prev && prev.net_profit)} <span>Biên ròng: <strong>${nm.toFixed(1)}%</strong></span></div>
        </div>
        <div class="kpi-card amber">
          <div class="kpi-label">EBITDA (HĐKD lõi)</div>
          <div class="kpi-value">${fmtBn(ebitda)} tỷ</div>
          <div class="kpi-sub"><span>ROE: <strong>${roe.toFixed(1)}%</strong> · EPS: <strong>${fmtNum(cur.eps, 0)} đ</strong></span></div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Tiền &amp; Tiền gửi kỳ hạn</div>
          <div class="kpi-value">${fmtBn(totalCash)} tỷ</div>
          <div class="kpi-sub"><span>Chiếm <strong>${((totalCash / cur.total_assets) * 100).toFixed(1)}%</strong> Tổng tài sản</span></div>
        </div>
        <div class="kpi-card teal">
          <div class="kpi-label">Dòng tiền Tự do (FCF)</div>
          <div class="kpi-value">${fmtBn(fcf)} tỷ</div>
          <div class="kpi-sub"><span>CFO: ${fmtBn(cur.cfo)} tỷ · CapEx: ${fmtBn(cur.capex)} tỷ</span></div>
        </div>
      `;

      // Chart 1: P&L & Margins
      destroyChart('overviewPnl');
      const labels = state.data.map(d => d.year);
      state.charts.overviewPnl = new Chart(document.getElementById('chartOverviewPnl'), {
        type: 'bar',
        data: {
          labels,
          datasets: [
            { label: 'Doanh thu thuần (tỷ)', data: state.data.map(d => toBn(d.net_rev)), backgroundColor: 'rgba(15, 76, 129, 0.82)', yAxisID: 'y' },
            { label: 'LNST (tỷ)', data: state.data.map(d => toBn(d.net_profit)), backgroundColor: 'rgba(13, 148, 136, 0.88)', yAxisID: 'y' },
            { label: 'Biên gộp (%)', data: state.data.map(d => (d.gross_profit / d.net_rev) * 100), type: 'line', borderColor: '#d97706', backgroundColor: '#d97706', tension: 0.3, yAxisID: 'y1' },
            { label: 'Biên ròng (%)', data: state.data.map(d => (d.net_profit / d.net_rev) * 100), type: 'line', borderColor: '#dc2626', backgroundColor: '#dc2626', tension: 0.3, yAxisID: 'y1' }
          ]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          scales: {
            y: { beginAtZero: true, title: { display: true, text: 'Tỷ VND' } },
            y1: { position: 'right', beginAtZero: true, max: 45, grid: { drawOnChartArea: false }, title: { display: true, text: '%' } }
          }
        }
      });

      // Chart 2: Cash Fortress & FCF
      destroyChart('overviewCash');
      state.charts.overviewCash = new Chart(document.getElementById('chartOverviewCash'), {
        type: 'bar',
        data: {
          labels,
          datasets: [
            { label: 'Tiền & TĐT (tỷ)', data: state.data.map(d => toBn(d.cash)), backgroundColor: '#38bdf8', stack: 'cash' },
            { label: 'Tiền gửi kỳ hạn NH (tỷ)', data: state.data.map(d => toBn(d.st_invest)), backgroundColor: '#0f4c81', stack: 'cash' },
            { label: 'Dòng tiền Tự do FCF (tỷ)', data: state.data.map(d => toBn((d.cfo || 0) - Math.abs(d.capex || 0))), type: 'line', borderColor: '#059669', borderWidth: 3, tension: 0.25 }
          ]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          scales: { y: { title: { display: true, text: 'Tỷ VND' } } }
        }
      });

      // Summary Table
      const rows = [
        ['Doanh thu thuần', d => fmtBn(d.net_rev), false],
        ['Giá vốn hàng bán', d => fmtBn(d.cogs), false],
        ['Lợi nhuận gộp', d => fmtBn(d.gross_profit), true],
        ['Biên lợi nhuận gộp (%)', d => fmtPct((d.gross_profit / d.net_rev) * 100), false],
        ['Chi phí bán hàng', d => fmtBn(d.selling_exp), false],
        ['Chi phí quản lý DN', d => fmtBn(d.admin_exp), false],
        ['Doanh thu hoạt động tài chính', d => fmtBn(d.fin_inc), false],
        ['Lợi nhuận trước thuế (PBT)', d => fmtBn(d.pbt), true],
        ['Thuế suất TNDN hiệu dụng (%)', d => fmtPct((d.tax / d.pbt) * 100), false],
        ['Lợi nhuận sau thuế (LNST)', d => fmtBn(d.net_profit), true],
        ['Tổng Tài sản', d => fmtBn(d.total_assets), false],
        ['Tiền & Đầu tư TC ngắn hạn', d => fmtBn(d.cash + d.st_invest), false],
        ['Vốn chủ sở hữu', d => fmtBn(d.equity), false],
        ['Lưu chuyển tiền HĐKD (CFO)', d => fmtBn(d.cfo), false],
        ['Chi đầu tư TSCĐ (CapEx)', d => fmtBn(d.capex), false],
        ['Dòng tiền tự do (FCF)', d => fmtBn(d.cfo - Math.abs(d.capex)), true]
      ];
      let html = `<thead><tr><th>Chỉ tiêu (Tỷ VND)</th>${state.data.map(d => `<th>${d.year}</th>`).join('')}</tr></thead><tbody>`;
      rows.forEach(([label, fn, isBold]) => {
        html += `<tr class="${isBold ? 'row-bold' : ''}"><td>${label}</td>${state.data.map(d => `<td>${fn(d)}</td>`).join('')}</tr>`;
      });
      html += '</tbody>';
      document.getElementById('tableOverviewSummary').innerHTML = html;
    } catch (err) {
      setStatus('Lỗi hiển thị Tổng quan: ' + err.message, 'err');
    }
  }

  // --- TAB 1: STEP 1 DATA INTEGRITY ---
  function runIntegrityChecks() {
    try {
      const checks = [];
      let passCount = 0;
      let warnCount = 0;
      let failCount = 0;

      const addCheck = (status, title, detail) => {
        if (status === 'pass') passCount++;
        else if (status === 'warn') warnCount++;
        else failCount++;
        checks.push({ status, title, detail });
      };

      // 1. Balance sheet equation across all years
      const bsBad = state.data.filter(d => Math.abs((d.total_liab + d.equity) - d.total_assets) > 1000);
      addCheck(bsBad.length === 0 ? 'pass' : 'fail',
        'Cân đối Kế toán (Tổng Tài sản = Nợ phải trả + VCSH)',
        bsBad.length === 0 ? `Khớp 100% (sai số 0 VND) trên toàn bộ ${state.data.length} năm tài chính.` : `Phát hiện lệch ở năm: ${bsBad.map(d => d.year).join(', ')}`);

      // 2. P&L Gross Profit check
      const gpBad = state.data.filter(d => Math.abs((d.net_rev - d.cogs) - d.gross_profit) > 1000);
      addCheck(gpBad.length === 0 ? 'pass' : 'fail',
        'Toàn vẹn KQKD (Doanh thu thuần - Giá vốn = Lợi nhuận gộp)',
        gpBad.length === 0 ? 'Khớp chính xác tuyệt đối trên tất cả các kỳ.' : `Lệch ở năm: ${gpBad.map(d => d.year).join(', ')}`);

      // 3. P&L Net Profit check
      const npBad = state.data.filter(d => Math.abs((d.pbt - d.tax) - d.net_profit) > 1000);
      addCheck(npBad.length === 0 ? 'pass' : 'fail',
        'Toàn vẹn Lợi nhuận ròng (LNTT - Thuế TNDN = LNST)',
        npBad.length === 0 ? 'Khớp chính xác 100%.' : `Lệch ở năm: ${npBad.map(d => d.year).join(', ')}`);

      // 4. Current Assets sum check
      const caBad = state.data.filter(d => Math.abs((d.cash + d.st_invest + d.ar_total + d.inventory + d.other_ca) - d.current_assets) > 1000);
      addCheck(caBad.length === 0 ? 'pass' : 'fail',
        'Cấu phần Tài sản ngắn hạn (Tiền + ĐTNH + Phải thu + HTK + Khác)',
        caBad.length === 0 ? 'Đầy đủ và khớp tổng tài sản ngắn hạn.' : `Lệch ở năm: ${caBad.map(d => d.year).join(', ')}`);

      // 5. Accounting policy shift detection (2019 -> 2020)
      const y19 = state.data.find(d => d.year === 2019);
      const y20 = state.data.find(d => d.year === 2020);
      if (y19 && y20) {
        const gm19 = (y19.gross_profit / y19.net_rev) * 100;
        const gm20 = (y20.gross_profit / y20.net_rev) * 100;
        if (gm20 - gm19 > 8) {
          addCheck('warn',
            'Cảnh báo Chuẩn hóa Chính sách Kế toán (2019 vs 2020)',
            `Biên gộp nhảy từ ${gm19.toFixed(1)}% lên ${gm20.toFixed(1)}% do từ 2020 DN chuyển khuyến mãi bằng sản phẩm (trong Giá vốn) sang hỗ trợ bằng tiền (trong CP Bán hàng). Khi phân tích xu hướng biên gộp, nên lấy mốc so sánh từ 2020 trở đi.`);
        }
      }

      // 6. Effective tax rate anomaly (preferential agriculture tax)
      const latest = state.data[state.data.length - 1];
      const effTax = (latest.tax / latest.pbt) * 100;
      addCheck(effTax < 16 ? 'warn' : 'pass',
        `Kiểm tra Thuế suất TNDN Hiệu dụng (${latest.year}: ${effTax.toFixed(1)}%)`,
        effTax < 16
          ? 'Thuế suất thấp hơn chuẩn 20% nhờ miễn thuế chế biến nông sản địa bàn khó khăn (NĐ 12/2015). Cần theo dõi điều kiện tỷ lệ NVL nông sản >= 30% để duy trì ưu đãi.'
          : 'Thuế suất phù hợp với mức phổ thông 20%.');

      // 7. Capital structure / Cash concentration alert
      const cashRatio = ((latest.cash + latest.st_invest) / latest.total_assets) * 100;
      addCheck(cashRatio > 50 ? 'warn' : 'pass',
        `Cấu trúc Tài sản Tiền mặt (${latest.year}: ${cashRatio.toFixed(1)}% Tổng TS)`,
        cashRatio > 50
          ? `Tiền & tiền gửi đạt ${fmtBn(latest.cash + latest.st_invest)} tỷ (${cashRatio.toFixed(1)}% Tổng TS). Lợi nhuận nhạy cảm cao với biến động lãi suất tiền gửi ngân hàng.`
          : 'Tỷ trọng tiền mặt ở mức cân bằng.');

      // 8. Missing/zero values check
      const missingDriver = state.data.filter(d => !d.material_cost || !d.employees);
      addCheck(missingDriver.length === 0 ? 'pass' : 'warn',
        'Độ phủ Dữ liệu Vận hành (Drivers: NVL, Khuyến mãi, Nhân sự)',
        missingDriver.length === 0 ? 'Đầy đủ dữ liệu thuyết minh chi phí theo yếu tố & nhân sự cho mọi năm.' : `Thiếu một số chỉ tiêu vận hành ở năm: ${missingDriver.map(d => d.year).join(', ')}`);

      const listEl = document.getElementById('integrityChecklist');
      listEl.innerHTML = checks.map(c => `
        <div class="check-item ${c.status}">
          <div style="font-size:16px; line-height:1;">${c.status === 'pass' ? '✅' : c.status === 'warn' ? '⚠️' : '❌'}</div>
          <div>
            <div style="font-weight:700; font-size:13px;">${c.title}</div>
            <div style="font-size:12.5px; color:var(--text-muted); margin-top:2px;">${c.detail}</div>
          </div>
        </div>
      `).join('');

      const badge = document.getElementById('integritySummaryBadge');
      badge.textContent = `${passCount} Đạt · ${warnCount} Lưu ý chuẩn hóa · ${failCount} Lỗi`;
      badge.className = `badge ${failCount > 0 ? 'badge-neg' : warnCount > 0 ? 'badge-warn' : 'badge-pos'}`;
    } catch (err) {
      setStatus('Lỗi kiểm chứng dữ liệu: ' + err.message, 'err', 'step1ActionStatus');
    }
  }

  function renderCleanTable() {
    const cols = [
      ['Năm', d => d.year],
      ['DTT', d => fmtBn(d.net_rev)],
      ['Giá vốn', d => fmtBn(d.cogs)],
      ['LN gộp', d => fmtBn(d.gross_profit)],
      ['CP Bán hàng', d => fmtBn(d.selling_exp)],
      ['CP QLDN', d => fmtBn(d.admin_exp)],
      ['DT Tài chính', d => fmtBn(d.fin_inc)],
      ['LNST', d => fmtBn(d.net_profit)],
      ['Tiền & ĐTNH', d => fmtBn(d.cash + d.st_invest)],
      ['Tổng TS', d => fmtBn(d.total_assets)],
      ['Nợ PT', d => fmtBn(d.total_liab)],
      ['VCSH', d => fmtBn(d.equity)],
      ['Nhân sự', d => fmtNum(d.employees, 0)],
      ['Ghi chú kiểm toán / chuẩn hóa', d => `<span style="white-space:normal; display:inline-block; min-width:220px; text-align:left; font-size:12px; color:var(--text-muted);">${d.note || '—'}</span>`]
    ];
    let html = `<thead><tr>${cols.map(c => `<th>${c[0]}</th>`).join('')}</tr></thead><tbody>`;
    state.data.forEach(d => {
      html += `<tr>${cols.map(c => `<td>${c[1](d)}</td>`).join('')}</tr>`;
    });
    html += '</tbody>';
    document.getElementById('tableCleanData').innerHTML = html;
  }

  // --- TAB 2: STEP 2 VARIANCE ANALYSIS ---
  function renderVariance() {
    try {
      const mode = document.getElementById('varMode').value;
      document.getElementById('varPeriodControls').style.display = mode === 'yoy' ? 'flex' : 'none';
      document.getElementById('varBudgetControls').style.display = mode === 'budget' ? 'flex' : 'none';

      let actual, base, actualLabel, baseLabel;
      if (mode === 'yoy') {
        const yAct = Number(document.getElementById('varActualYear').value);
        const yBase = Number(document.getElementById('varBaseYear').value);
        actual = state.data.find(d => d.year === yAct) || state.data[state.data.length - 1];
        base = state.data.find(d => d.year === yBase) || state.data[Math.max(0, state.data.length - 2)];
        actualLabel = `Thực tế ${actual.year}`;
        baseLabel = `Thực tế ${base.year}`;
      } else {
        actual = state.data[state.data.length - 1];
        base = state.budget;
        actualLabel = `Thực tế ${actual.year}`;
        baseLabel = base.label || 'Kế hoạch';
      }

      const dRev = actual.net_rev - base.net_rev;
      const dCogs = -(actual.cogs - base.cogs); // impact on profit
      const dGp = actual.gross_profit - base.gross_profit;
      const dSell = -(actual.selling_exp - base.selling_exp);
      const dAdmin = -(actual.admin_exp - base.admin_exp);
      const dFin = (actual.fin_inc - actual.fin_exp) - (base.fin_inc - (base.fin_exp || 0));
      const dAssoc = (actual.assoc_profit || 0) - (base.assoc_profit || 0);
      const dOther = (actual.other_profit || 0) - (base.other_profit || 0);
      const dPbt = actual.pbt - base.pbt;
      const dNet = actual.net_profit - base.net_profit;

      document.getElementById('varianceKpis').innerHTML = `
        <div class="kpi-card ${dRev >= 0 ? 'green' : 'red'}">
          <div class="kpi-label">Biến động Doanh thu thuần</div>
          <div class="kpi-value">${dRev >= 0 ? '+' : ''}${fmtBn(dRev)} tỷ</div>
          <div class="kpi-sub"><span class="badge ${dRev >= 0 ? 'badge-pos' : 'badge-neg'}">${fmtDeltaPct(actual.net_rev, base.net_rev)} (${dRev >= 0 ? 'Có lợi' : 'Bất lợi'})</span></div>
        </div>
        <div class="kpi-card ${dGp >= 0 ? 'green' : 'red'}">
          <div class="kpi-label">Biến động Lợi nhuận gộp</div>
          <div class="kpi-value">${dGp >= 0 ? '+' : ''}${fmtBn(dGp)} tỷ</div>
          <div class="kpi-sub"><span class="badge ${dGp >= 0 ? 'badge-pos' : 'badge-neg'}">${fmtDeltaPct(actual.gross_profit, base.gross_profit)}</span></div>
        </div>
        <div class="kpi-card ${dFin >= 0 ? 'green' : 'red'}">
          <div class="kpi-label">Tác động Tài chính ròng</div>
          <div class="kpi-value">${dFin >= 0 ? '+' : ''}${fmtBn(dFin)} tỷ</div>
          <div class="kpi-sub"><span class="badge badge-warn">Yếu tố Khách quan (Lãi suất)</span></div>
        </div>
        <div class="kpi-card ${dNet >= 0 ? 'green' : 'red'}">
          <div class="kpi-label">Biến động Lợi nhuận sau thuế</div>
          <div class="kpi-value">${dNet >= 0 ? '+' : ''}${fmtBn(dNet)} tỷ</div>
          <div class="kpi-sub"><span class="badge ${dNet >= 0 ? 'badge-pos' : 'badge-neg'}">${fmtDeltaPct(actual.net_profit, base.net_profit)}</span></div>
        </div>
      `;

      // Profit Bridge Waterfall Chart (floating bars)
      const bPbt = toBn(base.pbt);
      const steps = [
        { label: `LNTT ${baseLabel}`, val: bPbt, isTotal: true },
        { label: 'Biến động DTT', val: toBn(dRev) },
        { label: 'Biến động Giá vốn', val: toBn(dCogs) },
        { label: 'CP Bán hàng', val: toBn(dSell) },
        { label: 'CP QLDN', val: toBn(dAdmin) },
        { label: 'Tài chính ròng', val: toBn(dFin) },
        ...(Math.abs(dAssoc) > 0 ? [{ label: 'Lãi CT Liên kết', val: toBn(dAssoc) }] : []),
        { label: 'LN Khác', val: toBn(dOther) },
        { label: `LNTT ${actualLabel}`, val: toBn(actual.pbt), isTotal: true }
      ];

      let running = 0;
      const barData = [];
      const barColors = [];
      steps.forEach((s, i) => {
        if (s.isTotal) {
          barData.push([0, s.val]);
          barColors.push(i === 0 ? '#64748b' : '#0f4c81');
          running = s.val;
        } else {
          const start = running;
          const end = running + s.val;
          barData.push([Math.min(start, end), Math.max(start, end)]);
          barColors.push(s.val >= 0 ? '#059669' : '#dc2626');
          running = end;
        }
      });

      destroyChart('varianceBridge');
      state.charts.varianceBridge = new Chart(document.getElementById('chartVarianceBridge'), {
        type: 'bar',
        data: {
          labels: steps.map(s => s.label),
          datasets: [{
            label: 'Tác động lên LNTT (Tỷ VND)',
            data: barData,
            backgroundColor: barColors,
            borderRadius: 4
          }]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                label: (ctx) => {
                  const s = steps[ctx.dataIndex];
                  const sign = (!s.isTotal && s.val > 0) ? '+' : '';
                  return `${s.label}: ${sign}${s.val.toFixed(1)} tỷ VND`;
                }
              }
            }
          },
          scales: { y: { title: { display: true, text: 'Tỷ VND' } } }
        }
      });

      // Variance Table with Favorable/Unfavorable + Subjective/Objective
      const items = [
        { name: 'Doanh thu thuần', act: actual.net_rev, bas: base.net_rev, higherIsBetter: true, nature: 'Kết hợp (Sức mua thị trường & Nỗ lực phân phối)' },
        { name: 'Giá vốn hàng bán', act: actual.cogs, bas: base.cogs, higherIsBetter: false, nature: 'Khách quan (Giá nguyên liệu sữa/bao bì) & Chủ quan (Hiệu suất nhà máy)' },
        { name: 'Lợi nhuận gộp', act: actual.gross_profit, bas: base.gross_profit, higherIsBetter: true, bold: true, nature: 'Phản ánh sức mạnh định giá & kiểm soát giá thành' },
        { name: 'Chi phí bán hàng (gồm KM)', act: actual.selling_exp, bas: base.selling_exp, higherIsBetter: false, nature: 'Chủ quan (Quản trị ngân sách quảng cáo & khuyến mãi)' },
        { name: 'Chi phí quản lý DN', act: actual.admin_exp, bas: base.admin_exp, higherIsBetter: false, nature: 'Chủ quan (Tinh gọn bộ máy vận hành)' },
        { name: 'Doanh thu tài chính', act: actual.fin_inc, bas: base.fin_inc, higherIsBetter: true, nature: 'Khách quan (Mặt bằng lãi suất / thu nhập đầu tư)' },
        ...(((actual.assoc_profit || 0) !== 0 || (base.assoc_profit || 0) !== 0) ? [{ name: 'Phần lãi/lỗ Công ty liên kết', act: actual.assoc_profit || 0, bas: base.assoc_profit || 0, higherIsBetter: true, nature: 'Hợp nhất (Kết quả kinh doanh công ty liên kết)' }] : []),
        { name: 'Lợi nhuận trước thuế', act: actual.pbt, bas: base.pbt, higherIsBetter: true, bold: true, nature: 'Tổng hợp tác động vận hành & tài chính' },
        { name: 'Lợi nhuận sau thuế', act: actual.net_profit, bas: base.net_profit, higherIsBetter: true, bold: true, nature: 'Bao gồm ảnh hưởng ưu đãi thuế nông nghiệp' }
      ];

      let html = `<thead><tr>
        <th>Khoản mục (Tỷ VND)</th><th>${baseLabel}</th><th>${actualLabel}</th>
        <th>Chênh lệch (Tỷ)</th><th>% Biến động</th><th>Đánh giá</th><th style="text-align:left;">Phân loại Nguyên nhân (Chủ quan / Khách quan)</th>
      </tr></thead><tbody>`;
      items.forEach(it => {
        const diff = it.act - it.bas;
        const fav = it.higherIsBetter ? diff >= 0 : diff <= 0;
        html += `<tr class="${it.bold ? 'row-bold' : ''}">
          <td>${it.name}</td>
          <td>${fmtBn(it.bas)}</td>
          <td>${fmtBn(it.act)}</td>
          <td class="${fav ? 'text-pos' : 'text-neg'}">${diff >= 0 ? '+' : ''}${fmtBn(diff)}</td>
          <td class="${fav ? 'text-pos' : 'text-neg'}">${fmtDeltaPct(it.act, it.bas)}</td>
          <td><span class="badge ${fav ? 'badge-pos' : 'badge-neg'}">${fav ? 'Có lợi (F)' : 'Bất lợi (U)'}</span></td>
          <td style="text-align:left; white-space:normal; min-width:240px; font-size:12px; color:var(--text-muted);">${it.nature}</td>
        </tr>`;
      });
      html += '</tbody>';
      document.getElementById('tableVariance').innerHTML = html;
    } catch (err) {
      setStatus('Lỗi phân tích biến động: ' + err.message, 'err');
    }
  }

  function updateBudgetAndRender() {
    const revBn = Number(document.getElementById('budgetRevInput').value) || 3367;
    const netBn = Number(document.getElementById('budgetNetInput').value) || 404;
    state.budget.net_rev = revBn * 1e9;
    state.budget.cogs = state.budget.net_rev * 0.67;
    state.budget.gross_profit = state.budget.net_rev - state.budget.cogs;
    state.budget.net_profit = netBn * 1e9;
    state.budget.pbt = state.budget.net_profit / 0.88;
    state.budget.tax = state.budget.pbt - state.budget.net_profit;
    saveState();
    renderVariance();
  }

  // --- TAB 3: STEP 3 DRIVER-BASED ANALYSIS ---
  function renderDrivers() {
    try {
      const latest = state.data[state.data.length - 1];
      const prev = state.data[Math.max(0, state.data.length - 2)];
      const matPct = (latest.material_cost / latest.net_rev) * 100;
      const promoPct = (latest.promo_cost / latest.net_rev) * 100;
      const vnmPct = (latest.rev_vinamilk / latest.net_rev) * 100;
      const revPerEmp = latest.net_rev / (latest.employees || 1);

      const calcWC = (d) => {
        const dso = (d.ar_trade / d.net_rev) * 365;
        const dio = (d.inventory / d.cogs) * 365;
        const dpo = (d.ap_trade / d.cogs) * 365;
        return { dso, dio, dpo, ccc: dso + dio - dpo };
      };
      const wcLatest = calcWC(latest);
      const wcPrev = calcWC(prev);

      document.getElementById('driverKpis').innerHTML = `
        <div class="kpi-card">
          <div class="kpi-label">Chi phí NVL / Doanh thu (${latest.year})</div>
          <div class="kpi-value">${matPct.toFixed(1)}%</div>
          <div class="kpi-sub"><span>${fmtBn(latest.material_cost)} tỷ VND (Driver biên gộp số 1)</span></div>
        </div>
        <div class="kpi-card amber">
          <div class="kpi-label">Chi phí Hỗ trợ &amp; KM / DTT</div>
          <div class="kpi-value">${promoPct.toFixed(1)}%</div>
          <div class="kpi-sub"><span>${fmtBn(latest.promo_cost)} tỷ (Gấp ${(latest.promo_cost / latest.net_profit).toFixed(1)}x LNST)</span></div>
        </div>
        <div class="kpi-card teal">
          <div class="kpi-label">Tỷ trọng Kênh Vinamilk</div>
          <div class="kpi-value">${vnmPct.toFixed(1)}%</div>
          <div class="kpi-sub"><span>${fmtBn(latest.rev_vinamilk)} tỷ (Tăng từ ${((prev.rev_vinamilk / prev.net_rev) * 100).toFixed(1)}% năm ${prev.year})</span></div>
        </div>
        <div class="kpi-card green">
          <div class="kpi-label">Chu kỳ Tiền mặt (CCC)</div>
          <div class="kpi-value">${wcLatest.ccc.toFixed(1)} ngày</div>
          <div class="kpi-sub"><span>DSO ${wcLatest.dso.toFixed(0)} + DIO ${wcLatest.dio.toFixed(0)} - DPO ${wcLatest.dpo.toFixed(0)} (Năm trước: ${wcPrev.ccc.toFixed(1)} ngày)</span></div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Năng suất Doanh thu / Nhân sự</div>
          <div class="kpi-value">${fmtBn(revPerEmp, 2)} tỷ</div>
          <div class="kpi-sub"><span>Quy mô: <strong>${latest.employees}</strong> nhân viên</span></div>
        </div>
      `;

      const labels = state.data.map(d => d.year);

      // Chart 1: Revenue Mix & Vinamilk Share
      destroyChart('driverRev');
      state.charts.driverRev = new Chart(document.getElementById('chartDriverRevenue'), {
        type: 'bar',
        data: {
          labels,
          datasets: [
            { label: 'Bán ngoài (Thành phẩm + HH)', data: state.data.map(d => toBn(d.net_rev - d.rev_vinamilk)), backgroundColor: '#0f4c81', stack: 'rev' },
            { label: 'Kênh Công ty mẹ (Vinamilk)', data: state.data.map(d => toBn(d.rev_vinamilk)), backgroundColor: '#0d9488', stack: 'rev' },
            { label: '% Kênh Vinamilk', data: state.data.map(d => (d.rev_vinamilk / d.net_rev) * 100), type: 'line', borderColor: '#d97706', borderWidth: 3, yAxisID: 'y1', tension: 0.3 }
          ]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          scales: {
            y: { beginAtZero: true, title: { display: true, text: 'Tỷ VND' } },
            y1: { position: 'right', beginAtZero: true, max: 30, grid: { drawOnChartArea: false }, title: { display: true, text: '%' } }
          }
        }
      });

      // Chart 2: Cost Structure by Element (% Net Revenue)
      destroyChart('driverCosts');
      state.charts.driverCosts = new Chart(document.getElementById('chartDriverCosts'), {
        type: 'bar',
        data: {
          labels,
          datasets: [
            { label: 'Nguyên vật liệu (%)', data: state.data.map(d => (d.material_cost / d.net_rev) * 100), backgroundColor: '#1e3a8a', stack: 'c' },
            { label: 'Hỗ trợ, QC, KM (%)', data: state.data.map(d => (d.promo_cost / d.net_rev) * 100), backgroundColor: '#f59e0b', stack: 'c' },
            { label: 'Nhân công (%)', data: state.data.map(d => (d.labor_cost / d.net_rev) * 100), backgroundColor: '#10b981', stack: 'c' },
            { label: 'Khấu hao (%)', data: state.data.map(d => (d.depreciation / d.net_rev) * 100), backgroundColor: '#64748b', stack: 'c' }
          ]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          scales: { y: { beginAtZero: true, max: 100, title: { display: true, text: '% Doanh thu thuần' } } }
        }
      });

      // Chart 3: Working Capital Days
      const wcs = state.data.map(calcWC);
      destroyChart('driverWC');
      state.charts.driverWC = new Chart(document.getElementById('chartDriverWorkingCap'), {
        type: 'line',
        data: {
          labels,
          datasets: [
            { label: 'DIO (Ngày tồn kho)', data: wcs.map(w => w.dio), borderColor: '#d97706', tension: 0.25 },
            { label: 'DSO (Ngày phải thu)', data: wcs.map(w => w.dso), borderColor: '#2563eb', tension: 0.25 },
            { label: 'DPO (Ngày phải trả)', data: wcs.map(w => w.dpo), borderColor: '#059669', tension: 0.25 },
            { label: 'CCC (Chu kỳ tiền mặt)', data: wcs.map(w => w.ccc), borderColor: '#dc2626', borderWidth: 3, tension: 0.25 }
          ]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          scales: { y: { title: { display: true, text: 'Số ngày' } } }
        }
      });

      // Chart 4: Productivity
      destroyChart('driverProd');
      state.charts.driverProd = new Chart(document.getElementById('chartDriverProductivity'), {
        type: 'bar',
        data: {
          labels,
          datasets: [
            { label: 'Doanh thu / Nhân viên (Tỷ VND)', data: state.data.map(d => toBn(d.net_rev / (d.employees || 1))), backgroundColor: 'rgba(13, 148, 136, 0.8)', yAxisID: 'y' },
            { label: 'Số lượng nhân viên', data: state.data.map(d => d.employees), type: 'line', borderColor: '#0f4c81', borderWidth: 3, yAxisID: 'y1', tension: 0.25 }
          ]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          scales: {
            y: { beginAtZero: true, title: { display: true, text: 'Tỷ VND / người' } },
            y1: { position: 'right', beginAtZero: false, grid: { drawOnChartArea: false }, title: { display: true, text: 'Người' } }
          }
        }
      });
    } catch (err) {
      setStatus('Lỗi phân tích Drivers: ' + err.message, 'err');
    }
  }

  // --- TAB 4: STEP 4 SCENARIO PLANNING & RECOMMENDATIONS ---
  const PRESETS = {
    bear: { revGrowth: -2.0, matShock: 5.0, promoPct: 20.5, depositRate: 4.5, taxRate: 13.5, capexPct: 6.5 },
    base: { revGrowth: 6.0, matShock: 2.0, promoPct: 18.5, depositRate: 5.5, taxRate: 12.5, capexPct: 5.0 },
    bull: { revGrowth: 12.0, matShock: -1.5, promoPct: 17.0, depositRate: 6.5, taxRate: 11.5, capexPct: 4.0 }
  };

  function applyScenarioPreset(key) {
    const p = PRESETS[key] || PRESETS.base;
    document.querySelectorAll('.pill-btn').forEach(b => b.classList.toggle('active', b.dataset.scen === key));
    document.getElementById('slRevGrowth').value = p.revGrowth;
    document.getElementById('slMatShock').value = p.matShock;
    document.getElementById('slPromoPct').value = p.promoPct;
    document.getElementById('slDepositRate').value = p.depositRate;
    document.getElementById('slTaxRate').value = p.taxRate;
    document.getElementById('slCapexPct').value = p.capexPct;
    runScenarioModel();
  }

  function simulate3Years(baseRec, params) {
    const baseCogsRatio = baseRec.cogs / baseRec.net_rev;
    const baseMatShareOfCogs = Math.min(0.92, (baseRec.material_cost || baseRec.cogs * 0.85) / baseRec.cogs);
    const otherSellingRatio = Math.max(0.015, (baseRec.selling_exp - baseRec.promo_cost) / baseRec.net_rev);
    const adminRatio = baseRec.admin_exp / baseRec.net_rev;
    const depBase = baseRec.depreciation || baseRec.fixed_assets * 0.15;
    let cashPool = (baseRec.cash || 0) + (baseRec.st_invest || 0);
    let prevRev = baseRec.net_rev;
    const out = [];

    for (let i = 1; i <= 3; i++) {
      const year = baseRec.year + i;
      const rev = prevRev * (1 + params.revGrowth / 100);
      // Material shock shifts COGS ratio proportionally to material share of COGS
      const adjCogsRatio = baseCogsRatio * (1 + baseMatShareOfCogs * (params.matShock / 100));
      const cogs = rev * adjCogsRatio;
      const gp = rev - cogs;
      const promo = rev * (params.promoPct / 100);
      const sell = promo + rev * otherSellingRatio;
      const admin = rev * adminRatio;
      const finInc = cashPool * (params.depositRate / 100);
      const finExp = (baseRec.st_debt || 0) * 0.045;
      const pbt = gp + finInc - finExp - sell - admin;
      const tax = Math.max(0, pbt * (params.taxRate / 100));
      const net = pbt - tax;
      const capex = rev * (params.capexPct / 100);
      const dep = depBase * (1 + 0.04 * i);
      const cfo = net + dep;
      const fcf = cfo - capex;
      const dividend = Math.max(0, net * 0.65); // Historical payout ~60-70%
      cashPool = Math.max(0, cashPool + fcf - dividend);

      out.push({ year, rev, cogs, gp, gm: (gp / rev) * 100, sell, promo, admin, finInc, pbt, tax, net, nm: (net / rev) * 100, capex, fcf, cashPool });
      prevRev = rev;
    }
    return out;
  }

  function runScenarioModel() {
    try {
      const params = {
        revGrowth: Number(document.getElementById('slRevGrowth').value),
        matShock: Number(document.getElementById('slMatShock').value),
        promoPct: Number(document.getElementById('slPromoPct').value),
        depositRate: Number(document.getElementById('slDepositRate').value),
        taxRate: Number(document.getElementById('slTaxRate').value),
        capexPct: Number(document.getElementById('slCapexPct').value)
      };

      document.getElementById('valRevGrowth').textContent = `${params.revGrowth >= 0 ? '+' : ''}${params.revGrowth.toFixed(1)}%`;
      document.getElementById('valMatShock').textContent = `${params.matShock >= 0 ? '+' : ''}${params.matShock.toFixed(1)}%`;
      document.getElementById('valPromoPct').textContent = `${params.promoPct.toFixed(1)}%`;
      document.getElementById('valDepositRate').textContent = `${params.depositRate.toFixed(2)}%`;
      document.getElementById('valTaxRate').textContent = `${params.taxRate.toFixed(1)}%`;
      document.getElementById('valCapexPct').textContent = `${params.capexPct.toFixed(1)}%`;

      const latest = state.data[state.data.length - 1];
      const fc = simulate3Years(latest, params);
      state.forecast = fc;
      const y1 = fc[0];
      const y3 = fc[2];

      document.getElementById('scenarioKpis').innerHTML = `
        <div class="kpi-card">
          <div class="kpi-label">Dự báo Doanh thu ${y1.year}</div>
          <div class="kpi-value">${fmtBn(y1.rev)} tỷ</div>
          <div class="kpi-sub"><span>Đến ${y3.year}: <strong>${fmtBn(y3.rev)} tỷ</strong></span></div>
        </div>
        <div class="kpi-card ${y1.net >= latest.net_profit ? 'green' : 'red'}">
          <div class="kpi-label">Dự báo LNST ${y1.year}</div>
          <div class="kpi-value">${fmtBn(y1.net)} tỷ</div>
          <div class="kpi-sub"><span class="badge ${y1.net >= latest.net_profit ? 'badge-pos' : 'badge-neg'}">${fmtDeltaPct(y1.net, latest.net_profit)} vs ${latest.year}</span></div>
        </div>
        <div class="kpi-card teal">
          <div class="kpi-label">Biên Lợi nhuận gộp ${y1.year}</div>
          <div class="kpi-value">${y1.gm.toFixed(1)}%</div>
          <div class="kpi-sub"><span>Biên ròng: <strong>${y1.nm.toFixed(1)}%</strong></span></div>
        </div>
        <div class="kpi-card amber">
          <div class="kpi-label">Tổng FCF tích lũy 3 năm</div>
          <div class="kpi-value">${fmtBn(fc.reduce((s, r) => s + r.fcf, 0))} tỷ</div>
          <div class="kpi-sub"><span>Tiền &amp; Tiền gửi ${y3.year}: <strong>${fmtBn(y3.cashPool)} tỷ</strong></span></div>
        </div>
      `;

      // Forecast Chart
      destroyChart('scenarioFc');
      const allYears = [...state.data.map(d => String(d.year)), ...fc.map(f => `${f.year}F`)];
      const revSeries = [...state.data.map(d => toBn(d.net_rev)), ...fc.map(f => toBn(f.rev))];
      const netSeries = [...state.data.map(d => toBn(d.net_profit)), ...fc.map(f => toBn(f.net))];
      const revColors = [...state.data.map(() => 'rgba(15, 76, 129, 0.78)'), ...fc.map(() => 'rgba(37, 99, 235, 0.45)')];
      const netColors = [...state.data.map(() => 'rgba(13, 148, 136, 0.85)'), ...fc.map(() => 'rgba(5, 150, 105, 0.55)')];

      state.charts.scenarioFc = new Chart(document.getElementById('chartScenarioForecast'), {
        type: 'bar',
        data: {
          labels: allYears,
          datasets: [
            { label: 'Doanh thu thuần (tỷ)', data: revSeries, backgroundColor: revColors },
            { label: 'Lợi nhuận sau thuế (tỷ)', data: netSeries, backgroundColor: netColors }
          ]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          scales: { y: { beginAtZero: true, title: { display: true, text: 'Tỷ VND' } } }
        }
      });

      // 2D Sensitivity Matrix (Rev Growth x Material Shock -> Year 1 Net Profit)
      const revSteps = [-5, 0, 5, 10, 15];
      const matSteps = [-4, 0, 2, 5, 8];
      let sHtml = `<thead><tr><th>Giá NVL \\ Tăng trưởng DT</th>${revSteps.map(r => `<th>${r >= 0 ? '+' : ''}${r}%</th>`).join('')}</tr></thead><tbody>`;
      matSteps.forEach(m => {
        sHtml += `<tr><td style="font-weight:700;">NVL ${m >= 0 ? '+' : ''}${m}%</td>`;
        revSteps.forEach(r => {
          const sim = simulate3Years(latest, { ...params, revGrowth: r, matShock: m })[0];
          const valBn = toBn(sim.net);
          const cls = sim.net >= latest.net_profit * 1.1 ? 'sens-pos' : sim.net < latest.net_profit * 0.9 ? 'sens-neg' : 'sens-mid';
          sHtml += `<td class="${cls}">${valBn.toFixed(1)}</td>`;
        });
        sHtml += '</tr>';
      });
      sHtml += '</tbody>';
      document.getElementById('tableSensitivity').innerHTML = sHtml;

      // Forecast Table
      const fcRows = [
        ['Doanh thu thuần', r => fmtBn(r.rev), true],
        ['Giá vốn hàng bán', r => fmtBn(r.cogs), false],
        ['Lợi nhuận gộp', r => fmtBn(r.gp), true],
        ['Biên gộp (%)', r => fmtPct(r.gm), false],
        ['Chi phí bán hàng (gồm KM)', r => fmtBn(r.sell), false],
        ['Chi phí quản lý DN', r => fmtBn(r.admin), false],
        ['Doanh thu tài chính (lãi tiền gửi)', r => fmtBn(r.finInc), false],
        ['Lợi nhuận trước thuế', r => fmtBn(r.pbt), true],
        ['Thuế TNDN dự kiến', r => fmtBn(r.tax), false],
        ['Lợi nhuận sau thuế (LNST)', r => fmtBn(r.net), true],
        ['CapEx đầu tư dự kiến', r => fmtBn(r.capex), false],
        ['Dòng tiền tự do (FCF)', r => fmtBn(r.fcf), true],
        ['Số dư Tiền & Tiền gửi cuối năm', r => fmtBn(r.cashPool), false]
      ];
      let fHtml = `<thead><tr><th>Chỉ tiêu Dự phóng (Tỷ VND)</th><th>Thực tế ${latest.year}</th>${fc.map(f => `<th>Dự báo ${f.year}F</th>`).join('')}</tr></thead><tbody>`;
      const latestMap = {
        rev: latest.net_rev, cogs: latest.cogs, gp: latest.gross_profit, gm: (latest.gross_profit / latest.net_rev) * 100,
        sell: latest.selling_exp, admin: latest.admin_exp, finInc: latest.fin_inc, pbt: latest.pbt, tax: latest.tax,
        net: latest.net_profit, capex: latest.capex, fcf: latest.cfo - Math.abs(latest.capex), cashPool: latest.cash + latest.st_invest
      };
      fcRows.forEach(([lbl, fn, bold]) => {
        fHtml += `<tr class="${bold ? 'row-bold' : ''}"><td>${lbl}</td><td>${fn(latestMap)}</td>${fc.map(f => `<td>${fn(f)}</td>`).join('')}</tr>`;
      });
      fHtml += '</tbody>';
      document.getElementById('tableForecast').innerHTML = fHtml;

      // Dynamic AI FP&A Recommendations
      renderRecommendations(latest, params, y1, y3);
      renderPromptLibrary(latest, params, y1, y3);
    } catch (err) {
      setStatus('Lỗi chạy mô hình kịch bản: ' + err.message, 'err');
    }
  }

  function renderRecommendations(latest, params, y1, y3) {
    const recs = [];
    if (params.matShock >= 3) {
      const impactBn = toBn(y1.rev * (latest.cogs / latest.net_rev) * 0.85 * (params.matShock / 100));
      recs.push({
        level: 'high',
        title: `Phòng vệ biên gộp trước cú sốc giá nguyên liệu (+${params.matShock.toFixed(1)}%)`,
        body: `Giá NVL tăng làm bào mòn khoảng ${impactBn.toFixed(1)} tỷ lợi nhuận năm ${y1.year}. Đề xuất: (1) Đẩy nhanh tiến độ hoàn thiện Trang trại công nghệ cao 4.000 con (đang XDCB 143,2 tỷ) để tự chủ sữa tươi; (2) Tối ưu cơ cấu sản phẩm sang dòng sữa chua/sữa tiệt trùng biên cao và cân nhắc điều chỉnh giá bán 2–3%.`
      });
    }
    if (params.promoPct >= 18.5) {
      const save1Pct = toBn(y1.rev * 0.01);
      recs.push({
        level: 'med',
        title: `Tối ưu hóa ngân sách Khuyến mãi & Hỗ trợ bán hàng (${params.promoPct.toFixed(1)}% DTT)`,
        body: `Chi phí hỗ trợ/quảng cáo dự kiến ${fmtBn(y1.promo)} tỷ năm ${y1.year}. Chỉ cần nâng hiệu quả ROI Trade Marketing để giảm 1% tỷ trọng chi phí này sẽ mang lại ngay +${save1Pct.toFixed(1)} tỷ LNTT (tương đương +${((save1Pct / toBn(y1.pbt)) * 100).toFixed(1)}% lợi nhuận).`
      });
    }
    if (params.depositRate <= 5.5) {
      recs.push({
        level: 'med',
        title: `Tái phân bổ "pháo đài tiền mặt" ${fmtBn(latest.cash + latest.st_invest)} tỷ trong môi trường lãi suất thấp`,
        body: `Với lãi suất tiền gửi chỉ ${params.depositRate.toFixed(2)}%, thu nhập tài chính giảm đáng kể so với đỉnh 2023. Đề xuất giải ngân có kỷ luật vào dự án Nhà máy sữa công nghệ cao & mở rộng kênh phân phối thay vì giữ quá nhiều tiền gửi ngắn hạn.`
      });
    }
    const vnmShare = (latest.rev_vinamilk / latest.net_rev) * 100;
    if (vnmShare > 15) {
      recs.push({
        level: 'good',
        title: `Tận dụng cộng hưởng Vinamilk (${vnmShare.toFixed(1)}% DTT) nhưng tránh lệ thuộc`,
        body: `Kênh bán qua Vinamilk tăng mạnh lên ${fmtBn(latest.rev_vinamilk)} tỷ năm ${latest.year}. Cần song song phục hồi kênh phân phối độc lập miền Bắc/miền Trung và giữ kỷ luật công nợ phải thu (40–47 ngày) để bảo vệ DSO.`
      });
    }
    if (y1.net > latest.net_profit * 1.05) {
      recs.push({
        level: 'good',
        title: `Kịch bản khả quan: LNST ${y1.year} phục hồi ${fmtDeltaPct(y1.net, latest.net_profit)} lên ${fmtBn(y1.net)} tỷ`,
        body: `Dòng tiền tự do 3 năm đạt ${fmtBn(state.forecast.reduce((s, r) => s + r.fcf, 0))} tỷ, đủ khả năng duy trì chính sách cổ tức tiền mặt hấp dẫn (tối thiểu 50% LNST) mà không cần gia tăng đòn bẩy nợ vay.`
      });
    }

    document.getElementById('recommendationList').innerHTML = recs.map(r => `
      <div class="rec-item ${r.level}">
        <div class="rec-title">${r.title}</div>
        <div style="font-size:13px; color:var(--text);">${r.body}</div>
      </div>
    `).join('');
  }

  function renderPromptLibrary(latest, params, y1, y3) {
    const rawPrompt = `Bạn là Giám đốc FP&A (Financial Planning & Analysis). Hãy lập Báo cáo Phân tích & Hoạch định Tài chính 4 bước cho [TÊN DOANH NGHIỆP] dựa trên dữ liệu BCTC kiểm toán:
1. Kiểm chứng & Chuẩn hóa dữ liệu (Data Integrity): Nêu các điểm cần lưu ý về chính sách kế toán, thuế suất ưu đãi, cấu trúc tài sản.
2. Phân tích Biến động (Variance Analysis): Bóc tách nguyên nhân tăng/giảm LNTT và LNST giữa năm gần nhất và năm trước, phân rõ yếu tố Chủ quan (quản trị) và Khách quan (thị trường).
3. Phân tích Yếu tố Thúc đẩy (Driver-based Analysis): Đánh giá cơ cấu doanh thu, tỷ trọng chi phí NVL, chi phí khuyến mãi/quảng cáo và hiệu suất vốn lưu động (DSO, DIO, DPO, CCC).
4. Kịch bản Tương lai & Đề xuất Hành động cho CEO/CFO: Đánh giá tác động nếu giá nguyên liệu tăng +5% và đề xuất 3 hành động ưu tiên trong 12 tháng tới.`;

    const injectedPrompt = `Bạn là Giám đốc FP&A. Hãy viết bản Executive Memo (tối đa 1 trang A4) trình Ban Tổng Giám đốc ${state.meta.companyName} dựa trên dữ liệu đã kiểm chứng sau:
- Kết quả năm ${latest.year}: Doanh thu thuần ${fmtBn(latest.net_rev)} tỷ, LN gộp ${fmtBn(latest.gross_profit)} tỷ (biên ${((latest.gross_profit / latest.net_rev) * 100).toFixed(1)}%), Chi phí bán hàng ${fmtBn(latest.selling_exp)} tỷ (trong đó KM/hỗ trợ ${fmtBn(latest.promo_cost)} tỷ = ${((latest.promo_cost / latest.net_rev) * 100).toFixed(1)}% DTT), DT Tài chính ${fmtBn(latest.fin_inc)} tỷ, LNST ${fmtBn(latest.net_profit)} tỷ.
- Nền tảng bảng cân đối: Tiền & tiền gửi kỳ hạn ${fmtBn(latest.cash + latest.st_invest)} tỷ (${(((latest.cash + latest.st_invest) / latest.total_assets) * 100).toFixed(1)}% Tổng TS), XDCB dở dang ${fmtBn(latest.cip_long)} tỷ, Kênh Vinamilk chiếm ${((latest.rev_vinamilk / latest.net_rev) * 100).toFixed(1)}% DTT.
- Kịch bản FP&A đang mô phỏng (${y1.year}–${y3.year}): Tăng trưởng DT ${params.revGrowth}%/năm, biến động giá NVL ${params.matShock}%, tỷ lệ KM ${params.promoPct}% DTT, lãi suất tiền gửi ${params.depositRate}%.
- Kết quả dự phóng: LNST ${y1.year} đạt ${fmtBn(y1.net)} tỷ (${fmtDeltaPct(y1.net, latest.net_profit)} vs ${latest.year}), đến ${y3.year} đạt ${fmtBn(y3.net)} tỷ.
Yêu cầu: Phân tích sắc bén theo đúng 4 bước FP&A và chốt 3 quyết định hành động cụ thể cho Quý tới.`;

    document.getElementById('promptRaw').value = rawPrompt;
    document.getElementById('promptInjected').value = injectedPrompt;
  }

  // --- IMPORT / EXPORT / ACTIONS (v2.0 Multi-PDF + Smart Excel + Staging) ---
  async function handleFileUpload(event) {
    try {
      const fileList = event.target && event.target.files ? Array.from(event.target.files) : (event.dataTransfer ? Array.from(event.dataTransfer.files) : []);
      if (!fileList.length) return;
      if (event.target && event.target.value) event.target.value = '';

      setStatus(`Đang xử lý ${fileList.length} tệp...`, 'warn', 'step1ActionStatus');
      const collectedMap = new Map();
      let detectedCompany = '';
      const warnings = [];

      for (const file of fileList) {
        const ext = file.name.split('.').pop().toLowerCase();
        if (ext === 'pdf') {
          if (!window.FPA_PARSER) throw new Error('Module pdf_parser.js chưa sẵn sàng.');
          const ocrStartPage = Number(document.getElementById('ocrStartPage')?.value) || 5;
          const ocrEndPage = Number(document.getElementById('ocrEndPage')?.value) || 14;
          state.abortController = new AbortController();
          const cancelBtn = document.getElementById('btnCancelOcr');
          if (cancelBtn) cancelBtn.style.display = 'inline-flex';
          const buf = await file.arrayBuffer();
          const { lines, numPages, usedOcr } = await window.FPA_PARSER.extractLinesFromPDF(buf, {
            ocrStartPage,
            ocrEndPage,
            abortSignal: state.abortController.signal,
            onProgress: (msg) => setStatus(`[${file.name}] ${msg}`, 'warn', 'step1ActionStatus')
          });
          const parsed = window.FPA_PARSER.parseTT200Lines(lines, file.name);
          if (usedOcr) {
            warnings.push(`"${file.name}" (${numPages} trang): Đã chạy Auto-OCR trang ${ocrStartPage}–${ocrEndPage} (Đơn vị: ${parsed.unitLabel}). Hãy kiểm tra nhanh các ô bên dưới.`);
          }
          if (parsed.companyName && !detectedCompany) detectedCompany = parsed.companyName;
          if (!parsed.records.length) {
            warnings.push(`"${file.name}": Có chữ nhưng không nhận diện được bảng B01/B02 chuẩn TT200.`);
            continue;
          }
          parsed.records.forEach(rec => {
            const existing = collectedMap.get(rec.year);
            // Prefer record with more populated fields (current-year column from that year's own report)
            if (!existing || (rec.net_rev > 0 && rec.total_assets > 0 && !existing.note.includes('Bóc tách tự động'))) {
              collectedMap.set(rec.year, rec);
            }
          });
        } else if (ext === 'json') {
          const text = await file.text();
          const parsed = JSON.parse(text);
          const arr = Array.isArray(parsed) ? parsed : parsed.data;
          if (Array.isArray(arr)) {
            normalizeFlatRows(arr).forEach(r => collectedMap.set(r.year, r));
          }
        } else if (ext === 'xlsx' || ext === 'xls' || ext === 'csv') {
          if (typeof XLSX === 'undefined') throw new Error('Thư viện SheetJS chưa tải xong.');
          const buf = await file.arrayBuffer();
          const wb = XLSX.read(new Uint8Array(buf), { type: 'array' });
          const res = window.FPA_PARSER.parseExcelWorkbook(wb, file.name);
          const recs = res.mode === 'flat' ? normalizeFlatRows(res.records) : res.records;
          recs.forEach(r => collectedMap.set(r.year, r));
        } else {
          warnings.push(`Định dạng "${file.name}" chưa hỗ trợ.`);
        }
      }

      const extracted = Array.from(collectedMap.values()).sort((a, b) => a.year - b.year);
      if (detectedCompany) {
        const nameInput = document.getElementById('companyNameInput');
        if (nameInput) nameInput.value = detectedCompany;
      }

      if (!extracted.length) {
        const warnMsg = warnings.length ? warnings.join(' | ') : 'Không bóc tách được số liệu hợp lệ nào.';
        setStatus(warnMsg, 'err', 'step1ActionStatus');
        return;
      }

      state.staging = extracted;
      renderStagingTable(warnings);
      setStatus(`Đã bóc tách ${extracted.length} năm (${extracted.map(r => r.year).join(', ')}). Hãy rà soát nhanh bên dưới rồi bấm "Thay thế toàn bộ" hoặc "Gộp thêm".`, warnings.length ? 'warn' : 'ok', 'step1ActionStatus');
    } catch (err) {
      setStatus('Lỗi / Dừng đọc tệp: ' + err.message, 'err', 'step1ActionStatus');
    } finally {
      const cancelBtn = document.getElementById('btnCancelOcr');
      if (cancelBtn) cancelBtn.style.display = 'none';
      state.abortController = null;
    }
  }

  function cancelPdfProcessing() {
    if (state.abortController) {
      state.abortController.abort();
      setStatus('Đang dừng quá trình OCR...', 'warn', 'step1ActionStatus');
    }
  }


  function getCustomProfiles() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY_CUSTOM_PROFILES) || '{}'); }
    catch (_) { return {}; }
  }

  function refreshPresetDropdown(selectedKey) {
    const sel = document.getElementById('samplePresetSelect');
    if (!sel) return;
    const builtins = window.FPA_SAMPLE_PRESETS || {};
    const customs = getCustomProfiles();
    sel.innerHTML = '';
    const labels = {
      msn: 'Mẫu 1: Tập đoàn Masan (Hợp nhất 2021–2025)',
      mcm: 'Mẫu 2: Mộc Châu Milk (Riêng 2019–2024)',
      vnm: 'Mẫu 3: Vinamilk — VNM (Hợp nhất IFRS 2022–2025)'
    };
    Object.keys(builtins).forEach(k => {
      const opt = document.createElement('option');
      opt.value = k;
      opt.textContent = labels[k] || builtins[k].meta.companyName;
      sel.appendChild(opt);
    });
    Object.keys(customs).forEach(k => {
      const opt = document.createElement('option');
      opt.value = k;
      const d = customs[k].data || [];
      const span = d.length ? ` (${d[0].year}–${d[d.length - 1].year})` : '';
      opt.textContent = `Hồ sơ đã lưu: ${customs[k].meta.companyName}${span}`;
      sel.appendChild(opt);
    });
    if (selectedKey && [...sel.options].some(o => o.value === selectedKey)) {
      sel.value = selectedKey;
    }
  }

  function saveAsCustomProfile() {
    try {
      const nameVal = (document.getElementById('companyNameInput').value || state.meta.companyName || '').trim();
      if (!nameVal) {
        setStatus('Vui lòng nhập tên doanh nghiệp trước khi lưu hồ sơ.', 'warn', 'step1ActionStatus');
        return;
      }
      state.meta.companyName = nameVal;
      const key = 'custom_' + nameVal.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 28);
      const customs = getCustomProfiles();
      customs[key] = {
        meta: JSON.parse(JSON.stringify({ ...state.meta, id: key })),
        data: JSON.parse(JSON.stringify(state.data)),
        budget: JSON.parse(JSON.stringify(state.budget))
      };
      localStorage.setItem(STORAGE_KEY_CUSTOM_PROFILES, JSON.stringify(customs));
      saveState();
      refreshPresetDropdown(key);
      syncHeaderAndSelectors();
      setStatus(`Đã lưu hồ sơ "${nameVal}" vào danh sách chọn nhanh góc trên!`, 'ok', 'step1ActionStatus');
    } catch (err) {
      setStatus('Lỗi lưu hồ sơ: ' + err.message, 'err', 'step1ActionStatus');
    }
  }

  function switchSamplePreset(presetKey) {
    try {
      const customs = getCustomProfiles();
      const preset = (window.FPA_SAMPLE_PRESETS && window.FPA_SAMPLE_PRESETS[presetKey]) || customs[presetKey];
      if (!preset) return;
      state.meta = JSON.parse(JSON.stringify(preset.meta));
      state.data = JSON.parse(JSON.stringify(preset.data));
      state.budget = JSON.parse(JSON.stringify(preset.budget));
      saveState();
      syncHeaderAndSelectors();
      renderOverview();
      runIntegrityChecks();
      renderCleanTable();
      renderVariance();
      renderDrivers();
      runScenarioModel();
      setStatus(`Đã chuyển sang bộ dữ liệu mẫu: ${state.meta.companyName}`, 'ok', 'globalStatus');
    } catch (err) {
      setStatus('Lỗi chuyển bộ mẫu: ' + err.message, 'err');
    }
  }

  function normalizeFlatRows(rawRows) {
    const numKeys = [
      'year', 'gross_rev', 'deductions', 'net_rev', 'cogs', 'gross_profit', 'fin_inc', 'fin_exp', 'int_exp',
      'selling_exp', 'admin_exp', 'op_profit', 'other_inc', 'other_exp', 'other_profit', 'pbt', 'tax', 'net_profit', 'eps',
      'current_assets', 'cash', 'st_invest', 'ar_total', 'ar_trade', 'inventory', 'other_ca',
      'non_current_assets', 'fixed_assets', 'cip_long', 'total_assets', 'total_liab', 'current_liab', 'ap_trade',
      'st_debt', 'non_current_liab', 'equity', 'cfo', 'capex', 'cfi', 'cff', 'dividends_paid',
      'depreciation', 'material_cost', 'labor_cost', 'promo_cost', 'employees', 'rev_finished', 'rev_merch', 'rev_other', 'rev_vinamilk', 'shares'
    ];
    return rawRows.map(r => {
      const obj = {};
      numKeys.forEach(k => { obj[k] = Number(String(r[k] ?? 0).replace(/,/g, '')) || 0; });
      obj.note = r.note || '';
      return window.FPA_PARSER ? window.FPA_PARSER.finalizeDerivedFields(obj) : obj;
    }).filter(r => r.year > 1990 && (r.net_rev > 0 || r.total_assets > 0));
  }

  function renderStagingTable(warnings = []) {
    const box = document.getElementById('stagingBox');
    const info = document.getElementById('stagingInfo');
    if (box) box.classList.add('visible');
    if (info) {
      info.innerHTML = warnings.length
        ? `<span style="color:var(--warning); font-weight:600;">Lưu ý: ${warnings.join(' · ')}</span>`
        : 'Bạn có thể sửa trực tiếp các ô số liệu (đơn vị: Tỷ VND) trước khi áp dụng vào toàn bộ mô hình.';
    }

    const editCols = [
      ['net_rev', 'DTT'], ['cogs', 'Giá vốn'], ['selling_exp', 'CP Bán hàng'], ['admin_exp', 'CP QLDN'],
      ['fin_inc', 'DT Tài chính'], ['pbt', 'LNTT'], ['net_profit', 'LNST'],
      ['total_assets', 'Tổng TS'], ['cash', 'Tiền'], ['st_invest', 'Tiền gửi NH'],
      ['total_liab', 'Nợ PT'], ['equity', 'VCSH'], ['cfo', 'CFO'], ['capex', 'CapEx']
    ];

    let html = `<thead><tr><th>Năm</th>${editCols.map(c => `<th>${c[1]}</th>`).join('')}</tr></thead><tbody>`;
    state.staging.forEach((r, idx) => {
      html += `<tr><td style="font-weight:700;">${r.year}</td>`;
      editCols.forEach(([key]) => {
        const valBn = (Number(r[key] || 0) / 1e9).toFixed(1);
        html += `<td><input type="number" step="0.1" value="${valBn}" onchange="window.updateStagingCell(${idx}, '${key}', this.value)" /></td>`;
      });
      html += '</tr>';
    });
    html += '</tbody>';
    document.getElementById('tableStaging').innerHTML = html;
  }

  function updateStagingCell(rowIdx, key, valBn) {
    if (!state.staging[rowIdx]) return;
    state.staging[rowIdx][key] = Math.round((Number(valBn) || 0) * 1e9);
    if (window.FPA_PARSER) window.FPA_PARSER.finalizeDerivedFields(state.staging[rowIdx]);
  }

  function openManualStaging() {
    state.staging = JSON.parse(JSON.stringify(state.data));
    renderStagingTable([]);
    setStatus('Đang mở bảng chỉnh sửa nhanh số liệu hiện tại (Tỷ VND).', 'ok', 'step1ActionStatus');
  }

  function closeStagingBox() {
    const box = document.getElementById('stagingBox');
    if (box) box.classList.remove('visible');
  }

  function commitStagingData(mode) {
    try {
      if (!state.staging.length) return;
      const nameVal = (document.getElementById('companyNameInput').value || '').trim();
      if (nameVal) state.meta.companyName = nameVal;

      if (mode === 'merge') {
        const map = new Map(state.data.map(d => [d.year, d]));
        state.staging.forEach(s => map.set(s.year, window.FPA_PARSER.finalizeDerivedFields(s)));
        state.data = Array.from(map.values()).sort((a, b) => a.year - b.year);
      } else {
        state.data = state.staging.map(s => window.FPA_PARSER.finalizeDerivedFields(s)).sort((a, b) => a.year - b.year);
      }
      saveState();
      syncHeaderAndSelectors();
      runIntegrityChecks();
      renderCleanTable();
      renderOverview();
      closeStagingBox();
      setStatus(`Đã áp dụng thành công ${state.data.length} năm dữ liệu vào mô hình FP&A!`, 'ok', 'step1ActionStatus');
      setStatus(`Đã cập nhật dữ liệu mới (${state.data.length} năm: ${state.data[0].year}–${state.data[state.data.length - 1].year}).`, 'ok', 'globalStatus');
    } catch (err) {
      setStatus('Lỗi áp dụng dữ liệu: ' + err.message, 'err', 'step1ActionStatus');
    }
  }

  function updateCompanyName() {
    const val = (document.getElementById('companyNameInput').value || '').trim();
    if (!val) return;
    state.meta.companyName = val;
    saveState();
    syncHeaderAndSelectors();
    setStatus('Đã cập nhật tên doanh nghiệp.', 'ok', 'step1ActionStatus');
  }

  function resetDefaultData() {
    try {
      localStorage.removeItem(STORAGE_KEY_DATA);
      localStorage.removeItem(STORAGE_KEY_META);
      localStorage.removeItem(STORAGE_KEY_BUDGET);
      loadState();
      refreshPresetDropdown(state.meta && state.meta.id);
      syncHeaderAndSelectors();
      runIntegrityChecks();
      renderCleanTable();
      renderOverview();
      setStatus('Đã khôi phục dữ liệu BCTC kiểm toán gốc của Mộc Châu Milk (2019–2024).', 'ok', 'step1ActionStatus');
      setStatus('Đã khôi phục dữ liệu gốc MCM.', 'ok', 'globalStatus');
    } catch (err) {
      setStatus('Lỗi khôi phục: ' + err.message, 'err', 'step1ActionStatus');
    }
  }

  function downloadTemplateCsv() {
    try {
      const keys = Object.keys(state.data[0]);
      const lines = [keys.join(',')];
      state.data.forEach(r => {
        lines.push(keys.map(k => `"${String(r[k] ?? '').replace(/"/g, '""')}"`).join(','));
      });
      const blob = new Blob(['\uFEFF' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'mau_du_lieu_fpa.csv';
      a.click();
      setStatus('Đã tải xuống file mẫu mau_du_lieu_fpa.csv.', 'ok');
    } catch (err) {
      setStatus('Lỗi xuất CSV: ' + err.message, 'err');
    }
  }

  function exportFullExcel() {
    try {
      if (typeof XLSX === 'undefined') throw new Error('Thư viện SheetJS chưa sẵn sàng.');
      const wb = XLSX.utils.book_new();
      const wsHist = XLSX.utils.json_to_sheet(state.data);
      XLSX.utils.book_append_sheet(wb, wsHist, 'DuLieu_LichSu');

      if (!state.forecast.length) runScenarioModel();
      const fcSheetData = state.forecast.map(f => ({
        Nam_DuBao: f.year,
        DoanhThuThuan_Ty: Number(toBn(f.rev).toFixed(2)),
        GiaVon_Ty: Number(toBn(f.cogs).toFixed(2)),
        LoiNhuanGop_Ty: Number(toBn(f.gp).toFixed(2)),
        BienGop_Pct: Number(f.gm.toFixed(2)),
        ChiPhiBanHang_Ty: Number(toBn(f.sell).toFixed(2)),
        ChiPhiQLDN_Ty: Number(toBn(f.admin).toFixed(2)),
        DoanhThuTaiChinh_Ty: Number(toBn(f.finInc).toFixed(2)),
        LNTT_Ty: Number(toBn(f.pbt).toFixed(2)),
        ThueTNDN_Ty: Number(toBn(f.tax).toFixed(2)),
        LNST_Ty: Number(toBn(f.net).toFixed(2)),
        FCF_Ty: Number(toBn(f.fcf).toFixed(2)),
        TienVaTienGui_Ty: Number(toBn(f.cashPool).toFixed(2))
      }));
      const wsFc = XLSX.utils.json_to_sheet(fcSheetData);
      XLSX.utils.book_append_sheet(wb, wsFc, 'DuBao_KichBan_3Nam');
      XLSX.writeFile(wb, 'BaoCao_FPA_AutoModel.xlsx');
      setStatus('Đã xuất báo cáo Excel thành công (BaoCao_FPA_AutoModel.xlsx).', 'ok');
    } catch (err) {
      setStatus('Lỗi xuất Excel: ' + err.message, 'err');
    }
  }

  function copyPrompt(textareaId) {
    try {
      const ta = document.getElementById(textareaId);
      if (!ta) return;
      navigator.clipboard.writeText(ta.value).then(() => {
        setStatus('Đã sao chép Prompt vào Clipboard!', 'ok', 'copyStatus');
      }).catch(() => {
        ta.select();
        document.execCommand('copy');
        setStatus('Đã sao chép Prompt!', 'ok', 'copyStatus');
      });
    } catch (err) {
      setStatus('Lỗi sao chép: ' + err.message, 'err', 'copyStatus');
    }
  }

  function setupDropzone() {
    const dz = document.getElementById('dropzone');
    if (!dz) return;
    ['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('dragover'); }));
    ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('dragover'); }));
    dz.addEventListener('drop', handleFileUpload);
  }

  // Expose handlers to window for inline HTML events
  window.switchTab = switchTab;
  window.renderOverview = renderOverview;
  window.runIntegrityChecks = runIntegrityChecks;
  window.resetDefaultData = resetDefaultData;
  window.handleFileUpload = handleFileUpload;
  window.updateStagingCell = updateStagingCell;
  window.openManualStaging = openManualStaging;
  window.closeStagingBox = closeStagingBox;
  window.commitStagingData = commitStagingData;
  window.cancelPdfProcessing = cancelPdfProcessing;
  window.switchSamplePreset = switchSamplePreset;
  window.saveAsCustomProfile = saveAsCustomProfile;
  window.updateCompanyName = updateCompanyName;
  window.renderVariance = renderVariance;
  window.updateBudgetAndRender = updateBudgetAndRender;
  window.applyScenarioPreset = applyScenarioPreset;
  window.runScenarioModel = runScenarioModel;
  window.downloadTemplateCsv = downloadTemplateCsv;
  window.exportFullExcel = exportFullExcel;
  window.copyPrompt = copyPrompt;

  // Boot
  document.addEventListener('DOMContentLoaded', () => {
    try {
      loadState();
      refreshPresetDropdown(state.meta && state.meta.id);
      syncHeaderAndSelectors();
      setupDropzone();
      renderOverview();
      runIntegrityChecks();
      renderCleanTable();
    } catch (err) {
      setStatus('Lỗi khởi tạo ứng dụng: ' + err.message, 'err');
    }
  });
})();
