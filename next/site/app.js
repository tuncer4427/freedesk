'use strict';
// Picks the right installer for the visitor's computer and always offers the
// newest build, read live from the project's GitHub release.

const RELEASE_API = 'https://api.github.com/repos/tuncer4427/freedesk/releases/tags/fardesk-latest';
const RELEASE_PAGE = 'https://github.com/tuncer4427/freedesk/releases/tag/fardesk-latest';
const CACHE_KEY = 'fardesk.release.v1';
const CACHE_MS = 5 * 60 * 1000;
const PLATFORMS = {
  win: { pattern: /^FarDesk-(\d+\.\d+\.\d+)-win-x64\.exe$/, label: 'Windows için indir', icon: 'win' },
  'mac-arm64': { pattern: /^FarDesk-(\d+\.\d+\.\d+)-mac-arm64\.dmg$/, label: 'Mac için indir', icon: 'mac', detail: 'Apple işlemci' },
  'mac-x64': { pattern: /^FarDesk-(\d+\.\d+\.\d+)-mac-x64\.dmg$/, label: 'Mac için indir', icon: 'mac', detail: 'Intel işlemci' },
};

const $ = (id) => document.getElementById(id);

const versionParts = (v) => v.split('.').map((n) => Number.parseInt(n, 10));
function newer(a, b) {
  const x = versionParts(a);
  const y = versionParts(b);
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

function formatSize(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
}

function formatDate(iso) {
  try {
    return new Date(iso).toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' });
  } catch {
    return '';
  }
}

// The newest installer per platform. Older builds may still sit in the
// release, so the highest version number wins, not the first match.
function pickInstallers(assets) {
  const found = {};
  for (const asset of assets) {
    if (!asset || typeof asset.name !== 'string' || typeof asset.browser_download_url !== 'string') continue;
    if (!asset.browser_download_url.startsWith('https://github.com/tuncer4427/freedesk/releases/download/')) continue;
    for (const [key, platform] of Object.entries(PLATFORMS)) {
      const match = platform.pattern.exec(asset.name);
      if (!match) continue;
      const version = match[1];
      if (!found[key] || newer(version, found[key].version)) {
        found[key] = { version, url: asset.browser_download_url, size: asset.size, date: asset.updated_at, name: asset.name };
      }
    }
  }
  return found;
}

async function loadRelease() {
  try {
    const cached = JSON.parse(sessionStorage.getItem(CACHE_KEY) || 'null');
    if (cached && Date.now() - cached.at < CACHE_MS && cached.installers) return cached.installers;
  } catch {}
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(RELEASE_API, { headers: { Accept: 'application/vnd.github+json' }, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const release = await response.json();
    const installers = pickInstallers(Array.isArray(release.assets) ? release.assets : []);
    try {
      sessionStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), installers }));
    } catch {}
    return installers;
  } finally {
    clearTimeout(timer);
  }
}

// Which installer suits this computer. Browsers on Apple Silicon Macs often
// still say "Intel", so the hardware is checked where the browser allows it.
async function detectPlatform() {
  const ua = navigator.userAgent || '';
  const uaPlatform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
  const mobile = /Android|iPhone|iPad|iPod/i.test(ua) || (navigator.userAgentData && navigator.userAgentData.mobile);
  if (mobile) return { key: null, mobile: true };
  if (/Win/i.test(uaPlatform) || /Windows/i.test(ua)) return { key: 'win' };
  if (/Mac/i.test(uaPlatform) || /Macintosh/i.test(ua)) {
    try {
      if (navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) {
        const values = await navigator.userAgentData.getHighEntropyValues(['architecture']);
        if (values.architecture === 'arm') return { key: 'mac-arm64', sure: true };
        if (values.architecture === 'x86') return { key: 'mac-x64', sure: true };
      }
    } catch {}
    try {
      const gl = document.createElement('canvas').getContext('webgl');
      const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
      const renderer = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
      if (/Apple M\d|Apple GPU/i.test(renderer)) return { key: 'mac-arm64', sure: /Apple M\d/i.test(renderer) };
      if (/Intel|AMD|Radeon/i.test(renderer)) return { key: 'mac-x64', sure: true };
    } catch {}
    return { key: 'mac-arm64', sure: false };
  }
  return { key: null };
}

function setIcon(el, icon) {
  el.classList.remove('win', 'mac');
  if (icon) el.classList.add(icon);
}

function render(installers, detected) {
  const versions = Object.values(installers).map((i) => i.version);
  const newest = versions.reduce((best, v) => (!best || newer(v, best) ? v : best), '');
  const newestDate = Object.values(installers).reduce((d, i) => (!d || i.date > d ? i.date : d), '');
  $('release-line').textContent = newest ? `En güncel sürüm ${newest} · ${formatDate(newestDate)}` : 'Sürüm bilgisi alınamadı.';

  for (const key of Object.keys(PLATFORMS)) {
    const link = document.querySelector(`[data-download="${key}"]`);
    const meta = document.querySelector(`[data-meta="${key}"]`);
    const item = installers[key];
    link.href = item ? item.url : RELEASE_PAGE;
    meta.textContent = item ? `Sürüm ${item.version} · ${formatSize(item.size)}` : 'Şu an hazır değil';
    document.querySelector(`.platform[data-key="${key}"]`).classList.toggle('recommended', key === detected.key);
  }

  const primary = $('primary-download');
  const chosen = detected.key && installers[detected.key];
  if (chosen) {
    const platform = PLATFORMS[detected.key];
    primary.href = chosen.url;
    $('primary-label').textContent = platform.label;
    $('primary-meta').textContent = `Sürüm ${chosen.version} · ${formatSize(chosen.size)}${platform.detail ? ` · ${platform.detail}` : ''}`;
    setIcon($('primary-icon'), platform.icon);
    if (detected.key.startsWith('mac')) {
      const otherKey = detected.key === 'mac-arm64' ? 'mac-x64' : 'mac-arm64';
      const other = installers[otherKey];
      if (other) {
        const alt = $('alt-download');
        alt.replaceChildren(
          document.createTextNode(detected.sure ? 'Farklı bir Mac için: ' : 'Mac’iniz Intel işlemciliyse: '),
          Object.assign(document.createElement('a'), {
            href: other.url,
            textContent: otherKey === 'mac-x64' ? 'Intel sürümünü indirin' : 'Apple işlemci sürümünü indirin',
          }),
        );
        alt.hidden = false;
      }
      selectTab('mac');
    }
  } else {
    primary.href = '#indir';
    $('primary-label').textContent = 'FarDesk’i indir';
    $('primary-meta').textContent = detected.mobile
      ? 'FarDesk Windows ve Mac bilgisayarlar içindir'
      : newest
        ? `Sürüm ${newest} · Windows ve Mac`
        : 'Windows ve Mac';
    setIcon($('primary-icon'), null);
  }
}

function renderFailure(detected) {
  $('release-line').textContent = 'Sürüm bilgisi şu an alınamadı. İndirme bağlantıları sizi sürüm sayfasına götürür.';
  $('primary-meta').textContent = 'Sürüm sayfasından indirin';
  for (const key of Object.keys(PLATFORMS)) {
    document.querySelector(`[data-download="${key}"]`).href = RELEASE_PAGE;
    document.querySelector(`.platform[data-key="${key}"]`).classList.toggle('recommended', key === detected.key);
  }
  if (detected.key) {
    $('primary-label').textContent = PLATFORMS[detected.key].label;
    setIcon($('primary-icon'), PLATFORMS[detected.key].icon);
  }
}

function selectTab(which) {
  for (const name of ['win', 'mac']) {
    $(`tab-${name}`).setAttribute('aria-selected', String(name === which));
    $(`panel-${name}`).hidden = name !== which;
  }
}

function setupTabs() {
  for (const name of ['win', 'mac']) $(`tab-${name}`).addEventListener('click', () => selectTab(name));
  $('copy-command').addEventListener('click', async () => {
    const button = $('copy-command');
    try {
      await navigator.clipboard.writeText($('mac-command').textContent);
      button.textContent = 'Kopyalandı';
    } catch {
      const range = document.createRange();
      range.selectNodeContents($('mac-command'));
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      button.textContent = 'Seçildi, ⌘C ile kopyalayın';
    }
    setTimeout(() => {
      button.textContent = 'Kopyala';
    }, 2500);
  });
}

async function main() {
  $('year').textContent = String(new Date().getFullYear());
  setupTabs();
  const detected = await detectPlatform();
  if (detected.key === 'win') selectTab('win');
  try {
    render(await loadRelease(), detected);
  } catch (err) {
    console.error('release', err);
    renderFailure(detected);
  }
}

main();
