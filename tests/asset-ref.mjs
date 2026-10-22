#!/usr/bin/env node
/* AssetRef（web/domain/asset-ref.cjs）的纯逻辑：
     · set 只写白名单字段（DOM 节点 / 函数不能进 dataTransfer），两种 MIME 一起写；
     · read 认 JSON 与老载荷（只剩 application/x-asset-id）两种，坏 JSON 回 null 不抛；
     · isRef 只看类型；label 的拼装只有这一份（输入框标记与清单共用）。
   模块是 UMD + .cjs，Node 侧**只能默认导入** —— 写成具名导入会拿到空，这条也钉在这里。 */
import AssetRef from '../web/domain/asset-ref.cjs';

let bad = 0, checks = 0;
function ok(name, cond, detail) {
  checks++;
  if (cond) { console.log('  ✓ ' + name); return; }
  bad++;
  console.log('  ✗ ' + name + (detail ? ' —— ' + detail : ''));
}

/* 假 dataTransfer：只需要 setData / getData / types / effectAllowed 四样。 */
function fakeDT() {
  const m = new Map();
  return {
    effectAllowed: '',
    get types() { return [...m.keys()]; },
    setData(t, v) { m.set(String(t), String(v)); },
    getData(t) { return m.has(String(t)) ? m.get(String(t)) : ''; },
  };
}

ok('模块默认导入拿到 set / read / isRef / label',
  !!AssetRef && ['set', 'read', 'isRef', 'label'].every(k => typeof AssetRef[k] === 'function'));
ok('MIME 名是这两个（页面与判据都读它，不在别处再写一遍）',
  AssetRef.MIME === 'application/x-studio-ref' && AssetRef.MIME_ID === 'application/x-asset-id');

const full = {
  kind: 'asset', id: 'x1', name: '海边日落', type: '图片', assetId: 'a_1',
  src: '/asset/la_123?token=abcdefghijklmnopqrstuvwxyz', dl: '/getv?url=x',
  prompt: '夕阳下的海边', from: 'assets', taskId: 't_9', model: 'm1', provider: 'vgenv',
  credits: { charged: 3, held: 5 }, ts: 1700000000000, size: 1024,
  node: { not: 'a string' }, fn() {}, note: '不该进载荷',
};

const dt = fakeDT();
const wrote = AssetRef.set(dt, full);
ok('set 返回实际写进去的那一份（只按白名单收字段）',
  !!wrote && wrote.assetId === 'a_1' && wrote.prompt === '夕阳下的海边' && wrote.from === 'assets');
ok('对象 / 函数 / 白名单外的字段都不进载荷',
  wrote.node === undefined && wrote.fn === undefined && wrote.note === undefined);
ok('积分对象折成一个数（不是把对象塞进 dataTransfer）', wrote.credits === 3);
ok('两种 MIME 都写了，types 里都看得到',
  dt.types.indexOf(AssetRef.MIME) >= 0 && dt.types.indexOf(AssetRef.MIME_ID) >= 0);
ok('纯文本那一档写地址或名字（拖到地址栏 / 编辑器时给人看）',
  dt.getData('text/plain') === full.src);
ok('effectAllowed 标成 copy', dt.effectAllowed === 'copy');

const back = AssetRef.read(dt);
ok('read 读回同一份载荷', !!back && back.assetId === 'a_1' && back.prompt === '夕阳下的海边');
ok('src 原样保留、不截断（截了助手拿到的是打不开的地址）', back && back.src === full.src);
ok('isRef 认这两种 MIME', AssetRef.isRef(dt));
const plain = fakeDT();
plain.setData('text/plain', '一段普通文字');
ok('只有 text/plain 不算引用', !AssetRef.isRef(plain) && AssetRef.read(plain) === null);
const files = { types: ['Files'], getData: () => '' };
ok('外部文件拖动不算引用', !AssetRef.isRef(files));

const old = fakeDT();
old.setData(AssetRef.MIME_ID, 'la_abc');
const ob = AssetRef.read(old);
ok('老载荷（只有资产号）也认，本机号换成 /asset/ 地址',
  !!ob && ob.assetId === 'la_abc' && ob.src === '/asset/la_abc');
const oldCloud = fakeDT();
oldCloud.setData(AssetRef.MIME_ID, 'up_77');
const cb = AssetRef.read(oldCloud);
ok('平台号只留号、不硬拼 /asset/（那条路由只服务本机产物）',
  !!cb && cb.assetId === 'up_77' && cb.src === '');

const broken = fakeDT();
broken.setData(AssetRef.MIME, '{不是 JSON');
ok('坏 JSON 回 null，不抛', AssetRef.read(broken) === null);
ok('没给 dataTransfer 也回 null / false',
  AssetRef.read(null) === null && AssetRef.isRef(null) === false);

ok('label：提示词优先、类型跟在后面、资产号在括号里',
  AssetRef.label({ prompt: '夕阳下的海边', type: '图片', assetId: 'a_1' }) === '夕阳下的海边 · 图片（资产 a_1）');
ok('label：本机文件与任务号各是一种括号（资产号优先）',
  AssetRef.label({ name: '某文件', fileKey: 'f_1' }) === '某文件（本机文件 f_1）'
  && AssetRef.label({ name: '某任务', taskId: 't_1' }) === '某任务（任务 t_1）'
  && AssetRef.label({ name: '都有', taskId: 't_1', assetId: 'a_1' }) === '都有（资产 a_1）');
ok('label：长提示词只在显示这一层截断（载荷里仍是完整的）',
  AssetRef.label({ prompt: 'x'.repeat(80) }).indexOf('x'.repeat(48) + '…') === 0);
ok('label：什么都没有时给空串', AssetRef.label({}) === '');

console.log(bad ? `\n素材引用载荷判据：${bad}/${checks} 条红` : `\n素材引用载荷判据：${checks}/${checks} 全绿`);
process.exit(bad ? 1 : 0);
