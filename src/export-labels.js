function asciiText(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[^\x20-\x7e]+/g, ' ')
    .replace(/\(\s*\)|\[\s*\]|\{\s*\}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function englishExportLabel(value, fallback = 'Series') {
  const label = asciiText(value);
  return /[a-z0-9]/i.test(label) ? label : asciiText(fallback);
}

export function englishExportFilename(value, fallback = 'spectrum') {
  const stem = String(value ?? '').replace(/\.(csv|tsv|txt|dat|xy|xlsx|vms|vamas|npl|plotproject|xpsproject)$/i, '');
  const label = englishExportLabel(stem, fallback);
  const filename = label.replace(/[^a-z0-9._-]+/gi, '-').slice(0, 120).replace(/^[.-]+|[.-]+$/g, '');
  if (!filename) return 'spectrum';
  return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(filename) ? `xps-${filename}` : filename;
}
