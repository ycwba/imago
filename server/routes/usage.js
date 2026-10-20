/* /assets-usage：本机资产库磁盘用量（只读，不写不删）。 */
'use strict';
function createUsageRoutes(ctx) {
  const localUsageScan = ctx.localUsageScan;
  async function handleUsage(req, res, dataPath) {
    if (dataPath === '/assets-usage' && req.method === 'GET') {
      try {
        const u = await localUsageScan();
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(u));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: { message: '数不出本机资产库：' + ((e && e.message) || e) } }));
      }
      return;
    }
    return false;
  }
  return { handleUsage };
}
module.exports = { createUsageRoutes };
