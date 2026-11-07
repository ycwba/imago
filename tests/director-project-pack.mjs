#!/usr/bin/env node
/* 导演台「项目文件」判据：完整工程往返、格式闸门（含零写入）、校验和、导入归一化。
   纯件在 web/director/project-pack.js；engine 那一侧只负责下载 / 取文件 / 放回工作区，
   这里的每一条都不需要浏览器。 */
import assert from 'node:assert/strict';
import {
  PROJECT_PACK_TYPE, PROJECT_PACK_VERSION, projectPackChecksum,
  buildProjectPack, assertProjectPack, describeProjectPack, prepareProjectPackImport,
  projectPackStats, projPackFingerprint, scanProjectPackConflicts, projectPackMedia,
} from '../web/director/project-pack.js';

let n = 0;
const ok = (cond, msg) => { n++; assert.ok(cond, msg); };
const throws = (fn, re, msg) => { n++; assert.throws(fn, e => re.test(String(e && e.message)), msg); };

/* 一份「什么都有」的短片：没选用的 / 失败的 / 草稿占位 / 在途的候选，提示词、台词、
   参考图、首尾帧、裁剪与锁定、成片轨（画面 / 配音 / 字幕 / 标记 / 轨道状态）、画幅、视口游标。 */
function richProject() {
  return {
    id: 'p-src', name: '湖畔短片', groupId: 'g1',
    composition: { width: 1920, height: 1080 }, voiceModel: 'vm-1',
    curScene: 1, curShot: 1, curCand: 2,
    film: {
      clips: [
        { id: 'c1', shotId: 'sh1', candId: 'v1', sourceStart: 0.5, duration: 5, transition: { kind: 'fade', duration: 0.4 } },
        { id: 'c2', shotId: 'sh2', candId: 'v3', sourceStart: 0, duration: 3.2 },
      ],
      voices: [{ id: 'vo1', text: '旁白一句', duration: 2 }],
      captions: [{ id: 'cap1', text: '字幕', voiceId: 'vo1', start: 1, duration: 1 }],
      markers: [{ id: 'mk1', at: 3, label: '转场' }],
      tracks: { visibility: { video: true, voice: false }, locks: { video: true } },
    },
    scenes: [
      {
        id: 'sc1', name: '场景 1', img: 'data:image/png;base64,AAA', noPic: false,
        shots: [
          {
            id: 'sh1', name: '新镜头', prompt: '晨雾中的木栈道，逆光', line: '我们走吧', lineWho: '小雅',
            note: 'AI 给的画面说明', ar: '16:9', res: '768p', tier: 'fast', draw: 2, combo: 'img2v',
            firstFrame: 'data:image/png;base64,BBB', lastFrame: 'data:image/png;base64,CCC',
            refImages: ['data:image/png;base64,DDD'], refMeta: [{ label: '角色' }],
            keyframes: [{ t: 1.2, desc: '起手', status: 'done', assetId: 'a1' }],
            refVideo: { asset_id: 'rv1', name: '参考.mp4' }, refAudio: null,
            linkPrev: 'tail', modelAuto: 'chain',
            selId: 'v1',
            candidates: [
              { vid: 'v1', provider: 'p1', status: 'succeeded', progress: 100, url: '/asset/vid-1',
                prompt: '晨雾中的木栈道，逆光', selected: true, locked: true, trimS: 0.4, trimE: 4.6,
                duration: 5, priceMicros: 1200, shotId: 'sh1', _mirrorAnnounced: true },
              { vid: 'v2', provider: 'p2', status: 'failed', progress: 0, url: '',
                prompt: '同一句的另一种说法', error: '额度不足', shotId: 'sh1' },
              { vid: 'v3', provider: '', status: 'draft', progress: 0, url: null, prompt: '晨雾中的木栈道，逆光' },
              { vid: 'v4', provider: 'p1', status: 'creating', progress: 23, url: 'https://cdn/签名地址',
                prompt: '待生成', queue_position: 2 },
              { vid: 'v5', provider: 'local', status: 'succeeded', progress: 100,
                url: 'blob:http://localhost/abc', _objUrl: true, local: true, prompt: '' },
            ],
          },
        ],
      },
      {
        id: 'sc2', name: '场景 2', img: '', noPic: true,
        shots: [
          { id: 'sh2', name: '第二镜', prompt: '', line: '', note: '', candidates: [
            { vid: 'v6', status: 'succeeded', url: '/asset/vid-2', prompt: '' },
          ], selId: 'v6' },
        ],
      },
    ],
  };
}
const groupNameOf = p => (p && p.groupId === 'g1' ? '校园篇' : '');
const mkPack = (over = {}) => buildProjectPack({ projects: [richProject()], groupNameOf, ts: '2026-11-07T10:00:00.000Z', ...over });
const roundTrip = pack => JSON.parse(JSON.stringify(pack));

/* ① 打包：作品内容一条不少，运行时状态一条不留。 */
{
  const pack = mkPack();
  ok(pack.type === PROJECT_PACK_TYPE && pack.version === PROJECT_PACK_VERSION, '包类型 / 版本不对');
  ok(pack.app === 'director' && pack.ts === '2026-11-07T10:00:00.000Z', '没记来源与时间');
  ok(pack.checksum === projectPackChecksum(JSON.stringify(pack.projects)), 'checksum 不是按 projects 算的');
  const p = pack.projects[0];
  ok(p.groupName === '校园篇', '项目组名没带上');
  /* 组 id 是导出那台机器的工作区身份：带到别的机器上要么指空、要么撞进别人的组。 */
  ok(p.groupId === undefined, '组 id 不该跟着包走（跨机器只认组名）');
  ok(p.curScene === undefined && p.curShot === undefined && p.curCand === undefined, '视口游标不该进包');
  ok(p.scenes.length === 2 && p.scenes[0].shots[0].candidates.length === 5, '场景 / 候选少了');
  const cs = p.scenes[0].shots[0].candidates;
  ok(cs.map(c => c.status).join(',') === 'succeeded,failed,draft,creating,succeeded',
    '没选用 / 失败 / 草稿 / 在途的候选都要原样带出去');
  ok(cs[0].prompt === '晨雾中的木栈道，逆光' && p.scenes[0].shots[0].line === '我们走吧'
    && p.scenes[0].shots[0].note === 'AI 给的画面说明', '提示词 / 台词 / 画面说明丢了');
  ok(cs[0].selected === true && cs[0].locked === true && cs[0].trimS === 0.4 && cs[0].trimE === 4.6,
    '选用 / 锁定 / 裁剪状态丢了');
  ok(p.scenes[0].shots[0].selId === 'v1' && p.scenes[0].shots[0].firstFrame.startsWith('data:')
    && p.scenes[0].shots[0].refImages.length === 1, '选用指针对不上 / 参考图丢了');
  ok(p.film.clips.length === 2 && p.film.voices.length === 1 && p.film.captions.length === 1
    && p.film.markers.length === 1 && p.film.tracks.locks.video === true, '剪辑状态（成片轨）丢了');
  ok(p.film.clips[0].transition.kind === 'fade' && p.film.clips[0].shotId === 'sh1', '剪辑段里的引用被改了');
  ok(p.composition.width === 1920 && p.voiceModel === 'vm-1', '画幅 / 配音型号丢了');
  ok(cs[4].url === '' && cs[4]._objUrl === undefined, 'blob: 临时地址与内存标记必须清掉');
  /* 「这条投过自动镜像」是纯内存状态：带进包，新机器上的历史补扫会整批跳过这一条。 */
  ok(cs[0]._mirrorAnnounced === undefined, '投递标记不该跟着作品走');
  ok(cs[0].url === '/asset/vid-1' && cs[3].url === 'https://cdn/签名地址', '本机 / 平台地址要留着');
  assertProjectPack(roundTrip(pack));
  n++;
}

/* ② 摘要：每个数字都能从包里数出来，且把「视频字节带不走」说清楚。 */
{
  const pack = mkPack();
  const s = projectPackStats(pack.projects);
  ok(s.projects === 1 && s.groups === 1 && s.scenes === 2 && s.shots === 2 && s.candidates === 6, '摘要计数不对');
  ok(buildProjectPack({ projects: [richProject()], groupNameOf: () => '' }).stats.groups === 0,
    '未归组的短片不该数出项目组');
  ok(buildProjectPack({ projects: [richProject(), { ...richProject(), id: 'p2' }], groupNameOf }).stats.groups === 1,
    '同组两部短片只算一个项目组');
  ok(s.promptShots === 1 && s.promptCandidates === 4 && s.lines === 1 && s.notes === 1, '提示词计数不对');
  ok(s.selected === 2 && s.trimmed === 1 && s.locked === 1, '选用 / 裁剪 / 锁定计数不对');
  ok(s.clips === 2 && s.voices === 1 && s.captions === 1 && s.markers === 1, '剪辑计数不对');
  ok(s.localAssets === 2 && s.remoteUrls === 1 && s.blobUrls === 0, '媒体地址分类不对');
  const d = describeProjectPack(roundTrip(pack));
  ok(d.prompts === s.promptShots + s.promptCandidates + s.lines + s.notes, '摘要里的提示词数不对');
  ok(/6 条候选/.test(d.text) && /不覆盖现有项目/.test(d.text) && /视频字节不在包里/.test(d.text),
    '确认框没说清带什么、不动什么、什么带不走');
  ok(/2 条指向本机资产库/.test(d.text), '没提示本机素材换机器要一起搬');
  ok(/1 个项目组/.test(d.text) && /已有同名组会先问你/.test(d.text) && /改名/.test(d.text),
    '确认框没说明项目组重名时要先问怎么落位：' + d.text);
  /* 导出时清掉的那条 blob: 地址，包里已数不到，但摘要必须照样报出来。 */
  ok(pack.stats.blobUrls === 1 && d.blobUrls === 1 && /1 条临时视频地址已置空/.test(d.text),
    '被清掉的临时地址没在摘要里报数');
}

/* ③ 格式闸门：任何一项不过都拒绝，且原包一个字节都没被改（零写入的前提）。 */
{
  const raw = mkPack();
  throws(() => assertProjectPack(null), /不是导演台/, '空文件要拒');
  throws(() => assertProjectPack({ type: 'ai-workbench-backup', version: 1, projects: [] }), /不是导演台/, '整包备份混进来要拒');
  throws(() => assertProjectPack({ ...raw, version: PROJECT_PACK_VERSION + 1 }), /更新版本/, '更新版本要拒');
  throws(() => assertProjectPack({ ...raw, version: undefined }), /缺少可识别/, '无版本要拒');
  throws(() => assertProjectPack({ ...raw, projects: [] }), /没有短片/, '空短片表要拒');
  throws(() => assertProjectPack({ ...raw, projects: [{ id: 'p', name: 'x', scenes: [] }] }), /一个场景都没有/, '空场景要拒');
  throws(() => assertProjectPack({ ...raw, projects: [{ id: 'p', name: 'x', scenes: [{ shots: [] }] }] }),
    /一个镜头都没有/, '空镜头要拒');
  throws(() => assertProjectPack({ ...raw, projects: [{ id: '', name: 'x', scenes: [{ shots: [{}] }] }] }),
    /没有 id/, '没 id 要拒');
  const tampered = roundTrip(raw);
  tampered.projects[0].scenes[0].shots[0].prompt = '被人手改过';
  throws(() => assertProjectPack(tampered), /校验和对不上/, '内容被改但 checksum 没跟上要拒');
  throws(() => assertProjectPack({ ...raw, checksum: 'deadbeef' }), /校验和对不上/, '校验和字段被换要拒');
  const before = JSON.stringify(raw);
  const bad = roundTrip(raw); bad.version = 9;
  assert.throws(() => assertProjectPack(bad));
  ok(JSON.stringify(raw) === before, '闸门自己不许改动包（纯校验）');
  n++;
}

/* ④ 校验和：同文同值，改一个字就变。 */
{
  ok(projectPackChecksum('abc') === projectPackChecksum('abc'), '同一段文字两算不一样');
  ok(projectPackChecksum('abc') !== projectPackChecksum('abd'), '改一个字没变');
  ok(/^[0-9a-f]{16}$/.test(projectPackChecksum('中文也行')), '校验和不是 16 位十六进制');
}

/* ⑤ 导入归一化：追加、不覆盖、在途任务落地、内部引用不断。 */
{
  const pack = roundTrip(mkPack());
  const snapshot = JSON.stringify(pack);
  let seq = 0;
  const prep = prepareProjectPackImport(pack, {
    uid: () => 'new-' + (++seq),
    existingIds: ['p-src'],                 // 与本机已有短片撞 id
    nameTaken: nm => nm === '湖畔短片',      // 与本机已有短片撞名字
  });
  ok(JSON.stringify(pack) === snapshot, '导入准备把原包改了（必须先克隆再动）');
  ok(prep.items.length === 1, '该导入一部短片');
  const it = prep.items[0];
  ok(it.groupName === '校园篇' && it.project.groupName === undefined, '组名要单独递给调用方，不该留在项目里');
  ok(it.project.groupId === undefined, '导入后不该留着导出那台机器的组 id');
  ok(it.project.id === 'new-1' && prep.notes.newIds === 1, '撞 id 没换新的');
  ok(it.project.name === '湖畔短片（导入）' && prep.notes.renamed === 1, '撞名字没加后缀');
  ok(it.project.scenes[0].shots[0].selId === 'v1'
    && it.project.film.clips[0].shotId === 'sh1'
    && it.project.scenes[0].shots[0].candidates[0].vid === 'v1',
  '换项目 id 不该把镜头 / 候选 / 剪辑之间的引用扯断');
  const cs = it.project.scenes[0].shots[0].candidates;
  ok(cs[3].status === 'failed' && cs[3].progress === 0 && /重新生成/.test(cs[3].error),
    '在途任务落地成「可重试」，不能永远转圈');
  ok(prep.notes.inFlight === 1, '在途任务数没报出来');
  ok(cs[4].url === '' && prep.notes.deadUrls === 1, 'blob: 死链没清');
  ok(cs[0].status === 'succeeded' && cs[1].status === 'failed' && cs[2].status === 'draft',
    '已完成的 / 失败的 / 草稿候选状态不许被改');
  ok(it.project.curScene === undefined, '视口游标不该被带回来');

  /* 手改过 / 老版本的包里还可能留着 groupId：闸门只盖 checksum，这种包照样能过；
     导入侧必须自己抹掉 —— 否则短片会挂到本地另一拨巧合同 id 的组上。 */
  const foreign = roundTrip(mkPack());
  foreign.projects[0].groupId = 'g-foreign';
  foreign.checksum = projectPackChecksum(JSON.stringify(foreign.projects));
  const fp = prepareProjectPackImport(foreign, { uid: () => 'fresh' });
  ok(fp.items[0].project.groupId === undefined, '带 groupId 的老包也要把组 id 抹掉');
  ok(fp.items[0].groupName === '校园篇', '抹组 id 时不该把组名一起丢掉');
}

/* ⑥ 多短片包：组名各归各的，名字冲突只在真撞时加后缀。 */
{
  const a = richProject();
  const b = richProject(); b.id = 'p-b'; b.name = '另一部'; b.groupId = '';
  const pack = roundTrip(buildProjectPack({ projects: [a, b], groupNameOf, ts: '2026-11-07T10:00:00.000Z' }));
  const prep = prepareProjectPackImport(pack, {
    uid: () => 'fresh', existingIds: [], nameTaken: nm => nm === '另一部',
  });
  ok(prep.items.length === 2 && prep.items[0].groupName === '校园篇' && prep.items[1].groupName === '',
    '两部短片的组名没各自带回来');
  ok(prep.items[0].project.name === '湖畔短片' && prep.items[1].project.name === '另一部（导入）',
    '只给真撞名的那一部加后缀');
  ok(prep.notes.newIds === 0, '没撞 id 就不该换 id');
  const d = describeProjectPack(pack);
  ok(/2 部短片/.test(d.text) && d.candidates === 12, '多短片摘要数不对');
  ok(d.groups === 1 && /1 个项目组/.test(d.text), '多短片包里的项目组数不对：' + JSON.stringify(d.groups));
}

/* ⑦ 导出全部与导出当前共用一份格式：单部 / 多部都过同一道闸门。 */
{
  const one = mkPack();
  const two = buildProjectPack({ projects: [richProject(), { ...richProject(), id: 'p2', name: '第二部' }], groupNameOf });
  for (const p of [one, two]) {
    assertProjectPack(roundTrip(p));
    n++;
  }
  ok(one.projects.length === 1 && two.projects.length === 2, '导出范围没按传入的短片表走');
  ok(buildProjectPack({ projects: [richProject()], groupNameOf: () => '' }).projects[0].groupName === '',
    '未分组的短片不该凭空带一个组名');
  throws(() => buildProjectPack({ projects: [] }), /没有可导出/, '空表不该造出一个空包');
  throws(() => buildProjectPack({ projects: [{ id: 'p', name: 'x', scenes: [] }] }), /导不出去/,
    '坏工程不该被打包交出去');
}

/* ⑧ 随包带走的本机素材线索：换机器只拷视频文件、不搬索引时按它把旧号认回盘上那份。
     线索是可选的一段，老包没有也照样能导；带上了就必须自洽，且不能改动作品本身。 */
{
  const p = richProject();
  p.scenes[0].shots[0].candidates[0].url = '/asset/la_from_old_pc?v=2';
  p.scenes[1].shots[0].candidates[0].url = '/asset/la_from_old_pc';      // 同一枚号只带一条
  p.film.clips[0].src = '/asset/la_second_one';                            // 成片轨里也要扫到
  const hintOf = u => ({ name: u.includes('second') ? '第二段.mp4' : '第一段.mp4',
    file: '视频\\第一段.mp4', bytes: 4096, format: 'mp4',
    upstream: 'https://cdn.example.com/a.mp4?sig=1', assetId: 'asset_a', taskId: 'job_a' });
  const pack = buildProjectPack({ projects: [p], groupNameOf, hintOf });
  ok(Array.isArray(pack.media) && pack.media.length === 2, '本机素材线索该去重后带两条：' + JSON.stringify(pack.media));
  ok(pack.media.map(x => x.id).sort().join(',') === 'la_from_old_pc,la_second_one',
    '候选与成片轨里的旧号都要扫到：' + JSON.stringify(pack.media.map(x => x.id)));
  ok(pack.media.every(x => x.bytes === 4096 && x.file === '视频\\第一段.mp4'), '线索没带上落点 / 体积');
  ok(pack.mediaChecksum === projectPackChecksum(JSON.stringify(pack.media)), '线索校验和算错了');
  ok(pack.checksum === projectPackChecksum(JSON.stringify(pack.projects)), '作品校验和不该被线索改动');
  assertProjectPack(roundTrip(pack)); n++;

  /* 线索被改过 / 被抹掉校验和：**只丢线索、作品照常导入** —— 一条路径写错不该让人导不进来。 */
  const badHint = roundTrip(pack); badHint.media[0].bytes = 999;
  const droppedHint = projectPackMedia(badHint);
  ok(droppedHint.list.length === 0 && /校验和对不上/.test(droppedHint.why),
    '被人改过的线索必须丢掉：' + droppedHint.why);
  ok(prepareProjectPackImport(badHint, { uid: () => 'x' }).items.length === 1,
    '线索坏了不该把短片一起拦下');
  const noSum = roundTrip(pack); delete noSum.mediaChecksum;
  ok(projectPackMedia(noSum).list.length === 0, '线索没了校验和必须丢掉');

  /* 老包（没有 media）照旧认：这是「不需要兼容层」的例外 —— 用户手里已经导出的文件。 */
  const legacy = roundTrip(pack); delete legacy.media; delete legacy.mediaChecksum;
  assertProjectPack(legacy); n++;
  ok(prepareProjectPackImport(legacy, {}).media.length === 0, '老包导入时线索表该是空的');

  /* 导入侧原样交回，engine 拿它去问代理重绑。 */
  const prep = prepareProjectPackImport(roundTrip(pack), { uid: () => 'new' });
  ok(prep.media.length === 2 && prep.media.some(x => x.id === 'la_from_old_pc'), '导入没把线索交回来');
  ok(/2 条本机素材线索/.test(describeProjectPack(roundTrip(pack)).text), '确认框没说明线索的用处');

  /* 别名表还没就位时 hintOf 返回 null：号照样要带上，代理还能按文件名尾标认回。 */
  const noHints = buildProjectPack({ projects: [p], groupNameOf, hintOf: () => null });
  ok(noHints.media.length === 2 && noHints.media.every(x => x.id && x.file === undefined),
    '别名表没就位也要带号：' + JSON.stringify(noHints.media));
  assertProjectPack(roundTrip(noHints)); n++;
}

/* ⑨ 撞名后缀要能一直往后编：
   · 同一个包连导两次（本机已留着原片和上一次的「（导入）」）→ 这次的该叫「（导入 2）」，
     以前只判一次，第二次又给一枚「（导入）」，组里就出现两部同名短片；
   · 包里本来就带两部同名短片（同一部作品被复制过）→ 第二部在**这一批**里就得改名。 */
{
  const again = prepareProjectPackImport(roundTrip(mkPack()), {
    uid: () => 'new', existingIds: [],
    nameTaken: nm => ['湖畔短片', '湖畔短片（导入）'].includes(nm),
  });
  ok(again.items[0].project.name === '湖畔短片（导入 2）',
    '第二次导入又撞回同一个「（导入）」：' + again.items[0].project.name);
  ok(again.notes.renamed === 1, '改过名却没记进 renamed');

  const third = prepareProjectPackImport(roundTrip(mkPack()), {
    uid: () => 'new', existingIds: [],
    nameTaken: nm => ['湖畔短片', '湖畔短片（导入）', '湖畔短片（导入 2）'].includes(nm),
  });
  ok(third.items[0].project.name === '湖畔短片（导入 3）',
    '第三次导入没接着往后编：' + third.items[0].project.name);

  const a = richProject();
  const b = richProject(); b.id = 'p-copy'; b.groupId = '';
  const twins = roundTrip(buildProjectPack({ projects: [a, b], groupNameOf }));
  const dup = prepareProjectPackImport(twins, { uid: () => 'fresh' });
  const dupNames = dup.items.map(x => x.project.name);
  ok(dupNames[0] === '湖畔短片' && dupNames[1] === '湖畔短片（导入）',
    '同一批里的同名短片没当场分开：' + dupNames.join(' | '));
  ok(new Set(dupNames).size === dupNames.length, '同一批里仍有两部同名短片：' + dupNames.join(' | '));
  ok(dup.notes.renamed === 1, '同一批里改的那一部没记进 renamed');

  /* 本机没冲突、包里也没重名：一个后缀都不该加（别把正常导入也改了名）。 */
  const clean = prepareProjectPackImport(roundTrip(mkPack()), { uid: () => 'fresh' });
  ok(clean.items[0].project.name === '湖畔短片' && clean.notes.renamed === 0,
    '没撞名却改了名字：' + clean.items[0].project.name);
}

/* ⑨ 冲突扫描与两种导入策略：组名撞车怎么落位、内容完全一致要不要再导一份。 */
{
  const pack = mkPack();
  const local = richProject();
  const keyOf = k => String(k == null ? '' : k).trim().toLowerCase();

  /* 指纹只盖作品内容：名字 / id / 组 / 视口游标 / _objUrl / blob 地址都不该让它变。 */
  const fp = projPackFingerprint(pack.projects[0]);
  ok(fp === projPackFingerprint(local), '同一部短片在本机与包里算出了两枚指纹');
  ok(fp === projPackFingerprint({ ...local, id: 'another', name: '别的名字', groupId: 'g9', curShot: 0 }),
    '名字 / id / 组 / 视口游标不该进指纹');
  const withBlob = roundTrip(local);
  withBlob.scenes[0].shots[0].candidates[4].url = 'blob:http://localhost/新地址';
  withBlob.scenes[0].shots[0].candidates[4]._objUrl = true;
  ok(fp === projPackFingerprint(withBlob), '临时 blob 地址不该让同一部短片变成「另一部」');
  const changed = roundTrip(local);
  changed.scenes[0].shots[0].prompt += '（改过）';
  ok(fp !== projPackFingerprint(changed), '内容真变了，指纹却没变（会把两部不同的短片当成同一部）');
  /* 面板渲染时自己补上的那几样：同一部短片隔一会儿看就多出这些，指纹不该跟着变。 */
  const withDefaults = roundTrip(local);
  withDefaults.scenes[0].shots[0].adv = { bools: {}, topBools: {}, shape: { upscale: '' } };
  withDefaults.scenes[0].shots[0].combo = 'smart:fl2va+ref2va';
  withDefaults.scenes[0].shots[0].duration = 5;
  ok(fp === projPackFingerprint(withDefaults),
    '面板补的 combo / adv / duration 不该让同一部短片变成「另一部」');
  /* 但成片轨里的时长要照比：那才是「这部作品剪成什么样」。 */
  const durChanged = roundTrip(local);
  durChanged.film.clips[0].duration += 1;
  ok(fp !== projPackFingerprint(durChanged), '成片轨的片段时长变了，指纹却没变');

  /* 扫描只报事实：组名撞车、内容完全一致，各带上面部数 / 撞的是本机哪一部。 */
  const hit = scanProjectPackConflicts(pack, {
    nameKey: keyOf, localProjects: [local], groupTaken: n => keyOf(n) === keyOf('校园篇'),
  });
  ok(hit.groups.length === 1 && hit.groups[0].name === '校园篇' && hit.groups[0].count === 1,
    '组名撞车没扫出来：' + JSON.stringify(hit.groups));
  ok(hit.duplicates.length === 1 && hit.duplicates[0].index === 0
    && hit.duplicates[0].sameAs === '湖畔短片', '内容完全一致的那部没扫出来：' + JSON.stringify(hit.duplicates));
  const quiet = scanProjectPackConflicts(pack, {
    nameKey: keyOf, localProjects: [{ ...richProject(), name: '另一部' }], groupTaken: () => false,
  });
  ok(quiet.groups.length === 0, '本机没有同名组却报了撞车');
  const other = scanProjectPackConflicts(pack, {
    nameKey: keyOf, localProjects: [changed], groupTaken: () => false,
  });
  ok(other.duplicates.length === 0, '内容不一样却被当成重复');

  /* 默认策略：组名撞车就并进本机那个组（老行为不改）。 */
  const merged = prepareProjectPackImport(pack, { uid: () => 'fresh', nameKey: keyOf, groupTaken: n => !!keyOf(n) });
  ok(merged.items[0].groupName === '校园篇' && merged.notes.renamedGroups === 0,
    '默认策略不该改组名：' + merged.items[0].groupName);

  /* 用户选「给导入的组改名」：加「（导入）」后缀；本机连这个名字也有就继续往后编。 */
  const renamed = prepareProjectPackImport(pack, {
    uid: () => 'fresh', nameKey: keyOf, groupTaken: n => keyOf(n) === keyOf('校园篇'),
    groupPolicy: 'rename',
  });
  ok(renamed.items[0].groupName === '校园篇（导入）',
    '选了改名却没改：' + renamed.items[0].groupName);
  ok(renamed.notes.renamedGroups === 1 && renamed.notes.groupRenames[0].from === '校园篇'
    && renamed.notes.groupRenames[0].to === '校园篇（导入）', '改名没记进 notes');
  const bumped = prepareProjectPackImport(pack, {
    uid: () => 'fresh', nameKey: keyOf, groupPolicy: 'rename',
    groupTaken: n => ['校园篇', '校园篇（导入）'].some(x => keyOf(x) === keyOf(n)),
  });
  ok(bumped.items[0].groupName === '校园篇（导入 2）',
    '本机已占用了「（导入）」这个名字，没接着往后编：' + bumped.items[0].groupName);

  /* 同一个组里的几部只改一次名 —— 各改各的会把一组拆成好几个组。 */
  const twin = richProject(); twin.id = 'p-twin';
  const twoInOne = buildProjectPack({ projects: [richProject(), twin], groupNameOf });
  const bothRenamed = prepareProjectPackImport(twoInOne, {
    uid: () => 'fresh', nameKey: keyOf, groupTaken: n => keyOf(n) === keyOf('校园篇'), groupPolicy: 'rename',
  });
  ok(bothRenamed.items.map(x => x.groupName).join('|') === '校园篇（导入）|校园篇（导入）',
    '同组的两部被改成了两个组名：' + bothRenamed.items.map(x => x.groupName).join(' | '));
  ok(bothRenamed.notes.renamedGroups === 1, '同组两部各记了一次改名');

  /* 用户选「重复的不再导一份」：跳过的既不入 items，也不占名字。 */
  const skipped = prepareProjectPackImport(pack, { uid: () => 'fresh', skipIndexes: [0], nameTaken: () => false });
  ok(skipped.items.length === 0 && skipped.notes.skipped === 1,
    '跳过的短片还被算进了导入列表：' + skipped.items.length);
  ok(skipped.notes.skippedNames[0] === '湖畔短片', '跳过的那部没记名字：' + skipped.notes.skippedNames.join('、'));
  ok(skipped.items.length === 0 && skipped.notes.renamed === 0, '跳过的那部连名字都占掉了');
}

console.log('  ✓ 导演台项目文件：' + n + ' 项，0 项未通过');
