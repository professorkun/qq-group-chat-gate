/**
 * 出站文字清理（公开版，与 gate 配套）
 *
 * 只干一件事：去掉「（配了张睡着的图）」「（图：xxx）」这类报备式括注。
 * 图已经作为单独一条消息发出去了，文字里再报备一遍像机器日志，不像人说话。
 * 语气括号（笑）、（战术后仰）不动。
 */

const META_VERB = /[（(]\s*(?:配|附|加|带|发|补|贴|跟)(?:了|上|着)?(?:一|这)?[张副个]?[^（）()]{0,15}?(?:图|照片|表情包?|贴纸|GIF)[^（）()]{0,4}?[）)]/gu;
const META_LABEL = /[（(]\s*(?:图|图片|配图|照片|原图|表情包)\s*[:：][^（）()]{0,40}[）)]/gu;
const META_PLAIN = /[（(]\s*(?:配图|附图|如图|见图|已配图|已附)\s*[）)]/gu;

/** 返回清理后的文本；整条只剩括注时返回空串，调用方应保留原文，避免发空消息 */
export function cleanText(text) {
  if (typeof text !== 'string' || !text) return text;
  return text
    .replace(META_VERB, '')
    .replace(META_LABEL, '')
    .replace(META_PLAIN, '')
    .replace(/[ \t]+([，。！？；、,.!?;])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

export const __patterns = { META_VERB, META_LABEL, META_PLAIN };
