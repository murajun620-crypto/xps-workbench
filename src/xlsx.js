import JSZip from 'jszip';

const MAX_XML_BYTES = 32 * 1024 * 1024;
const MAX_WORKBOOK_XML_BYTES = 64 * 1024 * 1024;
const MAX_COLUMN = 16384;
const MAX_ROWS = 200000;
const PACKAGE_ORIGIN = 'https://xlsx.invalid';
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
