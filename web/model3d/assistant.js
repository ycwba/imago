/* 建模台给助手的能力声明（纯数据，不碰 window）：桥的静态那一半。
   运行时 api（ready / list / read / thumbnail / check / run）由页面 install 到 WBBridge.model3d；
   这一份只说「给助手哪些工具、属于哪一页、依赖桥的哪个方法、结果裁多长、参数长什么样」。
   助手的目录由它现拼（chat-tools.js 的 syncBridgeDecls）—— 改建模台的助手面只改这里。
   reads 走桥的只读方法，view 走 thumbnail + 看图，acts 走桥的 check/run（op 与建模 AI 同一套词汇）。 */
export const MODEL_ASSISTANT = {
  page: '建模台',
  route: 'model.html',
  reads: [
    {
      id: 'model_list', method: 'list', cap: 4000,
      arg: '无参数',
      doc: '建模台的白模库 / 当前场景：库名、库里模型 id、当前场景实体（id / 名字 / 种类 / 零件数）、灯。改白膜前先用它拿 id',
      input: { type: 'object', properties: {} },
    },
    {
      id: 'model_read', method: 'read', cap: 8000,
      arg: '{ "id": "实体 id" }',
      doc: '读建模台当前场景里某个实体的完整节点树与它的轨道（id / 名字 / 形状 / 坐标）。节点很多时先看返回里的大纲',
      input: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  ],
  view: {
    id: 'model_view',
    arg: '{ "ask": "可选：想让我看什么" }',
    doc: '看一眼建模台当前的视口（活动机位的构图），用于评价构图 / 光感。需要当前文字型号支持识图',
    input: { type: 'object', properties: { ask: { type: 'string' } } },
  },
  acts: [
    {
      id: 'model_edit', op: 'edit', effect: 'write', undo: 'model_undo',
      arg: '{ "scope": "scene|selection", "ops": [ …与建模 AI 相同的 op… ] }',
      title: '改建模台里的白膜',
      doc: '对建模台当前场景套白膜 op（与建模 AI 同一套词汇：update / add / remove / move / group / ungroup / cam / light / track / anim）。'
        + '不给 scope = 场景级（能改灯 / 机位 / 时间轴）；scope:"selection" = 只改当前选中实体的子树。'
        + '节点与灯的 id 从 model_list / model_read 拿，不要自己编；改坏了用 model_undo 退回。',
      input: { type: 'object', properties: {
        scope: { type: 'string', enum: ['scene', 'selection'] },
        ops: { type: 'array', minItems: 1 },
      }, required: ['ops'] },
    },
    {
      id: 'model_new', op: 'new', effect: 'write', undo: 'model_undo',
      arg: '{ "name": "白膜名字" }',
      title: '新建一个白膜（建模台）',
      doc: '在建模台当前场景里新建一个空实体（2–12 字的名字），之后可以用 model_edit 往它里面加零件。',
      input: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    },
    {
      id: 'model_add_to_scene', op: 'add', effect: 'write', undo: 'model_undo',
      arg: '{ "id": "白模库里的模型 id" }',
      title: '把白模库的模型放进场景（建模台）',
      doc: '把白模库里的某份模型深拷贝成当前场景里的可编辑实体。id 从 model_list 的【库里模型】拿。',
      input: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
    {
      id: 'model_undo', op: 'undo', effect: 'write',
      arg: '无参数',
      title: '撤销助手上一次改白膜（建模台）',
      doc: '把建模台退回到助手上一次经桥改动之前（最多 20 步；与建模台自己的 AI 撤销是两条账）。',
      input: { type: 'object', properties: {} },
    },
  ],
};