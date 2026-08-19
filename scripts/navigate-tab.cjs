// Navigate CDP tab using Page.navigate
const http = require('http');

const tabId = 'ED4D05B10F9D2BDD28AE7FA008F0811D';
const targetUrl = 'https://g.dianping.com/dzim-main-pc/index.html#/';

// First activate the target
const activateBody = JSON.stringify({ targetId: tabId });
const activateReq = http.request({
  hostname: '127.0.0.1',
  port: 18800,
  path: '/json/activate',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(activateBody)
  }
}, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => console.log('Activate result:', data));
});
activateReq.on('error', e => console.error('Activate error:', e.message));
activateReq.write(activateBody);
activateReq.end();
