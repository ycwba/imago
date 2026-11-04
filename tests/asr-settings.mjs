#!/usr/bin/env node
/* ASR 设置与任务账本判据：
   - SRT 时间格式与分段归一（负起点、倒挂终点、空白段）
   - 密钥只进盘、读接口只回 hasKey；clearKey 真的清掉
   - 重启把 queued/running 标成 interrupted（不自动重试）
   - done 的分段自动生成 SRT；sourceHash 可复用；账本最多 60 条
   - 覆盖前留 .bak.json，内容相同不留 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createAsrStore, toSrt, normSegments, srtTime } = require('../server/asr-store.js');

/* ---------- 纯函数 ---------- */
assert.equal(srtTime(0), '00:00:00,000');
assert.equal(srtTime(3661.5), '01:01:01,500');
assert.equal(srtTime(-3), '00:00:00,000');
/* 毫秒不能拼出 ,1000：1.9996 秒要进位成 2 秒整，而不是 `00:00:01,1000`（非法 SRT） */
assert.equal(srtTime(1.9996), '00:00:02,000');
assert.equal(srtTime(59.9999), '00:01:00,000');

const srt = toSrt([
  { start: 0, end: 1.2, text: '第一句' },
  { start: 1.3, end: 2, text: ' 第二句 ' },
]);
assert.match(srt, /^1\n00:00:00,000 --> 00:00:01,200\n第一句\n\n2\n/);
assert.match(srt, /第二句\n$/);

const segs = normSegments([
  { start: -2, end: 1.4, text: '  你好   世界 ' },
  { start: 5, end: 3, text: '倒挂的终点' },
  { start: 6, end: 7, text: '   ' },
  null,
]);
assert.equal(segs.length, 2);
assert.deepEqual(segs[0], { start: 0, end: 1.4, text: '你好 世界' });
assert.deepEqual(segs[1], { start: 5, end: 5, text: '倒挂的终点' });

/* ---------- 设置：白名单字段 / 密钥不回读 / 校验 ---------- */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aii-asr-'));
const logs = [];
const mk = () => createAsrStore({ dataDir: dir, log: s => logs.push(s) });
let s = mk();

let pub = s.settings();
assert.equal(pub.route, 'auto');
assert.equal(pub.service.model, '');        // 空 = 用这家声明里的默认型号
assert.equal(pub.service.hasKey, false);
assert.equal(pub.service.key, undefined);

pub = s.patchSettings({
  route: 'service',
  language: 'zh',
  service: { providerId: 'openai', model: 'gpt-4o-transcribe', baseUrl: 'https://api.openai.com/v1/', key: 'sk-secret' },
});
assert.equal(pub.route, 'service');
assert.equal(pub.language, 'zh');
assert.equal(pub.service.baseUrl, 'https://api.openai.com/v1');   // 末尾斜杠收掉
assert.equal(pub.service.hasKey, true);
assert.equal(pub.service.key, undefined);                          // 读接口绝不回明文

const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'asr.json'), 'utf8'));
assert.equal(onDisk.service.key, 'sk-secret');                     // 只有盘上有
assert.equal(onDisk.revision, 2);

/* 空 key 不覆盖已有密钥；clearKey 才清 */
pub = s.patchSettings({ service: { key: '   ' } });
assert.equal(pub.service.hasKey, true);
pub = s.patchSettings({ clearKey: true });
assert.equal(pub.service.hasKey, false);

assert.throws(() => s.patchSettings({ language: '中文！' }), /语言/);
assert.throws(() => s.patchSettings({ service: { baseUrl: 'ftp://x' } }), /http/);
assert.throws(() => s.patchSettings({ service: { providerId: 'a b' } }), /供应商/);

/* 换在线服务商：上一家的接口地址 / 型号 / 单独密钥一起作废（否则会带着旧密钥发到新地址） */
s.patchSettings({ service: { key: 'sk-old-provider' } });
pub = s.patchSettings({ service: { providerId: 'moonshot' } });
assert.equal(pub.service.hasKey, false, '换服务商要清掉上一家的单独密钥');
assert.equal(pub.service.baseUrl, '', '换服务商要清掉上一家的接口地址');
assert.equal(pub.service.model, '', '换服务商要清掉上一家的型号');

/* 校验中途失败不能留下半截改动：以前 route / providerId 已经改进内存，磁盘却没写 */
const snap = s.settings();
assert.throws(() => s.patchSettings({ route: 'auto', service: { providerId: 'openai', baseUrl: 'ftp://x' } }), /http/);
assert.equal(s.settings().route, snap.route, '失败的保存不能改掉路线');
assert.equal(s.settings().service.providerId, snap.service.providerId, '失败的保存不能改掉服务商');

/* 覆盖前留 .bak.json；第二次写入后它应存在且内容是上一版 */
assert.ok(fs.existsSync(path.join(dir, 'asr.bak.json')));

/* ---------- 任务账本 ---------- */
s.putJob({
  id: 'j1', state: 'done', progress: 1, route: 'service', language: 'zh',
  segments: [{ start: 0, end: 1, text: '你好' }, { start: 1, end: 2, text: '世界' }],
  sourceHash: 'abc123', engine: 'openai:gpt-4o-transcribe', media: 'a.mp3',
});
const j1 = s.job('j1');
assert.equal(j1.state, 'done');
assert.match(j1.srt, /00:00:00,000 --> 00:00:01,000/);
assert.ok(s.findByHash('abc123', 'service', 'zh'));
assert.equal(s.findByHash('abc123', 'local', 'zh'), null);
assert.equal(s.findByHash('abc123', 'service', 'en'), null);
/* 同一份音频换个模型/供应商再转，不能复用上一个模型的结果 */
s.putJob({ id: 'j1b', state: 'done', route: 'service', language: 'zh', sourceHash: 'abc123',
  engineKey: 'service:openai/whisper-1', segments: [{ start: 0, end: 1, text: '新结果' }] });
assert.ok(s.findByHash('abc123', 'service', 'zh', 'service:openai/whisper-1'));
assert.equal(s.findByHash('abc123', 'service', 'zh', 'service:moonshot/other'), null);

s.putJob({ id: 'j2', state: 'running', progress: 0.4, route: 'local', media: 'b.wav' });
assert.equal(s.job('j2').state, 'running');

/* 重启：在跑的两档一律 interrupted，并写明不自动重试 */
s = mk();
assert.equal(s.job('j2').state, 'interrupted');
assert.match(s.job('j2').error, /没有自动重试/);
assert.equal(s.job('j1').state, 'done');

/* 账本上限 60 条（按 updatedAt 取新） */
for (let i = 0; i < 65; i++) {
  s.putJob({ id: 'k' + i, state: 'done', route: 'local', sourceHash: 'h' + i, segments: [{ start: 0, end: 1, text: 'x' }] });
}
assert.equal(s.jobs().length, 60);
assert.equal(s.job('j1'), null);            // 最早的那条被挤出账本（不是静默丢：账本只留 60 条）

assert.equal(s.removeJob('k64'), true);
assert.equal(s.job('k64'), null);
assert.equal(s.removeJob('k64'), false);

fs.rmSync(dir, { recursive: true, force: true });

/* ---------- 通道密钥镜像（channel-cred.mirrored）：字符串键落盘是裸文本 ----------
   `sk_key_*` / `sk_base_*` 这类键走 ui.js 的 `LS.set`（裸字符串），DataSync 原样镜像成文件；
   只有对象类的键才是 Store 的信封 `{"data":…,"ts":…}`。以前 mirrored 只按信封 JSON.parse ——
   字符串键必抛、永远返回空，「用渠道那把密钥」永远读不到设置页里填的那把。 */
const { mirrored } = require('../server/channel-cred.js');
const mdir = fs.mkdtempSync(path.join(os.tmpdir(), 'aii-chan-'));
const mctx = { dataFileOf: k => path.join(mdir, k + '.json') };
fs.writeFileSync(path.join(mdir, 'sk_key_probe.json'), 'sk-or-v1-abc123');
fs.writeFileSync(path.join(mdir, 'sk_base_probe.json'), '{"data":"https://x.example/v1","ts":1}');
fs.writeFileSync(path.join(mdir, 'sk_key_blank.json'), '   ');
assert.equal(mirrored(mctx, 'sk_key_', 'probe'), 'sk-or-v1-abc123', '裸文本要按原值读回来');
assert.equal(mirrored(mctx, 'sk_base_', 'probe'), 'https://x.example/v1', '信封形状照旧拆 data');
assert.equal(mirrored(mctx, 'sk_key_', 'blank'), '', '空文件就是没有');
assert.equal(mirrored(mctx, 'sk_key_', 'missing'), '', '读不到就是没有');
fs.rmSync(mdir, { recursive: true, force: true });
console.log('✓ ASR 设置与任务账本行为通过');
