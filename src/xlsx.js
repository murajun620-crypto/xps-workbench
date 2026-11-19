import JSZip from 'jszip';
import { englishExportLabel } from './export-labels.js';

const MAX_XML_BYTES = 32 * 1024 * 1024;
const MAX_WORKBOOK_XML_BYTES = 64 * 1024 * 1024;
const MAX_COLUMN = 16384;
const MAX_ROWS = 200000;
const PACKAGE_ORIGIN = 'https://xlsx.invalid';
const SPREADSHEET_NAMESPACE = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const PACKAGE_NAMESPACE = 'http://schemas.openxmlformats.org/package/2006';
const OFFICE_REL_NAMESPACES = [
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  'http://purl.oclc.org/ooxml/officeDocument/relationships',
];
const invalidWorkbook = () => new Error('The XLSX workbook could not be read. Check that it is valid and unencrypted.');

function child(element, name) {
  if (!element) return undefined;
  for (const item of element.children) {
    if (item.localName === name) return item;
  }
  return undefined;
}

function readXmlBytes(entry, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    const stream = entry.internalStream('uint8array');
    stream.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        chunks.length = 0;
        stream.pause();
        reject(new Error('The XLSX workbook is too large when unpacked. Split the measurement sheets into separate files.'));
        return;
      }
      chunks.push(chunk);
    }).on('error', () => reject(invalidWorkbook())).on('end', () => {
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      resolve(bytes);
    }).resume();
  });
}

function xmlReader(zip) {
  let usedBytes = 0;
  return async (path, expectedRoot) => {
    const entry = zip.file(path);
    if (!entry) throw invalidWorkbook();
    const bytes = await readXmlBytes(entry, Math.min(MAX_XML_BYTES, MAX_WORKBOOK_XML_BYTES - usedBytes));
    usedBytes += bytes.length;
    const [first, second] = bytes;
    const encoding = (first === 0xff && second === 0xfe) || (first === 60 && second === 0)
      ? 'utf-16le'
      : (first === 0xfe && second === 0xff) || (first === 0 && second === 60) ? 'utf-16be' : 'utf-8';
    const xml = new TextDecoder(encoding).decode(bytes);
    if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) throw invalidWorkbook();
    const root = new DOMParser().parseFromString(xml, 'application/xml').documentElement;
    if (root?.localName !== expectedRoot || root.getElementsByTagNameNS('*', 'parsererror').length) {
      throw invalidWorkbook();
    }
    return root;
  };
}

function partPath(base, target) {
  if (!target) throw invalidWorkbook();
  try {
    const basePath = base.split('/').map(encodeURIComponent).join('/');
    const url = new URL(target, `${PACKAGE_ORIGIN}/${basePath}`);
    if (url.origin === PACKAGE_ORIGIN && !url.search && !url.hash) {
      const path = url.pathname.slice(1).split('/').map(decodeURIComponent);
      if (path.every((step) => step && !/[\\/]/.test(step) && step !== '..' && step !== '.')) {
        return path.join('/');
      }
    }
  } catch {
    // Invalid package paths are handled the same way as unresolved relationships.
  }
  throw invalidWorkbook();
}

function relationships(root, base) {
  const links = [];
  for (const item of root.children) {
    const type = item.getAttribute('Type')?.split('/').at(-1);
    if (item.localName !== 'Relationship' || item.getAttribute('TargetMode') === 'External' ||
        !['officeDocument', 'worksheet', 'sharedStrings'].includes(type)) continue;
    links.push({
      id: item.getAttribute('Id'),
      type,
      path: partPath(base, item.getAttribute('Target')),
    });
  }
  return links;
}

function relationshipPath(path) {
  const lastSlash = path.lastIndexOf('/') + 1;
  return `${path.slice(0, lastSlash)}_rels/${path.slice(lastSlash)}.rels`;
}

function stringValue(container) {
  if (!container) return '';
  // Reading text nodes from each rich-text run excludes optional phonetic annotations.
  let text = '';
  for (const item of container.children) {
    if (item.localName === 't') text += item.textContent;
    if (item.localName === 'r') text += child(item, 't')?.textContent || '';
  }
  return text;
}

function columnIndex(reference, fallback) {
  if (!reference) return fallback;
  const letters = /^[A-Z]{1,3}(?=\d+$)/.exec(reference)?.[0];
  if (!letters) throw invalidWorkbook();
  let column = 0;
  for (const letter of letters) column = column * 26 + letter.charCodeAt(0) - 64;
  return column - 1;
}

function cellValue(cell, sharedStrings) {
  const type = cell.getAttribute('t');
  if (type === 'inlineStr') return stringValue(child(cell, 'is'));
  const text = child(cell, 'v')?.textContent?.trim() || '';
  if (type === 's' && /^\d+$/.test(text)) return sharedStrings[Number(text)] ?? '';
  // Numeric formula cells expose the saved result through the same value element.
  if (type === null || type === 'n' || type === 'str') return text;
  return '';
}

function* worksheetRows(root, sharedStrings) {
  const data = child(root, 'sheetData');
  if (!data) throw invalidWorkbook();
  let rowCount = 0;
  let rowNumber = 0;
  for (const row of data.children) {
    if (row.localName !== 'row') continue;
    rowCount++;
    if (rowCount > MAX_ROWS) {
      throw new Error('XLSX import supports up to 200,000 rows per worksheet.');
    }
    rowNumber = Number(row.getAttribute('r')) || rowNumber + 1;
    const fields = [];
    let column = -1;
    for (const cell of row.children) {
      if (cell.localName !== 'c') continue;
      column = columnIndex(cell.getAttribute('r'), column + 1);
      if (column >= MAX_COLUMN) throw invalidWorkbook();
      const text = cellValue(cell, sharedStrings).trim();
      if (text) fields[column] = text;
    }
    if (fields.length) yield { fields, rowNumber };
  }
}

export async function* xlsxWorksheets(bytes) {
  let zip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw invalidWorkbook();
  }
  const read = xmlReader(zip);
  const root = await read('_rels/.rels', 'Relationships');
  const office = relationships(root, '').find(({ type }) => type === 'officeDocument');
  if (!office) throw invalidWorkbook();
  const workbook = await read(office.path, 'workbook');
  const links = relationships(await read(relationshipPath(office.path), 'Relationships'), office.path);
  const stringPart = links.find(({ type }) => type === 'sharedStrings');
  const sharedStrings = stringPart
    ? Array.from((await read(stringPart.path, 'sst')).children)
        .filter((item) => item.localName === 'si').map(stringValue)
    : [];
  const sheets = child(workbook, 'sheets');
  if (!sheets) throw invalidWorkbook();
  for (const sheet of sheets.children) {
    if (sheet.localName !== 'sheet') continue;
    const id = OFFICE_REL_NAMESPACES.map((ns) => sheet.getAttributeNS(ns, 'id')).find(Boolean);
    const worksheet = links.find((link) => link.id === id && link.type === 'worksheet');
    if (!worksheet) continue;
    const rows = worksheetRows(await read(worksheet.path, 'worksheet'), sharedStrings);
    yield { name: sheet.getAttribute('name') || 'Worksheet', rows };
  }
}

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const XML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
const MAX_SHEET_NAME = 31;

function xmlText(value) {
  return value.replace(/[&<>"']/g, (character) => XML_ESCAPES[character]);
}

function worksheetName(label, index, names) {
  const fallback = `Spectrum ${index + 1}`;
  const base = englishExportLabel(label, fallback)
    .replace(/[:\\/?*\[\]]+/g, ' ')
    .replace(/_x(?=[0-9a-f]{4}_)/gi, '-x')
    .replace(/\s+/g, ' ');
  const fit = (length) => base.slice(0, length).replace(/^[\s']+|[\s']+$/g, '') || fallback;
  let name = fit(MAX_SHEET_NAME);
  for (let number = 2; names.has(name.toLowerCase()); number++) {
    const suffix = ` (${number})`;
    name = fit(MAX_SHEET_NAME - suffix.length) + suffix;
  }
  names.add(name.toLowerCase());
  return name;
}

function worksheetXml({ x, y, energyScale, yUnit, xUnit = 'eV' }, name) {
  if (!x || !y || x.length !== y.length || x.length < 3) {
    throw new Error(`Spectrum "${name}" requires at least three paired energy and intensity values.`);
  }
  if (x.length >= 1048576) throw new Error(`Spectrum "${name}" exceeds Excel's worksheet row limit.`);
  const kinetic = energyScale === 'kinetic';
  const energyLabel = `${kinetic ? 'Kinetic Energy' : 'Binding Energy'} (${englishExportLabel(xUnit, 'eV')})`;
  const signalUnit = englishExportLabel(yUnit, '');
  const intensityLabel = signalUnit ? `Measured Intensity (${signalUnit})` : 'Measured Intensity';
  const rows = [`<row r="1"><c r="A1" t="inlineStr"><is><t>${xmlText(energyLabel)}</t></is></c>` +
    `<c r="B1" t="inlineStr"><is><t>${xmlText(intensityLabel)}</t></is></c></row>`];
  // Match shifted CSV's order on the binding and kinetic energy scales.
  for (let row = 0; row < x.length; row++) {
    const index = kinetic ? row : x.length - row - 1;
    const energy = x[index];
    const intensity = y[index];
    if (!Number.isFinite(energy) || !Number.isFinite(intensity)) {
      throw new Error(`Spectrum "${name}" contains an invalid energy or intensity value.`);
    }
    const address = row + 2;
    rows.push(`<row r="${address}"><c r="A${address}"><v>${energy}</v></c><c r="B${address}"><v>${intensity}</v></c></row>`);
  }
  return `${XML_HEADER}<worksheet xmlns="${SPREADSHEET_NAMESPACE}"><dimension ref="A1:B${rows.length}"/>` +
    '<cols><col min="1" max="1" width="23" customWidth="1"/><col min="2" max="2" width="32" customWidth="1"/></cols>' +
    `<sheetData>${rows.join('')}</sheetData></worksheet>`;
}

export async function spectraToXlsx(spectra) {
  if (!spectra.length) throw new Error('Choose at least one spectrum to export.');
  const zip = new JSZip();
  const names = new Set(['history']);
  const sheets = [];
  const contentTypes = [
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
  ];
  const worksheetLinks = [];
  const relationships = `${XML_HEADER}<Relationships xmlns="${PACKAGE_NAMESPACE}/relationships">`;
  const officeRelationships = OFFICE_REL_NAMESPACES[0];
  zip.file('_rels/.rels', relationships +
    `<Relationship Id="rId1" Type="${officeRelationships}/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  for (const [index, spectrum] of spectra.entries()) {
    const id = index + 1;
    const name = worksheetName(spectrum.name, index, names);
    const path = `worksheets/sheet${id}.xml`;
    zip.file(`xl/${path}`, worksheetXml(spectrum, name));
    sheets.push(`<sheet name="${xmlText(name)}" sheetId="${id}" r:id="rId${id}"/>`);
    worksheetLinks.push(`<Relationship Id="rId${id}" Type="${officeRelationships}/worksheet" Target="${path}"/>`);
    contentTypes.push(`<Override PartName="/xl/${path}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`);
  }
  zip.file('xl/workbook.xml', `${XML_HEADER}<workbook xmlns="${SPREADSHEET_NAMESPACE}" xmlns:r="${officeRelationships}">` +
    `<sheets>${sheets.join('')}</sheets></workbook>`);
  zip.file('xl/_rels/workbook.xml.rels', `${relationships}${worksheetLinks.join('')}</Relationships>`);
  zip.file('[Content_Types].xml', `${XML_HEADER}<Types xmlns="${PACKAGE_NAMESPACE}/content-types">${contentTypes.join('')}</Types>`);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}
