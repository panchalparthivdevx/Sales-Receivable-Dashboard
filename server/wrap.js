process.on('uncaughtException', e => { process.stderr.write('UNCAUGHT: ' + e.stack + '\n'); });
process.on('unhandledRejection', (r,p) => { process.stderr.write('UNHANDLED: ' + (r?.stack || r) + '\n'); });
require('./index.js');
