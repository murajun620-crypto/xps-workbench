import { ANALYSIS_METADATA_COLUMN, findCsvAnalysisColumns, readCsvAnalysis, serializeCsvAnalysis } from './csv-analysis.js';
import { englishExportLabel } from './export-labels.js';
import { xlsxWorksheets } from './xlsx.js';

const VAMAS_SIGNATURE = /^VAMAS Surface Chemical Analysis Standard Data Transfer Format\b/i;
const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eEdD][+-]?\d+)?$/;
const MIN_POINTS = 3;
const MAX_FILE_BYTES = 24 * 1024 * 1024;

function asNumber(field, decimalComma = false) {
  let value = (field ?? '').trim().replace(/\u2212/g, '-');
  if (decimalComma && !value.includes('.')) {
    value = value.replace(',', '.');
  } else if (/^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d*)?$/.test(value)) {
    value = value.replaceAll(',', '');
  }
  return NUMBER.test(value) ? Number(value.replace(/[dD]/, 'e')) : NaN;
}

function filenameStem(filename) {
  return filename.replace(/\.[^.]+$/, '') || 'Imported spectrum';
}

function axisScale(label) {
  if (/kinetic|運動|\bk\.?\s*e\.?\b/i.test(label)) return 'kinetic';
  if (/binding|結合|\bb\.?\s*e\.?\b/i.test(label)) return 'binding';
  return undefined;
}

function intensityUnit(label) {
  if (/\bcps\b|counts?\s*(?:per\s*s(?:ec(?:ond)?s?)?|\/\s*s)|カウント\/秒/i.test(label)) {
    return 'cps';
  }
  if (/\bcounts?\b|カウント/i.test(label)) return 'counts';
  if (/a\.?\s*u\.?\b|arb(?:itrary)?\.?\s*units?/i.test(label)) return 'a.u.';
  return '';
}

function energyFactor(label) {
  if (/(?<![a-z])mev\b/i.test(label)) return 0.001;
  if (/(?<![a-z])kev\b/i.test(label)) return 1000;
  return 1;
}

function makeSpectrum(pairs, metadata) {
  if (pairs.length < MIN_POINTS) {
    throw new Error('At least three rows of numeric energy and intensity values are required.');
  }

  const scale = energyFactor(metadata.xUnit || '');
  for (const point of pairs) point[0] *= scale;
  pairs.sort((a, b) => a[0] - b[0]);
  const x = [];
  const y = [];
  for (const [energy, intensity] of pairs) {
    if (!Number.isFinite(energy) || !Number.isFinite(intensity)) {
      throw new Error('The spectrum contains an invalid number.');
    }
    if (x[x.length - 1] === energy) {
      throw new Error('The file contains duplicate energy values. Import each measurement region separately.');
    }
    x.push(energy);
    y.push(intensity);
  }
  return { ...metadata, x, y, xUnit: 'eV' };
}

function splitDelimited(line, separator) {
  if (separator === 'space') {
    if (/^[+\-\u2212.\d]/.test(line)) return line.split(/\s+/);
    const wide = line.split(/\s{2,}/);
    if (wide.length > 1) return wide;
    const heading = line.match(
      /^((?:(?:binding|kinetic)\s*)?energy(?:\s*\([mk]?eV\))?|(?:結合|運動)?エネルギー(?:\s*\([mk]?eV\))?)\s+(.+)$/i,
    );
    return heading ? heading.slice(1) : line.split(/\s+/);
  }
  if (!line.includes('"')) return line.split(separator);

  const fields = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === separator && !quoted) {
      fields.push(value.trim());
      value = '';
    } else {
      value += character;
    }
  }
  fields.push(value.trim());
  return fields;
}

function namedColumns(fields) {
  // Plot Launcher's XPS Fit layout keeps the corrected spectrum in columns A and B.
  if (/^abscissa\b/i.test(fields[0]) && /^ordinate\b/i.test(fields[1])) {
    const sourceAxis = fields[5];
    const xLabel = /^original\s+(?:binding|kinetic)\s+energy\b/i.test(sourceAxis) ? sourceAxis : fields[0];
    return { x: 0, y: 1, xLabel, yLabel: fields[1] };
  }
  let x = -1;
  let y = -1;
  let xLabel;
  let yLabel;
  let priority = 0;
  for (const key of Object.keys(fields)) {
    const index = Number(key);
    const name = fields[index].trim().normalize('NFKC').replaceAll('_', ' ');
    if (x < 0 && (axisScale(name) || /\benergy\b|エネルギー|^\s*(?:x|m?ev|kev)\s*$/i.test(name))) {
      x = index;
      xLabel = name;
      continue;
    }
    const signal = /\b(raw|measured|observed|experiment(?:al)?)\b|実測|測定強度/i.test(name)
      ? 2
      : /intensity|counts?|\bcps\b|signal|強度|^\s*y\s*$/i.test(name) ? 1 : 0;
    if (signal > priority) {
      y = index;
      yLabel = name;
      priority = signal;
    }
  }
  return x < 0 || y < 0 ? null : { x, y, xLabel, yLabel };
}

function* delimitedRows(lines, separator) {
  for (const [lineIndex, line] of lines.entries()) {
    if (!line) continue;
    const comment = /^(?:#|\/\/|%)/.test(line);
    const fields = splitDelimited(line.replace(/^(?:#+|\/\/|%+)\s*/, ''), separator);
    yield { fields, comment, rowNumber: lineIndex + 1 };
  }
}

function numericTables(rows, { decimalComma, spreadsheet = false }) {
  const tables = [];
  let columns = null;
  let active = null;
  for (const { fields, comment, rowNumber } of rows) {
    const header = !spreadsheet && fields.length > 1 ? namedColumns(fields) : null;
    if (header) {
      columns = header;
      if (!spreadsheet) columns.analysis = findCsvAnalysisColumns(fields);
      active = null;
      continue;
    }
    if (comment) continue;
    const selection = columns || active?.positions;
    const [xIndex, yIndex] = selection ? [selection.x, selection.y] : spreadsheet ? Object.keys(fields) : [0, 1];
    const x = asNumber(fields[xIndex], decimalComma);
    const y = asNumber(fields[yIndex], decimalComma);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      if (
        active &&
        (spreadsheet || fields.length > Math.max(columns?.x ?? 0, columns?.y ?? 1)) &&
        (Number.isFinite(x) || Number.isFinite(y))
      ) {
        active.invalidRow ??= rowNumber;
        continue;
      }
      if (active) {
        active = null;
        columns = null;
      } else if (columns && Math.max(columns.x, columns.y) >= fields.length && fields.length > 1) {
        columns = null;
      }
      continue;
    }
    if (!active) {
      active = { pairs: [], columns, positions: { x: xIndex, y: yIndex }, decimalComma };
      tables.push(active);
    }
    active.pairs.push(active.columns?.analysis ? [x, y, fields] : [x, y]);
  }
  return tables.filter(({ pairs }) => pairs.length >= MIN_POINTS);
}

function tableToSpectrum(table, filename, name = filenameStem(filename)) {
  if (table.invalidRow) {
    throw new Error(`Row ${table.invalidRow} has a non-numeric energy or intensity value.`);
  }
  const { xLabel = '', yLabel = '' } = table.columns ?? {};
  const spectrum = makeSpectrum(table.pairs, {
    name,
    filename,
    xUnit: xLabel,
    yUnit: intensityUnit(yLabel),
    energyScale: axisScale(xLabel) ?? 'binding',
  });
  if (table.columns?.analysis) {
    spectrum.analysis = readCsvAnalysis(table.columns.analysis, table.pairs, (value) => asNumber(value, table.decimalComma));
  }
  return spectrum;
}

function parseDelimited(text, filename) {
  const lines = text.split(/\r\n|\n|\r/).map((line) => line.trim());
  const separators = ['\t', ',', ';', 'space'];
  let best = null;
  for (const separator of separators) {
    for (const table of numericTables(delimitedRows(lines, separator), { decimalComma: separator !== ',' })) {
      if (
        !best ||
        table.pairs.length > best.pairs.length ||
        (table.pairs.length === best.pairs.length && table.columns && !best.columns)
      ) {
        best = table;
      }
    }
  }
  if (!best) {
    throw new Error('Choose a CSV, TSV, or text file with energy and intensity columns.');
  }
  return tableToSpectrum(best, filename);
}

const ENERGY_UNIT = /^\s*[(\[]?\s*([mk]?eV)\s*[)\]]?\s*$/i;
const ENERGY_LABEL = /^(?:(?:photoelectron|electron|analyzer|corrected|calibrated)\s+)?(?:(?:binding|kinetic)\s*)?energ(?:y|ies)(?:\s*\d+)?$|^(?:(?:結合|運動)\s*)?エネルギー(?:\s*\d+)?$/i;
const AXIS_LABEL = /^(?:[bk]\.?\s*e\.?|e\s*[bk]|[mk]?ev|x|abscissa)(?:\s*\d+)?$/i;
const SIGNAL_LABEL = /intensity|counts?|\bcps\b|signal|\b(?:raw|measured|observed|experiment(?:al)?)\b|強度|実測|^(?:y|ordinate)(?:\s*\d+)?$/i;
const SUMMARY_LABEL = /^(?:(?:grand\s+)?totals?|sum|average|summary)\s*:?$/i;
const AUXILIARY_LABELS = new Set([
  '#', 'index', 'no', 'no.', 'date', 'timestamp', 'time', 'dwell', 'scan',
  'energy offset', 'energy shift', 'energy step', 'step size',
  'comment', 'comments', 'note', 'notes', 'background', 'residual', 'residuals', 'model',
  'synthesize', 'fit', 'total fit', 'fitted intensity', 'calculated intensity', 'background-subtracted intensity',
  'background subtracted intensity', '備考', '測定時間', '経過時間', '番号',
]);

function worksheetAxes(fields) {
  const axes = [];
  for (const key of Object.keys(fields)) {
    const x = Number(key);
    const label = fields[x].normalize('NFKC').replaceAll('_', ' ').trim();
    const heading = label.replace(/(?:\s*[([,:/]\s*|\s+)[mk]?ev\s*[)\]]?$/i, '');
    if (ENERGY_LABEL.test(heading) || AXIS_LABEL.test(heading)) {
      const scale = /^e\s*([bk])\b/i.exec(heading)?.[1]?.toLowerCase();
      const xLabel = scale === 'k' ? `Kinetic ${label}` : scale === 'b' ? `Binding ${label}` : label;
      axes.push({ x, xLabel, rows: [] });
    }
  }
  if (axes.length === 1 && /^abscissa\b/i.test(fields[0]) && /^ordinate\b/i.test(fields[1])) {
    axes[0].xLabel = namedColumns(fields).xLabel;
  }
  return axes;
}

function worksheetAuxiliaryColumn(label) {
  const heading = label.replace(/\s*[(\[].*$/, '').trim().toLowerCase();
  return AUXILIARY_LABELS.has(heading) ||
    /^(?:(?:data\s*)?point|row|channel)(?:\s+(?:no\.?|number|index|id))?$/.test(heading) ||
    /^(?:sample|scan|spectrum|step)\s+(?:no\.?|number|index|id)$/.test(heading) ||
    /^(?:dwell|acquisition|integration|elapsed)\s+time$/.test(heading) ||
    /^(?:pass|excitation|photon|source|original(?:\s+(?:binding|kinetic))?)\s+energy$/.test(heading) ||
    /^peak\s+\d+(?:\s+-\s+.+)?$/.test(heading) ||
    /^doublet\s+\d+\s+\S+(?:\s+-\s+.+)?$/.test(heading);
}

function columnAddress(index) {
  let address = '';
  for (let column = index + 1; column > 0; column = Math.floor((column - 1) / 26)) {
    address = String.fromCharCode(65 + (column - 1) % 26) + address;
  }
  return address;
}

function worksheetSignalColumn({ fields, rowNumber, units, axes }, axis, y) {
  const label = fields[y]?.trim() ?? '';
  const normalized = label.normalize('NFKC').replaceAll('_', ' ');
  const explicit = SIGNAL_LABEL.test(normalized);
  if (y === axis.x || (y < axis.x && (axes.length > 1 || !explicit)) || worksheetAuxiliaryColumn(normalized)) return null;
  const energyUnit = units?.[axis.x]?.normalize('NFKC').match(ENERGY_UNIT)?.[1];
  const signalUnit = units?.[y] ? intensityUnit(units[y]) : '';
  const column = columnAddress(y);
  return {
    axis,
    columns: {
      xLabel: energyUnit ? `${axis.xLabel} ${energyUnit}` : axis.xLabel,
      yLabel: signalUnit || label,
    },
    label: label || `Column ${column}`,
    address: `${column}${rowNumber}`,
    explicit,
    pairs: [],
    observed: 0,
    firstEnergyPoint: null,
    nextEnergyPoint: null,
  };
}

function worksheetSectionTables(section) {
  const { axes, rows } = section;
  const axesByColumn = new Map(axes.map(axis => [axis.x, axis]));
  const series = new Map();
  for (const row of rows) {
    const keys = Object.keys(row.fields);
    for (const key of keys) {
      const x = Number(key);
      const axis = axesByColumn.get(x);
      if (!axis) continue;
      const value = asNumber(row.fields[x], true);
      if (Number.isFinite(value)) {
        axis.value = value;
        axis.rows.push(row.rowNumber);
      }
    }
    let axisIndex = 0;
    for (const key of keys) {
      const y = Number(key);
      while (axes[axisIndex + 1]?.x <= y) axisIndex++;
      const axis = axes[axisIndex];
      if (!series.has(y)) series.set(y, worksheetSignalColumn(section, axis, y));
      const table = series.get(y);
      if (!table) continue;
      const intensity = asNumber(row.fields[y], true);
      const hasEnergy = axis.rows.at(-1) === row.rowNumber;
      if (!hasEnergy && SUMMARY_LABEL.test(row.fields[axis.x]?.trim() || '')) continue;
      if (!hasEnergy && !Number.isFinite(intensity)) continue;
      table.observed++;
      if (hasEnergy) {
        const energyPoint = axis.rows.length - 1;
        table.firstEnergyPoint ??= energyPoint;
        if (table.nextEnergyPoint !== null && table.nextEnergyPoint < energyPoint) {
          table.invalidRow ??= axis.rows[table.nextEnergyPoint];
        }
        table.nextEnergyPoint = energyPoint + 1;
      }
      if (hasEnergy && Number.isFinite(intensity)) {
        table.pairs.push([axis.value, intensity]);
      } else {
        table.invalidRow ??= row.rowNumber;
      }
    }
  }
  const candidates = [...series.entries()]
    .filter(([, table]) => table && (table.observed >= MIN_POINTS || table.pairs.length === MIN_POINTS - 1 ||
      (table.explicit && table.observed > 0 && table.axis.rows.length > 0)))
    .sort(([left], [right]) => left - right).map(([, table]) => table);
  const spectrumCounts = new Map();
  for (const { axis } of candidates) spectrumCounts.set(axis, (spectrumCounts.get(axis) ?? 0) + 1);
  for (const table of candidates) {
    if (spectrumCounts.get(table.axis) > 1) continue;
    if (table.firstEnergyPoint > 0) table.invalidRow = table.axis.rows[0];
    table.invalidRow ??= table.axis.rows[table.nextEnergyPoint ?? 0];
  }
  return candidates;
}

export function worksheetSpectra(rows, filename, sheetName) {
  const tables = [];
  const fallbackRows = [];
  let section;
  for (const row of rows) {
    if (!tables.length) fallbackRows.push(row);
    if (section && !section.units && !section.rows.length &&
        section.axes.some(({ x }) => ENERGY_UNIT.test(row.fields[x]?.normalize('NFKC') || ''))) {
      section.units = row.fields;
      continue;
    }
    const axes = worksheetAxes(row.fields);
    if (axes.length) {
      if (section) tables.push(...worksheetSectionTables(section));
      section = { ...row, axes, rows: [] };
    } else if (section) {
      section.rows.push(row);
    }
  }
  if (section) tables.push(...worksheetSectionTables(section));
  if (!tables.length) {
    const table = numericTables(fallbackRows, { decimalComma: true, spreadsheet: true })
      .reduce((best, next) => !best || next.pairs.length > best.pairs.length ? next : best, null);
    if (table) tables.push(table);
  }
  const labelCounts = new Map();
  for (const { label } of tables) labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
  return tables.map((table) => {
    const suffix = labelCounts.get(table.label) > 1 ? ` (${table.address})` : '';
    const name = tables.length > 1 ? `${sheetName} — ${table.label}${suffix}` : sheetName;
    try {
      return tableToSpectrum(table, filename, name);
    } catch (error) {
      throw new Error(`Spectrum "${name}". ${error.message}`);
    }
  });
}

async function parseXlsx(bytes, filename) {
  const regions = [];
  let invalidSheet;
  for await (const { name, rows } of xlsxWorksheets(bytes)) {
    try {
      for (const spectrum of worksheetSpectra(rows, filename, name)) regions.push(spectrum);
    } catch (error) {
      invalidSheet ??= error;
    }
  }
  if (regions.length) return { ...regions[0], regions };
  throw invalidSheet ?? new Error('Choose an XLSX workbook with at least three rows of numeric energy and intensity values in a worksheet.');
}

function parseVamas(text, filename) {
  const lines = text.split(/\r\n|\n|\r/);
  let cursor = 1;
  const invalid = () => new Error('The VAMAS data format could not be read.');
  function next() {
    if (cursor >= lines.length) throw invalid();
    return lines[cursor++].trim();
  }
  function skip(count) {
    if (cursor + count > lines.length) throw invalid();
    cursor += count;
  }
  function number() {
    const value = asNumber(next());
    if (!Number.isFinite(value)) throw invalid();
    return value;
  }
  function count() {
    const value = number();
    if (!Number.isSafeInteger(value) || value < 0 || value > lines.length) throw invalid();
    return value;
  }

  skip(4); // Institution, instrument, operator, and experiment identifiers.
  skip(count()); // Experiment comments.
  const experimentMode = next().toUpperCase();
  const scanMode = next().toUpperCase();
  if (experimentMode !== 'NORM' || !['REGULAR', 'IRREGULAR'].includes(scanMode)) {
    throw new Error('VAMAS import supports REGULAR and IRREGULAR scans in NORM mode.');
  }
  count(); // Number of spectral regions in the experiment.
  const experimentVariables = count();
  skip(experimentVariables * 2); // Labels and units.
  const blockOverrides = number();
  if (blockOverrides !== 0) {
    throw new Error('For VAMAS files with omitted block fields, export the energy and intensity as two columns and import those.');
  }
  skip(count()); // Manually entered item identifiers.
  const futureExperimentFields = count();
  const futureBlockFields = count();
  skip(futureExperimentFields);
  const blockCount = count();
  const regions = [];
  for (let block = 0; block < blockCount; block += 1) {
    const blockName = next();
    skip(8); // Sample identifier, six date/time fields, and GMT offset.
    skip(count()); // Block comments.
    const technique = next().toUpperCase();
    if (!['XPS', 'ESCA'].includes(technique)) {
      throw new Error('Choose a VAMAS file with XPS spectra.');
    }
    skip(experimentVariables);
    skip(1); // Source type.
    const sourceEnergy = number();
    skip(14); // Source, analyser, and spot parameters.
    const species = next();
    const transition = next();
    skip(1); // Charge number.

    const regular = scanMode === 'REGULAR';
    const xLabel = regular ? next() : '';
    const xUnit = regular ? next() : '';
    const xStart = regular ? number() : 0;
    const xStep = regular ? number() : 0;
    const variableCount = count();
    if (variableCount < (regular ? 1 : 2)) throw invalid();
    const variables = Array.from({ length: variableCount }, () => ({
      label: next(),
      unit: next(),
    }));
    const energy = regular ? { label: xLabel, unit: xUnit } : variables[0];
    const signal = variables[regular ? 0 : 1];
    if (!/^(?:[mk]?ev)$/i.test(energy.unit)) {
      throw new Error('VAMAS energy units must be eV, meV, or keV.');
    }
    if (regular && xStep === 0) throw invalid();

    skip(7); // Signal mode, collection time, scans, time correction, and sample orientation.
    skip(count() * 3); // Additional numerical parameters, name/unit/value.
    skip(futureBlockFields);
    const ordinates = count();
    if (ordinates % variableCount !== 0) throw invalid();
    skip(variableCount * 2); // Minimum and maximum for each recorded variable.
    if (cursor + ordinates > lines.length) throw invalid();

    const points = ordinates / variableCount;
    const pairs = [];
    for (let index = 0; index < points; index += 1) {
      const energyValue = regular ? xStart + index * xStep : number();
      const signalValue = number();
      skip(variableCount - (regular ? 1 : 2));
      pairs.push([energyValue, signalValue]);
    }
    regions.push(
      makeSpectrum(pairs, {
        name: blockName || [species, transition].filter(Boolean).join(' ') || `Region ${block + 1}`,
        filename,
        xUnit: energy.unit,
        yUnit: /^d$/i.test(signal.unit) ? intensityUnit(signal.label) : signal.unit,
        energyScale: axisScale(energy.label) ?? 'binding',
        ...(sourceEnergy > 0 && sourceEnergy < 100000 ? { sourceEnergy } : {}),
      }),
    );
  }
  if (!regions.length) throw invalid();
  return { ...regions[0], regions };
}

export function parseSpectrum(text, filename = '') {
  const source = text.replace(/^\uFEFF/, '');
  if (source.includes('\u0000')) {
    throw new Error('Choose a supported file with energy and intensity data.');
  }
  if (VAMAS_SIGNATURE.test(source.trimStart())) return parseVamas(source.trimStart(), filename);
  if (/\.(?:vms|npl)$/i.test(filename)) {
    throw new Error('The VAMAS (ISO 14976) file header is missing or invalid.');
  }
  return parseDelimited(source, filename);
}

export async function readSpectrumFile(file) {
  if (file.size > MAX_FILE_BYTES) {
    throw new Error('Choose a spectrum file of 24 MB or less.');
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (/\.xlsx$/i.test(file.name)) return parseXlsx(bytes, file.name);
  const first = bytes[0];
  const second = bytes[1];
  if (first === 0xff && second === 0xfe) {
    return parseSpectrum(new TextDecoder('utf-16le').decode(bytes), file.name);
  }
  if (first === 0xfe && second === 0xff) {
    return parseSpectrum(new TextDecoder('utf-16be').decode(bytes), file.name);
  }
  let source;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    source = new TextDecoder('shift_jis').decode(bytes);
  }
  return parseSpectrum(source, file.name);
}

export const DEMO_SPECTRA = [{ id: 'c1s', label: 'C 1s - Synthetic spectrum' }];

export function demoSpectrum() {
  const components = [
    { label: 'C-C / C-H', center: 284.8, fwhm: 1.15, height: 16700, mix: 0.28 },
    { label: 'C-O', center: 286.3, fwhm: 1.35, height: 5700, mix: 0.32 },
    { label: 'O-C=O', center: 288.75, fwhm: 1.4, height: 2900, mix: 0.34 },
  ];
  const x = Array.from({ length: 241 }, (_, index) => (28200 + index * 5) / 100);
  const signal = x.map((energy) =>
    components.reduce((total, { center, height, fwhm, mix }) => {
      const squared = ((2 * (energy - center)) / fwhm) ** 2;
      return total + height * ((1 - mix) * Math.exp(-Math.LN2 * squared) + mix / (1 + squared));
    }, 0),
  );
  const integral = signal.reduce(
    (sum, value, index) => (index === 0 ? sum : sum + (value + signal[index - 1]) / 2),
    0,
  );
  let accumulated = 0;
  let seed = 41071;
  const y = signal.map((value, index) => {
    if (index > 0) accumulated += (value + signal[index - 1]) / 2;
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const noise = (seed / 2 ** 32 - 0.5) * Math.sqrt(value + 2000) * 1.25;
    return Math.round(value + 1150 + 2100 * (accumulated / integral) + noise);
  });
  const peaks = components.map((peak) => ({ ...peak, shape: 'pseudo-voigt' }));
  return {
    name: DEMO_SPECTRA[0].label,
    filename: 'C1s-demo.csv',
    energyScale: 'binding',
    xUnit: 'eV',
    yUnit: 'cps',
    range: [x[0], x[x.length - 1]],
    x,
    y,
    peaks,
  };
}

function csvLabel(label) {
  const value = String(label);
  const literal = /^\s*[=+@-]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(literal) ? `"${literal.replaceAll('"', '""')}"` : literal;
}

function csvValue(value) {
  return Number.isFinite(value) ? value : '';
}

export function spectrumToCsv({
  x,
  y,
  columns = [],
  xUnit = 'eV',
  yUnit = '',
  energyScale = 'binding',
  analysis,
}) {
  const energyLabel = energyScale === 'kinetic' ? 'Kinetic Energy' : 'Binding Energy';
  const signalUnit = englishExportLabel(yUnit, '');
  const labels = [
    `${energyLabel} (${englishExportLabel(xUnit, 'eV')})`,
    signalUnit ? `Measured Intensity (${signalUnit})` : 'Measured Intensity',
    ...columns.map(({ label }, index) => englishExportLabel(label, `Column ${index + 3}`)),
  ];
  const metadata = analysis && serializeCsvAnalysis(analysis);
  if (metadata) labels.push(ANALYSIS_METADATA_COLUMN);
  const rows = [labels.map(csvLabel).join(',')];
  for (let row = 0; row < x.length; row += 1) {
    const index = energyScale === 'kinetic' ? row : x.length - 1 - row;
    const cells = [csvValue(x[index]), csvValue(y[index]), ...columns.map(({ values }) => csvValue(values[index]))];
    if (metadata) cells.push(row === 0 ? csvLabel(metadata) : '');
    rows.push(cells.join(','));
  }
  return `\uFEFF${rows.join('\r\n')}\r\n`;
}
