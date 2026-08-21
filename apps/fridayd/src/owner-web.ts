export const OWNER_WEB_HTML = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="color-scheme" content="light">
  <meta name="theme-color" content="#f4f0e7">
  <title>Friday · 私人 AI 助手</title>
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='14' fill='%2328313d'/%3E%3Ccircle cx='16' cy='16' r='8' fill='none' stroke='%23d54e32' stroke-width='3'/%3E%3Ccircle cx='16' cy='16' r='2.5' fill='%23d54e32'/%3E%3C/svg%3E">
  <link rel="stylesheet" href="/assets/friday.css">
</head>
<body>
  <a class="skip-link" href="#main-content">跳到主要内容</a>

  <div id="app-shell" class="app-shell">
    <aside class="sidebar">
      <div class="brand"><span class="reactor" aria-hidden="true"></span><span>FRIDAY AGENT</span></div>
      <nav class="primary-nav" aria-label="主导航">
        <button class="nav-item is-active" type="button" data-view="chat" aria-current="page"><span aria-hidden="true">◉</span><b>对话</b></button>
        <details class="advanced-menu">
          <summary class="nav-item advanced-summary"><span aria-hidden="true">≡</span><b>管理</b></summary>
          <div class="advanced-links">
            <button class="nav-item" type="button" data-view="devices"><span aria-hidden="true">⌁</span><b>设备</b></button>
            <button class="nav-item" type="button" data-view="tasks"><span aria-hidden="true">↗</span><b>任务</b><em id="task-count" hidden>0</em></button>
            <button class="nav-item" type="button" data-view="clearance"><span aria-hidden="true">◇</span><b>授权</b><em id="clearance-count" hidden>0</em></button>
          </div>
        </details>
      </nav>
      <div class="sidebar-footer">
        <div class="connection-state"><span id="hub-dot" class="status-dot"></span><span id="hub-state">Hub 在线</span></div>
        <span class="auth-label">Basic Auth · 私有连接</span>
      </div>
    </aside>

    <header class="mobile-header">
      <div class="brand"><span class="reactor" aria-hidden="true"></span><span>FRIDAY AGENT</span></div>
      <div class="connection-state"><span id="mobile-hub-dot" class="status-dot"></span><span id="mobile-hub-state">Hub 在线</span></div>
    </header>

    <main id="main-content" class="workspace" tabindex="-1">
      <section id="view-chat" class="view view-chat" data-view-panel="chat">
        <header class="view-header chat-header">
          <div>
            <p class="eyebrow">PERSONAL OPERATING INTELLIGENCE</p>
            <h1>Friday <span class="edition-mark">01</span></h1>
            <p class="chat-subtitle">一句话交代目标，剩下的上下文交给我。</p>
          </div>
          <div class="assistant-presence" aria-live="polite">
            <span class="presence-reactor" aria-hidden="true"><i></i></span>
            <span><strong id="presence-label">Friday 已就绪</strong><small id="presence-detail">等你开口</small></span>
          </div>
        </header>
        <div class="capability-ribbon" aria-label="Friday 当前能力">
          <span><i id="wechat-dot" class="status-dot status-dot-muted"></i><b id="wechat-header-state">微信状态检查中</b></span>
          <span><i class="ribbon-mark">M</i><b id="memory-summary">记忆读取中</b></span>
          <span><i class="ribbon-mark">N</i><b id="fleet-ribbon">节点读取中</b></span>
          <span><i class="ribbon-mark">↗</i><b id="growth-summary">迭代记录读取中</b></span>
        </div>
        <div class="chat-stage">
          <div id="conversation" class="conversation" role="log" aria-live="polite" aria-relevant="additions text" aria-label="与 Friday 的对话">
            <div class="conversation-empty">
              <p>今天先处理哪件事？</p>
              <span>直接说结果。简单的我自己处理，影响设备或服务时再请你确认。</span>
              <div class="starter-grid" aria-label="快速开始">
                <button type="button" data-starter="检查所有设备的状态，先给我异常结论">检查设备</button>
                <button type="button" data-starter="记住：回答时先给结论，再给必要细节">建立偏好</button>
                <button type="button" data-starter="回顾你最近的失败和卡点，提出一个可以验证的自我改进">让 Friday 进化</button>
              </div>
            </div>
          </div>
          <aside class="context-rail" aria-label="Friday 的长期上下文">
            <details class="context-drawer">
              <summary><span>记忆与成长</span><small id="memory-count">0 条记忆</small></summary>
              <div class="context-content">
                <section class="memory-section" aria-labelledby="memory-title">
                  <div class="context-heading"><h2 id="memory-title">长期记忆</h2><span>由你掌控</span></div>
                  <p>Friday 只使用你保留的稳定偏好；候选不会自动生效。</p>
                  <div id="memory-list" class="memory-list" aria-live="polite"></div>
                </section>
                <section class="growth-section" aria-labelledby="growth-title">
                  <div class="context-heading"><h2 id="growth-title">自我迭代</h2><span>自动采纳简单变化</span></div>
                  <p id="growth-detail">还没有可见的改进记录。</p>
                  <button id="propose-improvement" class="text-action" type="button">让 Friday 回顾并提出改进 →</button>
                </section>
              </div>
            </details>
          </aside>
        </div>
        <form id="composer" class="composer">
          <label class="visually-hidden" for="message">给 Friday 发消息</label>
          <div id="composer-media" class="composer-media" aria-live="polite" hidden></div>
          <textarea id="message" rows="1" maxlength="32768" placeholder="直接告诉 Friday 你要什么结果…"></textarea>
          <input id="media-picker" type="file" accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,video/quicktime" multiple hidden>
          <div class="composer-actions">
            <button id="attach" class="icon-button" type="button" aria-label="添加图片或短视频" title="添加图片或短视频">＋</button>
            <button id="voice" class="talk-button" type="button" aria-label="开启语音模式" aria-pressed="false" title="直接说话，Friday 回答时会朗读，也可以开口打断"><span class="voice-wave" aria-hidden="true">≋</span> 语音对话</button>
            <span id="composer-state" role="status"></span>
            <button id="send" class="button button-primary send-button" type="submit">发送 <span aria-hidden="true">↗</span></button>
          </div>
        </form>
      </section>

      <section id="view-devices" class="view" data-view-panel="devices" hidden>
        <header class="view-header">
          <div><p class="eyebrow">PRIVATE FLEET</p><h1>设备</h1></div>
          <button id="refresh-devices" class="button button-quiet" type="button">刷新状态</button>
        </header>
        <div class="section-intro">
          <p>Hub 只调度已登记且在线的节点。推荐通过 Tailscale 组网；模型看不到 SSH 密钥。</p>
          <span id="fleet-summary">正在读取设备…</span>
        </div>
        <div id="device-list" class="device-list" aria-live="polite"></div>
        <section class="integration-section" aria-labelledby="wechat-title">
          <div>
            <p class="eyebrow">CHANNEL</p>
            <h2 id="wechat-title">微信 iLink</h2>
          </div>
          <div id="wechat-detail" class="integration-detail"></div>
          <div class="integration-actions">
            <button id="wechat-refresh" class="button button-quiet" type="button">刷新微信状态</button>
            <button id="wechat-bind" class="button button-secondary" type="button">重新扫码绑定</button>
          </div>
          <div id="wechat-pairing" class="pairing" hidden>
            <img id="wechat-qr" alt="微信 iLink 绑定二维码">
            <div>
              <p id="wechat-pair-state">请使用微信扫码确认</p>
              <form id="wechat-code-form" hidden>
                <label for="wechat-code">微信显示的数字配对码</label>
                <div class="inline-form"><input id="wechat-code" inputmode="numeric" pattern="[0-9]{1,12}" autocomplete="one-time-code"><button class="button button-primary" type="submit">提交配对码</button></div>
              </form>
            </div>
          </div>
        </section>
      </section>

      <section id="view-tasks" class="view" data-view-panel="tasks" hidden>
        <header class="view-header">
          <div><p class="eyebrow">EXECUTION LEDGER</p><h1>任务</h1></div>
          <div class="header-actions">
            <label class="visually-hidden" for="task-filter">筛选任务</label>
            <select id="task-filter"><option value="active">进行中</option><option value="all">全部任务</option><option value="failed">失败任务</option></select>
            <button id="refresh-tasks" class="button button-quiet" type="button">刷新</button>
          </div>
        </header>
        <div id="task-list" class="ledger-list" aria-live="polite"></div>
      </section>

      <section id="view-clearance" class="view" data-view-panel="clearance" hidden>
        <header class="view-header">
          <div><p class="eyebrow">需要你确认</p><h1>授权</h1></div>
          <button id="refresh-clearance" class="button button-quiet" type="button">刷新</button>
        </header>
        <div class="section-intro clearance-intro">
          <p>只在需要写入、部署或影响服务时停下来。Friday 会先列明背景、风险和回滚方式，再由你一次授权。</p>
        </div>
        <section aria-labelledby="r1-title">
          <div class="section-heading"><h2 id="r1-title">待执行任务</h2><span>需要确认</span></div>
          <div id="approval-list" class="approval-list"></div>
        </section>
        <section aria-labelledby="improvement-title">
          <div class="section-heading"><h2 id="improvement-title">Friday 自我迭代</h2><span>重大变化需要 Web 确认</span></div>
          <div id="improvement-list" class="approval-list"></div>
        </section>
      </section>
    </main>

    <nav class="mobile-nav" aria-label="移动端主导航">
      <button class="nav-item is-active" type="button" data-view="chat"><span aria-hidden="true">◉</span><b>对话</b></button>
      <details class="advanced-menu mobile-advanced">
        <summary class="nav-item advanced-summary"><span aria-hidden="true">≡</span><b>管理</b></summary>
        <div class="advanced-sheet">
          <button class="nav-item" type="button" data-view="devices"><span aria-hidden="true">⌁</span><b>设备</b></button>
          <button class="nav-item" type="button" data-view="tasks"><span aria-hidden="true">↗</span><b>任务</b></button>
          <button class="nav-item" type="button" data-view="clearance"><span aria-hidden="true">◇</span><b>授权</b></button>
        </div>
      </details>
    </nav>
  </div>

  <div id="toast" class="toast" role="status" aria-live="polite" hidden></div>
  <script type="module" src="/assets/friday.js"></script>
</body>
</html>`;

export const OWNER_WEB_CSS = String.raw`@layer reset, base, components, responsive;

@layer reset {
  *, *::before, *::after { box-sizing: border-box; }
  html { text-size-adjust: 100%; }
  body, h1, h2, p { margin: 0; }
  button, input, textarea, select { font: inherit; }
  button { color: inherit; }
  img { max-width: 100%; display: block; }
  [hidden] { display: none !important; }
}

@layer base {
  :root {
    --paper: oklch(96% 0.012 82);
    --paper-deep: oklch(92% 0.018 80);
    --surface: oklch(98% 0.008 82);
    --ink: oklch(21% 0.022 244);
    --ink-soft: oklch(43% 0.026 244);
    --line: oklch(82% 0.018 78);
    --line-strong: oklch(68% 0.025 76);
    --accent: oklch(56% 0.19 32);
    --accent-dark: oklch(43% 0.16 30);
    --accent-soft: oklch(91% 0.055 45);
    --success: oklch(48% 0.115 153);
    --success-soft: oklch(91% 0.04 153);
    --warning: oklch(57% 0.12 72);
    --warning-soft: oklch(92% 0.05 80);
    --danger: oklch(51% 0.17 25);
    --danger-soft: oklch(92% 0.045 28);
    --font-body: "Avenir Next", "PingFang SC", "Noto Sans CJK SC", sans-serif;
    --font-display: "Iowan Old Style", "Songti SC", "Noto Serif CJK SC", serif;
    --text-xs: .75rem;
    --text-sm: .875rem;
    --text-base: 1rem;
    --text-lg: 1.25rem;
    --text-xl: clamp(2.25rem, 5vw, 4.5rem);
    --space-1: .25rem;
    --space-2: .5rem;
    --space-3: .75rem;
    --space-4: 1rem;
    --space-5: 1.25rem;
    --space-6: 1.5rem;
    --space-8: 2rem;
    --space-12: 3rem;
    --mobile-header: 60px;
    --mobile-nav: 68px;
    --ease-out: cubic-bezier(.22, 1, .36, 1);
    color: var(--ink);
    background: var(--paper);
    font-family: var(--font-body);
    font-size: 100%;
    font-kerning: normal;
  }

  body {
    min-height: 100vh;
    min-height: 100dvh;
    background: var(--paper);
    padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
  }

  h1, h2 { font-family: var(--font-display); font-weight: 600; letter-spacing: -.035em; }
  h1 { font-size: clamp(2.25rem, 4vw, 3.75rem); line-height: .98; }
  h2 { font-size: var(--text-lg); line-height: 1.2; }
  p { line-height: 1.6; }
  button, input, textarea, select { min-height: 44px; }
  button { cursor: pointer; }
  :focus:not(:focus-visible) { outline: none; }
  :focus-visible { outline: 3px solid color-mix(in oklch, var(--accent) 72%, var(--paper)); outline-offset: 3px; }
  ::selection { color: var(--ink); background: var(--accent-soft); }
}

@layer components {
  .skip-link { position: fixed; z-index: 100; inset: .75rem auto auto .75rem; transform: translateY(-160%); padding: .75rem 1rem; color: var(--surface); background: var(--ink); }
  .skip-link:focus { transform: translateY(0); }
  .visually-hidden { position: absolute !important; width: 1px; height: 1px; min-height: 1px !important; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
  .eyebrow { color: var(--accent-dark); font-size: var(--text-xs); font-weight: 700; letter-spacing: .14em; line-height: 1.2; }
  .brand { display: flex; align-items: center; gap: .75rem; font-size: var(--text-sm); font-weight: 700; letter-spacing: .16em; }
  .reactor { width: 22px; aspect-ratio: 1; border: 1px solid var(--accent); border-radius: 50%; position: relative; }
  .reactor::before, .reactor::after { content: ""; position: absolute; border-radius: 50%; }
  .reactor::before { inset: 4px; border: 2px solid var(--accent); }
  .reactor::after { inset: 8px; background: var(--accent); }

  .pairing label { font-size: var(--text-sm); font-weight: 700; }
  .inline-form { display: grid; gap: var(--space-2); }
  input, textarea, select { width: 100%; color: var(--ink); background: var(--surface); border: 1px solid var(--line-strong); border-radius: 2px; padding: .75rem 1rem; }
  input::placeholder, textarea::placeholder { color: var(--ink-soft); opacity: 1; }
  input:hover, textarea:hover, select:hover { border-color: var(--ink-soft); }
  .button { border: 0; border-radius: 2px; padding: .7rem 1rem; font-size: var(--text-sm); font-weight: 700; transition: transform 120ms var(--ease-out), color 120ms, background-color 120ms, border-color 120ms; }
  .button:active { transform: translateY(1px); }
  .button:disabled { cursor: not-allowed; opacity: .45; }
  .button-primary { color: var(--surface); background: var(--accent-dark); }
  .button-primary:hover { background: var(--accent); }
  .button-secondary { color: var(--surface); background: var(--ink); }
  .button-secondary:hover { background: var(--ink-soft); }
  .button-quiet { color: var(--ink); background: transparent; border: 1px solid var(--line-strong); }
  .button-quiet:hover { background: var(--paper-deep); }
  .text-button { min-height: 44px; padding: 0; color: var(--ink-soft); background: transparent; border: 0; font-size: var(--text-sm); text-align: left; }
  .text-button:hover { color: var(--accent-dark); }
  .icon-button { width: 44px; flex: 0 0 44px; color: var(--ink); background: transparent; border: 1px solid var(--line-strong); border-radius: 50%; font-weight: 700; }
  .icon-button:hover { color: var(--surface); background: var(--ink); border-color: var(--ink); }
  .talk-button { min-width: 4.25rem; padding: .6rem .8rem; color: var(--ink); background: transparent; border: 1px solid var(--line-strong); border-radius: 999px; font-size: var(--text-sm); font-weight: 700; }
  .talk-button:hover, .talk-button.is-recording { color: var(--surface); background: var(--accent-dark); border-color: var(--accent-dark); }
  .voice-wave { font-size: 1rem; }
  .auth-label { color: oklch(76% .018 80); font-size: var(--text-xs); }
  .advanced-menu > summary { list-style: none; cursor: pointer; }
  .advanced-menu > summary::-webkit-details-marker { display: none; }
  .advanced-links { display: grid; gap: .25rem; padding-top: .25rem; }
  .advanced-links .nav-item { width: 100%; }

  .app-shell { min-height: 100vh; min-height: 100dvh; display: grid; grid-template-rows: var(--mobile-header) minmax(0, 1fr); background: var(--paper); }
  .sidebar { display: none; }
  .mobile-header { position: relative; z-index: 20; display: flex; align-items: center; justify-content: space-between; min-height: var(--mobile-header); padding: .6rem 1rem; background: color-mix(in oklch, var(--paper) 94%, var(--surface)); border-bottom: 1px solid var(--line); }
  .connection-state, .channel-state { display: flex; align-items: center; gap: var(--space-2); color: var(--ink-soft); font-size: var(--text-xs); }
  .status-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--success); box-shadow: 0 0 0 3px var(--success-soft); }
  .status-dot-muted { background: var(--line-strong); box-shadow: 0 0 0 3px var(--paper-deep); }
  .status-dot-warning { background: var(--warning); box-shadow: 0 0 0 3px var(--warning-soft); }
  .status-dot-danger { background: var(--danger); box-shadow: 0 0 0 3px var(--danger-soft); }

  .workspace { min-width: 0; min-height: 0; height: 100%; overflow: auto; padding: 0 1rem calc(var(--mobile-nav) + env(safe-area-inset-bottom)); }
  .view { width: min(100%, 1120px); min-height: 100%; margin: 0 auto; padding: clamp(1.25rem, 5vw, 4rem) 0; animation: enter 420ms var(--ease-out) both; }
  .view-chat { display: grid; grid-template-rows: auto auto minmax(15rem, 1fr) auto; height: 100%; min-height: 32rem; padding-block: 1rem .75rem; }
  @keyframes enter { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
  .view-header { display: flex; align-items: flex-end; justify-content: space-between; gap: var(--space-4); padding-bottom: var(--space-8); border-bottom: 1px solid var(--line-strong); }
  .view-header > div:first-child { display: grid; gap: var(--space-2); }
  .view-header h1 { font-size: clamp(2.25rem, 5vw, 4rem); }
  .chat-header { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; padding-bottom: var(--space-3); }
  .chat-header > div:first-child { gap: .4rem; }
  .chat-subtitle { max-width: 34ch; color: var(--ink-soft); font-size: var(--text-sm); line-height: 1.45; }
  .edition-mark { display: inline-block; margin-left: .2em; color: var(--accent); font-family: var(--font-body); font-size: .28em; font-weight: 800; letter-spacing: .1em; vertical-align: top; }
  .assistant-presence { display: flex; align-items: center; gap: var(--space-2); min-width: max-content; }
  .assistant-presence > span:last-child { display: grid; gap: .1rem; }
  .assistant-presence strong { font-size: var(--text-sm); }
  .assistant-presence small { color: var(--ink-soft); font-size: var(--text-xs); }
  .presence-reactor { position: relative; width: 38px; aspect-ratio: 1; display: grid; place-items: center; border: 1px solid var(--line-strong); border-radius: 50%; }
  .presence-reactor::before, .presence-reactor::after, .presence-reactor i { content: ""; position: absolute; border-radius: 50%; }
  .presence-reactor::before { inset: 5px; border: 1px solid var(--accent); }
  .presence-reactor::after { inset: 11px; border: 3px solid var(--accent); }
  .presence-reactor i { width: 7px; aspect-ratio: 1; background: var(--accent); }
  .assistant-presence.is-active .presence-reactor::before { animation: reactor-turn 2.4s linear infinite; border-style: dashed; }
  .assistant-presence.is-listening .presence-reactor { background: var(--accent-soft); }
  @keyframes reactor-turn { to { transform: rotate(360deg); } }
  .capability-ribbon { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: stretch; gap: 0; padding: .45rem 0; border-bottom: 1px solid var(--line); }
  .capability-ribbon::-webkit-scrollbar { display: none; }
  .capability-ribbon > span { min-width: 0; display: flex; align-items: center; gap: .45rem; min-height: 36px; padding: .2rem .35rem; color: var(--ink-soft); font-size: .7rem; }
  .capability-ribbon > span:nth-child(even) { border-inline-start: 1px solid var(--line); padding-inline-start: .7rem; }
  .capability-ribbon b { min-width: 0; overflow: hidden; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
  .ribbon-mark { width: 17px; height: 17px; display: grid; place-items: center; color: var(--accent-dark); border: 1px solid color-mix(in oklch, var(--accent) 45%, var(--line)); border-radius: 50%; font-size: .58rem; font-style: normal; font-weight: 800; }
  .header-actions { display: flex; align-items: center; gap: var(--space-2); }
  .header-actions select { width: auto; min-width: 7rem; background: transparent; }
  .section-intro { display: grid; gap: var(--space-4); padding: var(--space-6) 0 var(--space-8); color: var(--ink-soft); }
  .section-intro p { max-width: 58ch; }
  .section-intro span { font-size: var(--text-sm); font-weight: 700; color: var(--ink); }

  .chat-stage { min-height: 0; display: grid; grid-template-rows: minmax(0, 1fr) auto; }
  .conversation { min-height: 0; overflow: auto; padding: var(--space-5) 0; scroll-behavior: smooth; scrollbar-gutter: stable; }
  .conversation-empty { min-height: 100%; display: grid; align-content: center; gap: var(--space-2); max-width: 38rem; padding: var(--space-4) 0; }
  .conversation-empty p { font-family: var(--font-display); font-size: clamp(1.7rem, 4vw, 2.5rem); line-height: 1.15; }
  .conversation-empty span { color: var(--ink-soft); line-height: 1.6; }
  .starter-grid { display: flex; flex-wrap: wrap; gap: var(--space-2); margin-top: var(--space-4); }
  .starter-grid button, .text-action { min-height: 44px; padding: .55rem .75rem; color: var(--ink); background: transparent; border: 1px solid var(--line-strong); font-size: var(--text-xs); text-align: left; transition: color 120ms, background-color 120ms, border-color 120ms; }
  .starter-grid button:hover, .text-action:hover { color: var(--surface); background: var(--ink); border-color: var(--ink); }
  .context-rail { grid-row: 2; min-width: 0; }
  .context-drawer { border-bottom: 1px solid var(--line); }
  .context-drawer > summary { min-height: 48px; display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); cursor: pointer; list-style: none; font-size: var(--text-sm); font-weight: 750; }
  .context-drawer > summary::-webkit-details-marker { display: none; }
  .context-drawer > summary::after { content: "+"; color: var(--accent-dark); font-size: 1.1rem; }
  .context-drawer[open] > summary::after { content: "−"; }
  .context-drawer > summary small { margin-left: auto; color: var(--ink-soft); font-size: var(--text-xs); font-weight: 500; }
  .context-content { max-height: min(38dvh, 22rem); overflow: auto; display: grid; gap: var(--space-6); padding: var(--space-3) 0 var(--space-5); }
  .memory-section, .growth-section { display: grid; gap: var(--space-3); }
  .context-heading { display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-2); }
  .context-heading h2 { font-family: var(--font-body); font-size: var(--text-sm); letter-spacing: 0; }
  .context-heading span { color: var(--accent-dark); font-size: .65rem; font-weight: 750; letter-spacing: .08em; }
  .memory-section > p, .growth-section > p { color: var(--ink-soft); font-size: var(--text-xs); line-height: 1.55; }
  .memory-list { display: grid; gap: var(--space-2); }
  .memory-item { display: grid; gap: .45rem; padding: .65rem 0; border-top: 1px solid var(--line); }
  .memory-item:first-child { border-top: 0; }
  .memory-item p { color: var(--ink); font-size: var(--text-xs); line-height: 1.5; }
  .memory-meta { display: flex; align-items: center; justify-content: space-between; gap: .4rem; color: var(--ink-soft); font-size: .65rem; }
  .memory-actions { display: flex; gap: .35rem; }
  .memory-actions button { min-height: 36px; padding: .3rem .55rem; color: var(--ink-soft); background: transparent; border: 1px solid var(--line); font-size: .7rem; }
  .memory-actions button:first-child { color: var(--accent-dark); border-color: color-mix(in oklch, var(--accent) 38%, var(--line)); }
  .memory-empty { color: var(--ink-soft); font-size: var(--text-xs); }
  .text-action { justify-self: start; border-width: 0 0 1px; padding-inline: 0; }
  .message { display: grid; gap: var(--space-2); margin-bottom: var(--space-8); }
  .message-user { justify-items: end; }
  .message-label { color: var(--ink-soft); font-size: var(--text-xs); font-weight: 700; letter-spacing: .08em; }
  .message-body { max-width: min(42rem, 88%); overflow-wrap: anywhere; line-height: 1.65; }
  .message-user .message-body { padding: .75rem 1rem; background: var(--paper-deep); border-radius: 14px 14px 2px 14px; }
  .message-user .message-body { white-space: pre-wrap; }
  .markdown-body { display: grid; gap: .8rem; }
  .markdown-body > :first-child { margin-top: 0; }
  .markdown-body > :last-child { margin-bottom: 0; }
  .markdown-body h2, .markdown-body h3, .markdown-body h4 { margin: .4rem 0 -.2rem; font-family: var(--font-body); letter-spacing: -.02em; }
  .markdown-body h2 { font-size: 1.18rem; }
  .markdown-body h3 { font-size: 1.05rem; }
  .markdown-body h4 { font-size: 1rem; }
  .markdown-body p { margin: 0; }
  .markdown-body ul, .markdown-body ol { display: grid; gap: .35rem; margin: 0; padding-left: 1.35rem; }
  .markdown-body li > p { display: inline; }
  .markdown-body blockquote { margin: 0; padding: .15rem 0 .15rem 1rem; color: var(--ink-soft); border-left: 2px solid var(--accent); }
  .markdown-body hr { width: 100%; border: 0; border-top: 1px solid var(--line); }
  .markdown-body strong { color: var(--ink); font-weight: 750; }
  .markdown-body em { color: var(--ink-soft); }
  .markdown-body code { padding: .12rem .32rem; color: var(--accent-dark); background: var(--accent-soft); font-size: .9em; font-variant-ligatures: none; }
  .markdown-body pre { overflow: auto; margin: 0; padding: .85rem 1rem; color: var(--paper); background: var(--ink); border: 1px solid var(--line); }
  .markdown-body pre code { padding: 0; color: inherit; background: transparent; font-size: .88em; white-space: pre; }
  .markdown-body a { color: var(--accent-dark); text-decoration-thickness: .08em; text-underline-offset: .16em; }
  .markdown-table { overflow-x: auto; border: 1px solid var(--line); }
  .markdown-table table { width: 100%; min-width: 28rem; border-collapse: collapse; font-size: var(--text-sm); }
  .markdown-table th, .markdown-table td { padding: .55rem .7rem; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
  .markdown-table th { color: var(--ink); background: var(--paper-deep); font-weight: 750; }
  .markdown-table tr:last-child td { border-bottom: 0; }
  .markdown-media { display: grid; gap: .35rem; margin: 0; }
  .markdown-media img, .markdown-media video { max-width: 100%; max-height: 24rem; border: 1px solid var(--line); background: var(--ink); object-fit: contain; }
  .markdown-media audio { width: min(100%, 28rem); }
  .markdown-media figcaption { color: var(--ink-soft); font-size: var(--text-xs); }
  .markdown-chart { display: grid; gap: .8rem; margin: 0; padding: 1rem; background: var(--paper-deep); border: 1px solid var(--line); }
  .markdown-chart figcaption { font-weight: 750; }
  .chart-bars { display: grid; grid-template-columns: repeat(var(--chart-count), minmax(2.5rem, 1fr)); gap: .55rem; align-items: end; min-height: 10rem; padding: .75rem .25rem 0; border-bottom: 1px solid var(--line-strong); }
  .chart-bar { display: grid; grid-template-rows: 1fr auto auto; gap: .25rem; align-items: end; min-width: 0; height: 100%; text-align: center; }
  .chart-bar::before { content: ""; width: min(2.25rem, 72%); height: var(--bar-height); justify-self: center; background: var(--accent); border-radius: 2px 2px 0 0; }
  .chart-bar-value { color: var(--ink); font-size: .7rem; font-variant-numeric: tabular-nums; }
  .chart-bar-label { overflow: hidden; color: var(--ink-soft); font-size: var(--text-xs); text-overflow: ellipsis; white-space: nowrap; }
  .message-media { width: min(32rem, 88%); display: grid; grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr)); gap: var(--space-2); }
  .message-user .message-media { justify-self: end; }
  .message-media figure { min-width: 0; margin: 0; display: grid; gap: var(--space-1); }
  .message-media img, .message-media video { width: 100%; max-height: 20rem; aspect-ratio: 4 / 3; object-fit: contain; background: var(--ink); border: 1px solid var(--line); }
  .message-media figcaption { color: var(--ink-soft); font-size: var(--text-xs); }
  .media-unavailable { min-height: 7rem; display: grid; place-items: center; padding: var(--space-3); color: var(--ink-soft); background: var(--paper-deep); border: 1px solid var(--line); font-size: var(--text-xs); text-align: center; }
  .message-friday .message-body { font-size: 1.05rem; }
  .message-meta { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); color: var(--ink-soft); font-size: var(--text-xs); }
  .message-meta button { min-height: 32px; padding: 0 .5rem; border: 0; color: var(--ink-soft); background: transparent; }
  .message-job { width: min(38rem, 100%); display: grid; gap: var(--space-2); padding: var(--space-3) 0 var(--space-3) var(--space-4); border-left: 2px solid var(--accent); font-size: var(--text-sm); }
  .message-approval { width: min(38rem, 100%); display: grid; gap: var(--space-2); margin-top: var(--space-3); padding: var(--space-4); background: var(--accent-soft); border: 1px solid color-mix(in oklch, var(--accent) 34%, var(--line)); }
  .message-approval strong { font-size: var(--text-sm); }
  .message-approval span { color: var(--ink-soft); font-size: var(--text-sm); line-height: 1.55; }
  .message-approval .button { justify-self: start; }
  .message-error { color: var(--danger); }

  .composer { position: relative; align-self: end; background: var(--surface); border: 1px solid var(--line-strong); box-shadow: 0 10px 32px color-mix(in oklch, var(--ink) 8%, transparent); }
  .composer:focus-within { border-color: var(--accent); }
  .composer textarea { display: block; min-height: 58px; max-height: 160px; field-sizing: content; resize: none; border: 0; background: transparent; padding: .9rem 1rem .65rem; }
  .composer textarea:focus-visible { outline: 0; }
  .composer-media { display: flex; gap: var(--space-2); overflow-x: auto; padding: var(--space-3) var(--space-3) 0; }
  .composer-media[hidden] { display: none; }
  .composer-media-item { position: relative; flex: 0 0 6.5rem; display: grid; gap: var(--space-1); }
  .composer-media-item img, .composer-media-item video { width: 6.5rem; height: 5rem; object-fit: cover; background: var(--ink); border: 1px solid var(--line); }
  .composer-media-item span { overflow: hidden; color: var(--ink-soft); font-size: var(--text-xs); text-overflow: ellipsis; white-space: nowrap; }
  .composer-media-item button { position: absolute; top: .25rem; right: .25rem; width: 36px; min-height: 36px; padding: 0; border: 0; border-radius: 50%; color: var(--surface); background: var(--ink); font-weight: 700; }
  .composer-actions { display: flex; align-items: center; gap: var(--space-2); padding: 0 var(--space-2) var(--space-2); }
  .composer-actions #composer-state { min-width: 0; flex: 1; overflow-wrap: anywhere; color: var(--ink-soft); font-size: var(--text-xs); }
  .send-button { min-width: 6.25rem; }

  .device-list, .ledger-list, .approval-list { display: grid; border-top: 1px solid var(--line); }
  .device-row { display: grid; gap: var(--space-4); padding: var(--space-6) 0; border-bottom: 1px solid var(--line); }
  .device-identity { display: flex; align-items: center; gap: var(--space-3); }
  .device-identity h2 { font-family: var(--font-body); font-size: var(--text-base); letter-spacing: 0; }
  .device-identity p, .device-meta { color: var(--ink-soft); font-size: var(--text-sm); }
  .device-meta { display: grid; gap: var(--space-2); }
  .chip-row { display: flex; flex-wrap: wrap; gap: var(--space-2); }
  .chip, .risk-chip, .state-chip { display: inline-flex; align-items: center; min-height: 28px; padding: .2rem .55rem; border-radius: 999px; font-size: var(--text-xs); font-weight: 700; }
  .chip { color: var(--ink-soft); background: var(--paper-deep); }
  .state-chip { color: var(--ink); background: var(--paper-deep); }
  .state-chip-success { color: var(--success); background: var(--success-soft); }
  .state-chip-warning { color: oklch(40% .1 70); background: var(--warning-soft); }
  .state-chip-danger { color: var(--danger); background: var(--danger-soft); }
  .risk-chip { color: var(--accent-dark); background: var(--accent-soft); }

  .integration-section { display: grid; gap: var(--space-6); margin-top: var(--space-12); padding-top: var(--space-8); border-top: 2px solid var(--ink); }
  .integration-section > div:first-child { display: grid; gap: var(--space-2); }
  .integration-detail { color: var(--ink-soft); }
  .integration-actions { display: flex; flex-wrap: wrap; gap: var(--space-2); }
  .pairing { display: grid; grid-template-columns: minmax(140px, 240px) 1fr; gap: var(--space-6); align-items: center; padding: var(--space-6) 0; border-top: 1px solid var(--line); }
  .pairing img { background: var(--surface); border: 1px solid var(--line); }
  .pairing > div { display: grid; gap: var(--space-4); }
  .inline-form { margin-top: var(--space-2); }

  .ledger-row { display: grid; gap: var(--space-4); padding: var(--space-6) 0; border-bottom: 1px solid var(--line); }
  .ledger-main { display: grid; gap: var(--space-2); }
  .ledger-title { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-2); }
  .ledger-title h2 { font-family: var(--font-body); font-size: var(--text-base); letter-spacing: 0; }
  .ledger-meta { color: var(--ink-soft); font-size: var(--text-sm); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
  .ledger-actions { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-2); }
  .empty-row { padding: var(--space-8) 0; color: var(--ink-soft); border-bottom: 1px solid var(--line); }
  .empty-state { display: grid; justify-items: start; gap: var(--space-2); padding: var(--space-8) 0; border-bottom: 1px solid var(--line); }
  .empty-state strong { font-family: var(--font-display); font-size: var(--text-lg); }
  .empty-state p { max-width: 54ch; color: var(--ink-soft); }
  .empty-state .button { margin-top: var(--space-2); }

  .clearance-intro { padding-bottom: var(--space-12); }
  .section-heading { display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-4); margin-bottom: var(--space-3); }
  .section-heading span { color: var(--accent-dark); font-size: var(--text-xs); font-weight: 700; letter-spacing: .1em; }
  .view[data-view-panel="clearance"] section + section { margin-top: var(--space-12); }
  .approval-row { display: grid; gap: var(--space-4); padding: var(--space-6) 0; border-bottom: 1px solid var(--line); }
  .approval-copy { display: grid; gap: var(--space-3); }
  .approval-copy h3 { margin: 0; font-size: var(--text-base); }
  .approval-context { display: grid; gap: var(--space-3); color: var(--ink-soft); font-size: var(--text-sm); }
  .approval-context div { display: grid; gap: var(--space-1); }
  .approval-context strong { color: var(--ink); }
  .approval-actions { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: center; }

  .mobile-nav { position: fixed; z-index: 30; inset: auto 0 0; min-height: var(--mobile-nav); display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); padding: .25rem max(.5rem, env(safe-area-inset-right)) max(.25rem, env(safe-area-inset-bottom)) max(.5rem, env(safe-area-inset-left)); background: var(--ink); }
  .nav-item { position: relative; min-height: 52px; display: flex; align-items: center; justify-content: center; gap: .35rem; color: oklch(74% .018 80); background: transparent; border: 0; font-size: var(--text-xs); }
  .nav-item b { font-weight: 600; }
  .nav-item.is-active { color: var(--surface); }
  .nav-item.is-active::after { content: ""; position: absolute; left: 24%; right: 24%; bottom: 2px; height: 2px; background: var(--accent); }
  .nav-item em { min-width: 18px; height: 18px; display: grid; place-items: center; border-radius: 9px; color: var(--surface); background: var(--accent); font-size: .65rem; font-style: normal; }
  .mobile-advanced { position: relative; }
  .mobile-advanced[open] > .advanced-summary { color: var(--surface); background: oklch(27% .028 244); }
  .advanced-sheet { position: absolute; right: .5rem; bottom: calc(100% + .5rem); min-width: 11rem; padding: .35rem; background: var(--ink); border: 1px solid oklch(37% .028 244); box-shadow: 0 12px 28px color-mix(in oklch, var(--ink) 24%, transparent); }
  .advanced-sheet .nav-item { justify-content: flex-start; padding: 0 .65rem; }
  .advanced-sheet .nav-item.is-active { color: var(--surface); background: oklch(27% .028 244); }

  .toast { position: fixed; z-index: 80; left: 50%; bottom: calc(5.5rem + env(safe-area-inset-bottom)); transform: translateX(-50%); width: min(90vw, 32rem); padding: .85rem 1rem; color: var(--surface); background: var(--ink); border-left: 3px solid var(--accent); font-size: var(--text-sm); box-shadow: 0 12px 32px color-mix(in oklch, var(--ink) 20%, transparent); animation: toast-in 240ms var(--ease-out) both; }
  @keyframes toast-in { from { opacity: 0; transform: translate(-50%, 10px); } }
}

@layer responsive {
  @media (min-width: 40rem) {
    .inline-form { grid-template-columns: minmax(0, 1fr) auto; }
    .device-row { grid-template-columns: minmax(15rem, .8fr) 1.2fr; align-items: center; }
    .ledger-row, .approval-row { grid-template-columns: minmax(0, 1fr) auto; align-items: center; }
    .approval-context { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  }

  @media (min-width: 56rem) {
    .app-shell { grid-template-columns: 208px minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); }
    .sidebar { position: sticky; z-index: 20; top: 0; height: 100vh; height: 100dvh; display: flex; flex-direction: column; padding: 2rem 1.25rem; color: var(--paper); background: var(--ink); }
    .sidebar .brand { padding: 0 .75rem; }
    .sidebar .reactor { border-color: oklch(72% .17 36); }
    .sidebar .reactor::before { border-color: oklch(72% .17 36); }
    .sidebar .reactor::after { background: oklch(72% .17 36); }
    .primary-nav { display: grid; gap: .25rem; margin-top: clamp(4rem, 12vh, 8rem); }
    .primary-nav .nav-item { justify-content: flex-start; min-height: 48px; padding: 0 .75rem; font-size: var(--text-sm); }
    .primary-nav .nav-item span { width: 1.25rem; color: oklch(66% .025 80); text-align: center; }
    .primary-nav .nav-item.is-active { background: oklch(27% .028 244); }
    .primary-nav .nav-item.is-active::after { inset: 11px auto 11px 0; width: 2px; height: auto; }
    .primary-nav .advanced-menu[open] > .advanced-summary { color: var(--surface); background: oklch(27% .028 244); }
    .primary-nav .advanced-links .nav-item { min-height: 44px; padding-left: 1.5rem; font-size: var(--text-xs); }
    .primary-nav .advanced-links .nav-item.is-active { background: oklch(30% .028 244); }
    .sidebar-footer { margin-top: auto; display: grid; gap: var(--space-3); padding: 0 .75rem; }
    .sidebar-footer .connection-state, .sidebar-footer .text-button { color: oklch(76% .018 80); }
    .mobile-header, .mobile-nav { display: none; }
    .workspace { height: 100dvh; padding: 0 clamp(2rem, 5vw, 5rem); }
    .view { min-height: 100%; }
    .view-chat { height: 100%; min-height: 40rem; padding: clamp(1.75rem, 4vh, 3rem) 0 1.5rem; }
    .capability-ribbon { display: flex; align-items: center; gap: var(--space-2); overflow-x: auto; padding: .65rem 0; }
    .capability-ribbon > span { flex: 0 0 auto; min-height: 30px; padding: .2rem .65rem; background: color-mix(in oklch, var(--paper-deep) 74%, transparent); border-radius: 999px; }
    .capability-ribbon > span:nth-child(even) { border-inline-start: 0; padding-inline-start: .65rem; }
    .chat-stage { grid-template: minmax(0, 1fr) / minmax(0, 1fr) minmax(17rem, 19rem); column-gap: clamp(1.5rem, 3vw, 3rem); }
    .conversation { grid-column: 1; grid-row: 1; padding-right: var(--space-2); }
    .context-rail { grid-column: 2; grid-row: 1; overflow: auto; padding: var(--space-5) 0 var(--space-5) var(--space-5); border-left: 1px solid var(--line); }
    .context-drawer { border-bottom: 0; }
    .context-drawer > summary::after { display: none; }
    .context-content { max-height: none; overflow: visible; }
    .toast { bottom: 2rem; }
  }

  @media (hover: hover) and (pointer: fine) {
    .button:hover { transform: translateY(-1px); }
    .button:active { transform: translateY(1px); }
  }

  @media (pointer: coarse) {
    .memory-actions button, .message-meta button { min-height: 44px; }
  }

  @media (forced-colors: active) {
    .status-dot, .ribbon-mark, .reactor, .presence-reactor { forced-color-adjust: none; }
    .nav-item.is-active::after { background: Highlight; }
  }

  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation-duration: .01ms !important; transition-duration: .01ms !important; scroll-behavior: auto !important; }
  }
}`;

export const OWNER_WEB_SCRIPT = String.raw`const byId = (id) => document.getElementById(id);
const all = (selector) => Array.from(document.querySelectorAll(selector));
const appState = {
  jobs: [], runners: [], improvements: [], nodeToolApprovals: [], conversationId: "main", activeView: "chat",
  conversationTurns: [], memories: [],
  pairingId: null, pairingTimer: null, recorder: null, voiceChunks: [],
  pendingMedia: [], uploadInFlight: false, sending: false,
  talkActive: false, recognition: null, talkTranscript: "", talkTimer: null,
  speaking: false, currentUtterance: null
};
const terminalStates = new Set(["SUCCEEDED", "FAILED", "CANCELLED"]);
const stateLabels = {
  WAIT_APPROVAL: "等待授权", DISPATCHED: "等待节点", RUNNING: "执行中", WAIT_USER: "等待输入",
  RECONCILING: "正在对账", SUCCEEDED: "已完成", FAILED: "失败", CANCELLED: "已停止",
  UNKNOWN: "状态未知", NEW: "已创建", PLANNING: "规划中", DRAFT: "草稿", TESTED: "测试通过", ADOPTED: "已采纳",
  CLEARED: "已授权", CANARY: "小流量验证", DEPLOYED: "已部署", ROLLED_BACK: "已回滚"
};
const toolLabels = { agent: "Friday Agent", codex: "Codex", pi: "Pi", claude: "Claude Code" };
const nodeToolLabels = {
  "system.snapshot": "读取系统状态", "process.list": "查看进程", "service.status": "查看服务状态",
  "journal.read": "读取运行日志", "network.sockets": "查看网络连接", "file.read": "读取文件",
  "file.search": "搜索文件", "file.write": "写入文件", "file.delete": "删除文件",
  "process.signal": "处理进程", "service.restart": "重启服务", "command.exec": "执行一次系统检查",
};

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const markdownFence = String.fromCharCode(96).repeat(3);

function safeMarkdownUrl(value, media) {
  const raw = String(value || "").trim().replace(/^<|>$/g, "");
  try {
    const url = new URL(raw, location.origin);
    if (url.username || url.password) return null;
    if (media) return url.origin === location.origin || url.protocol === "https:" ? url.href : null;
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? url.href : null;
  } catch (_) { return null; }
}

function appendMarkdownText(fragment, value) {
  String(value).split("\n").forEach((part, index) => {
    if (index > 0) fragment.append(document.createElement("br"));
    if (part) fragment.append(document.createTextNode(part));
  });
}

function markdownDestination(raw) {
  const parts = String(raw).trim().match(/^(<[^>]+>|[^\s]+)(?:\s+["']([^"']*)["'])?$/);
  return parts ? { url: parts[1], title: parts[2] || "" } : { url: String(raw).trim(), title: "" };
}

function markdownMedia(url, label) {
  const lower = url.toLowerCase().split("?")[0].split("#")[0];
  const figure = element("figure", "markdown-media");
  let media;
  if (/\.(mp4|webm|mov|m4v)$/.test(lower)) {
    media = document.createElement("video");
    media.controls = true;
    media.preload = "metadata";
    media.setAttribute("playsinline", "");
  } else if (/\.(mp3|m4a|wav|ogg|oga|aac|flac)$/.test(lower)) {
    media = document.createElement("audio");
    media.controls = true;
    media.preload = "metadata";
  } else {
    media = document.createElement("img");
    media.loading = "lazy";
    media.alt = label || "Friday 分享的图片";
  }
  media.referrerPolicy = "no-referrer";
  media.src = url;
  media.addEventListener("error", () => media.replaceWith(element("div", "media-unavailable", "媒体暂时无法读取")), { once: true });
  figure.append(media);
  if (label) figure.append(element("figcaption", "", label));
  return figure;
}

function inlineMarkdown(source) {
  const fragment = document.createDocumentFragment();
  const text = String(source || "");
  const codeMark = String.fromCharCode(96);
  let index = 0;
  let plainStart = 0;
  const flushPlain = (end) => {
    if (end > plainStart) appendMarkdownText(fragment, text.slice(plainStart, end));
  };
  while (index < text.length) {
    const isImage = text.startsWith("![", index);
    const isLink = text[index] === "[";
    if (text[index] === codeMark) {
      const end = text.indexOf(codeMark, index + 1);
      if (end > index + 1) {
        flushPlain(index);
        fragment.append(element("code", "", text.slice(index + 1, end)));
        index = end + 1;
        plainStart = index;
        continue;
      }
    }
    if (isImage || isLink) {
      const labelStart = index + (isImage ? 2 : 1);
      const labelEnd = text.indexOf("](", labelStart);
      const destinationEnd = labelEnd < 0 ? -1 : text.indexOf(")", labelEnd + 2);
      if (labelEnd > labelStart && destinationEnd > labelEnd + 2) {
        const destination = markdownDestination(text.slice(labelEnd + 2, destinationEnd));
        const url = safeMarkdownUrl(destination.url, isImage);
        if (url) {
          flushPlain(index);
          const label = text.slice(labelStart, labelEnd);
          if (isImage) fragment.append(markdownMedia(url, label));
          else {
            const link = element("a", "", label || url);
            link.href = url;
            if (destination.title) link.title = destination.title;
            if (/^https?:/i.test(url)) { link.target = "_blank"; link.rel = "noreferrer noopener"; }
            fragment.append(link);
          }
          index = destinationEnd + 1;
          plainStart = index;
          continue;
        }
      }
    }
    const marker = text.startsWith("**", index) || text.startsWith("__", index) ? text.slice(index, index + 2)
      : text.startsWith("~~", index) ? "~~"
      : (text[index] === "*" || text[index] === "_") && !/\s/.test(text[index + 1] || "") ? text[index] : "";
    if (marker) {
      const end = text.indexOf(marker, index + marker.length);
      if (end > index + marker.length) {
        flushPlain(index);
        const tag = marker === "~~" ? "del" : marker.length === 2 ? "strong" : "em";
        fragment.append(element(tag, "", text.slice(index + marker.length, end)));
        index = end + marker.length;
        plainStart = index;
        continue;
      }
    }
    index += 1;
  }
  flushPlain(text.length);
  return fragment;
}

function tableCells(line) {
  const trimmed = String(line).trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function isTableSeparator(line) {
  const cells = tableCells(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function isMarkdownBlockStart(line) {
  return /^ {0,3}(#{1,3})\s+/.test(line) || /^ {0,3}([-*+]\s+|\d+[.)]\s+|>\s?)/.test(line) || /^ {0,3}[-*_](?:\s*[-*_]){2,}\s*$/.test(line);
}

function chartBlock(value) {
  let data;
  try { data = JSON.parse(value); } catch (_) { return null; }
  if (!data || typeof data !== "object" || !Array.isArray(data.labels) || !Array.isArray(data.values) || data.labels.length === 0 || data.labels.length !== data.values.length || data.labels.length > 12) return null;
  const labels = data.labels.map((label) => String(label).trim().slice(0, 32));
  const values = data.values.map((number) => typeof number === "number" && Number.isFinite(number) && number >= 0 ? number : NaN);
  if (values.some((number) => Number.isNaN(number))) return null;
  const maximum = Math.max(...values, 1);
  const figure = element("figure", "markdown-chart");
  if (typeof data.title === "string" && data.title.trim()) figure.append(element("figcaption", "", data.title.trim().slice(0, 120)));
  const bars = element("div", "chart-bars");
  bars.style.setProperty("--chart-count", String(labels.length));
  labels.forEach((label, index) => {
    const bar = element("div", "chart-bar");
    bar.style.setProperty("--bar-height", String(Math.max(5, values[index] / maximum * 100)) + "%");
    bar.append(element("span", "chart-bar-value", String(values[index])), element("span", "chart-bar-label", label));
    bars.append(bar);
  });
  figure.append(bars);
  return figure;
}

function renderMarkdown(source) {
  const fragment = document.createDocumentFragment();
  const lines = String(source || "").replace(/\r\n?/g, "\n").split("\n");
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }
    const fence = line.match(new RegExp("^ {0,3}" + markdownFence + "([A-Za-z0-9_-]*)\\s*$"));
    if (fence) {
      const language = (fence[1] || "").toLowerCase();
      const content = [];
      index += 1;
      while (index < lines.length && lines[index].trim() !== markdownFence) { content.push(lines[index]); index += 1; }
      if (index < lines.length) index += 1;
      const chart = language === "chart" ? chartBlock(content.join("\n")) : null;
      if (chart) fragment.append(chart);
      else {
        const pre = document.createElement("pre");
        const code = document.createElement("code");
        if (language) code.className = "language-" + language;
        code.textContent = content.join("\n");
        pre.append(code); fragment.append(pre);
      }
      continue;
    }
    const heading = line.match(/^ {0,3}(#{1,3})\s+(.+?)\s*#*$/);
    if (heading) {
      const node = element("h" + Math.min(4, heading[1].length), "");
      node.append(inlineMarkdown(heading[2])); fragment.append(node); index += 1; continue;
    }
    if (index + 1 < lines.length && line.includes("|") && isTableSeparator(lines[index + 1])) {
      const table = document.createElement("table");
      const head = document.createElement("thead");
      const headRow = document.createElement("tr");
      tableCells(line).forEach((cell) => { const th = document.createElement("th"); th.scope = "col"; th.append(inlineMarkdown(cell)); headRow.append(th); });
      head.append(headRow); table.append(head);
      const body = document.createElement("tbody"); index += 2;
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
        const row = document.createElement("tr"); tableCells(lines[index]).forEach((cell) => { const td = document.createElement("td"); td.append(inlineMarkdown(cell)); row.append(td); });
        body.append(row); index += 1;
      }
      table.append(body); const wrapper = element("div", "markdown-table"); wrapper.append(table); fragment.append(wrapper); continue;
    }
    const list = line.match(/^ {0,3}([-*+]\s+|\d+[.)]\s+)(.+)$/);
    if (list) {
      const ordered = /^\d/.test(list[1]);
      const node = document.createElement(ordered ? "ol" : "ul");
      while (index < lines.length) {
        const item = lines[index].match(/^ {0,3}([-*+]\s+|\d+[.)]\s+)(.+)$/);
        if (!item || /^\d/.test(item[1]) !== ordered) break;
        const li = document.createElement("li"); li.append(inlineMarkdown(item[2])); node.append(li); index += 1;
      }
      fragment.append(node); continue;
    }
    if (/^ {0,3}>/.test(line)) {
      const quote = document.createElement("blockquote");
      while (index < lines.length && /^ {0,3}>/.test(lines[index])) { quote.append(inlineMarkdown(lines[index].replace(/^ {0,3}>\s?/, ""))); index += 1; if (index < lines.length) quote.append(document.createElement("br")); }
      fragment.append(quote); continue;
    }
    if (/^ {0,3}[-*_](?:\s*[-*_]){2,}\s*$/.test(line)) { fragment.append(document.createElement("hr")); index += 1; continue; }
    const paragraph = [line]; index += 1;
    while (index < lines.length && lines[index].trim() && !isMarkdownBlockStart(lines[index]) && !(index + 1 < lines.length && lines[index].includes("|") && isTableSeparator(lines[index + 1]))) { paragraph.push(lines[index]); index += 1; }
    const node = document.createElement("p"); node.append(inlineMarkdown(paragraph.join("\n"))); fragment.append(node);
  }
  return fragment;
}

function plainTextFromMarkdown(source) {
  const host = document.createElement("div");
  host.append(renderMarkdown(source));
  return host.textContent || String(source || "").replace(/[*_#>]/g, "").replace(new RegExp(String.fromCharCode(96), "g"), "").trim();
}

function csrfToken() {
  const match = document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith("friday_csrf="));
  return match ? decodeURIComponent(match.slice("friday_csrf=".length)) : "basic";
}

async function api(path, options) {
  const input = options || {};
  const method = input.method || "GET";
  const headers = new Headers(input.headers || {});
  headers.set("accept", "application/json");
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    const token = csrfToken();
    if (token) headers.set("x-friday-csrf", token);
  }
  const response = await fetch(path, Object.assign({}, input, { headers, credentials: "same-origin" }));
  const value = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && path !== "/v2/auth/login") setPresence("auth", "认证已失效，请刷新页面");
    const error = new Error(value.error && value.error.message ? value.error.message : "请求未完成，请稍后重试");
    error.code = value.error && value.error.code ? value.error.code : "REQUEST_FAILED";
    error.status = response.status;
    throw error;
  }
  return value;
}

function post(path, body) {
  return api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
}

let toastTimer;
function toast(message) {
  const node = byId("toast");
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 4200);
}

function activateView(name) {
  appState.activeView = name;
  all("[data-view-panel]").forEach((panel) => { panel.hidden = panel.dataset.viewPanel !== name; });
  all("[data-view]").forEach((button) => {
    const active = button.dataset.view === name;
    button.classList.toggle("is-active", active);
    if (active) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current");
  });
  all(".primary-nav .advanced-menu").forEach((menu) => { menu.open = name !== "chat"; });
  all(".mobile-advanced").forEach((menu) => { menu.open = false; });
  history.replaceState(null, "", "#" + name);
  byId("main-content").focus({ preventScroll: true });
  if (name === "devices") void loadDevices();
  if (name === "tasks") void loadJobs();
  if (name === "clearance") void loadClearance();
}

function formatTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}

function shortId(value) {
  return typeof value === "string" && value.length > 12 ? value.slice(0, 8) + "…" + value.slice(-4) : value || "—";
}

function statusChip(status) {
  const label = stateLabels[status] || status;
  let className = "state-chip";
  if (["SUCCEEDED", "DEPLOYED", "CLEARED", "TESTED", "ADOPTED"].includes(status)) className += " state-chip-success";
  if (["WAIT_APPROVAL", "WAIT_USER", "DISPATCHED", "CANARY"].includes(status)) className += " state-chip-warning";
  if (["FAILED", "CANCELLED", "ROLLED_BACK", "UNKNOWN"].includes(status)) className += " state-chip-danger";
  return element("span", className, label);
}

function approvalChip(risk) {
  return element("span", "risk-chip", risk === "R3" ? "仅限 Web 确认" : "需要你确认");
}

function emptyRow(text) {
  return element("p", "empty-row", text);
}

function emptyAction(title, detail, actionLabel, prompt) {
  const node = element("div", "empty-state");
  node.append(element("strong", "", title), element("p", "", detail));
  const action = element("button", "button button-quiet", actionLabel);
  action.type = "button";
  action.addEventListener("click", () => { activateView("chat"); useStarter(prompt); });
  node.append(action);
  return node;
}

function setPresence(mode, detail) {
  const host = document.querySelector(".assistant-presence");
  host.classList.toggle("is-active", ["thinking", "speaking"].includes(mode));
  host.classList.toggle("is-listening", mode === "listening");
  const labels = { ready: "Friday 已就绪", thinking: "Friday 正在思考", listening: "Friday 正在听", speaking: "Friday 正在回答", auth: "需要重新认证" };
  byId("presence-label").textContent = labels[mode] || "Friday";
  byId("presence-detail").textContent = detail || "";
}

function setHubConnection(mode) {
  const online = mode === "online";
  ["hub-dot", "mobile-hub-dot"].forEach((id) => { const node = byId(id); if (node) node.className = online ? "status-dot" : "status-dot status-dot-warning"; });
  ["hub-state", "mobile-hub-state"].forEach((id) => { const node = byId(id); if (node) node.textContent = online ? "Hub 在线" : "Hub 正在重连"; });
}

function useStarter(prompt) {
  byId("message").value = prompt;
  byId("message").focus();
  if (matchMedia("(max-width: 55.999rem)").matches) document.querySelector(".context-drawer").open = false;
}

async function boot() {
  try {
    const status = await api("/v2/auth/status");
    if (!status.authenticated) throw new Error("Basic Auth 未通过");
    const requestedView = location.hash.slice(1);
    activateView(["chat", "devices", "tasks", "clearance"].includes(requestedView) ? requestedView : "chat");
    document.querySelector(".context-drawer").open = matchMedia("(min-width: 56rem)").matches;
    await Promise.allSettled([loadConversation(), loadJobs(), loadDevices(), loadClearance(), loadMemory(), loadWechatStatus()]);
    startEventStream();
    setPresence("ready", "等你开口");
  } catch (error) {
    setPresence("auth", error.message);
    byId("conversation").replaceChildren(emptyRow("认证未完成。请刷新页面并输入 Friday Basic Auth。"));
  }
}

all("[data-view]").forEach((button) => button.addEventListener("click", () => activateView(button.dataset.view)));
byId("conversation").addEventListener("click", (event) => {
  const button = event.target.closest("[data-starter]");
  if (button) useStarter(button.dataset.starter);
});
byId("propose-improvement").addEventListener("click", () => useStarter("回顾你最近的失败和卡点，提出一个可以验证的自我改进。简单改进直接隔离修改并测试，重大变化再向我申请授权。"));
matchMedia("(min-width: 56rem)").addEventListener("change", (event) => { document.querySelector(".context-drawer").open = event.matches; });

async function loadConversation() {
  let turns = [];
  try {
    const index = await api("/v4/conversations?limit=50");
    if ((index.conversations || []).some((item) => item.conversationId === appState.conversationId)) {
      const result = await api("/v4/conversations/" + encodeURIComponent(appState.conversationId) + "/turns");
      turns = result.turns || [];
    }
  } catch (error) {
    throw error;
  }
  appState.conversationTurns = turns;
  renderConversation(turns);
}

function renderConversation(turns) {
  const host = byId("conversation");
  host.replaceChildren();
  if (!turns.length) {
    const empty = element("div", "conversation-empty");
    empty.append(element("p", "", "今天先处理哪件事？"), element("span", "", "直接说结果。简单的我自己处理，影响设备或服务时再请你确认。"));
    const starters = element("div", "starter-grid");
    [["检查设备", "检查所有设备的状态，先给我异常结论"], ["建立偏好", "记住：回答时先给结论，再给必要细节"], ["让 Friday 进化", "回顾你最近的失败和卡点，提出一个可以验证的自我改进"]].forEach(([label, prompt]) => {
      const button = element("button", "", label); button.type = "button"; button.dataset.starter = prompt; starters.append(button);
    });
    empty.append(starters);
    host.append(empty);
    return;
  }
  turns.forEach((turn) => {
    const user = element("article", "message message-user");
    user.append(element("span", "message-label", turn.channel === "wechat_ilink" ? "你 · 微信" : "你"));
    if (turn.text && turn.text.trim()) user.append(element("div", "message-body", turn.text));
    const visibleMedia = (turn.attachments || []).filter((item) => item.role !== "video_frame");
    if (visibleMedia.length) {
      const mediaHost = element("div", "message-media");
      visibleMedia.forEach((item) => mediaHost.append(conversationMediaFigure(item, turn.attachments || [])));
      user.append(mediaHost);
    }
    host.append(user);
    if (turn.assistantReply || turn.status === "FAILED" || turn.status === "THINKING") {
      const friday = element("article", "message message-friday");
      friday.append(element("span", "message-label", "FRIDAY"));
      const reply = turn.assistantReply || (turn.status === "THINKING" ? "正在处理…" : "这次没有完成。可以换一种说法后重试。");
      const body = element("div", "message-body markdown-body");
      body.append(renderMarkdown(reply));
      if (turn.status === "FAILED") body.classList.add("message-error");
      friday.append(body);
      if (turn.jobProposal || turn.selfImprovementProposal) {
        const proposal = turn.jobProposal || turn.selfImprovementProposal;
        const job = element("div", "message-job");
        job.append(element("strong", "", turn.selfImprovementProposal ? "Friday 已开始隔离改进" : "我已经准备好这项设备任务"));
        job.append(element("span", "", turn.selfImprovementProposal ? "简单变化会在测试通过后自动采纳，并用 brief 告诉你；重大变化才请你授权。" : "会在受控节点上执行，过程中不会把权限交给模型。"));
        const linkedJob = turn.jobId ? appState.jobs.find((item) => item.jobId === turn.jobId) : undefined;
        job.append(statusChip(turn.schedulingError ? "FAILED" : linkedJob?.status || (turn.selfImprovementProposal ? "DISPATCHED" : "WAIT_APPROVAL")));
        friday.append(job);

        const scheduledJob = linkedJob;
        if (scheduledJob?.status === "WAIT_APPROVAL" && scheduledJob.risk === "R1") {
          const approval = element("div", "message-approval");
          approval.append(element("strong", "", "这项任务等你确认"), element("span", "", "确认后 Friday 才会开始。"));
          const approve = element("button", "button button-primary", "确认并开始");
          approve.type = "button";
          approve.addEventListener("click", () => runAction(approve, () => post("/v2/jobs/" + scheduledJob.jobId + "/approve", {}), "好，任务开始了"));
          approval.append(approve);
          friday.append(approval);
        }
        const pendingNodeTool = turn.jobId ? (appState.nodeToolApprovals || []).find((item) => item.call.jobId === turn.jobId) : undefined;
        if (pendingNodeTool) {
          const approval = element("div", "message-approval");
          approval.append(
            element("strong", "", "我准备" + (nodeToolLabels[pendingNodeTool.call.name] || "继续处理")),
            element("span", "", pendingNodeTool.call.reason || "确认后我就继续。"),
          );
          const approve = element("button", "button button-primary", "确认并继续");
          approve.type = "button";
          approve.addEventListener("click", () => runAction(approve, () => post("/v2/node-tool-approvals/" + pendingNodeTool.call.callId + "/approve", {}), "好，我继续处理"));
          approval.append(approve);
          friday.append(approval);
        }
      }
      const meta = element("div", "message-meta");
      meta.append(element("span", "", formatTime(turn.updatedAt)));
      if (turn.assistantReply) {
        const speak = element("button", "", "朗读");
        speak.type = "button";
        speak.addEventListener("click", () => speakText(plainTextFromMarkdown(turn.assistantReply), speak));
        meta.append(speak);
      }
      friday.append(meta);
      host.append(friday);
    }
  });
  host.scrollTop = host.scrollHeight;
}

async function loadMemory() {
  try {
    const result = await api("/v2/memory/candidates");
    appState.memories = result.memories || [];
    renderMemory();
  } catch (_) {
    byId("memory-list").replaceChildren(element("p", "memory-empty", "记忆暂时不可用。"));
    byId("memory-summary").textContent = "记忆不可用";
  }
}

function renderMemory() {
  const host = byId("memory-list");
  host.replaceChildren();
  const pending = appState.memories.filter((item) => item.status === "PENDING");
  const confirmed = appState.memories.filter((item) => item.status === "CONFIRMED");
  byId("memory-count").textContent = confirmed.length + " 条长期记忆" + (pending.length ? " · " + pending.length + " 条待确认" : "");
  byId("memory-summary").textContent = pending.length ? pending.length + " 条记忆待确认" : confirmed.length + " 条长期记忆";
  if (!appState.memories.length) {
    host.append(element("p", "memory-empty", "还没有长期记忆。直接说“记住：……”即可建立第一条。"));
    return;
  }
  [...pending, ...confirmed].forEach((item) => {
    const row = element("article", "memory-item");
    row.append(element("p", "", item.value));
    const meta = element("div", "memory-meta");
    meta.append(element("span", "", item.status === "PENDING" ? "等待你确认" : "已用于后续对话"));
    const actions = element("div", "memory-actions");
    if (item.status === "PENDING") {
      const keep = element("button", "", "保留"); keep.type = "button";
      keep.addEventListener("click", () => runMemoryAction(keep, () => post("/v2/memory/candidates/" + item.id + "/confirm", {}), "这条记忆已经生效"));
      actions.append(keep);
    }
    const remove = element("button", "", item.status === "PENDING" ? "忽略" : "忘记"); remove.type = "button";
    remove.addEventListener("click", () => runMemoryAction(remove, () => api("/v2/memory/candidates/" + item.id, { method: "DELETE" }), item.status === "PENDING" ? "候选已忽略" : "这条记忆已删除"));
    actions.append(remove); meta.append(actions); row.append(meta); host.append(row);
  });
}

async function runMemoryAction(button, action, message) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "处理中…";
  try { await action(); await loadMemory(); toast(message); }
  catch (error) { toast("记忆操作没有完成：" + error.message); }
  finally { button.disabled = false; button.textContent = original; }
}

function conversationMediaFigure(media, attachments) {
  const figure = element("figure", "");
  const source = "/v4/media/" + encodeURIComponent(media.id);
  const preview = media.kind === "video" ? document.createElement("video") : document.createElement("img");
  preview.src = source;
  if (media.kind === "video") {
    preview.controls = true;
    preview.preload = "metadata";
    preview.setAttribute("playsinline", "");
  } else {
    preview.alt = "对话中上传的图片";
    preview.loading = "lazy";
  }
  preview.addEventListener("error", () => {
    preview.replaceWith(element("div", "media-unavailable", "媒体已过期或暂时无法读取"));
  }, { once: true });
  const frameCount = attachments.filter((item) => item.sourceMediaId === media.id).length;
  figure.append(preview, element("figcaption", "", media.kind === "video" ? "短视频 · " + frameCount + " 帧供 Friday 理解" : "图片"));
  return figure;
}

function renderComposerMedia() {
  const host = byId("composer-media");
  host.replaceChildren();
  const visible = appState.pendingMedia.filter((item) => item.role !== "video_frame");
  host.hidden = visible.length === 0;
  visible.forEach((media) => {
    const item = element("div", "composer-media-item");
    const preview = media.kind === "video" ? document.createElement("video") : document.createElement("img");
    preview.src = "/v4/media/" + encodeURIComponent(media.id);
    if (media.kind === "video") { preview.muted = true; preview.preload = "metadata"; }
    else preview.alt = "待发送图片";
    const remove = element("button", "", "×");
    remove.type = "button";
    remove.setAttribute("aria-label", "移除" + (media.kind === "video" ? "短视频" : "图片"));
    remove.addEventListener("click", () => removePendingMedia(media));
    item.append(preview, element("span", "", media.kind === "video" ? "短视频" : media.mimeType.replace("image/", "").toUpperCase()), remove);
    host.append(item);
  });
}

async function removePendingMedia(media) {
  const removed = appState.pendingMedia.filter((item) => item.id === media.id || item.sourceMediaId === media.id);
  appState.pendingMedia = appState.pendingMedia.filter((item) => !removed.includes(item));
  renderComposerMedia();
  try { await api("/v4/media/" + encodeURIComponent(media.id), { method: "DELETE" }); }
  catch (_) { /* Expiry performs the same private cleanup. */ }
}

async function uploadConversationMedia(blob, sourceMediaId) {
  const response = await fetch("/v4/media", {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "content-type": blob.type,
      "x-friday-csrf": csrfToken(),
      ...(sourceMediaId ? { "x-friday-source-media-id": sourceMediaId } : {})
    },
    body: blob
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) {
    const failure = new Error(value.error && value.error.message ? value.error.message : "媒体上传没有完成");
    failure.code = value.error && value.error.code ? value.error.code : "MEDIA_UPLOAD_FAILED";
    throw failure;
  }
  return value.media;
}

function waitForMedia(media, eventName) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("浏览器读取短视频超时")), 12000);
    const onSuccess = () => finish();
    const onError = () => finish(new Error("浏览器无法读取这个短视频格式"));
    media.addEventListener(eventName, onSuccess, { once: true });
    media.addEventListener("error", onError, { once: true });
    function finish(error) {
      clearTimeout(timer);
      media.removeEventListener(eventName, onSuccess);
      media.removeEventListener("error", onError);
      if (error) reject(error); else resolve();
    }
  });
}

async function canvasJpeg(canvas) {
  return new Promise((resolve, reject) => canvas.toBlob(
    (blob) => blob ? resolve(blob) : reject(new Error("浏览器没有生成视频代表帧")),
    "image/jpeg",
    .82
  ));
}

async function extractVideoFrames(file, frameLimit) {
  const source = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.preload = "auto";
  video.muted = true;
  video.setAttribute("playsinline", "");
  video.src = source;
  try {
    await waitForMedia(video, "loadedmetadata");
    if (!Number.isFinite(video.duration) || video.duration <= 0 || video.duration > 60) {
      throw new Error("短视频时长需要在 60 秒以内");
    }
    if (!video.videoWidth || !video.videoHeight) await waitForMedia(video, "loadeddata");
    const scale = Math.min(1, 1280 / video.videoWidth, 1280 / video.videoHeight);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("浏览器无法提取视频代表帧");
    const positions = [.08, .34, .66, .92].slice(0, frameLimit);
    const frames = [];
    for (const position of positions) {
      video.currentTime = Math.min(video.duration - .01, Math.max(.01, video.duration * position));
      await waitForMedia(video, "seeked");
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      frames.push(await canvasJpeg(canvas));
    }
    return frames;
  } finally {
    URL.revokeObjectURL(source);
    video.removeAttribute("src");
    video.load();
  }
}

async function addMediaFile(file) {
  const isImage = ["image/jpeg", "image/png", "image/webp", "image/gif"].includes(file.type);
  const isVideo = ["video/mp4", "video/webm", "video/quicktime"].includes(file.type);
  if (!isImage && !isVideo) throw new Error("仅支持 JPEG、PNG、WebP、GIF、MP4、WebM 或 QuickTime");
  if (isImage && file.size > 10 * 1024 * 1024) throw new Error("单张图片不能超过 10 MiB");
  if (isVideo && file.size > 40 * 1024 * 1024) throw new Error("短视频不能超过 40 MiB");
  if (isImage) {
    if (appState.pendingMedia.length >= 8) throw new Error("一条消息最多添加 8 个媒体项");
    appState.pendingMedia.push(await uploadConversationMedia(file));
    return;
  }
  const availableFrames = Math.min(4, 8 - appState.pendingMedia.length - 1);
  if (availableFrames < 1) throw new Error("请先移除部分附件，为视频代表帧留出空间");
  const frames = await extractVideoFrames(file, availableFrames);
  const video = await uploadConversationMedia(file);
  const uploaded = [video];
  try {
    for (const frame of frames) uploaded.push(await uploadConversationMedia(frame, video.id));
  } catch (error) {
    try { await api("/v4/media/" + encodeURIComponent(video.id), { method: "DELETE" }); } catch (_) {}
    throw error;
  }
  appState.pendingMedia.push(...uploaded);
}

byId("attach").addEventListener("click", () => byId("media-picker").click());
byId("media-picker").addEventListener("change", async (event) => {
  const files = Array.from(event.target.files || []);
  event.target.value = "";
  if (!files.length || appState.uploadInFlight) return;
  appState.uploadInFlight = true;
  byId("attach").disabled = true;
  byId("send").disabled = true;
  byId("composer-state").textContent = "正在安全处理媒体…";
  try {
    for (const file of files) await addMediaFile(file);
    renderComposerMedia();
  } catch (error) {
    toast("媒体没有添加：" + error.message);
  } finally {
    appState.uploadInFlight = false;
    byId("attach").disabled = false;
    byId("send").disabled = appState.sending;
    byId("composer-state").textContent = appState.talkActive ? "语音模式 · 浏览器语音服务" : "";
  }
});

async function submitConversation(text) {
  if (appState.sending || appState.uploadInFlight) throw new Error("上一条消息或媒体仍在处理中");
  const media = [...appState.pendingMedia];
  if (!text.trim() && !media.length) return null;
  appState.sending = true;
  byId("send").disabled = true;
  byId("attach").disabled = true;
  byId("composer-state").textContent = "Friday 正在处理…";
  setPresence("thinking", "正在整理上下文与下一步");
  try {
    const result = await post("/v4/conversations/" + encodeURIComponent(appState.conversationId) + "/messages", {
      messageId: crypto.randomUUID(), channel: "web", text,
      ...(media.length ? { mediaIds: media.map((item) => item.id) } : {})
    });
    const sentIds = new Set(media.map((item) => item.id));
    appState.pendingMedia = appState.pendingMedia.filter((item) => !sentIds.has(item.id));
    renderComposerMedia();
    await Promise.all([loadConversation(), loadJobs(), loadClearance(), loadMemory()]);
    return result;
  } finally {
    appState.sending = false;
    byId("send").disabled = false;
    byId("attach").disabled = false;
    byId("composer-state").textContent = appState.talkActive ? "语音模式 · 浏览器语音服务" : "";
    setPresence(appState.talkActive ? "listening" : "ready", appState.talkActive ? "可以继续说，开口即可打断" : "等你开口");
  }
}

byId("composer").addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = byId("message").value.trim();
  if (!text && !appState.pendingMedia.length) return;
  byId("message").value = "";
  resizeComposer();
  try {
    await submitConversation(text);
  } catch (error) {
    byId("message").value = text;
    toast(error.code === "AGENT_DISABLED" ? "Pi Agent 尚未启用，请检查 Hub 模型配置。" : "消息没有完成：" + error.message);
  } finally { byId("message").focus(); }
});

function resizeComposer() {
  // Modern browsers size this field through CSS field-sizing. Keeping the
  // hook makes the interaction harmless on older browsers without inline CSS.
}
byId("message").addEventListener("input", resizeComposer);
byId("message").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    byId("composer").requestSubmit();
  }
});

async function toggleRecordedVoice() {
  const button = byId("voice");
  if (appState.recorder && appState.recorder.state === "recording") {
    appState.recorder.stop();
    return;
  }
  if (!navigator.mediaDevices || !window.MediaRecorder) { toast("当前浏览器既不支持实时识别，也不支持录音回退。"); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    appState.voiceChunks = [];
    const recorder = new MediaRecorder(stream);
    appState.recorder = recorder;
    recorder.addEventListener("dataavailable", (event) => { if (event.data.size) appState.voiceChunks.push(event.data); });
    recorder.addEventListener("stop", async () => {
      stream.getTracks().forEach((track) => track.stop());
      button.classList.remove("is-recording");
      button.setAttribute("aria-label", "开启语音模式");
      button.setAttribute("aria-pressed", "false");
      button.textContent = "语音对话";
      byId("composer-state").textContent = "正在转写语音…";
      setPresence("thinking", "正在转写刚才的话");
      try {
        const blob = new Blob(appState.voiceChunks, { type: recorder.mimeType || "audio/webm" });
        const response = await fetch("/v2/voice/media", { method: "POST", credentials: "same-origin", headers: { "content-type": blob.type, "x-friday-csrf": csrfToken() }, body: blob });
        const media = await response.json();
        if (!response.ok) throw new Error(media.error && media.error.message ? media.error.message : "语音上传失败");
        const transcript = await post("/v2/voice/transcribe", { mediaId: media.media.id });
        const result = await submitConversation(transcript.text);
        if (result && result.turn && result.turn.assistantReply) await speakBrowser(plainTextFromMarkdown(result.turn.assistantReply));
      } catch (error) { toast("语音没有转写完成：" + error.message); }
      finally { byId("composer-state").textContent = ""; appState.recorder = null; setPresence("ready", "等你开口"); }
    });
    recorder.start();
    button.classList.add("is-recording");
    button.setAttribute("aria-label", "结束语音模式");
    button.setAttribute("aria-pressed", "true");
    button.textContent = "结束语音";
    byId("composer-state").textContent = "录音回退中，再按一次结束";
    setPresence("listening", "录音回退中，再按一次结束");
  } catch (error) { toast("无法使用麦克风，请检查浏览器权限。"); }
}

function recognitionConstructor() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

function stopLiveTalk() {
  appState.talkActive = false;
  clearTimeout(appState.talkTimer);
  appState.talkTimer = null;
  if (appState.recognition) {
    try { appState.recognition.stop(); } catch (_) {}
  }
  if (window.speechSynthesis) window.speechSynthesis.cancel();
  appState.speaking = false;
  const button = byId("voice");
  button.classList.remove("is-recording");
  button.setAttribute("aria-label", "开启语音模式");
  button.setAttribute("aria-pressed", "false");
  button.textContent = "语音对话";
  byId("composer-state").textContent = "";
  setPresence("ready", "等你开口");
}

function restartRecognition() {
  if (!appState.talkActive || !appState.recognition) return;
  setTimeout(() => {
    if (!appState.talkActive) return;
    try { appState.recognition.start(); } catch (_) { /* It may already be starting. */ }
  }, 250);
}

async function flushTalkTranscript() {
  clearTimeout(appState.talkTimer);
  appState.talkTimer = null;
  const text = appState.talkTranscript.trim();
  if (!text) return;
  if (appState.sending || appState.uploadInFlight) {
    appState.talkTimer = setTimeout(flushTalkTranscript, 500);
    return;
  }
  appState.talkTranscript = "";
  byId("message").value = "";
  try {
    const result = await submitConversation(text);
    if (appState.talkActive && result && result.turn && result.turn.assistantReply) {
      await speakBrowser(plainTextFromMarkdown(result.turn.assistantReply));
    }
  } catch (error) {
    appState.talkTranscript = text;
    byId("message").value = text;
    toast("语音模式没有完成：" + error.message);
  }
}

function configureRecognition(Recognition) {
  const recognition = new Recognition();
  recognition.lang = "zh-CN";
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;
  recognition.addEventListener("result", (event) => {
    let interim = "";
    let hasFinal = false;
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const transcript = event.results[index][0] ? event.results[index][0].transcript : "";
      if (event.results[index].isFinal) {
        appState.talkTranscript += (appState.talkTranscript ? " " : "") + transcript.trim();
        hasFinal = true;
      } else interim += transcript;
    }
    if (appState.speaking && (interim.trim() || hasFinal)) {
      window.speechSynthesis.cancel();
      appState.speaking = false;
      byId("composer-state").textContent = "已打断朗读，正在听…";
      setPresence("listening", "你已打断，我在听");
    }
    byId("message").value = [appState.talkTranscript, interim.trim()].filter(Boolean).join(" ");
    if (hasFinal) {
      clearTimeout(appState.talkTimer);
      appState.talkTimer = setTimeout(flushTalkTranscript, 850);
    }
  });
  recognition.addEventListener("end", restartRecognition);
  recognition.addEventListener("error", (event) => {
    if (event.error === "no-speech" || event.error === "aborted") return;
    if (event.error === "not-allowed" || event.error === "service-not-allowed") {
      stopLiveTalk();
      toast("浏览器没有获得麦克风或语音识别权限，请在站点设置中允许后重试。");
      return;
    }
    if (event.error === "network") toast("浏览器语音服务暂时不可达，Friday 会继续尝试重连。");
  });
  return recognition;
}

async function toggleLiveTalk() {
  if (appState.talkActive) { stopLiveTalk(); return; }
  const Recognition = recognitionConstructor();
  if (!Recognition) {
    toast("此浏览器没有连续语音识别，改用录音后转写。");
    await toggleRecordedVoice();
    return;
  }
  if (!appState.recognition) appState.recognition = configureRecognition(Recognition);
  appState.talkActive = true;
  appState.talkTranscript = "";
  const button = byId("voice");
  button.classList.add("is-recording");
  button.setAttribute("aria-label", "结束语音模式");
  button.setAttribute("aria-pressed", "true");
  button.textContent = "结束语音";
  byId("composer-state").textContent = "语音模式 · 正在听";
  setPresence("listening", "直接说话，停顿后自动发送");
  try { appState.recognition.start(); }
  catch (_) { restartRecognition(); }
}
byId("voice").addEventListener("click", toggleLiveTalk);

function speakBrowser(text) {
  if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) return Promise.resolve(false);
  window.speechSynthesis.cancel();
  return new Promise((resolve) => {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "zh-CN";
    utterance.rate = 1;
    utterance.pitch = 1;
    appState.currentUtterance = utterance;
    utterance.addEventListener("start", () => {
      appState.speaking = true;
      if (appState.talkActive) byId("composer-state").textContent = "Friday 正在说话 · 直接开口可打断";
      setPresence("speaking", appState.talkActive ? "直接开口可以打断" : "正在朗读回答");
    });
    const finish = () => {
      appState.speaking = false;
      if (appState.currentUtterance === utterance) appState.currentUtterance = null;
      if (appState.talkActive) byId("composer-state").textContent = "语音模式 · 浏览器语音服务";
      setPresence(appState.talkActive ? "listening" : "ready", appState.talkActive ? "可以继续说" : "等你开口");
      resolve(true);
    };
    utterance.addEventListener("end", finish, { once: true });
    utterance.addEventListener("error", finish, { once: true });
    window.speechSynthesis.speak(utterance);
  });
}

async function speakText(text, button) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "朗读中…";
  try {
    const spoken = await speakBrowser(text);
    if (!spoken) {
      button.textContent = "生成语音…";
      const result = await post("/v2/voice/synthesize", { text });
      const audio = new Audio("/v2/voice/media/" + encodeURIComponent(result.media.id));
      await audio.play();
    }
  } catch (error) { toast("语音朗读不可用：" + error.message); }
  finally { button.disabled = false; button.textContent = original; }
}

async function loadDevices() {
  try {
    const result = await api("/v1/runners");
    appState.runners = result.runners || [];
    renderDevices();
  } catch (error) { byId("device-list").replaceChildren(emptyRow("设备状态读取失败，请检查 Hub。")); }
}

function renderDevices() {
  const host = byId("device-list");
  host.replaceChildren();
  const online = appState.runners.filter((runner) => runner.online).length;
  byId("fleet-summary").textContent = "在线 " + online + " / " + appState.runners.length;
  byId("fleet-ribbon").textContent = appState.runners.length ? online + " / " + appState.runners.length + " 节点在线" : "尚未纳管节点";
  if (!appState.runners.length) {
    host.append(emptyAction("还没有纳管节点", "告诉 Friday 设备类型和用途，它会给出最短的 Runner 接入路径。", "让 Friday 帮我纳管", "帮我纳管一台设备。先问我必要信息，再给出最短、安全的 Runner 部署步骤。"));
    return;
  }
  appState.runners.forEach((runner) => {
    const row = element("article", "device-row");
    const identity = element("div", "device-identity");
    const dot = element("span", "status-dot" + (runner.online ? "" : " status-dot-danger"));
    const copy = element("div", "");
    copy.append(element("h2", "", runner.displayName || "未命名节点"), element("p", "", runner.online ? "在线 · 最近心跳 " + formatTime(runner.lastSeenAt) : "离线 · 最后心跳 " + formatTime(runner.lastSeenAt)));
    identity.append(dot, copy);
    const meta = element("div", "device-meta");
    meta.append(element("span", "", "Runner " + (runner.version || "未知版本") + " · 当前任务 " + (runner.activeJobs || 0)));
    const chips = element("div", "chip-row");
    (runner.workspaces || []).forEach((workspace) => chips.append(element("span", "chip", workspace)));
    (runner.capabilities || []).forEach((capability) => chips.append(element("span", "chip", capability)));
    meta.append(chips);
    row.append(identity, meta);
    host.append(row);
  });
}
byId("refresh-devices").addEventListener("click", () => Promise.all([loadDevices(), loadWechatStatus()]));

async function loadJobs() {
  try {
    const result = await api("/v2/jobs");
    appState.jobs = result.jobs || [];
    renderJobs();
    renderApprovals();
    updateCounts();
  } catch (error) { byId("task-list").replaceChildren(emptyRow("任务读取失败，请稍后刷新。")); }
}

function filteredJobs() {
  const filter = byId("task-filter").value;
  if (filter === "all") return appState.jobs;
  if (filter === "failed") return appState.jobs.filter((job) => job.status === "FAILED");
  return appState.jobs.filter((job) => !terminalStates.has(job.status));
}

function jobRow(job, approvalOnly) {
  const row = element("article", approvalOnly ? "approval-row" : "ledger-row");
  const main = element("div", approvalOnly ? "approval-copy" : "ledger-main");
  const title = element("div", "ledger-title");
  title.append(element("h2", "", (toolLabels[job.tool] || job.tool) + " · " + job.operation), statusChip(job.status), approvalChip(job.risk));
  main.append(title, element("p", "ledger-meta", job.workspaceId + " · 任务 " + shortId(job.jobId) + " · 节点 " + shortId(job.runnerId) + " · " + formatTime(job.updatedAt)));
  if (approvalOnly) main.append(element("p", "", "我会在受控节点执行这项任务。确认后才会开始。"));
  const actions = element("div", approvalOnly ? "approval-actions" : "ledger-actions");
  if (job.status === "WAIT_APPROVAL" && job.risk === "R1") {
    const approve = element("button", "button button-primary", "授权并执行");
    approve.type = "button";
    approve.addEventListener("click", () => runAction(approve, () => post("/v2/jobs/" + job.jobId + "/approve", {}), "任务已授权并派发"));
    actions.append(approve);
  }
  if (!["SUCCEEDED", "FAILED", "CANCELLED", "WAIT_APPROVAL"].includes(job.status)) {
    const stop = element("button", "button button-quiet", "停止任务");
    stop.type = "button";
    stop.addEventListener("click", () => runAction(stop, () => post("/v2/jobs/" + job.jobId + "/stop", {}), "任务已停止"));
    actions.append(stop);
  }
  row.append(main, actions);
  return row;
}

function renderJobs() {
  const host = byId("task-list");
  host.replaceChildren();
  const jobs = filteredJobs();
  if (!jobs.length) {
    if (byId("task-filter").value === "active") host.append(emptyAction("现在没有进行中的任务", "从对话开始即可。Friday 会选择合适节点并把过程留在这里。", "回到对话", ""));
    else host.append(emptyRow("没有符合条件的任务。"));
    return;
  }
  jobs.forEach((job) => host.append(jobRow(job, false)));
}
byId("task-filter").addEventListener("change", renderJobs);
byId("refresh-tasks").addEventListener("click", loadJobs);

async function runAction(button, action, successMessage) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "正在处理…";
  try { await action(); toast(successMessage); await Promise.all([loadJobs(), loadClearance(), loadConversation()]); }
  catch (error) { toast("操作没有完成：" + error.message); }
  finally { button.disabled = false; button.textContent = original; }
}

async function loadClearance() {
  try {
    const [result, nodeTools] = await Promise.all([api("/v4/self-improvements"), api("/v2/node-tool-approvals")]);
    appState.improvements = result.improvements || [];
    appState.nodeToolApprovals = nodeTools.approvals || [];
    renderApprovals();
    renderImprovements();
    renderConversation(appState.conversationTurns);
    updateCounts();
  } catch (error) { byId("improvement-list").replaceChildren(emptyRow("自我迭代记录读取失败，请稍后刷新。")); }
}

function renderApprovals() {
  const host = byId("approval-list");
  host.replaceChildren();
  const pending = appState.jobs.filter((job) => job.status === "WAIT_APPROVAL" && job.risk === "R1");
  (appState.nodeToolApprovals || []).forEach((item) => {
    const row = element("article", "approval-row");
    const copy = element("div", "approval-copy");
    const title = element("div", "ledger-title");
    title.append(element("h3", "", nodeToolLabels[item.call.name] || item.call.name), statusChip("WAIT_APPROVAL"), approvalChip(item.risk));
    copy.append(title, element("p", "ledger-meta", "任务 " + shortId(item.call.jobId) + " · 调用 " + shortId(item.call.callId)));
    const context = element("div", "approval-context");
    context.append(contextItem("要做什么", item.call.reason), contextItem("执行位置", "受控节点"));
    copy.append(context);
    const actions = element("div", "approval-actions");
    const approve = element("button", "button button-primary", "确认并继续");
    approve.type = "button";
    approve.addEventListener("click", () => runAction(approve, () => post("/v2/node-tool-approvals/" + item.call.callId + "/approve", {}), "节点工具调用已授权"));
    actions.append(approve);
    row.append(copy, actions);
    host.append(row);
  });
  if (!pending.length && !(appState.nodeToolApprovals || []).length) { host.append(emptyRow("当前没有等待授权的设备任务。")); return; }
  pending.forEach((job) => host.append(jobRow(job, true)));
}

function contextItem(label, text) {
  const node = element("div", "");
  node.append(element("strong", "", label), element("span", "", text || "—"));
  return node;
}

function renderImprovements() {
  const host = byId("improvement-list");
  host.replaceChildren();
  const active = appState.improvements.filter((item) => !["ADOPTED", "DEPLOYED", "ROLLED_BACK", "FAILED"].includes(item.state));
  const adopted = appState.improvements.filter((item) => item.state === "ADOPTED").length;
  const waiting = appState.improvements.filter((item) => item.state === "WAIT_APPROVAL").length;
  byId("growth-summary").textContent = waiting ? waiting + " 项重大迭代待确认" : active.length ? active.length + " 项迭代进行中" : adopted ? adopted + " 项简单迭代已采纳" : "随使用持续改进";
  byId("growth-detail").textContent = waiting ? "有重大变化需要你确认。" : active.length ? "Friday 正在隔离修改或验证，简单迭代完成后只汇报 brief。" : adopted ? "已进入下一次受控发布候选，不需要你授权。" : "还没有可见的改进记录。";
  if (!appState.improvements.length) { host.append(emptyRow("还没有自我迭代候选。Friday 会自行完成低风险的隔离修改和测试，重大变化才请求授权。")); return; }
  appState.improvements.forEach((item) => {
    const row = element("article", "approval-row");
    const copy = element("div", "approval-copy");
    const title = element("div", "ledger-title");
    title.append(element("h3", "", item.title), statusChip(item.state));
    if (item.clearance && item.clearance.risk) title.append(element("span", "risk-chip", item.clearance.risk));
    copy.append(title, element("p", "ledger-meta", item.category + " · " + shortId(item.id) + (item.sourceJobId ? " · 来源任务 " + shortId(item.sourceJobId) : "")));
    const context = element("div", "approval-context");
    context.append(contextItem("背景", item.background), contextItem("收益", item.expectedBenefit), contextItem("回滚", item.rollbackPlan));
    copy.append(context);
    if (item.state === "ADOPTED") copy.append(element("p", "ledger-meta", "Friday 已根据可信测试结果自动采纳。这项简单迭代无需授权，将进入下一次受控发布；当前生产版本尚未变化。"));
    const actions = element("div", "approval-actions");
    if (item.state === "TESTED" && item.clearanceRequired !== false) {
      const request = element("button", "button button-secondary", "生成确认请求");
      request.type = "button";
      request.addEventListener("click", () => runAction(request, () => post("/v4/self-improvements/" + item.id + "/clearance-request", {}), "确认请求已生成，请核对后授权"));
      actions.append(request);
    }
    if (item.state === "WAIT_APPROVAL" && item.clearance) {
      const grant = element("button", "button button-primary", "确认并继续");
      grant.type = "button";
      grant.addEventListener("click", () => runAction(grant, () => post("/v4/self-improvements/" + item.id + "/clearance-grant", { clearanceId: item.clearance.clearanceId }), "已确认"));
      actions.append(grant);
    }
    if (item.state === "CLEARED" && item.clearance) {
      const canary = element("button", "button button-primary", "启动小流量验证");
      canary.type = "button";
      canary.addEventListener("click", () => runAction(canary, () => post("/v4/self-improvements/" + item.id + "/canary", { clearanceId: item.clearance.clearanceId, canaryId: crypto.randomUUID() }), "小流量验证已启动"));
      actions.append(canary);
    }
    row.append(copy, actions);
    host.append(row);
  });
}
byId("refresh-clearance").addEventListener("click", () => Promise.all([loadJobs(), loadClearance()]));

function updateCounts() {
  const tasks = appState.jobs.filter((job) => !terminalStates.has(job.status)).length;
  const clearance = appState.jobs.filter((job) => job.status === "WAIT_APPROVAL" && job.risk === "R1").length + (appState.nodeToolApprovals || []).length + appState.improvements.filter((item) => item.state === "WAIT_APPROVAL" || item.state === "CLEARED" || (item.state === "TESTED" && item.clearanceRequired !== false)).length;
  [["task-count", tasks], ["clearance-count", clearance]].forEach(([id, count]) => {
    const node = byId(id);
    node.textContent = String(count);
    node.hidden = count === 0;
  });
}

async function loadWechatStatus() {
  const header = byId("wechat-header-state");
  const dot = byId("wechat-dot");
  const detail = byId("wechat-detail");
  try {
    const result = await api("/v4/channels/wechat-ilink/status");
    if (result.configured === false) {
      header.textContent = "微信未配置";
      dot.className = "status-dot status-dot-muted";
      detail.replaceChildren(element("p", "", "Hub 尚未配置 iLink Channel Gateway。配置后可在这里扫码绑定。"));
      byId("wechat-bind").disabled = true;
      return;
    }
    byId("wechat-bind").disabled = false;
    const connected = result.connected === true || result.status === "confirmed";
    header.textContent = connected ? "微信已连接" : "微信未连接";
    dot.className = "status-dot" + (connected ? "" : " status-dot-warning");
    detail.replaceChildren(element("p", "", connected ? "已绑定。微信私聊消息会进入主对话，群聊、未配对发送者和重复消息会被拒绝。" : "当前未绑定。扫码后可直接在微信私聊 Friday。"));
    byId("wechat-bind").textContent = connected ? "重新扫码绑定" : "扫码绑定";
  } catch (error) {
    header.textContent = error.code === "CHANNEL_GATEWAY_DISABLED" ? "微信未配置" : "微信状态不可用";
    dot.className = "status-dot status-dot-danger";
    detail.replaceChildren(element("p", "", "无法读取 iLink Gateway 状态。请检查 Hub 上的 Channel Gateway。"));
  }
}
byId("wechat-refresh").addEventListener("click", loadWechatStatus);

byId("wechat-bind").addEventListener("click", async () => {
  const button = byId("wechat-bind");
  button.disabled = true;
  try {
    const result = await post("/v4/channels/wechat-ilink/login", {});
    appState.pairingId = result.loginId;
    byId("wechat-qr").src = result.qrDataUrl;
    byId("wechat-pairing").hidden = false;
    byId("wechat-pair-state").textContent = "请使用微信扫码确认";
    pollPairing();
  } catch (error) { toast("无法生成微信二维码：" + error.message); }
  finally { button.disabled = false; }
});

async function pollPairing() {
  clearTimeout(appState.pairingTimer);
  if (!appState.pairingId) return;
  try {
    const result = await api("/v4/channels/wechat-ilink/login/" + appState.pairingId);
    const labels = { wait: "等待扫码", scaned: "已扫码，请在微信确认", need_verifycode: "微信要求填写数字配对码", confirmed: "绑定完成", expired: "二维码已过期", verify_code_blocked: "配对码错误次数过多", binded_redirect: "该账号已绑定其他入口" };
    byId("wechat-pair-state").textContent = labels[result.status] || "正在确认绑定状态";
    byId("wechat-code-form").hidden = result.status !== "need_verifycode";
    if (result.status === "confirmed") {
      appState.pairingId = null;
      byId("wechat-pairing").hidden = true;
      toast("微信 iLink 已绑定");
      await loadWechatStatus();
      return;
    }
    if (["expired", "verify_code_blocked", "binded_redirect"].includes(result.status)) { appState.pairingId = null; return; }
    appState.pairingTimer = setTimeout(pollPairing, 1800);
  } catch (error) {
    byId("wechat-pair-state").textContent = "状态读取失败，正在重试";
    appState.pairingTimer = setTimeout(pollPairing, 3000);
  }
}

byId("wechat-code-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!appState.pairingId) return;
  const code = byId("wechat-code").value.trim();
  if (!/^\d{1,12}$/.test(code)) { toast("请输入微信显示的数字配对码。"); return; }
  try {
    await post("/v4/channels/wechat-ilink/login/" + appState.pairingId + "/verify", { code });
    byId("wechat-code").value = "";
    byId("wechat-pair-state").textContent = "配对码已提交，请在微信确认";
    pollPairing();
  } catch (error) { toast("配对码没有提交：" + error.message); }
});

let eventSource;
function startEventStream() {
  if (eventSource) eventSource.close();
  eventSource = new EventSource("/v2/events");
  eventSource.addEventListener("message", (event) => {
    try {
      const data = JSON.parse(event.data);
      if (Array.isArray(data.jobs)) {
        appState.jobs = data.jobs;
        renderJobs(); renderApprovals(); updateCounts();
      }
    } catch (_) { /* Ignore malformed progress events; API refresh remains available. */ }
  });
  eventSource.addEventListener("error", () => {
    setHubConnection("reconnecting");
  });
  eventSource.addEventListener("open", () => {
    setHubConnection("online");
  });
}

addEventListener("pagehide", () => {
  if (eventSource) eventSource.close();
  clearTimeout(appState.pairingTimer);
  clearTimeout(appState.talkTimer);
  try { appState.recognition?.abort(); } catch { /* Browser recognition may already be closed. */ }
  try { speechSynthesis.cancel(); } catch { /* Speech synthesis is optional. */ }
});

void boot();`;
