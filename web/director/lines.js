/* 台词清单：剪辑右栏「台词」那一档的唯一渲染（本镜台词 + 全片台词两段共用这一份）。
   一行 = 一镜的一句台词；数据仍是 sh.line / sh.lineWho，这里不新增模型、不写数据。 */

const secTxt = v => String(Math.round((Number(v) || 0) * 10) / 10);

/* 说话人 → 素材库那一位（按名字认，与音色描述 / 参考音频同一个判据）。
   素材库里没有也把名字原样带回来 —— 界面写「不在素材库」，不吞掉用户写的名字。 */
export function speakerOf(who, lib) {
  const name = String(who || '').replace(/\s+/g, ' ').trim();
  if (!name) return { name: '', img: '', inLib: false, empty: true };
  const item = (lib || []).find(x => String((x && x.name) || '').trim() === name);
  return {
    name,
    img: item ? String(item.anchor || item.face || item.img || '') : '',
    inLib: !!item,
    empty: false,
  };
}

/* 两个读数：本镜那一排（这一镜自己的轴秒）与全片那一排（成片秒）。
   调用方把两条轨上算好的 `lineSpanAt` 结果交进来（与轨道上那两个待生成占位同一份算式）；
   算不出来的那一档照实说「没有位置」，不拿 0 冒充起点。 */
export function lineTimeOf(o) {
  const shot = o && o.shot, film = o && o.film;
  const span = r => secTxt(r.at) + '–' + secTxt(r.at + r.len) + ' 秒';
  const why = [];
  if (!shot) why.push('这一镜还没有画面段：本镜那一排没有可摆的位置');
  if (!film) why.push('这一镜还没进成片：全片那一排（成片秒）没有可摆的位置');
  return {
    shotText: shot ? '本镜 ' + span(shot) : '本镜 —',
    filmText: film ? '全片 ' + span(film) : '全片 —',
    title: (why.join('；') || '长按字数估（合成后以真实音频为准）：本镜那一排是本镜轴秒，全片那一排是成片秒'),
  };
}

/* 一行台词：头像 + 说话人 + 状态徽章 + 镜号 / 本镜 / 全片三格读数 + 台词输入框。
   两格输入都直接写调用方交给它的那一份 `row.sh`（binder 在 engine.js，这里只画不改）。 */
export function lineRowHTML(row, o) {
  const esc = o.esc;
  const sp = row.speaker;
  const thumb = sp.img
    ? `<img src="${esc(o.mediaSrc(sp.img))}" alt="" loading="lazy">`
    : `<span class="lr-ph">${o.icon('user', 14)}</span>`;
  const name = sp.empty ? '未写说话人' : sp.name;
  const note = sp.empty ? '' : (sp.inLib ? '' : ' · 不在素材库');
  /* 「未写 / 待生成 / 已生成」现判：有字才算写过，待生成用的是轨道上那一份 `pendingLineOf` 的结果，
     这一格不另记状态（另记一份就会和轨道上的斜纹占位说出不一样的一句话）。 */
  const empty = !String(row.text || '').trim();
  const state = empty ? 'none' : (row.pending ? 'pend' : 'done');
  const stateTxt = empty ? '未写' : (row.pending ? '待生成' : '已生成');
  /* 说话的人只有这一件控件：名字本身就是输入框（素材库同名项从这个 datalist 选），缩略图跟着名字换。 */
  return `<div class="line-row edit${row.mine ? ' on' : ''}" data-lineshot="${esc(row.sh.id)}"
    title="${esc('第 ' + row.no + ' 镜' + (row.time.title ? ' · ' + row.time.title : '') + (o.clickHint ? '。' + o.clickHint : ''))}">
    <div class="lr-thumb${sp.img ? '' : ' ph'}" title="${esc(name + note)}">${thumb}</div>
    <div class="lr-body">
      <div class="lr-top">
        <input class="ui-inp lr-name" data-line-who="${esc(row.sh.id)}" list="lineWhoList" value="${esc(row.who)}"
          placeholder="说话的人" title="填素材库里同名的素材，音色会自动取过来">
        <em class="${state}">${stateTxt}</em>
      </div>
      <div class="lr-when"><span>第 ${row.no} 镜</span><span>${esc(row.time.shotText)}</span><span>${esc(row.time.filmText)}</span></div>
      <textarea class="ui-ta lr-ta" rows="1" data-line-text="${esc(row.sh.id)}" placeholder="这一镜要念出来的台词">${esc(row.text)}</textarea>
    </div>
  </div>`;
}
