const published = 'https://murajun620-crypto.github.io/xps-workbench/';
const releasePattern = /^\d{1,5}\.\d{1,5}\.\d{1,5}$/;
const buildPattern = /^[0-9a-f]{12}$/;

function compareReleases(first, second) {
  const current = first.split('.').map(Number);
  const latest = second.split('.').map(Number);
  for (let i = 0; i < current.length; i++) {
    if (current[i] !== latest[i]) return current[i] - latest[i];
  }
  return 0;
}

export function installUpdateCheck() {
  const version = document.querySelector('meta[name="xps-version"]').content;
  const build = document.querySelector('meta[name="xps-build"]').content;
  document.getElementById('current-version').textContent = releasePattern.test(version) ? `v${version}` : 'Dev';
  const button = document.getElementById('check-updates');
  const dialog = document.getElementById('update-dialog');
  const status = document.getElementById('update-status');
  const openUpdate = document.getElementById('open-update');
  let active;
  dialog.addEventListener('close', () => {
    if (dialog.open) return;
    active?.abort();
    active = undefined;
  });

  button.addEventListener('click', async () => {
    if (dialog.open) return;
    active?.abort();
    const controller = new AbortController();
    active = controller;
    const timeout = setTimeout(() => controller.abort(), 8000);
    const base = location.protocol === 'file:' ? published : document.baseURI;
    const url = new URL('./version.json', base);
    url.searchParams.set('check', String(Date.now()));
    openUpdate.hidden = true;
    status.textContent = 'Checking for updates…';
    dialog.showModal();
    try {
      const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error('Missing release information.');
      const latest = await response.json();
      if (typeof latest.version !== 'string' || !releasePattern.test(latest.version) ||
        typeof latest.build !== 'string' || !buildPattern.test(latest.build)) {
        throw new Error('Invalid release information.');
      }
      if (active !== controller || !dialog.open) return;
      const order = releasePattern.test(version) ? compareReleases(version, latest.version) : -1;
      if (order < 0 || (order === 0 && latest.build !== build)) {
        status.textContent = `Version ${latest.version} is available. Open it in a new tab to keep this session open.`;
        const target = new URL('.', url);
        target.searchParams.set('v', `${latest.version}-${latest.build}`);
        openUpdate.href = target.href;
        openUpdate.hidden = false;
      } else {
        status.textContent = `You’re up to date (v${version}).`;
      }
    } catch {
      if (active === controller && dialog.open) {
        status.textContent = 'Could not check for updates. Check your connection and try again.';
      }
    } finally {
      clearTimeout(timeout);
      if (active === controller) active = undefined;
    }
  });
}
