const Service = require('node-windows').Service;
const path = require('path');

const svc = new Service({
  name: 'DevAccelerator-Dashboard-Backend',
  script: path.join(__dirname, 'server', 'index.js'),
});

svc.on('uninstall', () => console.log('Backend service removed.'));
svc.uninstall();
