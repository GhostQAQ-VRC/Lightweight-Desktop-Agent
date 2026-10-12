// 界面语言(v0.40):键 = 简体中文原文,查目标语言字典;未收录的键回退原文。
// v1 覆盖界面骨架:标题栏/侧栏/顶栏/输入区/模式菜单/设置导航与外壳/常规与外观 pane/常用按钮;
// 各功能 pane 的深层文案与动态提示暂仍为简体中文,后续版本逐步补齐。
(function () {
  const DICTS = {
    'zh-TW': {
      // 导航与外壳
      '设置': '設定',
      '供应商': '供應商', '提示词': '提示詞', '扩展': '擴充', 'Agent': 'Agent',
      '子智能体': '子智能體', '安全': '安全', '用量': '用量', '诊断': '診斷',
      '开发者': '開發者', '外观': '外觀', '常规': '一般',
      // 标题栏
      '最小化': '最小化', '最大化 / 还原': '最大化 / 還原', '关闭': '關閉',
      // 侧栏
      '新对话': '新對話', '新建对话 (Ctrl+N)': '新建對話 (Ctrl+N)', '暂无对话': '暫無對話',
      '正在回复…': '正在回覆…', '重命名': '重新命名', '删除': '刪除',
      '重命名分组': '重新命名分組', '设置工作文件夹': '設定工作資料夾', '删除分组(会话移入默认分组)': '刪除分組(會話移入預設分組)',
      // 顶栏
      '🔍 搜索': '🔍 搜尋', '导出': '匯出', '▦ 面板': '▦ 面板',
      '在当前对话中搜索 (Ctrl+F)': '在目前對話中搜尋 (Ctrl+F)',
      '导出当前对话为 Markdown': '匯出目前對話為 Markdown',
      '切换面板 (辅助对话 / 审查 / 终端 / 浏览器)': '切換面板 (輔助對話 / 審查 / 終端 / 瀏覽器)',
      '当前助手(角色提示词)': '目前助手(角色提示詞)',
      '智能体模式:对话 / 受限 / 完全 / 创造': '智能體模式:對話 / 受限 / 完全 / 創造 / 團隊',
      // 输入区
      '给 LiteAgent 发送消息…(Enter 发送,Shift+Enter 换行;可拖入或粘贴图片/文本文件)': '給 LiteAgent 傳送訊息…(Enter 傳送,Shift+Enter 換行;可拖入或貼上圖片/文字檔)',
      '搜索模型 ID / 供应商…': '搜尋模型 ID / 供應商…',
      '未选择模型': '未選擇模型', '请先在设置中配置模型': '請先在設定中配置模型',
      '选择模型(可搜索)': '選擇模型(可搜尋)', '点击展开': '點擊展開',
      '折叠/展开模型与技能栏': '摺疊/展開模型與技能欄',
      '🧠 思考': '🧠 思考',
      '推理强度(按所选模型能力自动识别)': '推理強度(按所選模型能力自動識別)',
      '添加图片或文本文件(也可直接拖入窗口或粘贴)': '新增圖片或文字檔(也可直接拖入視窗或貼上)',
      '发送 (Enter)': '傳送 (Enter)', '停止生成': '停止產生',
      // 模式
      '💬 对话模式': '💬 對話模式', '🔒 受限模式': '🔒 受限模式', '⚡ 完全模式': '⚡ 完全模式',
      '🎨 创造模式': '🎨 創造模式', '🤝 团队协同': '🤝 團隊協同',
      '对话': '對話', '受限': '受限', '完全': '完全', '创造': '創造', '团队': '團隊',
      // 常规 pane
      '语言': '語言', '界面语言(部分深层文案暂仍为简体中文,逐步补齐)': '介面語言(部分深層文案暫仍為簡體中文,逐步補齊)',
      '简体中文': '簡體中文', '繁體中文': '繁體中文', 'English': 'English',
      '硬件加速': '硬體加速', '使用 GPU 渲染界面;遇到花屏/渲染异常或省电时可关闭(重启应用生效)': '使用 GPU 渲染介面;遇到花屏/渲染異常或省電時可關閉(重啟應用生效)',
      '任务通知': '任務通知', '回复完成或出错、且窗口不在前台时弹系统通知': '回覆完成或出錯、且視窗不在前台時彈系統通知',
      '声音通知': '聲音通知', '系统通知附带提示音': '系統通知附帶提示音',
      '关闭窗口时隐藏到托盘': '關閉視窗時隱藏到系統匣', '点击 ✕ 不退出应用,最小化到系统托盘;托盘图标右键可退出': '點擊 ✕ 不結束應用,最小化到系統匣;系統匣圖示右鍵可結束',
      '保持电脑运行': '保持電腦執行', '阻止系统休眠与息屏(长任务挂机时使用;会增加耗电)': '阻止系統休眠與熄屏(長任務掛機時使用;會增加耗電)',
      '温度 temperature': '溫度 temperature', '越高越发散,0.7 适合日常对话': '越高越發散,0.7 適合日常對話',
      '携带历史条数与上下文压缩': '攜帶歷史條數與上下文壓縮', '已移至「上下文」页签(含摘要压缩策略)': '已移至「上下文」頁籤(含摘要壓縮策略)', '→ 上下文': '→ 上下文',
      '数据存储': '資料儲存', '配置、会话与插件等全部数据的存放目录': '配置、會話與外掛等全部資料的存放目錄',
      '打开': '開啟', '更改…': '變更…', '恢复默认': '恢復預設',
      '缓存存储': '快取儲存', '浏览器引擎缓存(图片/脚本等),可安全清除': '瀏覽器引擎快取(圖片/腳本等),可安全清除',
      '清除缓存': '清除快取',
      // 外观 pane
      '主题': '主題', '浅色 / 深色': '淺色 / 深色', '浅色': '淺色', '深色': '深色',
      '毛玻璃效果': '毛玻璃效果', '背景图片': '背景圖片', '以自定义图片作为整个界面的背景': '以自訂圖片作為整個介面的背景',
      '已设置': '已設定', '未设置': '未設定', '上传图片': '上傳圖片', '清除': '清除',
      '背景透明化': '背景透明化', '窗口背景透明,建议配合毛玻璃使用(需重启应用生效)': '視窗背景透明,建議配合毛玻璃使用(需重啟應用生效)',
      // 通知/重启 toast
      '重启应用后生效': '重啟應用後生效', '已开启': '已開啟', '已关闭': '已關閉',
      // 预设助手名(显示级翻译;自建名不在字典则原样)
      '默认助手': '預設助手', '编程专家': '編程專家', 'Unity 开发专家': 'Unity 開發專家',
      '3D 建模顾问': '3D 建模顧問', '游戏策划': '遊戲策劃', '前端工程师': '前端工程師',
      '后端架构师': '後端架構師', '数据分析师': '數據分析師', '翻译官': '翻譯官',
      '写作助手': '寫作助手', '学习导师': '學習導師',
      // 预设技能名
      '中英互译': '中英互譯', '润色改写': '潤色改寫', '网页总结': '網頁總結', '代码审查': '代碼審查',
      '周报生成': '週報產生', 'Unity 代码审查': 'Unity 代碼審查', 'Shader 助手': 'Shader 助手',
      '3D 模型优化': '3D 模型優化', '报错分析': '報錯分析', '关卡灵感': '關卡靈感', '表格公式': '表格公式',
      // 预设供应商名
      '智谱 GLM': '智譜 GLM', '通义千问': '通義千問', '通义千问(账号登录)': '通義千問(賬號登入)',
      'Claude(账号登录)': 'Claude(賬號登入)', 'Gemini(账号登录)': 'Gemini(賬號登入)',
      'ChatGPT(账号登录)': 'ChatGPT(賬號登入)', 'GitHub Copilot(账号登录)': 'GitHub Copilot(賬號登入)',
      'SiliconFlow 硅基流动': 'SiliconFlow 矽基流動', 'Ollama(本地)': 'Ollama(本地)', 'LM Studio(本地)': 'LM Studio(本地)',
      // 推理滑块档位
      '极简': '極簡', '低': '低', '中': '中', '高': '高', '超高': '超高', '最大': '最大',
      '动态': '動態', '深度推理': '深度推理', '自定义': '自訂', '自定义预算…': '自訂預算…',
      '该模型不支持推理': '該模型不支持推理',
      '档位已由 设置 → 模型 的逐模型配置锁定': '檔位已由 設定 → 供應商 的逐模型配置鎖定',
      '推理强度已设为:': '推理強度已設為:', '(按模型记忆)': '(按模型記憶)',
      // 用量条 / 终端状态栏
      '上下文': '上下文', '条': '條', '缓存命中': '快取命中', '本会话': '本會話', '全局': '全局', '次': '次',
      '未命名对话': '未命名對話', '● 回复中': '● 回覆中',
      // 右侧面板
      '辅助对话': '輔助對話', '审查': '審查', '终端': '終端', '浏览器': '瀏覽器',
      '打开标签页': '開啟標籤頁', '选择要在侧边面板中打开的标签。': '選擇要在側邊面板中開啟的標籤。',
      '返回标签页': '返回標籤頁', '收起面板': '收起面板',
      '子智能体': '子智能體',
      '子智能体运行(独立上下文 · 新→旧)': '子智能體執行(獨立上下文 · 新→舊)',
      '暂无子智能体运行 —— 主智能体派发任务后会实时显示在这里。': '暫無子智能體執行 —— 主智能體派發任務後會即時顯示在這裡。',
      '(等待输出…)': '(等待輸出…)',
      '● 运行中': '● 執行中', '✓ 完成': '✓ 完成', '✕ 出错': '✕ 出錯', '■ 已停止': '■ 已停止',
      '待批准': '待批准', '执行中': '執行中', '已完成': '已完成', '出错': '出錯', '已拒绝': '已拒絕', '已中止': '已中止',
      '等待你批准的工具调用:': '等待你批准的工具呼叫:', '(无参数摘要)': '(無參數摘要)',
      '批准': '批准', '拒绝': '拒絕', '已批准': '已批准', '已拒': '已拒',
      '工具调用记录(新→旧):': '工具呼叫記錄(新→舊):', '暂无记录': '暫無記錄',
      '重置': '重置', '默认分组': '預設分組',
      '轮': '輪', '步': '步', '上下文已用': '上下文已用', '系统提示词': '系統提示詞', '工具定义': '工具定義', '对话消息': '對話訊息', '加载中…': '載入中…', '发送消息后显示上下文构成': '傳送訊息後顯示上下文構成',
      '底部用量条样式': '底部用量條樣式', '紧凑': '緊湊', '详细(容量卡)': '詳細(容量卡)', '上下文容量': '上下文容量', '平均缓存命中率': '平均快取命中率', '消息': '訊息', '系统工具': '系統工具', '工具结果': '工具結果', '技能与专精': '技能與專精', '其他': '其他',
      '会话统计': '會話統計', '模型用时': '模型用時', '工具调用用时': '工具呼叫用時', '首 token 平均(TTFT)': '首 token 平均(TTFT)', '输出速度(TPS)': '輸出速度(TPS)', 'Token 用量': 'Token 用量', '未缓存输入': '未快取輸入', '缓存读取': '快取讀取', '输出': '輸出', '秒': '秒',
      '清空': '清空',
      '记录': '記錄',
      '自定义预算': '自訂預算',
      '在 设置 → 模型 对应模型行的「预算」输入框修改;清空后跟随档位滑块': '在 設定 → 供應商 對應模型行的「預算」輸入框修改;清空後跟隨檔位滑塊',

    },
    'en': {
      // 导航与外壳
      '设置': 'Settings',
      '供应商': 'Providers', '提示词': 'Prompts', '扩展': 'Extensions', 'Agent': 'Agent',
      '子智能体': 'Sub-agents', '安全': 'Security', '用量': 'Usage', '诊断': 'Diagnostics',
      '开发者': 'Developer', '外观': 'Appearance', '常规': 'General',
      // 标题栏
      '最小化': 'Minimize', '最大化 / 还原': 'Maximize / Restore', '关闭': 'Close',
      // 侧栏
      '新对话': 'New Chat', '新建对话 (Ctrl+N)': 'New Chat (Ctrl+N)', '暂无对话': 'No conversations',
      '正在回复…': 'Replying…', '重命名': 'Rename', '删除': 'Delete',
      '重命名分组': 'Rename group', '设置工作文件夹': 'Set workspace folder', '删除分组(会话移入默认分组)': 'Delete group (convs move to default)',
      // 顶栏
      '🔍 搜索': '🔍 Search', '导出': 'Export', '▦ 面板': '▦ Panel',
      '在当前对话中搜索 (Ctrl+F)': 'Search in conversation (Ctrl+F)',
      '导出当前对话为 Markdown': 'Export conversation as Markdown',
      '切换面板 (辅助对话 / 审查 / 终端 / 浏览器)': 'Toggle panel (aux / review / terminal / browser)',
      '当前助手(角色提示词)': 'Current assistant (role prompt)',
      '智能体模式:对话 / 受限 / 完全 / 创造': 'Agent mode: chat / restricted / full / create / team',
      // 输入区
      '给 LiteAgent 发送消息…(Enter 发送,Shift+Enter 换行;可拖入或粘贴图片/文本文件)': 'Message LiteAgent… (Enter to send, Shift+Enter for newline; drag or paste images/text files)',
      '搜索模型 ID / 供应商…': 'Search model ID / provider…',
      '未选择模型': 'No model selected', '请先在设置中配置模型': 'Configure a model in Settings first',
      '选择模型(可搜索)': 'Select model (searchable)', '点击展开': 'Click to expand',
      '折叠/展开模型与技能栏': 'Fold/unfold model & skills bar',
      '🧠 思考': '🧠 Thinking',
      '推理强度(按所选模型能力自动识别)': 'Reasoning effort (auto-detected per model)',
      '添加图片或文本文件(也可直接拖入窗口或粘贴)': 'Attach image or text file (drag into window or paste)',
      '发送 (Enter)': 'Send (Enter)', '停止生成': 'Stop generating',
      // 模式
      '💬 对话模式': '💬 Chat', '🔒 受限模式': '🔒 Restricted', '⚡ 完全模式': '⚡ Full Access',
      '🎨 创造模式': '🎨 Creator', '🤝 团队协同': '🤝 Team',
      '对话': 'Chat', '受限': 'Restricted', '完全': 'Full', '创造': 'Create', '团队': 'Team',
      // 常规 pane
      '语言': 'Language', '界面语言(部分深层文案暂仍为简体中文,逐步补齐)': 'Interface language (some deeper copy still in Chinese, translated progressively)',
      '简体中文': '简体中文', '繁體中文': '繁體中文', 'English': 'English',
      '硬件加速': 'Hardware acceleration', '使用 GPU 渲染界面;遇到花屏/渲染异常或省电时可关闭(重启应用生效)': 'Render UI with GPU; turn off if you see artifacts or to save power (restart required)',
      '任务通知': 'Task notifications', '回复完成或出错、且窗口不在前台时弹系统通知': 'System notification when a reply finishes or fails while the window is unfocused',
      '声音通知': 'Notification sound', '系统通知附带提示音': 'Play a sound with system notifications',
      '关闭窗口时隐藏到托盘': 'Close to tray', '点击 ✕ 不退出应用,最小化到系统托盘;托盘图标右键可退出': 'Hides to system tray instead of quitting; right-click tray icon to quit',
      '保持电脑运行': 'Keep computer awake', '阻止系统休眠与息屏(长任务挂机时使用;会增加耗电)': 'Prevent system sleep and display off (for long tasks; uses more power)',
      '温度 temperature': 'Temperature', '越高越发散,0.7 适合日常对话': 'Higher = more creative; 0.7 suits daily chat',
      '携带历史条数与上下文压缩': 'History length & context compression', '已移至「上下文」页签(含摘要压缩策略)': 'Moved to the Context tab (with summary strategy)', '→ 上下文': '→ Context',
      '数据存储': 'Data folder', '配置、会话与插件等全部数据的存放目录': 'Where config, conversations and plugins are stored',
      '打开': 'Open', '更改…': 'Change…', '恢复默认': 'Reset to default',
      '缓存存储': 'Cache folder', '浏览器引擎缓存(图片/脚本等),可安全清除': 'Chromium engine cache (images/scripts); safe to clear',
      '清除缓存': 'Clear cache',
      // 外观 pane
      '主题': 'Theme', '浅色 / 深色': 'Light / Dark', '浅色': 'Light', '深色': 'Dark',
      '毛玻璃效果': 'Acrylic blur', '背景图片': 'Background image', '以自定义图片作为整个界面的背景': 'Use a custom image as the app background',
      '已设置': 'Set', '未设置': 'Not set', '上传图片': 'Upload', '清除': 'Clear',
      '背景透明化': 'Transparent window', '窗口背景透明,建议配合毛玻璃使用(需重启应用生效)': 'Transparent window background; pairs well with blur (restart required)',
      // 通知/重启 toast
      '重启应用后生效': 'Takes effect after restart', '已开启': 'On', '已关闭': 'Off',
      // 预设助手名(显示级翻译;自建名不在字典则原样)
      '默认助手': 'Default Assistant', '编程专家': 'Coding Expert', 'Unity 开发专家': 'Unity Dev Expert',
      '3D 建模顾问': '3D Model Advisor', '游戏策划': 'Game Designer', '前端工程师': 'Frontend Engineer',
      '后端架构师': 'Backend Architect', '数据分析师': 'Data Analyst', '翻译官': 'Translator',
      '写作助手': 'Writing Assistant', '学习导师': 'Learning Tutor',
      // 预设技能名
      '中英互译': 'CN⇄EN Translate', '润色改写': 'Polish & Rewrite', '网页总结': 'Web Summary', '代码审查': 'Code Review',
      '周报生成': 'Weekly Report', 'Unity 代码审查': 'Unity Code Review', 'Shader 助手': 'Shader Helper',
      '3D 模型优化': '3D Model Optimize', '报错分析': 'Error Analysis', '关卡灵感': 'Level Ideas', '表格公式': 'Sheet Formulas',
      // 预设供应商名
      '智谱 GLM': 'Zhipu GLM', '通义千问': 'Qwen', '通义千问(账号登录)': 'Qwen (Account)',
      'Claude(账号登录)': 'Claude (Account)', 'Gemini(账号登录)': 'Gemini (Account)',
      'ChatGPT(账号登录)': 'ChatGPT (Account)', 'GitHub Copilot(账号登录)': 'GitHub Copilot (Account)',
      'SiliconFlow 硅基流动': 'SiliconFlow', 'Ollama(本地)': 'Ollama (Local)', 'LM Studio(本地)': 'LM Studio (Local)',
      // 推理滑块档位
      '极简': 'Minimal', '低': 'Low', '中': 'Medium', '高': 'High', '超高': 'Ultra', '最大': 'Max',
      '动态': 'Dynamic', '深度推理': 'Deep Reasoning', '自定义': 'Custom', '自定义预算…': 'Custom budget…',
      '该模型不支持推理': 'This model has no reasoning controls',
      '档位已由 设置 → 模型 的逐模型配置锁定': 'Level locked by per-model config in Settings → Providers',
      '推理强度已设为:': 'Reasoning effort set to:', '(按模型记忆)': '(remembered for this model)',
      // 用量条 / 终端状态栏
      '上下文': 'Context', '条': 'msgs', '缓存命中': 'Cache hit', '本会话': 'Session', '全局': 'Global', '次': 'runs',
      '未命名对话': 'Untitled chat', '● 回复中': '● Replying',
      // 右侧面板
      '辅助对话': 'Aux Chat', '审查': 'Review', '终端': 'Terminal', '浏览器': 'Browser',
      '打开标签页': 'Open Tabs', '选择要在侧边面板中打开的标签。': 'Choose a tab to open in the side panel.',
      '返回标签页': 'Back to tabs', '收起面板': 'Collapse panel',
      '子智能体': 'Sub-agent',
      '子智能体运行(独立上下文 · 新→旧)': 'Sub-agent runs (independent context · new→old)',
      '暂无子智能体运行 —— 主智能体派发任务后会实时显示在这里。': 'No sub-agent runs yet — they appear here in real time once the main agent dispatches tasks.',
      '(等待输出…)': '(Waiting for output…)',
      '● 运行中': '● Running', '✓ 完成': '✓ Done', '✕ 出错': '✕ Error', '■ 已停止': '■ Stopped',
      '待批准': 'Pending', '执行中': 'Running', '已完成': 'Done', '出错': 'Error', '已拒绝': 'Denied', '已中止': 'Aborted',
      '等待你批准的工具调用:': 'Tool calls awaiting your approval:', '(无参数摘要)': '(no argument summary)',
      '批准': 'Approve', '拒绝': 'Deny', '已批准': 'Approved', '已拒': 'Denied',
      '工具调用记录(新→旧):': 'Tool call log (new→old):', '暂无记录': 'No entries yet',
      '重置': 'Reset', '默认分组': 'Default Group',
      '轮': 'runs', '步': 'steps', '上下文已用': 'Context used',
      '系统提示词': 'System prompt', '工具定义': 'Tool definitions', '对话消息': 'Messages', '加载中…': 'Loading…', '发送消息后显示上下文构成': 'Send a message to see context breakdown',
      '底部用量条样式': 'Usage bar style', '紧凑': 'Compact', '详细(容量卡)': 'Detailed (capacity card)', '上下文容量': 'Context capacity', '平均缓存命中率': 'Avg cache hit', '消息': 'Messages', '系统工具': 'Built-in tools', '工具结果': 'Tool results', '技能与专精': 'Skills & specialty', '其他': 'Other',
      '会话统计': 'Session stats', '模型用时': 'Model time', '工具调用用时': 'Tool call time', '首 token 平均(TTFT)': 'Avg first token (TTFT)', '输出速度(TPS)': 'Output speed (TPS)', 'Token 用量': 'Token usage', '未缓存输入': 'Uncached input', '缓存读取': 'Cache read', '输出': 'Output', '秒': 's',
      '清空': 'Clear',
      '记录': 'Log',
      '自定义预算': 'Custom budget',
      '在 设置 → 模型 对应模型行的「预算」输入框修改;清空后跟随档位滑块': 'Edit the budget input on that model row in Settings → Providers; clear to follow the slider',

    },
  };
  let lang = 'zh-CN';
  function setLang(l) { lang = DICTS[l] ? l : 'zh-CN'; }
  function getLang() { return lang; }
  function t(zh) {
    if (lang === 'zh-CN') return zh;
    const d = DICTS[lang];
    return d && Object.prototype.hasOwnProperty.call(d, zh) ? d[zh] : zh;
  }
  window.I18N = { setLang, getLang, t };
})();
