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
  return filename.replace(/\.[^.]+$/, '') || '読み込んだスペクトル';
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
    throw new Error('エネルギーと強度の数値が3行以上必要です。');
  }

  const scale = energyFactor(metadata.xUnit || '');
  for (const point of pairs) point[0] *= scale;
  pairs.sort((a, b) => a[0] - b[0]);
  const x = [];
  const y = [];
  for (const [energy, intensity] of pairs) {
    if (!Number.isFinite(energy) || !Number.isFinite(intensity)) {
      throw new Error('スペクトルに読み取れない数値が含まれています。');
    }
    if (x[x.length - 1] === energy) {
      throw new Error('重複したエネルギー値があります。測定範囲ごとに分けて読み込んでください。');
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
    if (spreadsheet && columns && !active) {
      const unit = fields[columns.x]?.normalize('NFKC').match(/^\s*[(\[]?\s*([mk]?eV)\s*[)\]]?\s*$/i)?.[1];
      if (unit) {
        const signal = fields[columns.y];
        columns = {
          ...columns,
          xLabel: `${columns.xLabel} ${unit}`,
          yLabel: signal && intensityUnit(signal) ? signal : columns.yLabel,
        };
        continue;
      }
    }
    const header = fields.length > 1 ? namedColumns(fields) : null;
    if (header) {
      columns = header;
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
      active = { pairs: [], columns, positions: { x: xIndex, y: yIndex } };
      tables.push(active);
    }
    active.pairs.push([x, y]);
  }
  return tables.filter(({ pairs }) => pairs.length >= MIN_POINTS);
}

function tableToSpectrum(table, filename, name = filenameStem(filename)) {
  if (table.invalidRow) {
    throw new Error(`${table.invalidRow}行目のエネルギー値または強度が数値になっていません。`);
  }
  const { xLabel = '', yLabel = '' } = table.columns ?? {};
  return makeSpectrum(table.pairs, {
    name,
    filename,
    xUnit: xLabel,
    yUnit: intensityUnit(yLabel),
    energyScale: axisScale(xLabel) ?? 'binding',
  });
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
    throw new Error('CSV・TSV・テキストで、エネルギー列と強度列があるデータを選んでください。');
  }
  return tableToSpectrum(best, filename);
}

async function parseXlsx(bytes, filename) {
  const regions = [];
  let invalidSheet;
  for await (const { name, rows } of xlsxWorksheets(bytes)) {
    const tables = numericTables(rows, { decimalComma: true, spreadsheet: true });
    const candidates = tables.some((table) => table.columns) ? tables.filter((table) => table.columns) : tables;
    const table = candidates.reduce((best, next) => !best || next.pairs.length > best.pairs.length ? next : best, null);
    if (!table) continue;
    try {
      regions.push(tableToSpectrum(table, filename, name));
    } catch (error) {
      invalidSheet ??= new Error(`「${name}」シートの${error.message}`);
    }
  }
  if (regions.length) return { ...regions[0], regions };
  throw invalidSheet ?? new Error('XLSXの各シートに、エネルギーと強度の数値を3行以上入れてください。');
}

function parseVamas(text, filename) {
  const lines = text.split(/\r\n|\n|\r/);
  let cursor = 1;
  const invalid = () => new Error('VAMASのデータ形式を確認してください。');
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
    throw new Error('VAMASはNORMモードのREGULAR・IRREGULARスキャンに対応しています。');
  }
  count(); // Number of spectral regions in the experiment.
  const experimentVariables = count();
  skip(experimentVariables * 2); // Labels and units.
  const blockOverrides = number();
  if (blockOverrides !== 0) {
    throw new Error('ブロック項目を省略したVAMASは、エネルギー・強度の2列に書き出してください。');
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
      throw new Error('XPSスペクトルを含むVAMASファイルを選んでください。');
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
      throw new Error('VAMASのエネルギー単位を確認してください。');
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
        name: blockName || [species, transition].filter(Boolean).join(' ') || `領域 ${block + 1}`,
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
    throw new Error('テキスト形式で保存したエネルギーと強度のデータを選んでください。');
  }
  if (VAMAS_SIGNATURE.test(source.trimStart())) return parseVamas(source.trimStart(), filename);
  if (/\.(?:vms|npl)$/i.test(filename)) {
    throw new Error('VAMASファイル（ISO 14976）のヘッダーを確認してください。');
  }
  return parseDelimited(source, filename);
}

export async function readSpectrumFile(file) {
  if (file.size > MAX_FILE_BYTES) {
    throw new Error('24 MB以下のスペクトルファイルを選んでください。');
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

export const DEMO_SPECTRA = [{ id: 'c1s', label: 'C 1s — 合成データ' }];

export function demoSpectrum() {
  const components = [
    { label: 'C–C / C–H', center: 284.8, fwhm: 1.15, height: 16700, mix: 0.28 },
    { label: 'C–O', center: 286.3, fwhm: 1.35, height: 5700, mix: 0.32 },
    { label: 'O–C=O', center: 288.75, fwhm: 1.4, height: 2900, mix: 0.34 },
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
}) {
  const energyLabel = energyScale === 'kinetic' ? '運動エネルギー' : '結合エネルギー';
  const labels = [
    `${energyLabel} (${xUnit})`,
    yUnit ? `測定強度 (${yUnit})` : '測定強度',
    ...columns.map(({ label }) => label),
  ];
  const rows = [labels.map(csvLabel).join(',')];
  for (let row = 0; row < x.length; row += 1) {
    const index = energyScale === 'kinetic' ? row : x.length - 1 - row;
    rows.push(
      [
        csvValue(x[index]),
        csvValue(y[index]),
        ...columns.map(({ values }) => csvValue(values[index])),
      ].join(','),
    );
  }
  return `\uFEFF${rows.join('\r\n')}\r\n`;
}
