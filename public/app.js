const homePage = document.getElementById('home-page');
const toolPage = document.getElementById('tool-page');
const toolContent = document.getElementById('tool-content');
const toolsGrid = document.getElementById('tools-grid');

function initTheme() {
  const savedTheme = localStorage.getItem('theme') || 'dark';
  document.documentElement.setAttribute('data-theme', savedTheme);
  updateThemeIcon(savedTheme);
}

function toggleTheme() {
  const currentTheme = document.documentElement.getAttribute('data-theme');
  const newTheme = currentTheme === 'light' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', newTheme);
  localStorage.setItem('theme', newTheme);
  updateThemeIcon(newTheme);
}

function updateThemeIcon(theme) {
  const btn = document.querySelector('.theme-toggle');
  if (btn) {
    btn.textContent = theme === 'light' ? '☀️' : '🌙';
  }
}

function renderToolCards(filter = '') {
  const filterLower = filter.toLowerCase();
  const filteredTools = toolsData.filter(tool =>
    tool.title.toLowerCase().includes(filterLower) ||
    tool.desc.toLowerCase().includes(filterLower)
  );

  if (filteredTools.length === 0) {
    toolsGrid.innerHTML = '<div class="text-muted" style="grid-column:1/-1;text-align:center;padding:3rem">No matching tools found</div>';
    return;
  }

  toolsGrid.innerHTML = filteredTools.map((tool, index) => `
    <div class="tool-card" onclick="openTool('${tool.id}')" style="animation-delay: ${0.05 * (index + 1)}s">
      <div class="tool-icon">${tool.icon}</div>
      <h3>${tool.title}</h3>
      <p>${tool.desc}</p>
    </div>
  `).join('');
}

function filterTools(query) {
  renderToolCards(query);
}

const toolRenderers = {
  color: renderColorTool,
  text: renderTextTool,
  json: renderJsonTool,
  base64: renderBase64Tool,
  password: renderPasswordTool,
  timestamp: renderTimestampTool,
  url: renderUrlTool,
  hash: renderHashTool,
  uuid: renderUuidTool,
  base: renderBaseTool,
  regex: renderRegexTool,
  markdown: renderMarkdownTool,
  qrcode: renderQrcodeTool,
  jwt: renderJwtTool,
  html: renderHtmlTool,
  case: renderCaseTool,
  lorem: renderLoremTool,
  diff: renderDiffTool,
};

const toolInitializers = {
  timestamp: startTimestampTimer,
  markdown: previewMarkdown,
  qrcode: generateQRCode,
  case: convertCase,
};

function openTool(toolId) {
  if (!toolRenderers[toolId]) return;
  homePage.classList.add('hidden');
  toolPage.classList.remove('hidden');
  toolContent.innerHTML = toolRenderers[toolId]();
  if (toolInitializers[toolId]) {
    setTimeout(toolInitializers[toolId], 100);
  }
  window.location.hash = toolId;
}

function goHome() {
  if (typeof timestampInterval !== 'undefined' && timestampInterval) clearInterval(timestampInterval);
  toolPage.classList.add('hidden');
  homePage.classList.remove('hidden');
  window.location.hash = '';
}

function handleHash() {
  const hash = window.location.hash.slice(1);
  if (hash && toolRenderers[hash]) {
    openTool(hash);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  renderToolCards();
  handleHash();
  window.addEventListener('hashchange', handleHash);
});
