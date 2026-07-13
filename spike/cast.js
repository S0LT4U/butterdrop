// Spike helper: cast the receiver page to the TV, reusing the hardened
// CastSession from the main app. Usage: node spike/cast.js
const os = require('os');
const cast = require('../castclient');

function lanIp() {
  const cands = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) continue;
      let score = 0;
      if (/vethernet|wsl|virtual|loopback|bluetooth|vmware|hyper-v|npcap|vpn/i.test(name)) score -= 10;
      if (a.address.startsWith('192.168.')) score += 5;
      cands.push({ ip: a.address, score });
    }
  }
  cands.sort((x, y) => y.score - x.score);
  return cands.length ? cands[0].ip : 'localhost';
}

(async () => {
  const url = `http://${lanIp()}:8730/receiver`;
  console.log('Discovering cast devices…');
  const devices = await cast.discover(4000);
  if (!devices.length) {
    console.error('No cast devices found.');
    process.exit(1);
  }
  const device = devices[0];
  console.log(`Casting ${url} -> ${device.name} (${device.host})`);
  const session = new cast.CastSession(device.host);
  session.on('error', (e) => console.error('cast error:', e.message));
  session.on('closed', () => console.log('cast session closed'));
  await session.launch(`${url}?r=${Date.now()}`, () => false);
  console.log('Launched. Watch the TV; leave this running to keep the session.');
})();
