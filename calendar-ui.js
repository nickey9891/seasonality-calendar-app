'use strict';

(() => {
  let dayModalDate = null;
  let dayModalItems = [];

  function statusLabel(q, item) {
    if (q) {
      if (q.status === 'BUY SETUP') return 'BUY';
      if (q.status === 'SELL SETUP') return 'SELL';
      return q.status;
    }
    const today = new Date();
    const today0 = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    if (item.date > today0) return 'WATCH';
    return 'CHECK';
  }

  function statusClass(q, item) {
    if (q) return decisionClass(q.status);
    const today = new Date();
    const today0 = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    return item.date > today0 ? 'watch' : 'checking';
  }

  function ensureDayModal() {
    if ($('dayModalWrap')) return;
    const wrap = document.createElement('div');
    wrap.id = 'dayModalWrap';
    wrap.className = 'dayModalWrap';
    wrap.innerHTML = `
      <div class="dayModal" role="dialog" aria-modal="true" aria-labelledby="dayModalTitle">
        <div class="handle"></div>
        <div class="dayModalHead">
          <div>
            <h3 id="dayModalTitle">Day signals</h3>
            <div class="dayModalSub" id="dayModalSub"></div>
          </div>
          <button type="button" class="dayModalX" id="dayModalX" aria-label="Close">×</button>
        </div>
        <div class="dayTickerList" id="dayTickerList"></div>
        <button type="button" class="close" id="dayModalClose">Close</button>
      </div>`;
    document.body.appendChild(wrap);
    $('dayModalX').onclick = closeDayModal;
    $('dayModalClose').onclick = closeDayModal;
    wrap.onclick = e => { if (e.target === wrap) closeDayModal(); };
  }

  function closeDayModal() {
    const wrap = $('dayModalWrap');
    if (wrap) wrap.classList.remove('show');
    dayModalDate = null;
    dayModalItems = [];
  }

  function dayStatusRank(item) {
    const q = qualificationCache.get(qKey(item));
    if (!q) return 3;
    if (q.status === 'BUY SETUP' || q.status === 'SELL SETUP') return 0;
    if (q.status === 'WAIT') return 1;
    if (q.status === 'PASS') return 2;
    return 3;
  }

  function renderDayRows() {
    ensureDayModal();
    const list = $('dayTickerList');
    list.innerHTML = '';
    const sorted = [...dayModalItems].sort((a, b) => {
      const rankDiff = dayStatusRank(a) - dayStatusRank(b);
      return rankDiff || signalStrength(b.signal) - signalStrength(a.signal) || a.ticker.localeCompare(b.ticker);
    });

    if (!sorted.length) {
      list.innerHTML = '<div class="dayEmpty">No qualifying historical trends start on this date.</div>';
      return;
    }

    for (const item of sorted) {
      const q = qualificationCache.get(qKey(item));
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'dayTickerRow';
      button.dataset.qkey = qKey(item);
      const direction = item.signal.dir === 'up' ? 'Bullish' : 'Bearish';
      const arrow = item.signal.dir === 'up' ? '↑' : '↓';
      const avg = pct(item.signal.avg);
      button.innerHTML = `
        <div class="dayTickerLeft">
          <div class="dayTickerName ${item.signal.dir}">${arrow} ${item.ticker}</div>
          <div class="dayTickerMeta">${direction} · ${Math.round(item.signal.win)}% · avg ${avg} · ${item.signal.years}y</div>
        </div>
        <div class="dayTickerRight">
          <span class="decision ${statusClass(q, item)}">${statusLabel(q, item)}</span>
          <span class="dayChevron">›</span>
        </div>`;
      button.onclick = () => {
        closeDayModal();
        openModal(item);
      };
      list.appendChild(button);
    }
  }

  function shouldQualifyDay(date) {
    const today = new Date();
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const cutoff = addMarketDays(start, 5);
    return date <= cutoff && projectedEnd(date) >= start;
  }

  async function refreshDayQualifications() {
    if (!dayModalDate || !dayModalItems.length || !shouldQualifyDay(dayModalDate)) return;
    const snapshotKey = ymd(dayModalDate);
    await pool(dayModalItems, 3, async item => {
      if (!qualificationCache.has(qKey(item))) {
        try { await qualifySignal(item); } catch (_) {}
      }
      if (dayModalDate && ymd(dayModalDate) === snapshotKey) renderDayRows();
    });
  }

  function openDayModal(date, items) {
    ensureDayModal();
    dayModalDate = new Date(date);
    dayModalItems = [...items];
    $('dayModalTitle').textContent = dayModalDate.toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric'
    });
    $('dayModalSub').textContent = `${items.length} ticker${items.length === 1 ? '' : 's'} · tap a ticker for full details`;
    renderDayRows();
    $('dayModalWrap').classList.add('show');
    refreshDayQualifications();
  }

  renderCalendar = function(signals) {
    const y = current.getFullYear(), m = current.getMonth();
    $('monthTitle').textContent = current.toLocaleString('en-US', { month: 'long', year: 'numeric' });

    const byDate = new Map();
    for (const s of signals) {
      const key = ymd(s.date);
      if (!byDate.has(key)) byDate.set(key, []);
      byDate.get(key).push(s);
    }
    for (const arr of byDate.values()) arr.sort((a, b) => signalStrength(b.signal) - signalStrength(a.signal));

    const first = new Date(y, m, 1);
    const start = new Date(y, m, 1 - first.getDay());
    const today = new Date();
    const grid = $('grid');
    grid.innerHTML = '';

    for (let i = 0; i < 42; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      const inMonth = d.getMonth() === m;
      const key = ymd(d);
      const ev = inMonth ? (byDate.get(key) || []) : [];

      const cell = document.createElement('div');
      cell.className = 'day' + (!inMonth ? ' other' : '') + (key === ymd(today) ? ' today' : '') + (ev.length ? ' hasSignals' : '');
      cell.setAttribute('role', ev.length ? 'button' : 'gridcell');
      if (ev.length) {
        cell.tabIndex = 0;
        cell.setAttribute('aria-label', `${d.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}: ${ev.length} ticker signals. Tap to view all.`);
        cell.onclick = () => openDayModal(d, ev);
        cell.onkeydown = e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openDayModal(d, ev);
          }
        };
      }

      const num = document.createElement('div');
      num.className = 'num';
      num.textContent = d.getDate();
      cell.appendChild(num);

      if (inMonth && ev.length) {
        ev.slice(0, 4).forEach(item => {
          const b = document.createElement('button');
          const q = qualificationCache.get(qKey(item));
          b.type = 'button';
          b.className = `stock ${item.signal.dir}`;
          const action = q && (q.status === 'BUY SETUP' || q.status === 'SELL SETUP')
            ? ` ${q.status === 'BUY SETUP' ? 'BUY' : 'SELL'}`
            : '';
          b.textContent = `${item.signal.dir === 'up' ? '↑' : '↓'} ${item.ticker} ${Math.round(item.signal.win)}${action}`;
          b.onclick = e => {
            e.stopPropagation();
            openModal(item);
          };
          cell.appendChild(b);
        });

        if (ev.length > 4) {
          const more = document.createElement('button');
          more.type = 'button';
          more.className = 'more moreButton';
          more.textContent = `+${ev.length - 4} more`;
          more.onclick = e => {
            e.stopPropagation();
            openDayModal(d, ev);
          };
          cell.appendChild(more);
        } else {
          const hint = document.createElement('div');
          hint.className = 'tapHint';
          hint.textContent = 'Tap day';
          cell.appendChild(hint);
        }
      }
      grid.appendChild(cell);
    }
    $('emptyHint').style.display = signals.length ? 'none' : 'block';
  };

  ensureDayModal();

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && $('dayModalWrap')?.classList.contains('show')) {
      e.stopImmediatePropagation();
      closeDayModal();
    }
  }, true);

  if (Array.isArray(currentSignals) && currentSignals.length) renderCalendar(currentSignals);
})();
