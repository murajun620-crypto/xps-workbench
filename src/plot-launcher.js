import { englishExportFilename, englishExportLabel } from './export-labels.js';

export const PLOT_LAUNCHER_URL = 'https://murajun620-crypto.github.io/plot_launcher_web/';

const MAX_ROWS = 200_000;
const MAX_COLUMNS = 256;
const MAX_CSV_BYTES = 30 * 1024 * 1024;
const PEAK_COLORS = ['#704dd9', '#008666', '#b26413', '#be3c78', '#1979b4', '#b84225'];
const PALETTE_COLOR = /^#[0-9a-f]{6}$/i;

function peakLabels(components) {
  if (!components.length) return ['Peak'];
  return components.map(({ label }, index) => {
    const prefix = `Peak ${index + 1}`;
    const name = englishExportLabel(label, prefix).slice(0, 175);
    return name === prefix ? prefix : `${prefix} - ${name}`;
  });
}

function escapeCsvHeader(text) {
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csvValue(value) {
  return Number.isFinite(value) ? value : '';
}

/**
 * Plot Launcher's XPS Fit CSV preset detects the A/B header pair and consumes
 * fixed columns. H onward are net components that its renderer adds to D.
 */
export function toPlotLauncherFitCsv({
  x, y, residual, background, corrected, originalX, fit, components = [], energyScale = 'binding',
}) {
  if (x.length !== y.length || !x.length) {
    throw new Error('Plot Launcher requires matching energy and intensity values.');
  }
  if (x.length > MAX_ROWS) {
    throw new Error('Plot Launcher can open up to 200,000 points. Export a standard CSV for larger spectra.');
  }
  const labels = peakLabels(components);
  if (7 + labels.length > MAX_COLUMNS) {
    throw new Error('Plot Launcher supports up to 256 CSV columns.');
  }
  const axis = energyScale === 'kinetic' ? 'kinetic' : 'binding';
  const header = [
    'Abscissa', 'Ordinate', 'Residual', 'Background', 'Background-subtracted intensity',
    `Original ${axis} energy (eV)`, 'Synthesize', ...labels,
  ];
  // Preserve the full aligned spectrum, with blank fit cells beyond the fitted window.
  const rows = [header.map(escapeCsvHeader).join(',')];
  for (let row = 0; row < x.length; row += 1) {
    const index = energyScale === 'kinetic' ? row : x.length - 1 - row;
    const values = [
      x[index], y[index], residual?.[index], background?.[index], corrected?.[index],
      originalX?.[index] ?? x[index], fit?.[index],
    ];
    for (const { values: component } of components) values.push(component[index]);
    // The preset requires at least one peak column even before a fit is available.
    if (!components.length) values.push(undefined);
    rows.push(values.map(csvValue).join(','));
  }
  const csv = `\uFEFF${rows.join('\r\n')}\r\n`;
  // The text is ASCII apart from the three-byte UTF-8 BOM.
  if (csv.length + 2 > MAX_CSV_BYTES) {
    throw new Error('Plot Launcher supports up to 30 MB of CSV data.');
  }
  return csv;
}

function encodeCsv(csv) {
  const bytes = new TextEncoder().encode(csv);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 32768) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 32768));
  }
  return btoa(binary);
}

export function toPlotLauncherProject({
  name, energyScale = 'binding', components = [], ...data
}) {
  const stem = englishExportFilename(name, 'xps-fit').slice(0, 120);
  const filename = `${stem}.csv`;
  const csv = toPlotLauncherFitCsv({ ...data, energyScale, components });
  const fills = components.map(({ color }, index) => ({
    x: 0,
    upper: index + 7,
    lower: 3,
    color: PALETTE_COLOR.test(color) ? color : PEAK_COLORS[index % PEAK_COLORS.length],
    alpha: 0.3,
  }));

  return JSON.stringify({
    format: 'plotlauncher-project',
    version: 1,
    settings: {
      format: 'plotlauncher-web',
      version: 1,
      rangeDefaultsVersion: 1,
      data: { filename, sheet: 'CSV', headerRow: 1 },
      plotType: 'XPS Fit',
      axes: {
        // Project import requires an axes object and skips preset application.
        // Set only the native XPS Fit defaults that differ from its base axes.
        xLabel: energyScale === 'kinetic' ? 'Kinetic energy' : 'Binding energy',
        xUnit: 'eV',
        yLabel: 'Intensity',
        yUnit: 'arb. units',
        hideYTicks: true,
        hideYTickLabels: true,
      },
      series: [{
        x: 0, y: 1, xColumn: 'Abscissa', yColumn: 'Ordinate', name: 'Measured intensity',
        color: '#253853', mode: 'line', visible: true,
      }],
      options: {
        scatterSize: 6,
        scatterEdgeWidth: 0.4,
        scatterEdgeColor: '#3c3c3c',
        scatterFaceColor: '#ffffff',
        scatterAlpha: 0.65,
        fitLineWidth: data.fit?.some(Number.isFinite) ? 1.0 : 0,
        fitLineColor: '#5441d0',
        bgLineWidth: 0.7,
        bgLineColor: '#6f7890',
        fills,
      },
      annotations: [],
    },
    data: { filename, base64: encodeCsv(csv), sheetIndex: 0, headerRow: 1, sample: false },
    fonts: [],
    workspace: { saveName: stem, pngDpi: 1200, view: { zoom: 1, x: 0, y: 0 }, sections: [] },
  });
}
