// Vercel entry point: the whole Express server (server/index.js) runs as one function.
// vercel.json sends every /api/* request here; the React build is served as static files.
module.exports = require('../server/index.js');
