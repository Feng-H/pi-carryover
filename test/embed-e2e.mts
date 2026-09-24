/**
 * v1.1.2 端到端测试：真实下载模型 → 离线加载 → 中英文判定矩阵。
 * 手动执行：node test/embed-e2e.mts [缓存目录]
 * 用全新空目录 = 强制全链路（探测/下载/续传/加载）；复用已有目录 = 跳过下载。
 */
import fs from "node:fs";
import { EmbedEngine, EMBED_MODELS } from "../extensions/lib/embed.ts";
import { resolveEndpoint, ensureModelFiles } from "../extensions/lib/downloader.ts";

const cacheDir = process.argv[2] ?? "/tmp/carryover-e2e-cache";
fs.mkdirSync(cacheDir, { recursive: true });
console.log(`缓存目录: ${cacheDir}（${fs.readdirSync(cacheDir).length ? "已有内容，可能跳过下载" : "空，强制全链路下载"}）\n`);

// ===== 1. endpoint 探测 =====
const t0 = Date.now();
const endpoint = await resolveEndpoint({});
console.log(`1. endpoint 探测（${Date.now() - t0}ms）: ${endpoint ?? "均不可达 ❌"}`);
if (!endpoint) process.exit(1);
console.log(`   ${endpoint.includes("hf-mirror") ? "→ 国内网络，自动使用镜像" : "→ 可直连官方"}\n`);

// ===== 2. 下载双模型（断点续传） =====
for (const lang of ["zh", "en"] as const) {
  const spec = EMBED_MODELS[lang];
  const t = Date.now();
  const ok = await ensureModelFiles(spec.id, spec.files, endpoint, cacheDir, (p) => {
    if (p.total > 0 && p.bytes === p.total) return; // 完成时打一行
  });
  const files = spec.files.map((f) => {
    const s = `${cacheDir}/${spec.id}/${f}`;
    return fs.existsSync(s) ? `${(fs.statSync(s).size / 1e6).toFixed(1)}MB` : "缺失";
  });
  console.log(`2. ${spec.label}: ${ok ? "✅" : "❌"}（${((Date.now() - t) / 1000).toFixed(0)}s，文件 ${files.join(" / ")}）`);
}
console.log("");

// ===== 3. 引擎初始化（离线加载） =====
const engine = new EmbedEngine();
engine.cacheDir = cacheDir;
const ensure = async (lang: "zh" | "en") =>
  ensureModelFiles(EMBED_MODELS[lang].id, EMBED_MODELS[lang].files, endpoint, cacheDir, () => {});
const t3 = Date.now();
const inited = await engine.init("auto", ensure);
console.log(`3. 引擎初始化: ${inited ? "✅" : "❌"}（${Date.now() - t3}ms）\n`);
if (!inited) process.exit(1);

// ===== 4. 判定矩阵（模拟 input 钩子：observe 窗口 → detect 新消息） =====
const cases = {
  zh: {
    same: [
      { w: ["登录页面有个bug，点击按钮没反应", "看了下控制台报了 CORS 错误", "后端接口需要配置跨域"], n: "改成允许所有来源还是只允许指定域名" },
      { w: ["这个 React 组件渲染太慢了", "列表有五千条数据，每次都全量重渲染", "考虑用虚拟列表优化"], n: "引入 react-window 大概要改多少代码" },
      { w: ["数据库连接池经常耗尽", "并发高峰期报 too many connections", "MySQL 的 max_connections 调到多少合适"], n: "顺便看下慢查询日志里有没有长事务" },
      { w: ["帮我把这个模块的单元测试补齐", "mock 掉网络请求部分", "覆盖率目标是 80%"], n: "跑一遍 CI 看看流水线能不能过" },
      { w: ["部署到服务器后 nginx 返回 502", "检查了上游端口是通的", "怀疑是进程没起来"], n: "看一下 pm2 的日志输出" },
      { w: ["把这段文档翻译成英文", "术语表在 glossary.md 里", "保持 markdown 格式不变"], n: "第三章的技术参数部分也要同步翻译" },
      { w: ["设计一个缓存淘汰策略", "现在用的是简单的 TTL", "热点 key 经常被误淘汰"], n: "试试 LRU 加上访问频率权重怎么样" },
      { w: ["帮我重构这个支付模块", "先拆出退款逻辑", "接口保持向后兼容"], n: "单元测试迁移到新目录后记得改 import" },
    ],
    diff: [
      { w: ["帮我看一下 pi-carryover 的压缩配置在哪里读取", "suggest 模式的提示文案是什么", "压缩后话题归档保存在哪个目录"], n: "帮我写一首关于秋天落叶的五言绝句，要押韵" },
      { w: ["登录页面有个bug，点击按钮没反应", "看了下控制台报了 CORS 错误", "后端接口需要配置跨域"], n: "周末去杭州旅游有什么景点推荐，怎么规划两日游路线" },
      { w: ["这个 React 组件渲染太慢了", "列表有五千条数据，每次都全量重渲染", "考虑用虚拟列表优化"], n: "小孩发烧三十八度五应该怎么物理降温" },
      { w: ["帮我把这个模块的单元测试补齐", "mock 掉网络请求部分", "覆盖率目标是 80%"], n: "推荐几本适合初学者的西方哲学入门书籍" },
      { w: ["部署到服务器后 nginx 返回 502", "检查了上游端口是通的", "怀疑是进程没起来"], n: "怎么把家里的路由器固件刷成 openwrt" },
      { w: ["整理一下这个季度的报销单据", "差旅发票和餐饮发票分开贴", "记得核对发票抬头"], n: "下周五的同学聚会定在哪家餐厅比较好" },
      { w: ["优化一下首页的加载速度", "图片懒加载已经加了", "首屏 JS 包太大"], n: "我想开始健身，新手一周练几次合适" },
      { w: ["把数据库迁移到新版本", "先在测试环境跑一遍迁移脚本", "备份做好快照"], n: "孩子上小学学区内哪所学校口碑好" },
    ],
  },
  en: {
    same: [
      { w: ["the login page button doesn't respond when clicked", "console shows a CORS error", "the backend API needs cross-origin config"], n: "should we allow all origins or only specific domains" },
      { w: ["this React component renders too slowly", "the list has 5000 rows, full re-render every time", "let's optimize with a virtualized list"], n: "how much code would change to bring in react-window" },
      { w: ["database connection pool keeps getting exhausted", "peak concurrency reports too many connections", "what should max_connections be for MySQL"], n: "also check the slow query log for long transactions" },
      { w: ["help me finish unit tests for this module", "mock out the network requests", "coverage target is 80 percent"], n: "run CI once to see if the pipeline passes" },
      { w: ["nginx returns 502 after deploying to the server", "checked the upstream port is reachable", "suspect the process isn't running"], n: "take a look at the pm2 logs" },
      { w: ["refactor the payment module please", "extract the refund logic first", "keep the API backward compatible"], n: "remember to update imports after moving the tests" },
    ],
    diff: [
      { w: ["help me write a haiku about autumn leaves", "suggest mode shows a notification", "where are topic archives stored"], n: "recommend some beginner philosophy books please" },
      { w: ["the login page button doesn't respond", "console shows a CORS error", "backend needs cross-origin config"], n: "any good spots to visit in Hangzhou this weekend" },
      { w: ["this React component renders slowly", "the list re-renders fully", "use a virtualized list"], n: "how do I lower a fever of 38.5 in a child" },
      { w: ["help me finish unit tests", "mock the network requests", "coverage target 80 percent"], n: "what is the best recipe for sourdough bread" },
      { w: ["nginx returns 502 after deploy", "upstream port is reachable", "suspect process not running"], n: "how to flash my home router with openwrt firmware" },
      { w: ["optimize the homepage load time", "image lazy loading is done", "the initial JS bundle is too big"], n: "I want to start jogging, how often should a beginner run" },
    ],
  },
};

let total = 0;
let passed = 0;
for (const [lang, groups] of Object.entries(cases)) {
  console.log(`===== ${lang.toUpperCase()} 判定矩阵（冷启动固定阈值 ${EMBED_MODELS[lang].threshold}，案例间重置历史）=====`);
  for (const [kind, list] of Object.entries(groups)) {
    for (const c of list) {
      // 模拟会话：窗口消息逐条 observe（引擎内积累向量）
      for (const m of c.w) await engine.observe(m);
      const r = await engine.detect(c.n);
      const expectShift = kind === "diff";
      total++;
      const ok = r && r.shift === expectShift;
      if (ok) passed++;
      console.log(
        `  ${ok ? "✅" : "❌"} ${kind === "same" ? "同话题" : "异话题"} sim=${r?.similarity.toFixed(3)}/thr=${r?.threshold.toFixed(3)} → shift=${r?.shift}（期望 ${expectShift}） "${c.n.slice(0, 22)}"`,
      );
      engine.resetWindow(); // 案例间隔离（重置窗口）
    }
  }
}
console.log(`\n===== 总判定：${passed}/${total} ${passed === total ? "🎯 全部正确" : "存在误判"} =====`);

// ===== 5. 性能采样 =====
const t5 = Date.now();
for (let i = 0; i < 10; i++) await engine.detect("这是一条用于性能采样的消息内容质量检测");
console.log(`单条 detect 延迟采样: ${((Date.now() - t5) / 10).toFixed(1)}ms/条`);

// ===== 6. v1.2.0 自适应阈值：语域漂移序列验证 =====
// 简短语域（短句/口语化）sim 系统性偏低，固定 0.4 对同话题「好的 我试试」实测误报；
// 历史基线自动下探后正确判定 —— 这是 v1.2.0 的核心修复场景。
console.log(`\n===== 6. 语域漂移序列（v1.2.0 自适应）=====`);
const terse = ["渲染慢", "列表太长", "虚拟列表", "memo 没用", "key 用错了", "profiler 看下"];
engine.resetWindow();
const terseHist: number[] = [];
for (const m of terse) {
  const r = await engine.detect(m);
  if (r && !r.shift) terseHist.push(r.similarity);
  await engine.observe(m);
}
console.log(`  简短语域历史 sim: [${terseHist.map((x) => x.toFixed(3)).join(", ")}]`);
for (const [kind, text, wantShift] of [
  ["同话题", "好的 我试试", false],
  ["异话题", "杭州旅游攻略", true],
] as const) {
  const r = await engine.detect(text);
  const ok = r && r.shift === wantShift;
  console.log(
    `  ${ok ? "✅" : "❌"} [${kind}] sim=${r?.similarity.toFixed(3)} thr=${r?.threshold.toFixed(3)}${r?.adaptive ? "(自适应)" : ""} → shift=${r?.shift}（期望 ${wantShift}） "${text}"`,
  );
}
engine.resetWindow();
