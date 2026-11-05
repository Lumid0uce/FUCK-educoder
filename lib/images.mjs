/**
 * 截图 → 模型可用的图像输入。
 *
 * 这里要同时喂两条通道，形态不一样：
 *   - 宿主 LLM：`{type:'image', attachment}`，attachment 必须由 `ctx.get('attachments').saveImage()` 生成
 *   - OpenAI 兼容 HTTP：`{type:'image_url', image_url:{url:'data:image/png;base64,...'}}`
 *
 * 所以一次读盘，按通道各准备一份。宿主路由若明确声明不支持图片（inputModalities 不含 image），
 * 就不塞图了——塞了也会被宿主替换成一行占位文字，白费 token。
 */

import { readFileSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { pickRoute, routeSupportsImages } from './ai.mjs';

/** 按扩展名猜媒体类型。 */
export function mediaTypeOf(path) {
  const ext = String(path ?? '').split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  return 'image/png';
}

/**
 * 准备图像输入。
 * @param {object} opts
 * @param {object} [opts.llm] - ctx.get('llm')
 * @param {object} [opts.aiConfig]
 * @param {object} [opts.attachments] - ctx.get('attachments')
 * @param {string[]} opts.paths - 本地图片路径
 * @param {number} [opts.maxImages=2]
 * @returns {Promise<{images: Array, httpImages: Array, used: string[], notes: string[]}>}
 */
export async function prepareImages({ llm, aiConfig = {}, attachments, paths = [], maxImages = 2 }) {
  const notes = [];
  const result = { images: [], httpImages: [], used: [], notes };

  const wanted = (paths ?? []).filter(Boolean).slice(0, Math.max(1, maxImages));
  if (!wanted.length) return result;

  // 宿主路能不能吃图
  let hostOk = false;
  let routeLabel = '';
  if (llm) {
    try {
      const route = await pickRoute(llm, aiConfig);
      routeLabel = `${route.provider}/${route.model}`;
      const supports = routeSupportsImages(route);
      if (supports === false) {
        notes.push(`宿主模型 ${routeLabel} 声明只接受文本输入，截图不发给宿主通道`);
      } else {
        hostOk = Boolean(attachments?.saveImage);
        if (!hostOk) notes.push('没有 attachments 服务，截图无法转成图像块');
      }
    } catch (error) {
      notes.push(`查模型能力失败（${error.message}），截图只走 HTTP 通道`);
    }
  }

  const cap = Math.min(
    attachments?.imageLimits?.maxImageBytes ?? 5_000_000,
    attachments?.imageLimits?.maxMessageImageBytes ?? 8_000_000,
  );

  for (const path of wanted) {
    let size = 0;
    try {
      size = statSync(path).size;
    } catch {
      notes.push(`截图不存在：${path}`);
      continue;
    }
    if (size > cap) {
      notes.push(`截图过大（${Math.round(size / 1024)} KB > ${Math.round(cap / 1024)} KB）：${path}`);
      continue;
    }

    // HTTP 通道要 base64
    try {
      const buf = await readFile(path);
      result.httpImages.push({ mediaType: mediaTypeOf(path), data: buf.toString('base64') });
    } catch (error) {
      notes.push(`读截图失败 ${path}：${error.message}`);
    }

    // 宿主通道要 attachment
    if (hostOk) {
      try {
        const data = readFileSync(path);
        const ref = await attachments.saveImage({ data: new Uint8Array(data), mediaType: mediaTypeOf(path) });
        result.images.push(ref);
        result.used.push(path);
      } catch (error) {
        notes.push(`截图转附件失败 ${path}：${error.message}`);
      }
    } else if (result.httpImages.length) {
      result.used.push(path);
    }
  }

  return result;
}
