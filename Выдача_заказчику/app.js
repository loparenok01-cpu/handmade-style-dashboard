'use strict';

const KNOWN_CATEGORIES = ['Серьги', 'Кольца', 'Браслеты', 'Подвески'];
const MONTHS_GENITIVE = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'
];
const DAY_MS = 86400000;

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }

  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

function parseNumber(raw) {
  const normalized = String(raw).trim().replace(/\s+/g, '').replace(',', '.');
  if (normalized === '') {
    return null;
  }
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

function isValidIsoDate(iso) {
  const probe = new Date(0);
  probe.setUTCFullYear(
    Number(iso.slice(0, 4)),
    Number(iso.slice(5, 7)) - 1,
    Number(iso.slice(8, 10))
  );
  return probe.toISOString().slice(0, 10) === iso;
}

function loadOrders(text) {
  const rows = parseCsv(String(text == null ? '' : text));
  if (rows.length === 0) {
    return [];
  }

  const columns = ['order_id', 'date', 'product', 'category', 'quantity', 'price', 'total'];
  const header = rows[0].map(cell => cell.trim());
  const missing = columns.filter(name => header.indexOf(name) === -1);
  if (missing.length > 0) {
    throw new Error(
      'не найдены колонки: ' + missing.join(', ') +
      '. Ожидается CSV со столбцами: ' + columns.join(', ') + '.'
    );
  }

  const index = {};
  columns.forEach(name => {
    index[name] = header.indexOf(name);
  });

  const orders = [];
  const seenIds = new Set();

  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    const line = r + 1;

    if (cells.length === 1 && cells[0].trim() === '') {
      continue;
    }
    if (cells.length < columns.length) {
      throw new Error(
        'строка ' + line + ': ожидалось ' + columns.length +
        ' колонок, найдено ' + cells.length + '. Проверьте разделители и кавычки.'
      );
    }

    const idRaw = cells[index.order_id].trim();
    if (!/^\d+$/.test(idRaw)) {
      throw new Error('строка ' + line + ': «' + idRaw + '» — order_id должен быть целым числом.');
    }
    const orderId = Number(idRaw);
    if (seenIds.has(orderId)) {
      continue;
    }

    const date = cells[index.date].trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error('строка ' + line + ': дата «' + date + '» должна быть в формате ГГГГ-ММ-ДД.');
    }
    if (!isValidIsoDate(date)) {
      throw new Error('строка ' + line + ': дата «' + date + '» не существует в календаре.');
    }

    const product = cells[index.product].trim();
    if (product === '') {
      throw new Error('строка ' + line + ': не заполнено название товара.');
    }

    const quantity = parseNumber(cells[index.quantity]);
    if (quantity === null || quantity <= 0) {
      throw new Error('строка ' + line + ': количество «' + cells[index.quantity].trim() + '» должно быть положительным числом.');
    }

    const price = parseNumber(cells[index.price]);
    if (price === null || price < 0) {
      throw new Error('строка ' + line + ': цена «' + cells[index.price].trim() + '» должна быть неотрицательным числом.');
    }

    const total = parseNumber(cells[index.total]);
    if (total === null || total < 0) {
      throw new Error('строка ' + line + ': сумма «' + cells[index.total].trim() + '» должна быть неотрицательным числом.');
    }

    const category = cells[index.category].trim();

    seenIds.add(orderId);
    orders.push({
      id: orderId,
      date: date,
      product: product,
      category: KNOWN_CATEGORIES.indexOf(category) !== -1 ? category : 'Прочее',
      quantity: quantity,
      price: price,
      total: total,
      mismatch: Math.abs(total - quantity * price) > 0.01
    });
  }

  return orders;
}

function accumulate(map, key, order) {
  let group = map.get(key);
  if (!group) {
    group = { name: key, revenue: 0, units: 0, orderCount: 0 };
    map.set(key, group);
  }
  group.revenue += order.total;
  group.units += order.quantity;
  group.orderCount += 1;
}

function compareGroups(a, b) {
  return (b.revenue - a.revenue) ||
    (b.orderCount - a.orderCount) ||
    a.name.localeCompare(b.name, 'ru');
}

function buildDateRange(dayMap) {
  const keys = Array.from(dayMap.keys()).sort();
  if (keys.length === 0) {
    return [];
  }
  const start = Date.parse(keys[0] + 'T00:00:00Z');
  const end = Date.parse(keys[keys.length - 1] + 'T00:00:00Z');
  const result = [];
  for (let t = start; t <= end; t += DAY_MS) {
    const iso = new Date(t).toISOString().slice(0, 10);
    const day = dayMap.get(iso);
    result.push({
      date: iso,
      revenue: day ? day.revenue : 0,
      orderCount: day ? day.orderCount : 0
    });
  }
  return result;
}

function aggregate(orders) {
  const productMap = new Map();
  const categoryMap = new Map();
  const dayMap = new Map();
  let revenue = 0;
  let units = 0;
  let mismatchCount = 0;

  for (const order of orders) {
    revenue += order.total;
    units += order.quantity;
    if (order.mismatch) {
      mismatchCount += 1;
    }
    accumulate(productMap, order.product, order);
    accumulate(categoryMap, order.category, order);
    accumulate(dayMap, order.date, order);
  }

  const orderCount = orders.length;
  const avgCheck = orderCount > 0 ? revenue / orderCount : 0;
  const share = value => (revenue > 0 ? (value / revenue) * 100 : 0);

  const byProduct = Array.from(productMap.values())
    .map(group => Object.assign({}, group, { share: share(group.revenue) }))
    .sort(compareGroups);

  const byCategory = Array.from(categoryMap.values())
    .map(group => Object.assign({}, group, { share: share(group.revenue) }))
    .sort(compareGroups);

  const byDate = buildDateRange(dayMap).map(day => Object.assign(day, { share: share(day.revenue) }));

  const dates = Array.from(dayMap.keys()).sort();
  const period = {
    from: dates.length > 0 ? dates[0] : null,
    to: dates.length > 0 ? dates[dates.length - 1] : null
  };

  const sumProducts = byProduct.reduce((sum, group) => sum + group.revenue, 0);
  const sumCategories = byCategory.reduce((sum, group) => sum + group.revenue, 0);
  const sumDays = byDate.reduce((sum, day) => sum + day.revenue, 0);
  const converged = Math.abs(revenue - sumProducts) < 0.01 &&
    Math.abs(revenue - sumCategories) < 0.01 &&
    Math.abs(revenue - sumDays) < 0.01;
  if (!converged) {
    console.error(
      'Сходимость не сойшлась: выручка ' + revenue +
      ', по товарам ' + sumProducts +
      ', по категориям ' + sumCategories +
      ', по дням ' + sumDays
    );
  }

  const mismatches = orders.filter(order => order.mismatch).map(order => ({
    id: order.id,
    date: order.date,
    total: order.total,
    expected: order.quantity * order.price
  }));

  return {
    revenue: revenue,
    orderCount: orderCount,
    avgCheck: avgCheck,
    units: units,
    mismatchCount: mismatchCount,
    mismatches: mismatches,
    byProduct: byProduct,
    byCategory: byCategory,
    byDate: byDate,
    period: period,
    converged: converged
  };
}

function formatRub(value) {
  return Math.round(value).toLocaleString('ru-RU') + '\u00A0₽';
}

function formatAvgRub(value) {
  return value.toLocaleString('ru-RU', {
    minimumFractionDigits: Number.isInteger(value) ? 0 : 1,
    maximumFractionDigits: 1
  }) + '\u00A0₽';
}

function formatPercent(value) {
  return value.toLocaleString('ru-RU', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1
  }) + '\u00A0%';
}

function formatInt(value) {
  return value.toLocaleString('ru-RU');
}

function formatPlural(value, one, few, many) {
  const mod10 = value % 10;
  const mod100 = value % 100;
  if (mod10 === 1 && mod100 !== 11) {
    return value + ' ' + one;
  }
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return value + ' ' + few;
  }
  return value + ' ' + many;
}

function formatPeriod(from, to) {
  if (!from || !to) {
    return '';
  }
  const fromParts = from.split('-').map(Number);
  const toParts = to.split('-').map(Number);
  if (fromParts[0] === toParts[0] && fromParts[1] === toParts[1]) {
    const month = MONTHS_GENITIVE[fromParts[1] - 1];
    const dayFrom = String(fromParts[2]).padStart(2, '0');
    const dayTo = String(toParts[2]).padStart(2, '0');
    if (from === to) {
      return dayFrom + ' ' + month + ' ' + fromParts[0];
    }
    return dayFrom + '–' + dayTo + ' ' + month + ' ' + fromParts[0];
  }
  return from + ' — ' + to;
}

function formatDateRu(iso) {
  return iso.slice(8, 10) + '.' + iso.slice(5, 7) + '.' + iso.slice(0, 4);
}

function formatMismatchText(state) {
  const shown = state.mismatches.slice(0, 3);
  const examples = shown.map(m =>
    '№' + m.id + ' от ' + formatDateRu(m.date) +
    ' — в выгрузке ' + formatRub(m.total) +
    ', а количество × цена = ' + formatRub(m.expected)
  ).join('; ');
  const rest = state.mismatchCount > shown.length
    ? '; … и ещё ' + (state.mismatchCount - shown.length)
    : '';
  return 'Расхождение в ' +
    formatPlural(state.mismatchCount, 'заказе', 'заказах', 'заказах') +
    ' (выручка считается по сумме из выгрузки): ' + examples + rest + '.';
}

function filterOrders(orders, from, to) {
  if (!from && !to) {
    return orders;
  }
  let start = from;
  let end = to;
  if (start && end && start > end) {
    const tmp = start;
    start = end;
    end = tmp;
  }
  return orders.filter(order =>
    (!start || order.date >= start) && (!end || order.date <= end));
}

let allOrders = [];
let dataMinDate = '';
let dataMaxDate = '';
let filterFrom = '';
let filterTo = '';

function updateDataBounds() {
  const dates = allOrders.map(order => order.date).sort();
  dataMinDate = dates.length > 0 ? dates[0] : '';
  dataMaxDate = dates.length > 0 ? dates[dates.length - 1] : '';
  const fromInput = document.getElementById('filter-from');
  const toInput = document.getElementById('filter-to');
  if (fromInput && toInput) {
    fromInput.min = dataMinDate;
    fromInput.max = dataMaxDate;
    toInput.min = dataMinDate;
    toInput.max = dataMaxDate;
  }
}

function showBanner(message) {
  const banner = document.getElementById('error-banner');
  if (banner) {
    banner.textContent = 'Не удалось прочитать данные. ' + message;
    banner.hidden = false;
  }
}

function hideBanner() {
  const banner = document.getElementById('error-banner');
  if (banner) {
    banner.hidden = true;
  }
}

function setUploadStatus(text) {
  setText('upload-status', text);
}

function onFileSelected(event) {
  const input = event.target;
  const file = input && input.files && input.files[0] ? input.files[0] : null;
  if (!file) {
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const csv = typeof reader.result === 'string' ? reader.result : '';
      allOrders = loadOrders(csv);
      hideBanner();
      updateDataBounds();
      onFilterReset();
      setUploadStatus(
        'Загружено: ' + file.name + ' — ' +
        formatPlural(allOrders.length, 'заказ', 'заказа', 'заказов')
      );
    } catch (error) {
      showBanner(error instanceof Error ? error.message : String(error));
      setUploadStatus('Не удалось прочитать ' + file.name);
    }
    input.value = '';
  };
  reader.onerror = () => {
    showBanner('Не удалось прочитать файл ' + file.name + '.');
    setUploadStatus('Не удалось прочитать ' + file.name);
    input.value = '';
  };
  reader.readAsText(file, 'utf-8');
}

function refresh() {
  const filtered = filterOrders(allOrders, filterFrom, filterTo);
  render(aggregate(filtered));
}

function onFilterChange() {
  const fromInput = document.getElementById('filter-from');
  const toInput = document.getElementById('filter-to');
  filterFrom = fromInput ? fromInput.value : '';
  filterTo = toInput ? toInput.value : '';
  refresh();
}

function onFilterReset() {
  const fromInput = document.getElementById('filter-from');
  const toInput = document.getElementById('filter-to');
  if (fromInput) {
    fromInput.value = dataMinDate;
  }
  if (toInput) {
    toInput.value = dataMaxDate;
  }
  filterFrom = dataMinDate;
  filterTo = dataMaxDate;
  refresh();
}

function setText(id, text) {
  const element = document.getElementById(id);
  if (element) {
    element.textContent = text;
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

function render(state) {
  if (state.orderCount > 0) {
    setText(
      'period-label',
      'Заказы ' + formatPeriod(state.period.from, state.period.to) +
      ' · ' + formatPlural(state.orderCount, 'заказ', 'заказа', 'заказов')
    );
  } else {
    setText('period-label', 'Нет данных за период');
  }
  setText('revenue-value', formatRub(state.revenue));
  setText('orders-value', formatInt(state.orderCount));
  setText('avg-value', formatAvgRub(state.avgCheck));

  const mismatchBanner = document.getElementById('mismatch-banner');
  if (mismatchBanner) {
    if (state.mismatchCount > 0) {
      mismatchBanner.textContent = formatMismatchText(state);
      mismatchBanner.hidden = false;
    } else {
      mismatchBanner.hidden = true;
    }
  }

  renderTopProducts(state);
  renderCategories(state);
  renderDays(state);
}

function renderTopProducts(state) {
  const container = document.getElementById('top-products');
  if (!container) {
    return;
  }
  container.textContent = '';
  if (state.byProduct.length === 0) {
    container.appendChild(el('p', 'empty-note', 'Нет заказов за период'));
    return;
  }
  const rows = state.byProduct.slice(0, 5);
  const maxRevenue = rows[0].revenue > 0 ? rows[0].revenue : 1;

  const table = el('table', 'top-table');
  const thead = el('thead');
  const headRow = el('tr');
  ['№', 'Товар', 'Кол-во, шт', 'Выручка, ₽', 'Доля, %'].forEach(title => {
    headRow.appendChild(el('th', null, title));
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = el('tbody');
  rows.forEach((group, i) => {
    const tr = el('tr');
    tr.appendChild(el('td', 'top-table__rank', String(i + 1)));

    const productCell = el('td', 'top-table__product');
    productCell.appendChild(el('span', 'top-table__name', group.name));
    const rowBar = el('span', 'top-table__bar');
    rowBar.style.width = Math.round((group.revenue / maxRevenue) * 100) + '%';
    productCell.appendChild(rowBar);
    tr.appendChild(productCell);

    tr.appendChild(el('td', 'num', formatInt(group.units)));
    tr.appendChild(el('td', 'num', formatRub(group.revenue)));
    tr.appendChild(el('td', 'num', formatPercent(group.share)));
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  container.appendChild(table);
}

function renderCategories(state) {
  const container = document.getElementById('categories');
  if (!container) {
    return;
  }
  container.textContent = '';
  if (state.byCategory.length === 0) {
    container.appendChild(el('p', 'empty-note', 'Нет заказов за период'));
    return;
  }
  const maxRevenue = state.byCategory[0].revenue > 0 ? state.byCategory[0].revenue : 1;
  const list = el('div', 'cat-list');

  state.byCategory.forEach(group => {
    const item = el('div', 'cat-item');

    const head = el('div', 'cat-item__head');
    head.appendChild(el('span', 'cat-item__name', group.name));
    head.appendChild(el('span', 'cat-item__sum', formatRub(group.revenue)));
    head.appendChild(el('span', 'cat-item__share', formatPercent(group.share)));
    item.appendChild(head);

    const track = el('div', 'cat-item__track');
    const bar = el('div', 'cat-item__bar');
    bar.style.width = Math.round((group.revenue / maxRevenue) * 100) + '%';
    track.appendChild(bar);
    item.appendChild(track);

    item.appendChild(el('div', 'cat-item__meta',
      formatPlural(group.orderCount, 'заказ', 'заказа', 'заказов') +
      ' · ' + formatInt(group.units) + ' шт.'));
    list.appendChild(item);
  });
  container.appendChild(list);
}

function renderDays(state) {
  const container = document.getElementById('by-day');
  if (!container) {
    return;
  }
  container.textContent = '';
  if (state.byDate.length === 0) {
    container.appendChild(el('p', 'empty-note', 'Нет заказов за период'));
    return;
  }
  let maxRevenue = 0;
  state.byDate.forEach(day => {
    if (day.revenue > maxRevenue) {
      maxRevenue = day.revenue;
    }
  });
  const chart = el('div', 'chart');

  state.byDate.forEach(day => {
    const dateLabel = day.date.slice(8, 10) + '.' + day.date.slice(5, 7);
    const col = el('div', 'chart__col');
    col.title = dateLabel + ': ' + formatRub(day.revenue);
    col.appendChild(el('span', 'chart__value', formatRub(day.revenue)));

    const track = el('span', 'chart__track');
    const bar = el('span', 'chart__bar');
    bar.style.height = (maxRevenue > 0 ? Math.round((day.revenue / maxRevenue) * 100) : 0) + '%';
    track.appendChild(bar);
    col.appendChild(track);

    col.appendChild(el('span', 'chart__date', dateLabel));
    chart.appendChild(col);
  });
  container.appendChild(chart);
}

function renderError(message) {
  const banner = document.getElementById('error-banner');
  if (banner) {
    banner.textContent = 'Не удалось прочитать данные. ' + message;
    banner.hidden = false;
  }
  const mismatchBanner = document.getElementById('mismatch-banner');
  if (mismatchBanner) {
    mismatchBanner.hidden = true;
  }
  setText('period-label', 'Данные не загружены');
  setText('revenue-value', '—');
  setText('orders-value', '—');
  setText('avg-value', '—');
}

function init() {
  try {
    const csv = typeof RAW_ORDERS_CSV === 'string' ? RAW_ORDERS_CSV : '';
    allOrders = loadOrders(csv);

    updateDataBounds();

    const fromInput = document.getElementById('filter-from');
    const toInput = document.getElementById('filter-to');
    const resetButton = document.getElementById('filter-reset');
    const fileInput = document.getElementById('csv-file');
    if (fromInput && toInput) {
      fromInput.value = dataMinDate;
      toInput.value = dataMaxDate;
      fromInput.addEventListener('change', onFilterChange);
      toInput.addEventListener('change', onFilterChange);
    }
    if (resetButton) {
      resetButton.addEventListener('click', onFilterReset);
    }
    if (fileInput) {
      fileInput.addEventListener('change', onFileSelected);
    }

    filterFrom = dataMinDate;
    filterTo = dataMaxDate;
    refresh();
  } catch (error) {
    renderError(error instanceof Error ? error.message : String(error));
  }
}

init();
