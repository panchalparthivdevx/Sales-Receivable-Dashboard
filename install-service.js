const Service = require('node-windows').Service;
const path = require('path');

const svc = new Service({
  name: 'DevAccelerator-Dashboard-Backend',
  description: 'Sales & Receivable Dashboard Backend (Node.js/Express)',
  script: path.join(__dirname, 'server', 'index.js'),
  nodeOptions: [],
  workingDirectory: __dirname,
  allowServiceLogon: true,
});

svc.on('install', () => {
  svc.start();
  console.log('Backend service installed and started.');
  console.log('It will auto-start on every Windows reboot.');
});

svc.on('error', (err) => console.error('Service error:', err));

svc.install();
