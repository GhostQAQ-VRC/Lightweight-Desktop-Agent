// Agent 工具集:定义(发给模型)+ 执行器(在主进程跑)
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const security = require('./security');
const sandbox = require('./sandbox');
const search = require('./search');
const http = require('./http');

const DEFINITIONS = [
  {
    name: 'list_dir',
    description: '列出指定目录下的文件和子目录。相对路径基于当前工作目录解析。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目录路径,默认为工作目录 "."' },
      },
      required: ['path'],
    },
  },
  {
    name: 'read_file',
    description: '读取文本文件内容(输出带行号)。大文件可用 offset/limit 分段读取。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径' },
        offset: { type: 'integer', description: '起始行号,从 1 开始,默认 1' },
        limit: { type: 'integer', description: '读取行数,默认 400,最大 1000' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: '把文本内容写入文件(覆盖已有文件;目录不存在会自动创建)。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径' },
        content: { type: 'string', description: '要写入的完整内容' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'run_command',
    description: `在用户电脑上用系统 Shell(${process.platform === 'win32' ? 'cmd.exe' : 'bash'})执行命令并返回输出。受沙箱约束:危险命令会被拦截,当前目录锁定在工作目录内。`,
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令' },
        cwd: { type: 'string', description: '可选,执行目录,默认为工作目录' },
      },
      required: ['command'],
    },
  },
  {
    name: 'web_search',
    description: '联网搜索:用搜索引擎查询,返回标题/链接/摘要列表。适合查新闻、最新信息、文档定位;需要网页全文时再用 web_fetch 打开具体链接。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词' },
        count: { type: 'integer', description: '可选,结果条数 1-10,默认 5' },
      },
      required: ['query'],
    },
  },
  {
    name: 'web_fetch',
    description: '抓取网页内容并转为纯文本(去除 HTML 标签),用于查阅在线资料。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '完整的 http/https 链接' },
      },
      required: ['url'],
    },
  },
  {
    name: 'read_conversation',
    description: '分段读取本应用内另一个对话的历史消息(用于接手/修复其他对话,避免一次性载入全文)。返回会话元信息与一个消息段;配合 offset/limit 翻页直到读完 total 条。',
    parameters: {
      type: 'object',
      properties: {
        convId: { type: 'string', description: '目标对话的 ID(见接手消息中的〖接手对话 <id>〗)' },
        offset: { type: 'integer', description: '可选,起始消息序号(从 0 开始),默认 0' },
        limit: { type: 'integer', description: '可选,本次读取条数 1-30,默认 10' },
      },
      required: ['convId'],
    },
  },
  // ===== 工具链扩充(v0.53.0):文件搜索 / 精确编辑 / 目录与移动删除 / 代码执行 / 系统交互 / 下载 =====
  {
    name: 'glob_files',
    description: '按通配模式搜索文件名(** 匹配任意层目录,* 匹配单层任意字符,? 匹配单个字符,[abc] 字符类;不支持 {})。自动跳过 node_modules/.git 目录。适合"找出项目里所有 .prefab 文件"这类需求。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '通配模式,如 "**/*.cs" 或 "Assets/**/*.prefab"' },
        path: { type: 'string', description: '可选,起始目录,默认工作目录 "."' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'grep_text',
    description: '在工作目录内按正则表达式搜索文件内容,返回 文件:行号: 匹配行。自动跳过 node_modules/.git、大于 1MB 与二进制文件。适合"找到调用某函数的位置"。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '正则表达式(JavaScript 语法)' },
        path: { type: 'string', description: '可选,起始目录,默认工作目录 "."' },
        ignoreCase: { type: 'boolean', description: '可选,忽略大小写,默认 false' },
        max: { type: 'integer', description: '可选,最大命中数,默认 50,上限 200' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'edit_file',
    description: '对已有文本文件做精确替换编辑:oldString 在文件中必须恰好出现一次(除非 all:true),替换为 newString。比整文件覆写更安全,改前建议先 read_file 确认内容。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径' },
        oldString: { type: 'string', description: '要被替换的原文(必须与文件内容精确匹配)' },
        newString: { type: 'string', description: '替换后的新文本' },
        all: { type: 'boolean', description: '可选,true = 替换全部出现;默认 false 且要求恰好出现一次' },
      },
      required: ['path', 'oldString', 'newString'],
    },
  },
  {
    name: 'mkdir',
    description: '创建目录(自动创建缺失的父目录)。已存在时直接成功。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目录路径' },
      },
      required: ['path'],
    },
  },
  {
    name: 'move_path',
    description: '移动或重命名文件/目录(同盘 rename;目标已存在时报错,不做覆盖)。',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: '源路径' },
        to: { type: 'string', description: '目标路径' },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'delete_path',
    description: '删除文件或目录。目录必须 recursive:true 才会递归删除全部内容,否则仅允许删除空目录。执行前需要用户审批。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '要删除的路径' },
        recursive: { type: 'boolean', description: '递归删除目录及其全部内容,默认 false' },
      },
      required: ['path'],
    },
  },
  {
    name: 'file_info',
    description: '查看文件/目录元信息:大小、类型、创建/修改时间、是否文本文件。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件或目录路径' },
      },
      required: ['path'],
    },
  },
  {
    name: 'run_code',
    description: '运行一段 JavaScript(Node)或 Python 代码并返回输出。代码写入临时文件后在当前工作目录执行(可读写工作目录文件),超时自动终止。执行前需要用户审批。适合计算、批量处理、调用专用库等命令行不好表达的场合。',
    parameters: {
      type: 'object',
      properties: {
        language: { type: 'string', enum: ['node', 'python'], description: '运行时,默认 node' },
        code: { type: 'string', description: '完整代码文件内容(不是 REPL 片段;需要输出请 console.log/print)' },
      },
      required: ['code'],
    },
  },
  {
    name: 'open_external',
    description: '用系统默认程序打开目标:https?:// 链接(系统浏览器,受安全门槛约束)或工作目录内的文件。HTML 文件会直接在应用内置浏览器中打开(立即可见,不再弹外部浏览器)。',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: '链接或文件路径' },
      },
      required: ['target'],
    },
  },
  {
    name: 'clipboard',
    description: '读取或写入系统剪贴板文本。注意:读取会拿到用户剪贴板中的全部内容(可能含敏感信息),仅在任务确有必要时使用。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['read', 'write'], description: 'read = 读取文本,write = 写入文本' },
        text: { type: 'string', description: 'action=write 时要写入的文本' },
      },
      required: ['action'],
    },
  },
  {
    name: 'system_info',
    description: '查看本机系统信息:操作系统/架构/CPU 核数/内存/开机时长/工作目录所在磁盘容量。',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'download_file',
    description: '下载 http/https 文件到工作目录(走网络代理与安全审计),大小上限 100MB。适合取模型/素材/发布包;网页正文请用 web_fetch。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '文件直链(http/https)' },
        path: { type: 'string', description: '保存路径(工作目录内,含文件名)' },
      },
      required: ['url', 'path'],
    },
  },
  // ===== 工具链扩充第二批(2026-10-25):复制 / 进程管理 / 通用 HTTP / 压缩包 / 截屏(agent.js) =====
  {
    name: 'copy_path',
    description: '复制文件或整个目录(递归)到新路径。目标已存在时报错不做覆盖;源与目标都必须在工作目录内。',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: '源路径(文件或目录)' },
        to: { type: 'string', description: '目标路径(不存在)' },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'process_list',
    description: '列出系统正在运行的进程(名称/PID/内存占用)。可按名称子串过滤。适合排查端口占用、确认程序是否卡死、找到要结束的进程 PID。',
    parameters: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: '可选,只列名称包含该子串的进程(忽略大小写)' },
      },
      required: [],
    },
  },
  {
    name: 'stop_process',
    description: '结束指定 PID 的进程树(Windows 用 taskkill /T)。执行前需要用户审批;系统关键进程与 LiteAgent 自身受保护不可结束。',
    parameters: {
      type: 'object',
      properties: {
        pid: { type: 'integer', description: '要结束的进程 PID(先用 process_list 查)' },
      },
      required: ['pid'],
    },
  },
  {
    name: 'web_request',
    description: '发起通用 HTTP 请求(GET/POST/PUT/PATCH/DELETE/HEAD)并返回状态码/响应头/响应体(截断 20KB)。适合调用 REST API、测试接口、发 webhook;读网页正文用 web_fetch、下载文件用 download_file。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '完整 http/https 地址' },
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'], description: '可选,默认 GET' },
        headers: { type: 'object', description: '可选,自定义请求头(如 content-type、authorization)' },
        body: { type: 'string', description: '可选,请求体(上限 64KB,常用于 JSON)' },
      },
      required: ['url'],
    },
  },
  {
    name: 'zip_create',
    description: '把文件或目录打包为 .zip(递归,自动跳过 node_modules/.git)。零依赖原生实现,上限 2000 个文件 / 200MB。',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: '源文件或目录(工作目录内)' },
        to: { type: 'string', description: '输出 .zip 路径(工作目录内)' },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'zip_extract',
    description: '解压 .zip 到指定目录(零依赖原生实现,支持 stored/deflate;加密 zip 会拒绝)。自动防护 zip-slip 路径穿越;上限 5000 条目 / 200MB。',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '.zip 文件路径(工作目录内)' },
        to: { type: 'string', description: '解压目标目录(工作目录内)' },
      },
      required: ['file', 'to'],
    },
  },
  // ===== 视频工具(2026-10-25 第三批):零依赖,复用 Chromium 原生 SVG 光栅化 / MediaRecorder / 解码器 =====
  {
    name: 'make_video',
    description: '把 SVG 帧序列合成为视频(.webm):你逐帧写 SVG(每帧一个完整 <svg> 文档),工具光栅化后按 fps 拼接成视频文件。适合动画、演示、进度可视化等矢量画面。上限 300 帧 / 1280×720;帧与帧之间只改变化的部分(位移/颜色/透明度),静态元素保持一致。',
    parameters: {
      type: 'object',
      properties: {
        frames: { type: 'array', items: { type: 'string' }, description: 'SVG 帧数组,每项一个完整 <svg>…</svg> 文档' },
        fps: { type: 'integer', description: '帧率 1-30,默认 10' },
        width: { type: 'integer', description: '画布宽 64-1280,默认 640' },
        height: { type: 'integer', description: '画布高 64-720,默认 360' },
        path: { type: 'string', description: '输出 .webm 路径(工作目录内)' },
      },
      required: ['frames', 'path'],
    },
  },
  {
    name: 'video_info',
    description: '查看视频文件元信息:时长、分辨率。支持 Chromium 能解码的格式(webm/mp4 等常见格式)。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '视频文件路径(工作目录内)' },
      },
      required: ['path'],
    },
  },
  // ===== 常规 Agent 能力补充(2026-10-25 第五批):窗口管理 / 系统通知 / 定时提醒 =====
  {
    name: 'window_list',
    description: '列出当前所有可见窗口(进程名/PID/窗口标题)。可按标题子串过滤。适合"找到某个程序的窗口再操作它"。',
    parameters: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: '可选,只列标题包含该子串的窗口' },
      },
      required: [],
    },
  },
  {
    name: 'window_action',
    description: '操作其他程序的窗口:激活(切到前台)/最小化/最大化/还原/关闭/置顶(取消置顶)。按 PID 或标题子串定位目标窗口(取第一个匹配)。关闭窗口可能丢失未保存内容,操作前与用户确认。',
    parameters: {
      type: 'object',
      properties: {
        pid: { type: 'integer', description: '目标进程 PID(与 title 二选一)' },
        title: { type: 'string', description: '目标窗口标题子串(与 pid 二选一,忽略大小写)' },
        action: { type: 'string', enum: ['activate', 'minimize', 'maximize', 'restore', 'close', 'topmost', 'untopmost'], description: '窗口操作' },
      },
      required: ['action'],
    },
  },
  {
    name: 'system_notify',
    description: '发一条 Windows 系统通知(右下角弹横幅)。适合长任务完成、需要用户注意时提醒(需在 设置→常规 开启任务通知)。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '通知标题' },
        body: { type: 'string', description: '通知正文' },
      },
      required: ['title'],
    },
  },
  {
    name: 'schedule_task',
    description: '设置一次性延时提醒:到时发送系统通知并输出到当前对话(仅本次运行期间有效,重启后失效;非持久定时任务)。',
    parameters: {
      type: 'object',
      properties: {
        delaySec: { type: 'integer', description: '延时秒数(1-86400)' },
        title: { type: 'string', description: '提醒标题' },
        body: { type: 'string', description: '提醒正文' },
      },
      required: ['delaySec', 'title'],
    },
  },
  {
    name: 'ask_user',
    description: '向用户提出选择题(会暂停等待用户回答,回答后继续)。用法:制定计划/方案遇到关键分歧点、需要用户拍板时调用(如技术选型、保存位置、命名风格)。给出 2-4 个由你设计的固定选项,系统会自动在末尾附加「自定义输入」入口(用户可填自己的路线);每个选项用 label 写短名称、detail 写一行补充说明(如「保存到桌面,双击就能玩」);有明确推荐项时在 label 末尾加「(推荐)」。不要连续滥用问询,能合理默认的直接做。',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '问句,如:你想用哪种方式搭建?' },
        context: { type: 'string', description: '背景补充(1-2 句,可选)' },
        options: {
          type: 'array',
          maxItems: 4,
          description: '2-4 个固定选项',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: '选项短名称(≤30 字,推荐项末尾加「(推荐)」)' },
              detail: { type: 'string', description: '选项一行说明(可选)' },
            },
            required: ['label'],
          },
        },
      },
      required: ['question', 'options'],
    },
  },
  {
    name: 'serve_dir',
    description: '把工作目录(或其子目录)起一个本地 HTTP 服务器(仅 127.0.0.1 可访问,默认 15 分钟自动停止)。网页游戏/H5 项目的刚需:ES 模块、fetch、CORS、音频自动播放都要求 http:// 源,file:// 直开会全部失效。返回 URL 后用 open_external 给用户预览,或用 browser_check 无头验证。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '要服务的目录(相对工作目录),默认 "."' },
        minutes: { type: 'integer', description: '自动停止的分钟数(1-60,默认 15)' },
      },
      required: [],
    },
  },
  {
    name: 'stop_serve',
    description: '停止 serve_dir 启动的本地 HTTP 服务器(不传 serviceId 则停止全部)。',
    parameters: {
      type: 'object',
      properties: {
        serviceId: { type: 'string', description: 'serve_dir 返回的 serviceId(如 srv-1);不填停全部' },
      },
      required: [],
    },
  },
];

// 创造模式专属:智能体自我扩展(管理自己的助手角色与技能)
const SELF_DEFINITIONS = [
  {
    name: 'manage_assistants',
    description: '管理"助手角色"(顶栏可切换的系统提示词预设)。action=list 查看现有;create 创建;update 修改;delete 删除(默认助手不可删)。创建的助手立即出现在顶栏选择器中。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'update', 'delete'], description: '操作类型' },
        id: { type: 'string', description: 'update/delete 时必填,先用 list 查询' },
        name: { type: 'string', description: '角色名,简短(如:编程专家)' },
        icon: { type: 'string', description: '一个 emoji 图标' },
        prompt: { type: 'string', description: '角色系统提示词,写清楚身份、风格、输出要求' },
      },
      required: ['action'],
    },
  },
  {
    name: 'manage_skills',
    description: '管理"技能"(输入框上方的快捷任务卡片,点击即激活对应指令)。action=list/create/update/delete。创建的技能立即出现在技能栏。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'update', 'delete'], description: '操作类型' },
        id: { type: 'string', description: 'update/delete 时必填' },
        name: { type: 'string', description: '技能名,2-6 个字最佳' },
        icon: { type: 'string', description: '一个 emoji 图标' },
        prompt: { type: 'string', description: '激活该技能时附加的系统指令' },
        insert: { type: 'string', description: '可选,激活时预填到输入框的模板' },
        agent: { type: 'boolean', description: '是否需要调用工具(建议配合完全/受限模式)' },
      },
      required: ['action'],
    },
  },
];

function selfChange(ctx) {
  try { if (ctx && ctx.onChange) ctx.onChange(); } catch (_) { /* ignore */ }
}

// ---- 记忆 / 学习(v0.41,开发者选项开关门控,由 agent.js 按开关注入工具) ----
const MEMORY_DEFINITIONS = [
  {
    name: 'memory_save',
    description: '保存一条长期记忆:用户的偏好、习惯、重要事实、项目背景、与用户的约定等。跨会话生效(开启记忆功能时,所有新对话自动继承)。只在值得长期记住时使用;不要保存密码/密钥等敏感信息;不要重复保存已有内容。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '记忆内容,一句话,简明具体(如:用户的 VRChat 工程在 D:\\VRChat\\Projects)' },
      },
      required: ['text'],
    },
  },
];

const LEARN_DEFINITIONS = [
  {
    name: 'self_learn',
    description: '把用户纠正你的做法/教授的经验沉淀为长期知识。两种去向:kind=prompt 写入「用户提示词」—— 之后的每次对话自动生效,适合通用规矩与偏好(如"回答先给结论再给细节");kind=skill 创建「用户技能」—— 出现在输入框上方技能栏,用户点击启用,适合可复现的操作流程(如"部署步骤")。当用户指出你的错误并给出正确方法,或说"以后都这样做/记住这个方法"时使用。',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['prompt', 'skill'], description: 'prompt=每次对话自动生效的规矩;skill=技能栏卡片,按需启用' },
        title: { type: 'string', description: '标题:prompt 是规矩名(如"先结论后细节");skill 是技能名(2-6 个字)' },
        content: { type: 'string', description: '完整内容:用户教的正确方法,写具体、可执行,让下次照做不再犯错' },
      },
      required: ['kind', 'title', 'content'],
    },
  },
];

function memorySaveExec(args, ctx) {
  const store = ctx.store;
  if (!store || !store.config) throw new Error('内部错误:缺少配置访问');
  const clean = String(args.text || '').trim().slice(0, 400);
  if (!clean) throw new Error('缺少 text');
  let list = (store.config.memories || []).slice();
  if (list.some((m) => m.text === clean)) return '该记忆已存在,无需重复保存。';
  list.push({ id: 'mem-' + Math.random().toString(36).slice(2, 8), text: clean, createdAt: Date.now() });
  if (list.length > 200) list = list.slice(-200); // 上限 200 条:超出淘汰最旧
  store.updateConfig({ memories: list });
  selfChange(ctx);
  return `已保存长期记忆(${list.length}/200): ${clean}`;
}

function selfLearnExec(args, ctx) {
  const store = ctx.store;
  if (!store || !store.config) throw new Error('内部错误:缺少配置访问');
  const kind = String(args.kind || '');
  const title = String(args.title || '').trim();
  const content = String(args.content || '').trim();
  if (!title || !content) throw new Error('缺少 title 或 content');
  if (kind === 'prompt') {
    const list = (store.config.learnedPrompts || []).slice();
    const clean = content.slice(0, 2000);
    if (list.some((x) => x.text === clean)) return '该经验已在用户提示词中,无需重复学习。';
    list.push({ id: 'lp-' + Math.random().toString(36).slice(2, 8), title: title.slice(0, 30), text: clean, createdAt: Date.now() });
    if (list.length > 100) list = list.slice(-100);
    store.updateConfig({ learnedPrompts: list });
    selfChange(ctx);
    return `已沉淀为用户提示词「${title.slice(0, 30)}」(${list.length}/100):之后的每次对话自动生效。`;
  }
  if (kind === 'skill') {
    const list = (store.config.skills || []).slice();
    const name0 = title.slice(0, 20);
    const exist = list.find((s) => s.learned && s.name === name0);
    if (exist) {
      exist.prompt = content.slice(0, 4000);
      store.updateConfig({ skills: list });
      selfChange(ctx);
      return `已更新学习技能「${name0}」。`;
    }
    // 与既有技能同名时加后缀,不覆盖用户自建技能
    const name = list.some((s) => s.name === name0) ? (name0 + '-学').slice(0, 20) : name0;
    list.push({ id: 'learned-' + Math.random().toString(36).slice(2, 8), name, icon: '📖', prompt: content.slice(0, 4000), insert: '', agent: false, learned: true });
    store.updateConfig({ skills: list });
    selfChange(ctx);
    return `已沉淀为用户技能「${name}」(📖 输入框上方技能栏可启用):之后的对话中按需启用。`;
  }
  throw new Error('kind 必须是 prompt 或 skill');
}

function manageAssistantsExec(args, ctx) {
  const store = ctx.store;
  if (!store || !store.config) throw new Error('内部错误:缺少配置访问');
  const action = String(args.action || '');
  let list = (store.config.assistants || []).slice();

  if (action === 'list') {
    if (!list.length) return '(暂无助手角色)';
    return list.map((a) => `- id:${a.id} | ${a.icon || '🤖'} ${a.name}${a.id === 'default' ? '(默认,不可删)' : ''}\n  提示词: ${(a.prompt || '(空)').slice(0, 100).replace(/\n/g, ' ')}`).join('\n');
  }
  if (action === 'create') {
    const name = String(args.name || '').trim();
    if (!name) throw new Error('缺少 name');
    if (list.some((a) => a.name === name)) throw new Error(`已存在同名助手「${name}」,可换名或用 update 修改它`);
    const item = {
      id: 'ast-' + Math.random().toString(36).slice(2, 8),
      name: name.slice(0, 30),
      icon: String(args.icon || '🧩').slice(0, 8) || '🧩',
      prompt: String(args.prompt || '').slice(0, 8000),
    };
    list.push(item);
    store.updateConfig({ assistants: list });
    selfChange(ctx);
    return `已创建助手「${item.name}」(id: ${item.id}),已出现在顶栏选择器。`;
  }
  if (action === 'update') {
    const item = list.find((a) => a.id === args.id);
    if (!item) throw new Error('未找到该助手 id,可先 action=list 查询');
    if (args.name !== undefined && String(args.name).trim()) item.name = String(args.name).trim().slice(0, 30);
    if (args.icon !== undefined && String(args.icon).trim()) item.icon = String(args.icon).trim().slice(0, 8);
    if (args.prompt !== undefined) item.prompt = String(args.prompt).slice(0, 8000);
    store.updateConfig({ assistants: list });
    selfChange(ctx);
    return `已更新助手「${item.name}」。`;
  }
  if (action === 'delete') {
    if (args.id === 'default') throw new Error('默认助手不可删除');
    const before = list.length;
    list = list.filter((a) => a.id !== args.id);
    if (list.length === before) throw new Error('未找到该助手 id');
    store.updateConfig({ assistants: list });
    selfChange(ctx);
    return '已删除该助手。';
  }
  throw new Error('action 必须是 list/create/update/delete');
}

function manageSkillsExec(args, ctx) {
  const store = ctx.store;
  if (!store || !store.config) throw new Error('内部错误:缺少配置访问');
  const action = String(args.action || '');
  let list = (store.config.skills || []).slice();

  if (action === 'list') {
    if (!list.length) return '(暂无技能)';
    return list.map((s) => `- id:${s.id} | ${s.icon || '⚡'} ${s.name} | 需工具:${!!s.agent}\n  附加指令: ${(s.prompt || '(空)').slice(0, 100).replace(/\n/g, ' ')}`).join('\n');
  }
  if (action === 'create') {
    const name = String(args.name || '').trim();
    if (!name) throw new Error('缺少 name');
    if (list.some((s) => s.name === name)) throw new Error(`已存在同名技能「${name}」`);
    const item = {
      id: 'skill-' + Math.random().toString(36).slice(2, 8),
      name: name.slice(0, 20),
      icon: String(args.icon || '⚡').slice(0, 8) || '⚡',
      prompt: String(args.prompt || '').slice(0, 4000),
      insert: String(args.insert || '').slice(0, 2000),
      agent: !!args.agent,
    };
    list.push(item);
    store.updateConfig({ skills: list });
    selfChange(ctx);
    return `已创建技能「${item.name}」(id: ${item.id}),已出现在输入框上方技能栏。`;
  }
  if (action === 'update') {
    const item = list.find((s) => s.id === args.id);
    if (!item) throw new Error('未找到该技能 id,可先 action=list 查询');
    if (args.name !== undefined && String(args.name).trim()) item.name = String(args.name).trim().slice(0, 20);
    if (args.icon !== undefined && String(args.icon).trim()) item.icon = String(args.icon).trim().slice(0, 8);
    if (args.prompt !== undefined) item.prompt = String(args.prompt).slice(0, 4000);
    if (args.insert !== undefined) item.insert = String(args.insert).slice(0, 2000);
    if (args.agent !== undefined) item.agent = !!args.agent;
    store.updateConfig({ skills: list });
    selfChange(ctx);
    return `已更新技能「${item.name}」。`;
  }
  if (action === 'delete') {
    const before = list.length;
    list = list.filter((s) => s.id !== args.id);
    if (list.length === before) throw new Error('未找到该技能 id');
    store.updateConfig({ skills: list });
    selfChange(ctx);
    return '已删除该技能。';
  }
  throw new Error('action 必须是 list/create/update/delete');
}

function resolveIn(p, workspace) {
  if (typeof p !== 'string' || !p.trim()) throw new Error('缺少 path 参数');
  return path.isAbsolute(p) ? path.normalize(p) : path.resolve(workspace, p);
}

// Windows 下很多命令输出 GBK:优先按 UTF-8 解码,出现替换符时回退 GBK
function decodeBuffer(buf) {
  let text = buf.toString('utf8');
  if (text.includes('\uFFFD')) {
    try {
      const alt = new TextDecoder('gbk').decode(buf);
      if (!alt.includes('\uFFFD')) text = alt;
    } catch (_) { /* ICU 不含 gbk 时忽略 */ }
  }
  return text;
}

function stripHtml(html) {
  const entities = {
    '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
    '&#39;': "'", '&nbsp;': ' ', '&copy;': '©', '&mdash;': '—',
  };
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/table|\/section|\/article|\/header|\/footer)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(amp|lt|gt|quot|#39|nbsp|copy|mdash);/g, (m) => entities[m] || m)
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

function fetchWithTimeout(url, opts, ms, outerSignal) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error(`请求超时(${ms / 1000}s)`)), ms);
  const onAbort = () => ac.abort(outerSignal && outerSignal.reason ? outerSignal.reason : new Error('已中止'));
  if (outerSignal) {
    if (outerSignal.aborted) onAbort();
    else outerSignal.addEventListener('abort', onAbort, { once: true });
  }
  return http.fetch(url, {
    signal: ac.signal,
    headers: { 'user-agent': 'Mozilla/5.0 (LiteAgent/0.1)' },
    redirect: 'follow',
    ...opts,
  }).finally(() => {
    clearTimeout(timer);
    if (outerSignal) outerSignal.removeEventListener('abort', onAbort);
  });
}

function runCommand(command, cwd, timeoutSec, signal) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, {
        shell: true,
        cwd,
        windowsHide: true,
        env: { ...process.env, NO_COLOR: '1', TERM: 'dumb' },
      });
    } catch (e) {
      resolve(`命令启动失败: ${e.message}`);
      return;
    }

    const CAP = 64 * 1024;
    const chunks = [];
    const size = () => chunks.reduce((n, c) => n + c.length, 0);
    let killed = false;

    const killTree = () => {
      killed = true;
      try {
        if (process.platform === 'win32' && child.pid) {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        } else {
          child.kill('SIGKILL');
        }
      } catch (_) { try { child.kill(); } catch (_) { /* ignore */ } }
    };

    const timer = setTimeout(killTree, Math.max(5, Number(timeoutSec) || 120) * 1000);
    const onAbort = () => killTree();
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout.on('data', (d) => { if (size() < CAP * 2) chunks.push(d); });
    child.stderr.on('data', (d) => { if (size() < CAP * 2) chunks.push(d); });

    child.on('error', (e) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve(`命令启动失败: ${e.message}`);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      let out = decodeBuffer(Buffer.concat(chunks)).trim();
      let truncated = '';
      if (out.length > CAP) { out = out.slice(0, CAP); truncated = '\n…(输出过长已截断)'; }
      const head = killed ? '命令超时或被中止,已强制结束。\n' : '';
      resolve(`${head}退出码: ${code === null ? '-' : code}\n${out ? out + truncated : '(无输出)'}`);
    });
  });
}

// 沙箱检查:文件路径锁定/系统区黑名单;失败抛错并记审计。
// 在 path.resolve 之上追加 realpath 防线:junction/symlink 的真实指向也必须在工作目录内
// (path.resolve 不解析链接,mklink /J 建在工作目录内即可让表面路径穿透 —— 攻防测试 B2 锚定)。
async function assertFsPath(abs, ctx, toolName) {
  const sb = ctx.sandbox || { fsLock: true, cmdScreen: 'strict' };
  const c = sandbox.checkFsPath(abs, ctx.workspace, sb.fsLock);
  if (!c.ok) {
    if (ctx.store) security.auditAppend(ctx.store, { kind: 'sandbox', tool: toolName, detail: String(c.reason).slice(0, 200) });
    throw new Error(c.reason);
  }
  let real = null;
  try {
    real = await fsp.realpath(c.path);
  } catch (_) {
    // 路径尚不存在(写入场景):对最近的现存祖先解析链接后再拼回
    try { real = path.join(await fsp.realpath(path.dirname(c.path)), path.basename(c.path)); } catch (_) { /* 祖先也不存在时无从解析 */ }
  }
  if (real) {
    const c2 = sandbox.checkFsPath(real, ctx.workspace, sb.fsLock);
    if (!c2.ok) {
      const reason = `已按沙箱设置拦截:该路径是目录链接(junction/symlink)或短文件名,真实指向越出允许范围。${c2.reason}`;
      if (ctx.store) security.auditAppend(ctx.store, { kind: 'sandbox', tool: toolName, detail: reason.slice(0, 200) });
      throw new Error(reason);
    }
  }
  return c.path;
}

// ===== 工具链扩充 helper(v0.53.0) =====
const clipText = (s, n) => (String(s || '').length > n ? String(s || '').slice(0, n) + '…' : String(s || ''));

// mini-glob:** 任意层(含 0 层)、* 单层任意、? 单字符、[abc] 字符类;其余字符字面
function globToRegex(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        const j = i + 2;
        if (pattern[j] === '/') { re += '(?:.*/)?'; i = j; } // **/ = 任意层目录前缀(含无)
        else { re += '.*'; i = j - 1; }
      } else re += '[^/\\\\]*';
    } else if (c === '?') re += '[^/\\\\]';
    else if (c === '[') {
      const end = pattern.indexOf(']', i + 1);
      if (end > i + 1) { re += '[' + pattern.slice(i + 1, end).replace(/\\/g, '\\\\') + ']'; i = end; }
      else re += '\\[';
    } else re += c.replace(/[.+^${}()|?*[\]]/g, '\\$&');
  }
  return new RegExp('^' + re + '$', 'i');
}

// 递归遍历目录(相对路径 + 相对工作目录沙箱检查);跳过 node_modules/.git;上限 maxFiles 防大目录卡死
async function walkFiles(rootAbs, cb, maxFiles = 4000) {
  const SKIP = new Set(['node_modules', '.git']);
  let count = 0;
  const queue = [['', rootAbs]];
  while (queue.length) {
    const [rel, abs] = queue.shift();
    let entries;
    try { entries = await fsp.readdir(abs, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of entries) {
      if (SKIP.has(e.name)) continue;
      const childRel = rel ? rel + '/' + e.name : e.name;
      const childAbs = path.join(abs, e.name);
      if (e.isDirectory()) queue.push([childRel, childAbs]);
      else if (e.isFile()) {
        count++;
        if (await cb(childRel, childAbs) === false) return count;
        if (count >= maxFiles) return count;
      }
    }
  }
  return count;
}

const TEXT_EXTS = new Set(['.txt', '.md', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.html', '.htm', '.css', '.scss', '.less', '.xml', '.yml', '.yaml', '.csv', '.log', '.py', '.rb', '.go', '.rs', '.java', '.kt', '.c', '.h', '.cpp', '.hpp', '.cs', '.php', '.sh', '.bat', '.cmd', '.ps1', '.psm1', '.sql', '.ini', '.cfg', '.conf', '.toml', '.env', '.gitignore', '.shader', '.glsl', '.hlsl', '.cginc', '.unity', '.prefab', '.mat', '.asset', '.anim', '.controller', '.uxml', '.uss', '.asmdef', '.csproj', '.sln', '.vue', '.svelte', '.proto', '.gradle', '.properties', '.lock']);

async function isTextFile(abs, size) {
  if (size > 1024 * 1024) return false;
  if (TEXT_EXTS.has(path.extname(abs).toLowerCase())) return true;
  // 无扩展名/未知扩展名:读头部 2KB 查 NUL 字节判二进制
  const fd = await fsp.open(abs, 'r').catch(() => null);
  if (!fd) return false;
  try {
    const buf = Buffer.alloc(Math.min(2048, size));
    await fd.read(buf, 0, buf.length, 0);
    return !buf.includes(0);
  } finally { await fd.close(); }
}

// ===== 图片隐私保护(v0.54.1) =====
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.svg', '.tif', '.tiff', '.heic', '.avif', '.raw']);
function isImagePath(abs) { return IMAGE_EXTS.has(path.extname(String(abs || '')).toLowerCase()); }

// 图片隐私闸门:开启(security.imagePrivacy !== false,默认开)后,无论沙箱模式如何,
// 图片一律只允许访问工作目录内的 —— 工作区外的图片读取/打开/查看强制拦截,与沙箱开关解耦。
// 用户手动发到聊天里的图片走附件通道,不经过文件路径,天然不受影响。
async function assertImagePrivacy(abs, ctx, toolName) {
  if (!ctx.security || ctx.security.imagePrivacy === false) return;
  if (!isImagePath(abs)) return;
  const c = sandbox.checkFsPath(abs, ctx.workspace, true); // 强制目录锁定,与沙箱设置无关
  if (!c.ok) {
    if (ctx.store) security.auditAppend(ctx.store, { kind: 'privacy', tool: toolName, path: String(abs).slice(0, 200) });
    throw new Error(`图片隐私保护:已强制拦截 —— 「${path.basename(abs)}」在工作目录之外,AI 禁止访问/查看工作目录外的图片。只有工作目录内的图片、或你手动发到聊天里的图片才可访问(可在 设置→安全 关闭图片隐私)。`);
  }
}

// run_code 的 Node 进程内守卫:预载脚本把 fs 读文件 API 包一层,工作目录之外的图片一律读取失败。
// 覆盖 readFileSync/readFile/promises.readFile/createReadStream;代码内再开子进程绕过属于沙箱固有边界,由 run_command 人工审批兜底
async function writeImageGuard(workspace) {
  const guard = `'use strict';
(function () {
  var path = require('path');
  var WORKSPACE = ${JSON.stringify(workspace)};
  var IMG = ${JSON.stringify([...IMAGE_EXTS])};
  function outsideImage(p) {
    try {
      var abs = path.resolve(String(p));
      if (IMG.indexOf(path.extname(abs).toLowerCase()) === -1) return null;
      var rel = path.relative(WORKSPACE, abs);
      return (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) ? null : abs;
    } catch (_) { return null; }
  }
  var MSG = '图片隐私保护:已拦截对工作目录之外图片的读取(用户隐私图片不可访问)。';
  var fs = require('fs');
  function wrapSync(fn) {
    return function (p) {
      var hit = outsideImage(p);
      if (hit) throw new Error(MSG + ' [' + hit + ']');
      return fn.apply(this, arguments);
    };
  }
  function wrapCb(fn) {
    return function (p) {
      var hit = outsideImage(p);
      var cb = arguments[arguments.length - 1];
      if (hit && typeof cb === 'function') { process.nextTick(cb, new Error(MSG + ' [' + hit + ']')); return; }
      if (hit) throw new Error(MSG + ' [' + hit + ']');
      return fn.apply(this, arguments);
    };
  }
  function wrapPromise(fn) {
    return function (p) {
      var hit = outsideImage(p);
      if (hit) return Promise.reject(new Error(MSG + ' [' + hit + ']'));
      return fn.apply(this, arguments);
    };
  }
  fs.readFileSync = wrapSync(fs.readFileSync);
  fs.readFile = wrapCb(fs.readFile);
  if (fs.promises && fs.promises.readFile) fs.promises.readFile = wrapPromise(fs.promises.readFile);
  // fd 族防线:readFile/createReadStream 之外,open 拿 fd 再 read 同样能读出图片字节(openSync/open/
  // promises.open 一并包装;后续 readSync/read 只见 fd 不见路径,必须在 open 处拦截)
  fs.openSync = wrapSync(fs.openSync);
  fs.open = wrapCb(fs.open);
  if (fs.promises && fs.promises.open) fs.promises.open = wrapPromise(fs.promises.open);
  var origStream = fs.createReadStream;
  fs.createReadStream = function (p) {
    var hit = outsideImage(p);
    if (hit) throw new Error(MSG + ' [' + hit + ']');
    return origStream.apply(fs, arguments);
  };
})();
`;
  const f = path.join(os.tmpdir(), `liteagent-imgguard-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.js`);
  await fsp.writeFile(f, guard, 'utf8');
  return f;
}

// ===== 工具链第二批 helper(2026-10-25):复制 / 进程 / zip(零依赖) =====
// 递归复制(上限 4000 文件 / 500MB)
async function copyTree(fromAbs, toAbs) {
  const st = await fsp.stat(fromAbs);
  if (st.isFile()) {
    await fsp.mkdir(path.dirname(toAbs), { recursive: true });
    await fsp.copyFile(fromAbs, toAbs);
    return { files: 1, dirs: 0, bytes: st.size };
  }
  let files = 0, dirs = 0, bytes = 0;
  const cp = async (src, dst) => {
    if (files > 4000 || bytes > 500 * 1024 * 1024) throw new Error('复制规模超上限(4000 文件 / 500MB),请分批处理');
    const s = await fsp.stat(src);
    if (s.isDirectory()) {
      dirs++;
      await fsp.mkdir(dst, { recursive: true });
      for (const e of await fsp.readdir(src, { withFileTypes: true })) await cp(path.join(src, e.name), path.join(dst, e.name));
    } else {
      files++;
      bytes += s.size;
      await fsp.mkdir(path.dirname(dst), { recursive: true });
      await fsp.copyFile(src, dst);
    }
  };
  await cp(fromAbs, toAbs);
  return { files, dirs, bytes };
}

// —— 本地 HTTP 服务器(v0.54.21 游戏工具链):网页游戏/H5 的 http:// 源刚需 ——
// 仅 127.0.0.1 可访问;上限 3 个并发;默认 15 分钟自动停止;请求路径限定在服务目录内(防穿越)
const SERVE_MIME = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', js: 'text/javascript', mjs: 'text/javascript',
  css: 'text/css', json: 'application/json', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp', ico: 'image/x-icon', mp3: 'audio/mpeg',
  ogg: 'audio/ogg', wav: 'audio/wav', glb: 'model/gltf-binary', gltf: 'model/gltf+json', wasm: 'application/wasm',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', map: 'application/json',
  md: 'text/markdown; charset=utf-8', txt: 'text/plain; charset=utf-8',
};
const serveServers = new Map(); // id → { srv, dir, timer }
let serveSeq = 0;
function stopServeById(id) {
  const s = serveServers.get(id);
  if (!s) return false;
  if (s.timer) clearTimeout(s.timer);
  try { s.srv.close(); } catch (_) { /* 已停 */ }
  serveServers.delete(id);
  return true;
}
async function serveDirStart(args, ctx) {
  if (serveServers.size >= 3) throw new Error('本地服务器已达上限(3 个),请先用 stop_serve 停掉不需要的');
  const rel = String(args.path || '.');
  const abs = await assertFsPath(path.isAbsolute(rel) ? path.normalize(rel) : path.resolve(ctx.workspace, rel), ctx, 'serve_dir');
  const st = await fsp.stat(abs).catch(() => null);
  if (!st || !st.isDirectory()) throw new Error(`不是目录: ${abs}`);
  const minutes = Math.min(60, Math.max(1, parseInt(args.minutes, 10) || 15));
  const id = 'srv-' + (++serveSeq);
  const srv = require('http').createServer((req, res) => {
    try {
      const relReq = decodeURIComponent(String(req.url || '/').split('?')[0]).replace(/^\/+/, '') || 'index.html';
      const full = path.resolve(abs, relReq);
      if (path.relative(abs, full).startsWith('..')) { res.writeHead(403); res.end('403'); return; } // 穿越快判(目录内限定)
      let target = full;
      const st2 = fs.statSync(full); // 不存在/非法 → 404
      if (st2.isDirectory()) target = path.join(full, 'index.html');
      const ext = path.extname(target).slice(1).toLowerCase();
      res.writeHead(200, { 'content-type': SERVE_MIME[ext] || 'application/octet-stream', 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
      fs.createReadStream(target).pipe(res);
    } catch (_) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
    }
  });
  await new Promise((resolve, reject) => { srv.once('error', reject); srv.listen(0, '127.0.0.1', () => resolve()); });
  const port = srv.address().port;
  const timer = setTimeout(() => stopServeById(id), minutes * 60000);
  if (timer.unref) timer.unref();
  serveServers.set(id, { srv, dir: abs, timer });
  return `本地服务器已启动 → http://127.0.0.1:${port}/\n- 根目录: ${abs}\n- serviceId: ${id}(${minutes} 分钟后自动停止,或用 stop_serve 手动停)\n- 用 open_external 打开该 URL 给用户预览,或用 browser_check 无头加载验证渲染与报错`;
}

// 进程列表:Windows tasklist CSV;POSIX ps。只读,供 AI 排查卡死/占用
async function processList(filterText) {
  const flt = String(filterText || '').toLowerCase();
  let out = '';
  if (process.platform === 'win32') {
    out = await runCommand('tasklist /fo csv /nh', undefined, 20, null);
  } else {
    out = await runCommand('ps -eo pid,comm,rss --no-headers', undefined, 20, null);
  }
  const rows = [];
  for (const line of String(out || '').split(/\r?\n/)) {
    if (process.platform === 'win32') {
      const cells = (line.match(/"([^"]*)"/g) || []).map((s) => s.slice(1, -1));
      if (cells.length >= 5 && /^\d+$/.test(cells[1])) {
        rows.push({ name: cells[0], pid: cells[1], mem: cells[4] });
      }
    } else {
      const c = line.trim().split(/\s+/);
      if (c.length >= 3 && /^\d+$/.test(c[0])) rows.push({ name: c[1], pid: c[0], mem: c[2] + ' KB' });
    }
  }
  const hit = flt ? rows.filter((r) => r.name.toLowerCase().includes(flt)) : rows;
  const lines = hit.slice(0, 200).map((r) => `${r.pid}\t${r.name}\t${r.mem}`);
  return `共 ${rows.length} 个进程${flt ? `,匹配「${filterText}」${hit.length} 个` : ''}${hit.length > 200 ? '(仅列前 200)' : ''}:\nPID\t名称\t内存\n` + (lines.join('\n') || '(无匹配)');
}

// 结束进程:保护自身与系统关键进程(黑名单法 + 自杀拦截);真正执行由 agent 层审批把关
const PROC_GUARD = new Set(['system', 'registry', 'idle', 'wininit.exe', 'csrss.exe', 'winlogon.exe', 'services.exe', 'lsass.exe', 'smss.exe', 'svchost.exe', 'dwm.exe', 'explorer.exe', 'fontdrvhost.exe']);
async function stopProcess(pid) {
  const n = parseInt(pid, 10);
  if (!Number.isInteger(n) || n <= 0) throw new Error('pid 必须是正整数');
  if (n === process.pid) throw new Error('拒绝结束 LiteAgent 自身进程');
  // 反查进程名,系统关键进程保护(查不到名称时也放行到 taskkill,由系统权限兜底)
  if (process.platform === 'win32') {
    const probe = await runCommand(`tasklist /fi "PID eq ${n}" /fo csv /nh`, undefined, 15, null);
    const name = ((String(probe).match(/"([^"]*)"/) || [])[1] || '').toLowerCase();
    if (name && PROC_GUARD.has(name)) throw new Error(`拒绝结束系统关键进程: ${name}(PID ${n})`);
    const out = await runCommand(`taskkill /pid ${n} /T /F`, undefined, 20, null);
    return out;
  }
  try { process.kill(n, 'SIGTERM'); } catch (e) { throw new Error(`结束进程失败: ${e.message}`); }
  return `已向 PID ${n} 发送 SIGTERM`;
}

// ===== zip 零依赖实现(zlib inflateRaw/deflateRaw;CRC32 查表) =====
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function dosDateTime(d) {
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const time = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xFFFF;
  return { date: date & 0xFFFF, time };
}

async function zipCreate(fromAbs, toAbs) {
  const st = await fsp.stat(fromAbs).catch(() => { throw new Error(`源路径不存在: ${fromAbs}`); });
  // 收集文件清单(目录递归,跳过 node_modules/.git)
  const files = [];
  if (st.isFile()) files.push({ name: path.basename(fromAbs), abs: fromAbs });
  else await walkFiles(fromAbs, async (rel, abs) => { if (files.length < 2000) files.push({ name: rel, abs }); });
  if (files.length > 2000) throw new Error('文件数超过上限(2000),请分批打包');
  const chunks = [];
  const central = [];
  let offset = 0;
  let totalRaw = 0;
  const { date, time } = dosDateTime(new Date());
  for (const f of files) {
    const data = await fsp.readFile(f.abs);
    totalRaw += data.length;
    if (totalRaw > 200 * 1024 * 1024) throw new Error('打包总量超过上限(200MB)');
    let method = 8;
    let comp = require('zlib').deflateRawSync(data);
    if (comp.length >= data.length) { method = 0; comp = data; }
    const nameBuf = Buffer.from(f.name.split(path.sep).join('/'), 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0x0800, 6);      // UTF-8 名
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, comp);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);             // version made by
    cd.writeUInt16LE(20, 6);             // version needed
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(comp.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);             // extra len
    cd.writeUInt16LE(0, 32);             // comment len
    cd.writeUInt16LE(0, 34);             // disk
    cd.writeUInt16LE(0, 36);             // internal attr
    cd.writeUInt32LE(0, 38);             // external attr
    cd.writeUInt32LE(offset, 42);        // local header offset
    central.push(cd, nameBuf);
    offset += local.length + nameBuf.length + comp.length;
  }
  const cdStart = offset;
  let cdSize = 0;
  for (const c of central) cdSize += c.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdStart, 16);
  await fsp.mkdir(path.dirname(toAbs), { recursive: true });
  await fsp.writeFile(toAbs, Buffer.concat([...chunks, ...central, eocd]));
  return `已打包 ${files.length} 个文件(${(totalRaw / 1024).toFixed(1)} KB 原始数据)→ ${toAbs}`;
}

async function zipExtract(fileAbs, toAbs) {
  const buf = await fsp.readFile(fileAbs).catch(() => { throw new Error(`zip 文件不存在: ${fileAbs}`); });
  if (buf.length < 22) throw new Error('不是有效的 zip 文件(过小)');
  // EOCD 从尾部回扫(允许注释区)
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 zip 文件(缺少中央目录)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (count > 5000) throw new Error(`条目数超上限(${count} > 5000)`);
  const zlib = require('zlib');
  await fsp.mkdir(toAbs, { recursive: true });
  let files = 0, dirs = 0, totalOut = 0;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip 中央目录损坏');
    const flags = buf.readUInt16LE(p + 8);
    if (flags & 0x1) throw new Error('加密 zip 不支持,请先解密');
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString('utf8');
    p += 46 + nlen + elen + clen;
    if (!name) continue;
    // zip-slip 防护:条目名解析后必须落在目标目录内(绝对路径/../ 均拒)
    if (/^[a-zA-Z]:|^\/|^\\/.test(name) || name.split(/[\\/]/).includes('..')) {
      throw new Error(`zip 条目路径可疑,已拒绝: ${name}`);
    }
    const target = path.resolve(toAbs, name);
    if (path.relative(toAbs, target).startsWith('..')) throw new Error(`zip 条目路径越界,已拒绝: ${name}`);
    if (name.endsWith('/')) {
      await fsp.mkdir(target, { recursive: true });
      dirs++;
      continue;
    }
    if (buf.readUInt32LE(lho) !== 0x04034b50) throw new Error('zip 本地头损坏: ' + name);
    const lnlen = buf.readUInt16LE(lho + 26);
    const lelen = buf.readUInt16LE(lho + 28);
    const dataStart = lho + 30 + lnlen + lelen;
    let data;
    if (method === 0) data = buf.slice(dataStart, dataStart + csize);
    else if (method === 8) {
      try {
        data = zlib.inflateRawSync(buf.slice(dataStart, dataStart + csize), { maxOutputLength: 100 * 1024 * 1024 });
      } catch (e) {
        throw new Error(`解压失败(${name}): ${e.message}`);
      }
    } else throw new Error(`不支持的压缩方法(${method}): ${name}`);
    if (data.length !== usize) throw new Error(`zip 条目大小不符(疑似 zip bomb),已拒绝: ${name}`);
    if (crc32(data) !== crc) throw new Error(`CRC 校验失败: ${name}`);
    totalOut += data.length;
    if (totalOut > 200 * 1024 * 1024) throw new Error('解压总量超上限(200MB),已中止');
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, data);
    files++;
  }
  return `已解压 ${files} 个文件、${dirs} 个目录(${(totalOut / 1024).toFixed(1)} KB)→ ${toAbs}`;
}

// run_code 运行器:代码写临时文件 → 复用 runCommand(工作目录执行、超时/中止、输出捕获)→ 清理
async function runCodeFile(language, code, ctx) {
  if (typeof code !== 'string' || !code.trim()) throw new Error('缺少 code 参数');
  if (code.length > 256 * 1024) throw new Error('代码过长(上限 256KB)');
  const lang = language === 'python' ? 'python' : 'node';
  const ext = lang === 'python' ? '.py' : '.js';
  const tmpFile = path.join(os.tmpdir(), `liteagent-runcode-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}${ext}`);
  await fsp.writeFile(tmpFile, code, 'utf8');
  let guardFile = null;
  try {
    const quoted = `"${tmpFile}"`;
    if (lang === 'node') {
      // 图片隐私开启时注入进程内守卫(python 无等价机制,靠审批兜底)
      if (ctx.security && ctx.security.imagePrivacy !== false) guardFile = await writeImageGuard(ctx.workspace);
      return await runCommand(`node${guardFile ? ` --require "${guardFile}"` : ''} ${quoted}`, ctx.workspace, ctx.shellTimeout, ctx.signal);
    }
    // python:优先 python,启动失败(常见于只有 py launcher 的 Windows)回退 py
    const pyCheck = await runCommand('python --version', ctx.workspace, 10, ctx.signal);
    const runner = /Python \d/.test(pyCheck) ? 'python' : 'py';
    return await runCommand(`${runner} ${quoted}`, ctx.workspace, ctx.shellTimeout, ctx.signal);
  } finally {
    fsp.unlink(tmpFile).catch(() => {});
    if (guardFile) fsp.unlink(guardFile).catch(() => {});
  }
}

async function execute(name, args, ctx) {
  // ctx: { workspace, shellTimeout, signal, sandbox: {fsLock, cmdScreen}, store, security }
  args = args || {};
  switch (name) {
    case 'list_dir': {
      const abs = await assertFsPath(resolveIn(args.path || '.', ctx.workspace), ctx, 'list_dir');
      let entries;
      try {
        entries = await fsp.readdir(abs, { withFileTypes: true });
      } catch (e) {
        throw new Error(`无法读取目录 ${abs}: ${e.message}`);
      }
      entries.sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
      const items = entries.slice(0, 500).map((e) => (e.isDirectory() ? e.name + '/' : e.name));
      return `目录: ${abs}(共 ${entries.length} 项${entries.length > 500 ? ',仅显示前 500' : ''})\n${items.join('\n') || '(空目录)'}`;
    }

    case 'read_file': {
      const abs = await assertFsPath(resolveIn(args.path, ctx.workspace), ctx, 'read_file');
      await assertImagePrivacy(abs, ctx, 'read_file');
      const st = await fsp.stat(abs).catch(() => { throw new Error(`文件不存在: ${abs}`); });
      if (st.isDirectory()) throw new Error(`这是一个目录,请改用 list_dir: ${abs}`);
      if (st.size > 512 * 1024) throw new Error(`文件过大(${(st.size / 1024).toFixed(0)}KB),超过 512KB 上限,请用命令行工具处理`);
      const raw = await fsp.readFile(abs, 'utf8');
      const lines = raw.split(/\r?\n/);
      const offset = Math.max(1, parseInt(args.offset, 10) || 1);
      const limit = Math.min(1000, Math.max(1, parseInt(args.limit, 10) || 400));
      const slice = lines.slice(offset - 1, offset - 1 + limit);
      const numbered = slice.map((l, i) => `${String(offset + i).padStart(5)}| ${l}`).join('\n');
      const more = offset - 1 + slice.length < lines.length
        ? `\n…(共 ${lines.length} 行,可用 offset=${offset + limit} 继续读取)`
        : '';
      return `文件: ${abs}(${st.size} 字节)\n${numbered}${more}`;
    }

    case 'write_file': {
      if (typeof args.content !== 'string') throw new Error('缺少 content 参数');
      const abs = await assertFsPath(resolveIn(args.path, ctx.workspace), ctx, 'write_file');
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, args.content, 'utf8');
      const lineCount = args.content ? args.content.split(/\r?\n/).length : 0;
      return `已写入: ${abs}(${args.content.length} 字符,${lineCount} 行)`;
    }

    case 'run_command': {
      const command = String(args.command || '').trim();
      if (!command) throw new Error('缺少 command 参数');
      const sb = ctx.sandbox || { fsLock: true, cmdScreen: 'strict' };
      const screen = sandbox.screenCommand(command, sb.cmdScreen);
      if (!screen.ok) {
        if (ctx.store) security.auditAppend(ctx.store, { kind: 'sandbox', tool: 'run_command', detail: screen.reason.slice(0, 200) });
        throw new Error(screen.reason);
      }
      const cwd = await assertFsPath(resolveIn(args.cwd || '.', ctx.workspace), ctx, 'run_command');
      const st = await fsp.stat(cwd).catch(() => null);
      if (!st || !st.isDirectory()) throw new Error(`执行目录不存在: ${cwd}`);
      return runCommand(command, cwd, ctx.shellTimeout, ctx.signal);
    }

    case 'web_search':
      return search.webSearchExec(args, ctx);

    // 对话交接分段读取(v0.52.0):只读会话存储,不涉文件沙箱;每条文本截断防单段过大
    case 'read_conversation': {
      const store = require('./store');
      const c = store.getConv(String(args.convId || '').trim());
      if (!c) throw new Error(`找不到对话: ${args.convId}`);
      const msgs = c.messages || [];
      const off = Math.max(0, parseInt(args.offset, 10) || 0);
      const lim = Math.min(30, Math.max(1, parseInt(args.limit, 10) || 10));
      const slice = msgs.slice(off, off + lim).map((m, i) => ({
        index: off + i,
        role: m.role,
        text: m.role === 'user'
          ? (typeof m.content === 'string' ? m.content : '[附件消息]')
          : (m.blocks || []).filter((b) => b.type === 'text').map((b) => b.content).join('\n') || (m.content || ''),
        tools: (m.blocks || []).filter((b) => b.type === 'tool').map((b) => `${b.name || '?'}(${b.status || '?'})`),
      }));
      for (const s of slice) if (s.text && s.text.length > 500) s.text = s.text.slice(0, 500) + '…(已截断,可用 offset 继续读上下文)';
      return { title: c.title, total: msgs.length, offset: off, returned: slice.length, done: off + slice.length >= msgs.length, messages: slice };
    }

    case 'web_fetch': {
      const url = String(args.url || '').trim();
      if (!/^https?:\/\//i.test(url)) throw new Error('仅支持 http/https 链接');
      // 与模型请求同门槛:HTTPS 强制 + 域名白名单(防借工具探测内网/明文外发)
      if (ctx.security) security.assertUrlAllowed(url, ctx.security);
      const res = await fetchWithTimeout(url, {}, 20000, ctx.signal);
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      if (!/text\/|json|xml|html/.test(ct)) throw new Error(`不支持的内容类型: ${ct || '未知'}`);
      const body = await res.text();
      const isHtml = /html/.test(ct) || /^\s*<(!doctype|html)/i.test(body);
      let text = isHtml ? stripHtml(body) : body;
      if (text.length > 12000) text = text.slice(0, 12000) + '\n…(内容过长已截断)';
      return `URL: ${url}\n状态码: ${res.status}\n\n${text || '(空内容)'}`;
    }

    // ===== 工具链扩充执行器(v0.53.0) =====
    case 'glob_files': {
      const rootAbs = await assertFsPath(resolveIn(args.path || '.', ctx.workspace), ctx, 'glob_files');
      const st = await fsp.stat(rootAbs).catch(() => { throw new Error(`目录不存在: ${rootAbs}`); });
      if (!st.isDirectory()) throw new Error(`不是一个目录: ${rootAbs}`);
      const re = globToRegex(String(args.pattern || '**/*'));
      const hits = [];
      const total = await walkFiles(rootAbs, async (rel) => {
        if (re.test(rel)) hits.push(rel);
        if (hits.length >= 300) return false; // 命中截断
      });
      if (!hits.length) return `模式 ${args.pattern} 在 ${rootAbs} 下无匹配(扫描 ${total} 个文件)。`;
      return `匹配 ${hits.length}${hits.length >= 300 ? '(截断)' : ''}/${total} 个文件(相对 ${args.path || '.'}):\n` + hits.join('\n');
    }

    case 'grep_text': {
      const rootAbs = await assertFsPath(resolveIn(args.path || '.', ctx.workspace), ctx, 'grep_text');
      const st = await fsp.stat(rootAbs).catch(() => { throw new Error(`目录不存在: ${rootAbs}`); });
      if (!st.isDirectory()) throw new Error(`不是一个目录: ${rootAbs}`);
      let re;
      try { re = new RegExp(String(args.pattern || ''), args.ignoreCase ? 'i' : ''); } catch (e) { throw new Error(`正则无效: ${e.message}`); }
      const max = Math.min(200, Math.max(1, parseInt(args.max, 10) || 50));
      const hits = [];
      let scanned = 0, textFiles = 0;
      await walkFiles(rootAbs, async (rel, abs) => {
        scanned++;
        const sz = (await fsp.stat(abs).catch(() => null));
        if (!sz || !sz.isFile() || sz.size > 1024 * 1024) return;
        if (!TEXT_EXTS.has(path.extname(abs).toLowerCase()) && !(await isTextFile(abs, sz.size))) return;
        textFiles++;
        let content;
        try { content = await fsp.readFile(abs, 'utf8'); } catch (_) { return; }
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            hits.push(`${rel}:${i + 1}: ${clipText(lines[i].trim(), 200)}`);
            if (hits.length >= max) return false;
          }
        }
      });
      if (!hits.length) return `正则 ${args.pattern} 在 ${rootAbs} 下无匹配(扫描 ${scanned} 个文件,其中 ${textFiles} 个文本文件)。`;
      return `命中 ${hits.length}${hits.length >= max ? '(截断)' : ''} 处(扫描 ${scanned} 个文件):\n` + hits.join('\n');
    }

    case 'edit_file': {
      if (typeof args.oldString !== 'string' || typeof args.newString !== 'string') throw new Error('缺少 oldString/newString 参数');
      if (args.oldString === args.newString) throw new Error('oldString 与 newString 相同,无需编辑');
      const abs = await assertFsPath(resolveIn(args.path, ctx.workspace), ctx, 'edit_file');
      const st = await fsp.stat(abs).catch(() => { throw new Error(`文件不存在: ${abs}`); });
      if (st.isDirectory()) throw new Error(`这是一个目录: ${abs}`);
      if (st.size > 512 * 1024) throw new Error(`文件过大(${(st.size / 1024).toFixed(0)}KB),超过 512KB 上限,请用 read_file/write_file 分段处理`);
      const raw = await fsp.readFile(abs, 'utf8');
      const count = raw.split(args.oldString).length - 1;
      if (count === 0) throw new Error('oldString 在文件中未找到(需与文件内容精确匹配,建议先 read_file 确认)');
      if (count > 1 && !args.all) throw new Error(`oldString 在文件中出现 ${count} 次(要求恰好一次;确认要全部替换时传 all:true)`);
      const next = args.all ? raw.split(args.oldString).join(args.newString) : raw.replace(args.oldString, args.newString);
      await fsp.writeFile(abs, next, 'utf8');
      return `已编辑: ${abs}(替换 ${args.all ? count : 1} 处;${st.size} → ${next.length} 字节)`;
    }

    case 'mkdir': {
      const abs = await assertFsPath(resolveIn(args.path, ctx.workspace), ctx, 'mkdir');
      await fsp.mkdir(abs, { recursive: true });
      return `目录已就绪: ${abs}`;
    }

    case 'move_path': {
      const fromAbs = await assertFsPath(resolveIn(args.from, ctx.workspace), ctx, 'move_path');
      const toAbs = await assertFsPath(resolveIn(args.to, ctx.workspace), ctx, 'move_path');
      const fs1 = await fsp.stat(fromAbs).catch(() => { throw new Error(`源路径不存在: ${fromAbs}`); });
      let targetExists = false;
      try { await fsp.access(toAbs); targetExists = true; } catch (_) { /* 不存在 = 可写 */ }
      if (targetExists) throw new Error(`目标已存在,不做覆盖: ${toAbs}`);
      await fsp.mkdir(path.dirname(toAbs), { recursive: true });
      try {
        await fsp.rename(fromAbs, toAbs);
      } catch (e) {
        if (e.code === 'EXDEV') throw new Error('跨盘移动暂不支持,请用 run_code 复制后删除');
        throw new Error(`移动失败: ${e.message}`);
      }
      return `已移动: ${fromAbs} → ${toAbs}${fs1.isDirectory() ? '(目录)' : ''}`;
    }

    case 'delete_path': {
      const abs = await assertFsPath(resolveIn(args.path, ctx.workspace), ctx, 'delete_path');
      const st = await fsp.stat(abs).catch(() => { throw new Error(`路径不存在: ${abs}`); });
      if (st.isDirectory()) {
        if (args.recursive) {
          await fsp.rm(abs, { recursive: true, force: false });
          return `已递归删除目录: ${abs}`;
        }
        const rest = await fsp.readdir(abs);
        if (rest.length) throw new Error(`目录非空(含 ${rest.length} 项)。删除整个目录需传 recursive:true,该操作需要用户审批。`);
        await fsp.rmdir(abs);
        return `已删除空目录: ${abs}`;
      }
      await fsp.unlink(abs);
      return `已删除文件: ${abs}(${st.size} 字节)`;
    }

    case 'file_info': {
      const abs = await assertFsPath(resolveIn(args.path, ctx.workspace), ctx, 'file_info');
      const st = await fsp.stat(abs).catch(() => { throw new Error(`路径不存在: ${abs}`); });
      const kind = st.isDirectory() ? '目录' : (await isTextFile(abs, st.size) ? '文本文件' : '二进制文件');
      return [
        `路径: ${abs}`,
        `类型: ${kind}`,
        `大小: ${st.size} 字节(${(st.size / 1024).toFixed(1)} KB)`,
        `创建: ${st.birthtime.toISOString()}`,
        `修改: ${st.mtime.toISOString()}`,
      ].join('\n');
    }

    case 'run_code':
      return runCodeFile(args.language, args.code, ctx);

    case 'copy_path': {
      const fromAbs = await assertFsPath(resolveIn(args.from, ctx.workspace), ctx, 'copy_path');
      const toAbs = await assertFsPath(resolveIn(args.to, ctx.workspace), ctx, 'copy_path');
      const st = await fsp.stat(fromAbs).catch(() => { throw new Error(`源路径不存在: ${fromAbs}`); });
      const exists = await fsp.stat(toAbs).then(() => true, () => false);
      if (exists) throw new Error(`目标已存在,不做覆盖: ${toAbs}`);
      const r = await copyTree(fromAbs, toAbs);
      return `已复制${st.isDirectory() ? '目录' : '文件'}: ${fromAbs} → ${toAbs}(${r.files} 个文件${r.dirs ? `,${r.dirs} 个子目录` : ''},${(r.bytes / 1024).toFixed(1)} KB)`;
    }

    case 'process_list':
      return processList(args.filter);

    case 'stop_process':
      return stopProcess(args.pid);

    case 'web_request': {
      const method = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(args.method) ? args.method : 'GET';
      const url = String(args.url || '').trim();
      if (!/^https?:\/\//i.test(url)) throw new Error('仅支持 http/https 链接');
      if (ctx.security) security.assertUrlAllowed(url, ctx.security);
      const rawHeaders = (args.headers && typeof args.headers === 'object' && !Array.isArray(args.headers)) ? args.headers : {};
      const headers = { 'user-agent': 'Mozilla/5.0 (LiteAgent/0.1)' };
      for (const [k, v] of Object.entries(rawHeaders)) {
        const key = String(k).trim().toLowerCase();
        if (['host', 'connection', 'content-length', 'transfer-encoding'].includes(key)) continue; // fetch 管控头
        headers[key] = String(v).slice(0, 500);
      }
      let body;
      if (args.body != null) {
        body = String(args.body);
        if (body.length > 64 * 1024) throw new Error('请求体超过 64KB 上限');
      }
      const res = await fetchWithTimeout(url, { method, headers, ...(body != null && method !== 'GET' && method !== 'HEAD' ? { body } : {}) }, 20000, ctx.signal);
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      const headLines = [];
      res.headers.forEach((v, k) => { if (headLines.length < 10) headLines.push(`${k}: ${String(v).slice(0, 200)}`); });
      let bodyText = '';
      if (method !== 'HEAD' && !/image\/|audio\/|video\/|octet-stream|application\/zip/.test(ct)) {
        bodyText = (await res.text().catch(() => '')) || '';
        if (bodyText.length > 20 * 1024) bodyText = bodyText.slice(0, 20 * 1024) + '\n…(响应体过长已截断)';
      } else if (method !== 'HEAD') {
        bodyText = `(二进制响应,内容类型 ${ct || '未知'},未返回主体;文件请用 download_file)`;
      }
      return `HTTP ${res.status} ${res.statusText || ''}\n${headLines.join('\n')}\n\n${bodyText || '(空响应体)'}`;
    }

    case 'zip_create': {
      const fromAbs = await assertFsPath(resolveIn(args.from, ctx.workspace), ctx, 'zip_create');
      const toAbs = await assertFsPath(resolveIn(args.to, ctx.workspace), ctx, 'zip_create');
      return zipCreate(fromAbs, toAbs);
    }

    case 'zip_extract': {
      const fileAbs = await assertFsPath(resolveIn(args.file, ctx.workspace), ctx, 'zip_extract');
      const toAbs = await assertFsPath(resolveIn(args.to, ctx.workspace), ctx, 'zip_extract');
      return zipExtract(fileAbs, toAbs);
    }

    case 'make_video': {
      const videogen = require('./videogen');
      const outAbs = await assertFsPath(resolveIn(args.path, ctx.workspace), ctx, 'make_video');
      if (!/\.webm$/i.test(outAbs)) throw new Error('输出路径必须以 .webm 结尾');
      const r = await videogen.makeVideo(args);
      await fsp.mkdir(path.dirname(outAbs), { recursive: true });
      await fsp.writeFile(outAbs, r.buffer);
      return `已生成视频: ${outAbs}(${r.frames} 帧 @ ${r.fps}fps,${r.width}x${r.height},${(r.buffer.length / 1024).toFixed(1)} KB,webm)`;
    }

    case 'video_info': {
      const videogen = require('./videogen');
      const abs = await assertFsPath(resolveIn(args.path, ctx.workspace), ctx, 'video_info');
      const meta = await videogen.videoInfo(abs);
      return [
        `文件: ${abs}`,
        `时长: ${Number.isFinite(meta.duration) ? meta.duration.toFixed(2) + ' 秒' : '(未知)'}`,
        `分辨率: ${meta.width}x${meta.height}`,
      ].join('\n');
    }

    // ===== 常规 Agent 能力执行器(第五批) =====
    case 'window_list': {
      const out = await runCommand(
        process.platform === 'win32'
          ? 'powershell -NoProfile -Command "Get-Process | Where-Object { $_.MainWindowTitle } | Select-Object Id,ProcessName,MainWindowTitle | ConvertTo-Csv -NoTypeInformation"'
          : 'ps -eo pid,comm --no-headers',
        undefined, 20, ctx.signal,
      );
      const flt = String(args.filter || '').toLowerCase();
      const rows = [];
      for (const line of String(out || '').split(/\r?\n/)) {
        if (process.platform === 'win32') {
          const cells = (line.match(/"([^"]*)"/g) || []).map((s) => s.slice(1, -1));
          if (cells.length >= 3 && /^\d+$/.test(cells[0])) rows.push({ pid: cells[0], name: cells[1], title: cells[2] });
        } else {
          const c = line.trim().split(/\s+/);
          if (c.length >= 2 && /^\d+$/.test(c[0])) rows.push({ pid: c[0], name: c[1], title: c[1] });
        }
      }
      const hit = flt ? rows.filter((r) => r.title.toLowerCase().includes(flt)) : rows;
      const lines = hit.slice(0, 60).map((r) => `${r.pid}\t${r.name}\t${r.title}`);
      return `共 ${rows.length} 个可见窗口${flt ? `,匹配 ${hit.length} 个` : ''}${hit.length > 60 ? '(仅列前 60)' : ''}:\nPID\t进程\t标题\n` + (lines.join('\n') || '(无匹配)');
    }

    case 'window_action': {
      if (process.platform !== 'win32') throw new Error('window_action 目前仅支持 Windows');
      const action = String(args.action || '');
      const actMap = {
        activate: '[W]::SetForegroundWindow($h)',
        minimize: '[W]::ShowWindow($h,11)',
        maximize: '[W]::ShowWindow($h,3)',
        restore: '[W]::ShowWindow($h,9)',
        close: '[W]::PostMessage($h,0x0010,[IntPtr]::Zero,[IntPtr]::Zero)',
        topmost: '[W]::SetWindowPos($h,([IntPtr](-1)),0,0,0,0,0x0003)',
        untopmost: '[W]::SetWindowPos($h,([IntPtr](-2)),0,0,0,0,0x0003)',
      };
      if (!actMap[action]) throw new Error('action 必须是 activate/minimize/maximize/restore/close/topmost/untopmost');
      const pidNum = parseInt(args.pid, 10);
      if (!Number.isInteger(pidNum) || pidNum <= 0) {
        if (!String(args.title || '').trim()) throw new Error('需要 pid 或 title 之一来定位窗口');
      }
      const find = Number.isInteger(pidNum) && pidNum > 0
        ? `$p = Get-Process -Id ${pidNum} -ErrorAction SilentlyContinue`
        : `$t = '${String(args.title || '').replace(/'/g, "''")}'; $p = Get-Process | Where-Object { $_.MainWindowTitle -like ('*' + $t + '*') } | Select-Object -First 1`;
      const script = [
        'Add-Type @\'',
        'using System; using System.Runtime.InteropServices;',
        'public class W {',
        '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);',
        '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);',
        '  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);',
        '  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);',
        '}',
        '\'@',
        find,
        'if (-not $p) { Write-Output "NOTFOUND"; exit }',
        '$h = $p.MainWindowHandle;',
        'if ($h -eq [IntPtr]::Zero) { Write-Output "NOHANDLE"; exit }',
        `$ok = ${actMap[action]};`,
        'Write-Output ("DONE pid=" + $p.Id + " title=" + $p.MainWindowTitle + " ok=" + $ok)',
      ].join('\n');
      // -EncodedCommand(base64/UTF-16LE)传多行脚本:here-string 依赖换行,-Command 拼接会被转义破坏
      const b64 = Buffer.from(script, 'utf16le').toString('base64');
      const out = await runCommand(`powershell -NoProfile -EncodedCommand ${b64}`, undefined, 25, ctx.signal);
      if (/NOTFOUND/.test(out)) throw new Error('未找到目标窗口(用 window_list 查 PID 或标题)');
      if (/NOHANDLE/.test(out)) throw new Error('目标进程没有可见窗口');
      if (!/DONE/.test(out)) throw new Error('窗口操作失败: ' + out.slice(-200));
      return `已执行 ${action}: ${(/DONE pid=\d+ title=.*/.exec(out) || [''])[0].replace(/^DONE /, '')}`;
    }

    case 'system_notify': {
      const electron = require('electron');
      const N = electron && typeof electron === 'object' ? electron.Notification : null;
      if (!N) throw new Error('system_notify 仅在应用内可用');
      if (!N.isSupported()) throw new Error('此系统不支持通知');
      const n = new N({ title: String(args.title || 'LiteAgent').slice(0, 60), body: String(args.body || '').slice(0, 200) });
      n.show();
      return `已发送系统通知:${args.title}`;
    }

    case 'schedule_task': {
      const electron = require('electron');
      const N = electron && typeof electron === 'object' ? electron.Notification : null;
      if (!N) throw new Error('schedule_task 仅在应用内可用');
      const delay = Math.min(86400, Math.max(1, parseInt(args.delaySec, 10) || 0));
      if (!delay) throw new Error('delaySec 必须是 1-86400 的秒数');
      const title = String(args.title || '提醒').slice(0, 60);
      const body = String(args.body || '').slice(0, 200);
      global.__liteSchedules = global.__liteSchedules || 0;
      global.__liteSchedules++;
      const fire = () => {
        try {
          if (N.isSupported()) new N({ title, body, silent: false }).show();
        } catch (_) { /* 通知失败不影响 */ }
        global.__liteSchedules--;
      };
      setTimeout(fire, delay * 1000).unref?.();
      return `已设置延时提醒:${delay} 秒后触发「${title}」(系统通知;仅本次运行期间有效)`;
    }

    case 'open_external': {
      // 惰性 require:应用主进程内 electron 返回 API;ELECTRON_RUN_AS_NODE(测试)下返回路径串,诚实报错
      const electron = require('electron');
      const shell = electron && typeof electron === 'object' ? electron.shell : null;
      if (!shell) throw new Error('open_external 仅在应用内可用');
      const target = String(args.target || '').trim();
      if (!target) throw new Error('缺少 target 参数');
      if (/^https?:\/\//i.test(target)) {
        if (ctx.security) security.assertUrlAllowed(target, ctx.security);
        await shell.openExternal(target);
        security.auditAppend(ctx.store, { kind: 'open', target: target.slice(0, 200) });
        return `已用系统默认浏览器打开: ${target}`;
      }
      const abs = await assertFsPath(resolveIn(target, ctx.workspace), ctx, 'open_external');
      await assertImagePrivacy(abs, ctx, 'open_external');
      // Pointer Lock 预检:HTML 页面自带鼠标锁定(FPS/3D 游戏常用)时提前告知,
      // 避免"鼠标被隐形程序锁住"的困惑 —— 打开页面后按 Esc 即可释放
      let pointerLockNote = '';
      if (/\.(html?|htm)$/i.test(abs)) {
        try {
          const st = await fsp.stat(abs);
          if (st.size < 4 * 1024 * 1024) {
            const head = (await fsp.readFile(abs, 'utf8')).slice(0, 256 * 1024);
            if (/requestPointerLock|pointerLockElement/i.test(head)) {
              pointerLockNote = '\n⚠ 该页面使用鼠标锁定(Pointer Lock,FPS/3D 游戏常用):按 Esc 释放;若游戏在释放后立刻重新锁定把你卡住,快速连按两次 Esc 可强制解除(该页面本次不再锁定)。建议把页面改成用户点击「开始」按钮后再申请锁定。';
              security.auditAppend(ctx.store, { kind: 'open', target: abs.slice(0, 200), note: 'pointer-lock' });
            }
          }
        } catch (_) { /* 读取失败不影响打开 */ }
      }
      // HTML:改在内置浏览器直接打开(用户裁定"能内部打开就内部打开")—— 返回内部标记,
      // agent.js 检测后发 internal-preview 事件,渲染端在右侧面板浏览器打开;Pointer Lock 预检照旧
      if (/\.(html?|htm)$/i.test(abs)) {
        security.auditAppend(ctx.store, { kind: 'open', target: abs.slice(0, 200), note: 'internal-preview' });
        return `__INTERNAL_PREVIEW__${abs}${pointerLockNote ? '||' + pointerLockNote.trim() : ''}`;
      }
      const errMsg = await shell.openPath(abs);
      if (errMsg) throw new Error(`无法打开: ${errMsg}`);
      security.auditAppend(ctx.store, { kind: 'open', target: abs.slice(0, 200) });
      return `已用系统关联程序打开: ${abs}` + pointerLockNote;
    }
    case 'serve_dir': {
      const out = await serveDirStart(args, ctx);
      security.auditAppend(ctx.store, { kind: 'serve', dir: String(args.path || '.'), minutes: String(args.minutes || 15) });
      return out;
    }
    case 'stop_serve': {
      const id = args.serviceId ? String(args.serviceId) : null;
      if (id) {
        if (!stopServeById(id)) throw new Error(`没有运行中的服务器: ${id}`);
        return `已停止 ${id}`;
      }
      const n = serveServers.size;
      for (const k of [...serveServers.keys()]) stopServeById(k);
      return n ? `已停止全部 ${n} 个本地服务器` : '当前没有运行中的本地服务器';
    }
    case 'clipboard': {
      const electron = require('electron');
      const clip = electron && typeof electron === 'object' ? electron.clipboard : null;
      if (!clip || !clip.readText) throw new Error('剪贴板仅在应用内可用');
      if (args.action === 'write') {
        if (typeof args.text !== 'string') throw new Error('action=write 需要 text 参数');
        clip.writeText(args.text);
        return `已写入剪贴板(${args.text.length} 字符)`;
      }
      const text = clip.readText() || '';
      return `剪贴板内容(${text.length} 字符):\n${clipText(text, 4000) || '(空)'}`;
    }

    case 'system_info': {
      const cpus = os.cpus();
      let disk = '';
      try {
        const stf = await fsp.statfs(ctx.workspace);
        disk = `\n磁盘(${ctx.workspace}): 总 ${(stf.blocks * stf.bsize / 1024 ** 3).toFixed(0)} GB / 可用 ${(stf.bavail * stf.bsize / 1024 ** 3).toFixed(0)} GB`;
      } catch (_) { /* statfs 不可用时略 */ }
      return [
        `系统: ${os.platform()} ${os.release()}(${os.arch()})`,
        `主机名: ${os.hostname()}`,
        `CPU: ${cpus[0] ? cpus[0].model.trim() : '?'} × ${cpus.length} 核`,
        `内存: ${(os.totalmem() / 1024 ** 3).toFixed(1)} GB 总量 / ${(os.freemem() / 1024 ** 3).toFixed(1)} GB 可用`,
        `开机时长: ${(os.uptime() / 3600).toFixed(1)} 小时`,
        `工作目录: ${ctx.workspace}`,
      ].join('\n') + disk;
    }

    case 'download_file': {
      const url = String(args.url || '').trim();
      if (!/^https?:\/\//i.test(url)) throw new Error('仅支持 http/https 链接');
      if (ctx.security) security.assertUrlAllowed(url, ctx.security);
      const abs = await assertFsPath(resolveIn(args.path, ctx.workspace), ctx, 'download_file');
      const res = await fetchWithTimeout(url, {}, 60000, ctx.signal);
      if (!res.ok) throw new Error(`下载失败: HTTP ${res.status}`);
      const total = parseInt(res.headers.get('content-length') || '0', 10);
      if (total > 100 * 1024 * 1024) throw new Error(`文件过大(${(total / 1024 / 1024).toFixed(0)}MB),超过 100MB 上限`);
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      const MAX = 100 * 1024 * 1024;
      let got = 0;
      const chunks = [];
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        got += value.length;
        if (got > MAX) { try { reader.cancel(); } catch (_) {} throw new Error('下载超过 100MB 上限,已中止'); }
        chunks.push(Buffer.from(value));
      }
      await fsp.writeFile(abs, Buffer.concat(chunks));
      security.auditAppend(ctx.store, { kind: 'download', url: url.slice(0, 200), path: abs.slice(0, 200), size: got });
      return `已下载: ${abs}(${got} 字节${total ? `,共 ${total}` : ''})`;
    }

    case 'manage_assistants':
      return manageAssistantsExec(args, ctx);

    case 'manage_skills':
      return manageSkillsExec(args, ctx);

    case 'memory_save':
      return memorySaveExec(args, ctx);

    case 'self_learn':
      return selfLearnExec(args, ctx);

    default:
      throw new Error(`未知工具: ${name}`);
  }
}

module.exports = { DEFINITIONS, SELF_DEFINITIONS, MEMORY_DEFINITIONS, LEARN_DEFINITIONS, execute, assertFsPath, assertImagePrivacy, isImagePath, writeImageGuard, IMAGE_EXTS };
