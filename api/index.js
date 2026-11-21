// Entry cho Vercel Serverless Function — mọi request /api/* được rewrite về đây (xem vercel.json)
const { handleApi } = require('../lib/api');

module.exports = (req, res) => handleApi(req, res);
