/* /assets-usage：本机资产库磁盘用量（只读，不写不删）。 */
'use strict';
const { sendJson, fail } = require('./http.js');
function createUsageRoutes(ctx) {
  const localUsageScan = ctx.localUsageScan;
  async function handleUsage(req, res, dataPath) {
    if (dataPath === '/assets-usage' && req.method === 'GET') {
      try {
        const u = await localUsageScan();
        sendJson(res, 200, u);
      } catch (e) {
        fail(res, 500, '数不出本机资产库：' + ((e && e.message) || e));
      }
      return;
    }
    return false;
  }
  return { handleUsage };
}
module.exports = { createUsageRoutes };
