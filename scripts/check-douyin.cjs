// Check Douyin tab content via CDP
const http = require('http');
const WebSocket = require('ws');

const tabId = '5E6373A24901FE8558A1970044BD8FDD';
const wsUrl = 'ws://127.0.0.1:18800/devtools/page/' + tabId;

const ws = new WebSocket(wsUrl);
let id = 0;

ws.on('open', () => {
  console.log('Connected to Douyin tab');
  // Enable domains
  ws.send(JSON.stringify({ id: ++id, method: 'Page.enable' }));
  ws.send(JSON.stringify({ id: ++id, method: 'Runtime.enable' }));
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());

  if (msg.id === 10 && msg.result?.result?.value) {
    console.log('\n=== Douyin Page Info ===');
    const info = msg.result.result.value;
    console.log('Href:', info.href);
    console.log('Row count:', info.rowCount);
    console.log('Titles:', JSON.stringify(info.titles?.slice(0, 10)));
    console.log('\nBody text preview:', info.text?.slice(0, 300));
    ws.close();
  }

  if (msg.method === 'Page.loadEventFired') {
    console.log('Page loaded, running diagnostics...');
    setTimeout(() => runDiagnostics(), 500);
  }
});

function runDiagnostics() {
  const expr = `(() => {
    const rows = document.querySelectorAll('[class*="contactCard"], [class*="ContactCard"], .chat-list-item, [class*="chat-list"]');
    return {
      rowCount: rows.length,
      href: location.href,
      titles: Array.from(rows).map(r => r.innerText?.trim()?.slice(0, 50)),
      bodyText: (document.body?.innerText || '').slice(0, 300),
      classes: Array.from(document.querySelectorAll('*'))
        .map(el => String(el.className || ''))
        .filter(c => c.includes('contact') || c.includes('chat') || c.includes('list'))
        .slice(0, 10)
    };
  })()`;

  ws.send(JSON.stringify({ id: 10, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }));
}

ws.on('error', (e) => console.error('WS Error:', e.message));
