/**
 * 模型预下载器：endpoint 自动探测 + 逐文件 Range 断点续传。
 *
 * 为什么不用 transformers.js 内置下载？
 *   - 无断点续传：HF CDN 在部分网络（尤其代理）下大文件断连率高，一断从头再来
 *   - 无 endpoint 控制：国内直连 huggingface.co 常不可达
 *
 * 下载完成后 pipeline() 100% 命中本地缓存，离线运行。
 */

import fs from "node:fs";
import path from "node:path";

export const HF_OFFICIAL = "https://huggingface.co";
export const HF_MIRROR = "https://hf-mirror.com";
const PROBE_TIMEOUT_MS = 5_000;
const CHUNK_TIMEOUT_MS = 120_000; // 单次尝试整体超时（断点续传兜底，可重进）

/** 探测 endpoint 可达性（HEAD，跟随重定向） */
async function probeEndpoint(base: string): Promise<boolean> {
  try {
    const resp = await fetch(base, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return resp.ok || resp.status === 403 || resp.status === 404; // 通了就算可达（403/404=网络层通了）
  } catch {
    return false;
  }
}

export interface EndpointPreference {
  /** 用户在 settings.json 显式配置的 endpoint */
  configured?: string;
  /** 上次探测持久化的结果 */
  resolved?: string;
}

/**
 * endpoint 优先级：显式配置 > 上次探测结果 > 现场探测（官方 5s → 镜像 → 双不通）。
 * 返回 null 表示完全不可达。
 */
export async function resolveEndpoint(pref: EndpointPreference = {}): Promise<string | null> {
  if (pref.configured && pref.configured.trim()) return pref.configured.trim();
  if (process.env.HF_ENDPOINT?.trim()) return process.env.HF_ENDPOINT.trim();
  if (pref.resolved?.trim()) return pref.resolved.trim();
  if (await probeEndpoint(HF_OFFICIAL)) return HF_OFFICIAL;
  if (await probeEndpoint(HF_MIRROR)) return HF_MIRROR;
  return null;
}

export interface DownloadProgress {
  file: string; // 当前文件（相对路径）
  bytes: number; // 已下载（含断点续传的已有部分）
  total: number; // Content-Length 总长（未知为 0）
}

/**
 * 单文件断点续传下载（curl -C - 等效）。
 * @returns "ok" | "failed"（重试耗尽）
 */
export async function downloadFileResumable(
  url: string,
  dest: string,
  onProgress: (p: DownloadProgress) => void,
  maxRetries = 5,
): Promise<"ok" | "failed"> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const have = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
      const headers: Record<string, string> = {};
      if (have > 0) headers["Range"] = `bytes=${have}-`;

      const resp = await fetch(url, {
        headers,
        redirect: "follow",
        signal: AbortSignal.timeout(CHUNK_TIMEOUT_MS),
      });

      if (resp.status === 416) return "ok"; // 已完整（Range 越界）
      if (resp.status === 206) {
        // 断点续传 OK：Content-Range: bytes start-end/total
        const cr = resp.headers.get("content-range") ?? "";
        const total = Number(cr.split("/")[1]) || 0;
        if (!fs.existsSync(dest)) fs.mkdirSync(path.dirname(dest), { recursive: true });
        const fh = fs.createWriteStream(dest, { flags: "a" });
        let bytes = have;
        onProgress({ file: path.basename(dest), bytes, total });
        for await (const chunk of resp.body!) {
          fh.write(chunk);
          bytes += chunk.length;
          onProgress({ file: path.basename(dest), bytes, total });
        }
        await new Promise<void>((r) => fh.end(r));
        if (total > 0 && bytes !== total) throw new Error(`incomplete: ${bytes}/${total}`);
        return "ok";
      }
      if (resp.status === 200) {
        const total = Number(resp.headers.get("content-length")) || 0;
        if (!fs.existsSync(dest)) fs.mkdirSync(path.dirname(dest), { recursive: true });
        const fh = fs.createWriteStream(dest, { flags: have > 0 ? "w" : "w" }); // 服务器不支持 Range → 重写
        let bytes = 0;
        onProgress({ file: path.basename(dest), bytes: have + total, total: have + total });
        for await (const chunk of resp.body!) {
          fh.write(chunk);
          bytes += chunk.length;
          onProgress({ file: path.basename(dest), bytes, total });
        }
        await new Promise<void>((r) => fh.end(r));
        if (total > 0 && bytes !== total) throw new Error(`incomplete: ${bytes}/${total}`);
        return "ok";
      }
      throw new Error(`HTTP ${resp.status}`);
    } catch {
      if (attempt >= maxRetries) return "failed";
      await new Promise((r) => setTimeout(r, 1500 * attempt)); // 退避
    }
  }
  return "failed";
}

/**
 * 确保模型全部文件就位。逐文件断点续传，全部成功返回 true。
 * fileChecks: 可选的完整性校验（size 映射，来自 HEAD/缓存清单；0 = 不校验大小只校验存在）
 */
export async function ensureModelFiles(
  modelId: string,
  files: string[],
  endpoint: string,
  cacheDir: string,
  onProgress: (p: DownloadProgress & { model: string }) => void,
): Promise<boolean> {
  const base = path.join(cacheDir, "models--" + modelId.replace("/", "--"));
  // transformers.js 缓存布局：<cacheDir>/<org>/<model>/<file>
  const [org, name] = modelId.split("/");
  const dir = path.join(cacheDir, org, name);
  void base;

  // 先看已齐没齐（离线快速路径）
  if (files.every((f) => fs.existsSync(path.join(dir, f)))) return true;

  for (const f of files) {
    const dest = path.join(dir, f);
    const url = `${endpoint}/${modelId}/resolve/main/${f}`;
    const r = await downloadFileResumable(url, dest, (p) => onProgress({ ...p, model: name }));
    if (r === "failed") {
      try {
        // 半成品 onnx 留着（下次续传）；JSON 半成品删掉防解析错
        if (f.endsWith(".json")) fs.rmSync(dest, { force: true });
      } catch {}
      return false;
    }
  }
  return true;
}
