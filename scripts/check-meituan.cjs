// Check Meituan tab content using CDP JSON API
const http = require('http');

const tabId = 'ED4D05B10F9D2BDD28AE7FA008F0811D';

// First get the webSocketDebuggerUrl
http.get(`http://127.0.0.1:18800/json`, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    const tabs = JSON.parse(data);
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) {
      console.log('Tab not found');
      return;
    }
    console.log('Tab:', tab.title);
    console.log('WebSocket URL:', tab.webSocketDebuggerUrl);

    // Connect via WebSocket
    const WebSocket = require('ws');
    const ws = new WebSocket(tab.webSocketDebuggerUrl);

    ws.on('open', () => {
      console.log('Connected!');
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.enable' }));
    });

    ws.on('message', (msg) => {
      const parsed = JSON.parse(msg.toString());
      if (parsed.id === 1 && parsed.result?.result?.value) {
        console.log('Page loaded');
        // Now evaluate our script
        const expr = `(() => {
          let doc = null;
          try {
            const f = document.querySelector('iframe[name="chat"]') || document.querySelector('iframe');
            if (f) doc = f.contentDocument || f.contentWindow.document;
          } catch(e) {}
          if (!doc) doc = document;
          const items = Array.from(doc.querySelectorAll('.chat-list-item'));
          const rows = [];
          for (let i = 0; i < items.length; i++) {
            const el = items[i];
            const nameEl = el.querySelector('.userinfo-username, [class*="username"]');
            const name = ((nameEl && nameEl.innerText) || '').trim();
            const lastEl = el.querySelector('.userinfo-lastchat, [class*="lastchat"]');
            const last = ((lastEl && lastEl.innerText) || '').trim().slice(0, 50);
            const badge = el.querySelector('.mtd-badge-text');
            const unread = badge ? parseInt(badge.innerText) || 0 : 0;
            rows.push({ index: i, name, last, unread });
          }
          return { rowCount: items.length, rows };
        })()`;
        ws.send(JSON.stringify({ id: 2, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }));
      }
      if (parsed.id === 2 && parsed.result?.result?.value) {
        console.log('\n=== Meituan Chat List ===');
        console.log(JSON.stringify(parsed.result.result.value, null, 2));
        ws.close();
      }
    });

    ws.on('error', (e) => console.error('WS Error:', e.message));
    setTimeout(() => { ws.close(); process.exit(0); }, 8000);
  });
});
