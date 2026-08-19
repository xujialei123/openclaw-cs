// Check all CDP tabs
const http = require('http');
const WebSocket = require('ws');

http.get('http://127.0.0.1:18800/json', (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', async () => {
    const tabs = JSON.parse(data);
    console.log('=== CDP Tabs ===');
    for (const tab of tabs) {
      if (tab.type !== 'page') continue;
      console.log(`\nTab ID: ${tab.id}`);
      console.log(`Title: ${tab.title}`);
      console.log(`URL: ${tab.url.substring(0, 100)}...`);

      // Connect and check content
      const ws = new WebSocket(tab.webSocketDebuggerUrl);
      await new Promise((resolve) => {
        ws.on('open', () => {
          ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
            expression: `() => ({ rowCount: document.querySelectorAll('[class*="contactCard"], [class*="ContactCard"], .chat-list-item').length, text: document.body?.innerText?.slice(0, 200) })`,
            returnByValue: true
          }}));
        });
        ws.on('message', (msg) => {
          const parsed = JSON.parse(msg.toString());
          if (parsed.id === 1) {
            console.log(`Content: ${JSON.stringify(parsed.result?.result?.value)}`);
            ws.close();
            resolve();
          }
        });
        setTimeout(() => { ws.close(); resolve(); }, 3000);
      });
    }
  });
});
