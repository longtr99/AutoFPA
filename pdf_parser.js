/* FP&A AutoModel v3.0 - Vietnamese BCTC (TT200 & TT202 Hợp nhất) PDF + Auto-OCR + Smart Excel Parser */
(function () {
  'use strict';

  if (typeof pdfjsLib !== 'undefined') {
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }

  let ocrWorker = null;

  async function getOcrWorker(onProgress) {
    if (typeof Tesseract === 'undefined') {
      throw new Error('Thư viện OCR (Tesseract.js) chưa tải xong. Vui lòng kiểm tra kết nối Internet.');
    }
    if (!ocrWorker) {
      if (onProgress) onProgress('Đang khởi tạo bộ đọc OCR tiếng Việt (chỉ tải 1 lần ~10MB)...');
      ocrWorker = await Tesseract.createWorker('vie', 1, {
        logger: (m) => {
          if (onProgress && m.status === 'loading language traineddata') {
            onProgress(`Đang tải gói ngôn ngữ OCR tiếng Việt (${Math.round((m.progress || 0) * 100)}%)...`);
          }
        }
      });
    }
    return ocrWorker;
  }

  // Parse Vietnamese number format: "81.621.329" or "(233.984)" or "-16,832"
  function parseVNNumber(token) {
    if (!token) return null;
    let s = String(token).trim();
    if (!s || s === '-' || s === '—') return null;
    let isNeg = false;
    if ((s.startsWith('(') && s.endsWith(')')) || s.startsWith('(')) {
      isNeg = true;
      s = s.replace(/[()]/g, '').trim();
    } else if (s.startsWith('-')) {
      isNeg = true;
      s = s.slice(1).trim();
    }
    // Fix common OCR confusions inside numeric tokens
    s = s.replace(/[oO]/g, '0').replace(/[lI|]/g, '1').replace(/\s+/g, '');
    const dotCount = (s.match(/\./g) || []).length;
    const commaCount = (s.match(/,/g) || []).length;
    if (dotCount >= 1 && commaCount === 0) {
      s = s.replace(/\./g, '');
    } else if (commaCount >= 1 && dotCount === 0) {
      s = s.replace(/,/g, '');
    } else {
      s = s.replace(/\./g, '').replace(',', '.');
    }
    if (!/^\d+(\.\d+)?$/.test(s)) return null;
    const val = Number(s);
    if (!Number.isFinite(val)) return null;
    return isNeg ? -val : val;
  }

  function extractRowNumbers(line) {
    // Match formatted numbers (e.g. 81.621.329, (233.984), 1.345) — ignore 2-3 digit codes like 100, 270
    const regex = /\(?\-?\d{1,3}(?:[.,]\d{3})+\)?|\(?\-?\d{5,}\)?/g;
    const matches = line.match(regex) || [];
    const nums = [];
    for (const m of matches) {
      const n = parseVNNumber(m);
      if (n !== null) nums.push(n);
    }
    return nums;
  }

  // Preprocess rendered PDF page canvas for crisp OCR of numbers & tables
  function enhanceCanvasContrast(canvas) {
    const ctx = canvas.getContext('2d');
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = imgData.data;
    for (let i = 0; i < d.length; i += 4) {
      // Grayscale luminance
      const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      // Boost contrast gently while suppressing light red stamp bleed
      const val = gray > 195 ? 255 : (gray < 120 ? 0 : gray);
      d[i] = d[i + 1] = d[i + 2] = val;
    }
    ctx.putImageData(imgData, 0, 0);
  }

  // Extract lines from PDF: fast text-layer first; automatic Tesseract.js OCR fallback for scanned PDFs
  async function extractLinesFromPDF(arrayBuffer, options = {}) {
    if (typeof pdfjsLib === 'undefined') {
      throw new Error('Thư viện PDF.js chưa tải xong. Vui lòng kiểm tra kết nối Internet.');
    }
    const { onProgress, ocrStartPage = 5, ocrEndPage = 14, abortSignal = null } = options;
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const allLines = [];
    let totalChars = 0;
    const maxTextPages = Math.min(pdf.numPages, 22);

    // Phase 1: Fast native text-layer scan
    for (let p = 1; p <= maxTextPages; p++) {
      if (abortSignal && abortSignal.aborted) throw new Error('Đã hủy đọc PDF theo yêu cầu.');
      if (onProgress) onProgress(`Đang kiểm tra lớp chữ trang ${p}/${maxTextPages}...`);
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      const rows = new Map();

      for (const item of content.items) {
        const str = (item.str || '').trim();
        if (!str) continue;
        totalChars += str.length;
        const y = Math.round(item.transform[5] / 4) * 4;
        if (!rows.has(y)) rows.set(y, []);
        rows.get(y).push({ x: item.transform[4], str });
      }
      const sortedYs = Array.from(rows.keys()).sort((a, b) => b - a);
      for (const y of sortedYs) {
        const lineItems = rows.get(y).sort((a, b) => a.x - b.x);
        const lineText = lineItems.map(i => i.str).join(' ').replace(/\s+/g, ' ').trim();
        if (lineText) allLines.push({ page: p, text: lineText });
      }
    }

    if (totalChars >= 120) {
      return { lines: allLines, totalChars, numPages: pdf.numPages, usedOcr: false };
    }

    // Phase 2: Automatic Smart OCR for Scanned Image PDFs (Cover page 1 + Financial Statements pages start..end)
    const worker = await getOcrWorker(onProgress);
    const pagesToOcr = [1];
    const pStart = Math.max(2, Math.min(ocrStartPage, pdf.numPages));
    const pEnd = Math.min(ocrEndPage, pdf.numPages);
    for (let p = pStart; p <= pEnd; p++) pagesToOcr.push(p);

    const ocrLines = [];
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    for (let idx = 0; idx < pagesToOcr.length; idx++) {
      if (abortSignal && abortSignal.aborted) throw new Error('Đã hủy OCR theo yêu cầu.');
      const p = pagesToOcr[idx];
      if (onProgress) onProgress(`PDF ảnh scan → Đang OCR trang ${p} (${idx + 1}/${pagesToOcr.length})...`);

      const page = await pdf.getPage(p);
      const viewport = page.getViewport({ scale: 2.0 });
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await page.render({ canvasContext: ctx, viewport }).promise;
      enhanceCanvasContrast(canvas);

      const { data } = await worker.recognize(canvas);
      const rawLines = (data.text || '').split(/\r?\n/);
      for (const rl of rawLines) {
        const clean = rl.replace(/\s+/g, ' ').trim();
        if (clean) ocrLines.push({ page: p, text: clean });
      }
    }

    return { lines: ocrLines, totalChars: ocrLines.length * 20, numPages: pdf.numPages, usedOcr: true };
  }

  // Detect unit multiplier (VND vs Triệu VND vs Nghìn VND) & parse TT200 + TT202 Consolidated lines
  function parseTT200Lines(lines, fileName) {
    const fullText = lines.map(l => l.text).join('\n');

    // 1. Detect fiscal year
    let detectedYear = null;
    const yMatch1 = fullText.match(/31\s*tháng\s*12\s*năm\s*(20\d{2})/i) || fullText.match(/31\/12\/(20\d{2})/);
    if (yMatch1) detectedYear = Number(yMatch1[1]);
    if (!detectedYear && fileName) {
      const yf = fileName.match(/(20\d{2})/);
      if (yf) detectedYear = Number(yf[1]);
    }
    if (!detectedYear) detectedYear = new Date().getFullYear() - 1;

    // 2. Detect Unit Multiplier (Critical for Consolidated BCTC like Masan: "Triệu VND")
    let unitMultiplier = 1;
    let unitLabel = 'VND';
    if (/triệu\s*(vnd|vnđ|đồng)/i.test(fullText)) {
      unitMultiplier = 1e6;
      unitLabel = 'Triệu VND';
    } else if (/(nghìn|ngàn)\s*(vnd|vnđ|đồng)/i.test(fullText)) {
      unitMultiplier = 1e3;
      unitLabel = 'Nghìn VND';
    }

    // 3. Detect company name
    let companyName = '';
    for (const l of lines.slice(0, 60)) {
      if (/CÔNG\s+TY\s+(CỔ\s+PHẦN|TNHH)/i.test(l.text) && !/KIỂM\s+TOÁN|DELOITTE|KPMG|PWC|EY|CHI\s+NHÁNH/i.test(l.text)) {
        companyName = l.text.replace(/^.*?(CÔNG\s+TY)/i, '$1').trim();
        break;
      }
    }

    const cur = createEmptyRecord(detectedYear, `Bóc tách tự động (${unitLabel}) từ ${fileName}`);
    const prev = createEmptyRecord(detectedYear - 1, `Số liệu so sánh (${unitLabel}) từ ${fileName}`);

    let section = 'UNKNOWN';
    let matchedFields = 0;

    // Supports both TT200 (B01-DN) and TT202 Consolidated (B01-DN/HN), with or without leading zeros
    const B01_RULES = [
      [/\b100\b/, /tài sản ngắn hạn/i, 'current_assets'],
      [/\b110\b/, /tiền và các khoản tương đương tiền|^tiền\b/i, 'cash'],
      [/\b120\b/, /đầu tư tài chính ngắn hạn/i, 'st_invest'],
      [/\b130\b/, /các khoản phải thu ngắn hạn/i, 'ar_total'],
      [/\b131\b/, /phải thu.*khách hàng/i, 'ar_trade'],
      [/\b140\b/, /hàng tồn kho/i, 'inventory'],
      [/\b150\b/, /tài sản ngắn hạn khác/i, 'other_ca'],
      [/\b200\b/, /tài sản dài hạn/i, 'non_current_assets'],
      [/\b220\b/, /tài sản cố định/i, 'fixed_assets'],
      [/\b240\b/, /tài sản dở dang dài hạn/i, 'cip_long'],
      [/\b270\b/, /tổng\s*(cộng\s*)?tài sản/i, 'total_assets'],
      [/\b300\b/, /nợ phải trả/i, 'total_liab'],
      [/\b310\b/, /nợ ngắn hạn/i, 'current_liab'],
      [/\b311\b/, /phải trả người bán ngắn hạn/i, 'ap_trade'],
      [/\b320\b/, /vay.*ngắn hạn/i, 'st_debt'],
      [/\b330\b/, /nợ dài hạn/i, 'non_current_liab'],
      [/\b338\b/, /vay.*dài hạn/i, 'lt_debt'],
      [/\b400\b/, /vốn chủ sở hữu/i, 'equity']
    ];

    const B02_RULES = [
      [/\b0?1\b/, /tổng doanh thu|doanh thu bán hàng và cung cấp dịch vụ/i, 'gross_rev'],
      [/\b0?2\b/, /các khoản giảm trừ doanh thu/i, 'deductions'],
      [/\b10\b/, /doanh thu thuần/i, 'net_rev'],
      [/\b11\b/, /giá vốn hàng bán/i, 'cogs'],
      [/\b20\b/, /lợi nhuận gộp/i, 'gross_profit'],
      [/\b21\b/, /doanh thu hoạt động tài chính/i, 'fin_inc'],
      [/\b22\b/, /chi phí tài chính/i, 'fin_exp'],
      [/\b23\b/, /chi phí lãi vay/i, 'int_exp'],
      [/\b24\b/, /phần lãi.*công ty liên kết/i, 'assoc_profit'],
      [/\b25\b/, /chi phí bán hàng/i, 'selling_exp'],
      [/\b26\b/, /chi phí quản lý doanh nghiệp/i, 'admin_exp'],
      [/\b30\b/, /lợi nhuận thuần từ hoạt động kinh doanh/i, 'op_profit'],
      [/\b31\b/, /thu nhập khác/i, 'other_inc'],
      [/\b32\b/, /chi phí khác/i, 'other_exp'],
      [/\b40\b/, /lợi nhuận khác|lỗ khác|kết quả.*hoạt động khác/i, 'other_profit'],
      [/\b50\b/, /lợi nhuận.*trước thuế/i, 'pbt'],
      [/\b51\b/, /chi phí thuế.*hiện hành/i, 'tax_curr'],
      [/\b52\b/, /(chi phí|lợi ích).*thuế.*hoãn lại/i, 'tax_def'],
      [/\b60\b/, /lợi nhuận.*sau thuế/i, 'net_profit'],
      [/\b70\b/, /lãi cơ bản trên cổ phiếu/i, 'eps']
    ];

    const B03_RULES = [
      [/\b0?2\b/, /khấu hao/i, 'depreciation'],
      [/\b20\b/, /lưu chuyển tiền thuần từ hoạt động kinh doanh/i, 'cfo'],
      [/\b21\b/, /tiền chi.*mua.*tài sản cố định/i, 'capex'],
      [/\b30\b/, /lưu chuyển tiền thuần từ hoạt động đầu tư/i, 'cfi'],
      [/\b36\b/, /cổ tức/i, 'dividends_paid'],
      [/\b40\b/, /lưu chuyển tiền thuần từ hoạt động tài chính/i, 'cff']
    ];

    let taxCurrCur = 0, taxDefCur = 0, taxCurrPrev = 0, taxDefPrev = 0;

    for (const l of lines) {
      const txt = l.text;
      if (/BẢNG\s+CÂN\s+ĐỐI\s+KẾ\s+TOÁN|Mẫu\s*(số\s*)?B\s*01/i.test(txt)) { section = 'B01'; continue; }
      if (/BÁO\s+CÁO\s+KẾT\s+QUẢ\s+HOẠT\s+ĐỘNG\s+KINH\s+DOANH|Mẫu\s*(số\s*)?B\s*02/i.test(txt)) { section = 'B02'; continue; }
      if (/BÁO\s+CÁO\s+LƯU\s+CHUYỂN\s+TIỀN\s+TỆ|Mẫu\s*(số\s*)?B\s*03/i.test(txt)) { section = 'B03'; continue; }
      if (/THUYẾT\s+MINH\s+BÁO\s+CÁO\s+TÀI\s+CHÍNH|Mẫu\s*(số\s*)?B\s*09/i.test(txt)) { section = 'B09'; continue; }

      const rules = section === 'B01' ? B01_RULES : section === 'B02' ? B02_RULES : section === 'B03' ? B03_RULES : null;
      if (!rules) continue;

      const nums = extractRowNumbers(txt);
      if (nums.length === 0) continue;

      for (const [codeRx, labelRx, key] of rules) {
        if (labelRx.test(txt) && (codeRx.test(txt) || nums.length >= 2)) {
          const isEps = key === 'eps';
          const mult = isEps ? 1 : unitMultiplier;
          const absKey = (key === 'capex' || key === 'dividends_paid');
          const vCur = (absKey ? Math.abs(nums.length >= 2 ? nums[nums.length - 2] : nums[0]) : (nums.length >= 2 ? nums[nums.length - 2] : nums[0])) * mult;
          const vPrev = nums.length >= 2 ? (absKey ? Math.abs(nums[nums.length - 1]) : nums[nums.length - 1]) * mult : 0;

          if (key === 'tax_curr') {
            if (!taxCurrCur) { taxCurrCur = vCur; matchedFields++; }
            if (!taxCurrPrev && nums.length >= 2) taxCurrPrev = vPrev;
          } else if (key === 'tax_def') {
            if (!taxDefCur) { taxDefCur = vCur; matchedFields++; }
            if (!taxDefPrev && nums.length >= 2) taxDefPrev = vPrev;
          } else {
            if (!cur[key]) { cur[key] = vCur; matchedFields++; }
            if (!prev[key] && nums.length >= 2) prev[key] = vPrev;
          }
          break;
        }
      }
    }

    if (taxCurrCur || taxDefCur) cur.tax = taxCurrCur + taxDefCur;
    if (taxCurrPrev || taxDefPrev) prev.tax = taxCurrPrev + taxDefPrev;

    [cur, prev].forEach(r => finalizeDerivedFields(r));

    const results = [];
    if (cur.net_rev > 0 || cur.total_assets > 0) results.push(cur);
    if (prev.net_rev > 0 || prev.total_assets > 0) results.push(prev);

    return { companyName, records: results, matchedFields, unitLabel };
  }

  function createEmptyRecord(year, note = '') {
    return {
      year, gross_rev: 0, deductions: 0, net_rev: 0, cogs: 0, gross_profit: 0,
      fin_inc: 0, fin_exp: 0, int_exp: 0, assoc_profit: 0, selling_exp: 0, admin_exp: 0, op_profit: 0,
      other_inc: 0, other_exp: 0, other_profit: 0, pbt: 0, tax: 0, net_profit: 0, eps: 0,
      current_assets: 0, cash: 0, st_invest: 0, ar_total: 0, ar_trade: 0, inventory: 0, other_ca: 0,
      non_current_assets: 0, fixed_assets: 0, cip_long: 0, total_assets: 0,
      total_liab: 0, current_liab: 0, ap_trade: 0, st_debt: 0, non_current_liab: 0, lt_debt: 0, equity: 0,
      cfo: 0, capex: 0, cfi: 0, cff: 0, dividends_paid: 0,
      depreciation: 0, material_cost: 0, labor_cost: 0, promo_cost: 0, employees: 0,
      rev_finished: 0, rev_merch: 0, rev_other: 0, rev_vinamilk: 0, shares: 0, note
    };
  }

  function finalizeDerivedFields(r) {
    r.assoc_profit = Number(r.assoc_profit) || 0;
    r.lt_debt = Number(r.lt_debt) || 0;
    if (!r.gross_rev && r.net_rev) r.gross_rev = r.net_rev + r.deductions;
    if (!r.gross_profit && r.net_rev && r.cogs) r.gross_profit = r.net_rev - r.cogs;
    if (!r.op_profit && r.gross_profit) {
      r.op_profit = r.gross_profit + (r.fin_inc - r.fin_exp) + r.assoc_profit - (r.selling_exp + r.admin_exp);
    }
    if (!r.pbt && r.op_profit) r.pbt = r.op_profit + r.other_profit;
    if (!r.net_profit && r.pbt) r.net_profit = r.pbt - r.tax;
    if (!r.total_assets && (r.current_assets || r.non_current_assets)) r.total_assets = r.current_assets + r.non_current_assets;
    if (!r.total_liab && (r.current_liab || r.non_current_liab)) r.total_liab = r.current_liab + r.non_current_liab;
    if (!r.material_cost && r.cogs) r.material_cost = Math.round(r.cogs * 0.80);
    if (!r.promo_cost && r.selling_exp) r.promo_cost = Math.round(r.selling_exp * 0.45);
    if (!r.labor_cost && r.cogs) r.labor_cost = Math.round(r.cogs * 0.08);
    if (!r.rev_finished && r.net_rev) r.rev_finished = r.net_rev;
    return r;
  }

  // Smart Excel parser (supports flat table & vertical TT200/TT202 multi-year sheets with auto unit detection)
  function parseExcelWorkbook(wb, fileName) {
    const allRecordsMap = new Map();
    const CODE_MAP = {
      '100': 'current_assets', '110': 'cash', '120': 'st_invest', '130': 'ar_total', '131': 'ar_trade',
      '140': 'inventory', '150': 'other_ca', '200': 'non_current_assets', '220': 'fixed_assets',
      '240': 'cip_long', '270': 'total_assets', '300': 'total_liab', '310': 'current_liab',
      '311': 'ap_trade', '320': 'st_debt', '330': 'non_current_liab', '338': 'lt_debt', '400': 'equity',
      '01': 'gross_rev', '1': 'gross_rev', '02': 'deductions', '2': 'deductions',
      '10': 'net_rev', '11': 'cogs', '20': 'gross_profit',
      '21': 'fin_inc', '22': 'fin_exp', '23': 'int_exp', '24': 'assoc_profit',
      '25': 'selling_exp', '26': 'admin_exp', '30': 'op_profit', '31': 'other_inc',
      '32': 'other_exp', '40': 'other_profit', '50': 'pbt', '51': 'tax', '60': 'net_profit', '70': 'eps'
    };

    for (const sheetName of wb.SheetNames) {
      const ws = wb.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
      if (!rows.length) continue;

      const firstKeys = Object.keys(rows[0]).map(k => k.toLowerCase());
      if (firstKeys.includes('year') && firstKeys.includes('net_rev')) {
        return { mode: 'flat', records: rows };
      }

      const sheetText = JSON.stringify(rows.slice(0, 8));
      let mult = 1;
      if (/triệu\s*(vnd|vnđ|đồng)/i.test(sheetText)) mult = 1e6;
      else if (/(nghìn|ngàn)\s*(vnd|vnđ|đồng)/i.test(sheetText)) mult = 1e3;

      const yearCols = Object.keys(rows[0]).filter(k => /20\d{2}/.test(k));
      if (yearCols.length > 0) {
        const isCashFlow = /lctt|luu chuyen|cash/i.test(sheetName);
        for (const r of rows) {
          const vals = Object.values(r).map(v => String(v).trim());
          const rowText = vals.join(' ');
          let code = '';
          for (const v of vals) {
            if (/^\d{1,3}$/.test(v)) { code = v; break; }
          }
          let fieldKey = null;
          if (isCashFlow) {
            if (code === '02' || code === '2' || /khấu hao/i.test(rowText)) fieldKey = 'depreciation';
            else if (code === '20' || /lưu chuyển tiền thuần từ hoạt động kinh doanh/i.test(rowText)) fieldKey = 'cfo';
            else if (code === '21' || /mua.*tài sản cố định/i.test(rowText)) fieldKey = 'capex';
            else if (code === '30' || /lưu chuyển tiền thuần từ hoạt động đầu tư/i.test(rowText)) fieldKey = 'cfi';
            else if (code === '40' || /lưu chuyển tiền thuần từ hoạt động tài chính/i.test(rowText)) fieldKey = 'cff';
          } else {
            fieldKey = CODE_MAP[code] || null;
          }
          if (!fieldKey) continue;

          for (const yc of yearCols) {
            const y = Number(yc.match(/(20\d{2})/)[1]);
            if (!allRecordsMap.has(y)) allRecordsMap.set(y, createEmptyRecord(y, `Nạp từ Excel (${fileName})`));
            const rec = allRecordsMap.get(y);
            const num = parseVNNumber(r[yc]);
            if (num !== null && !rec[fieldKey]) {
              const m = fieldKey === 'eps' ? 1 : mult;
              rec[fieldKey] = (fieldKey === 'capex' || fieldKey === 'dividends_paid') ? Math.abs(num) * m : num * m;
            }
          }
        }
      }
    }

    const records = Array.from(allRecordsMap.values()).map(finalizeDerivedFields).filter(r => r.net_rev > 0 || r.total_assets > 0);
    return { mode: 'vertical', records };
  }

  window.FPA_PARSER = {
    extractLinesFromPDF,
    parseTT200Lines,
    parseExcelWorkbook,
    createEmptyRecord,
    finalizeDerivedFields
  };
})();
