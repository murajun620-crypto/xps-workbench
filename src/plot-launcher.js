export const PLOT_LAUNCHER_URL = 'https://murajun620-crypto.github.io/plot_launcher_web/';

const lineStyles = new Map([
  ['-', '-'], ['--', '--'], ['-.', '-.'], [':', ':'],
  ['solid', '-'], ['dashed', '--'], ['dash', '--'],
  ['dashdot', '-.'], ['dotted', ':'], ['dot', ':'],
]);

function projectCsv(csv) {
  const columns = [];
  const bomLength = csv.startsWith('\uFEFF') ? 1 : 0;
  let index = bomLength;
  let value = '';
  let quoted = false;
  for (; index < csv.length; index += 1) {
    const char = csv[index];
    if (char === '"') {
      if (quoted && csv[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (!quoted && char === ',') {
      columns.push(value);
      value = '';
    } else if (!quoted && (char === '\n' || char === '\r')) {
      break;
    } else {
      value += char;
    }
  }
  columns.push(value);
  const rowBreak = /\r\n?|\n/g;
  rowBreak.lastIndex = index;
  let rowCount = 0;
  while (rowBreak.test(csv) && rowBreak.lastIndex < csv.length) {
    rowCount += 1;
    if (rowCount > 200_000) throw new Error('PlotLauncherに渡せるデータは200,000行までです。');
  }
  if (columns.length > 256) throw new Error('PlotLauncherに渡せるデータは256列までです。');
  // Plot Launcher matches series by the unique column names exposed by its CSV reader.
  const names = new Set();
  const unique = columns.map((column, columnIndex) => {
    const title = column.trim().slice(0, 200);
    const base = title && !title.startsWith('Unnamed:') ? title : `列 ${columnIndex + 1}`;
    let name = base;
    let suffix = 2;
    while (names.has(name)) {
      const ending = ` [${suffix}]`;
      name = `${base.slice(0, 200 - ending.length)}${ending}`;
      suffix += 1;
    }
    names.add(name);
    return name;
  });
  if (unique.every((name, columnIndex) => name === columns[columnIndex])) {
    return { columns: unique, csv };
  }
  const header = unique.map(name => `"${name.replaceAll('"', '""')}"`).join(',');
  return { columns: unique, csv: `${csv.slice(0, bomLength)}${header}${csv.slice(index)}` };
}

function encodeCsv(csv) {
  const bytes = new TextEncoder().encode(csv);
  if (bytes.length > 30 * 1024 * 1024) {
    throw new Error('PlotLauncherに渡せるCSVは30 MBまでです。');
  }
  let binary = '';
  for (let index = 0; index < bytes.length; index += 32768) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 32768));
  }
  return btoa(binary);
}

export function toPlotLauncherProject({
  name, csv, xLabel = 'Binding energy', yUnit = 'arb. units', series, reverseX = true,
}) {
  const stem = String(name || 'xps-fit')
    .replace(/\.(?:csv|tsv|txt|vms|vamas|plotproject)$/i, '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .slice(0, 120).replace(/[. ]+$/, '') || 'xps-fit';
  const filename = `${stem}.csv`;
  const { columns, csv: embeddedCsv } = projectCsv(csv);
  if (series.length < 1 || series.length > 32 || series.some(({ column }) => (
    !Number.isInteger(column) || column < 1 || column >= columns.length
  ))) {
    throw new Error('PlotLauncher用のグラフ系列を確認してください。');
  }

  return JSON.stringify({
    format: 'plotlauncher-project',
    version: 1,
    settings: {
      format: 'plotlauncher-web',
      version: 1,
      rangeDefaultsVersion: 1,
      data: { filename, sheet: 'CSV', headerRow: 1 },
      // The dedicated XPS Fit plot expects fixed-position columns and hides individual series controls.
      plotType: reverseX ? 'XPS Core' : 'General',
      axes: {
        xLabel, xUnit: 'eV', yLabel: 'Intensity', yUnit,
        width: 5.2, height: 3.6,
        legend: series.length > 1,
      },
      series: series.map(({ column, label, color, style, mode }) => ({
        x: 0, y: column, xColumn: columns[0], yColumn: columns[column],
        name: label || columns[column],
        ...(color && { color }),
        mode: ['line', 'scatter', 'line+scatter'].includes(mode) ? mode : 'line',
        lineStyle: lineStyles.get(style) || '-',
        lineWidth: 1,
        markerSize: 8,
      })),
      options: {},
      annotations: [],
    },
    data: { filename, base64: encodeCsv(embeddedCsv), sheetIndex: 0, headerRow: 1, sample: false },
    fonts: [],
    workspace: { saveName: stem, pngDpi: 1200, view: { zoom: 1, x: 0, y: 0 }, sections: [] },
  });
}
