// 通用接入示例：任何 IM 桥都能照这三步接
//
// 1) 入站：allow(msg) 决定要不要唤醒模型
// 2) 唤醒前：decorate(msg, text) 拼入最近几条群消息
// 3) 出站：cleanText(reply) 去掉报备式括注
//
// 这里用伪代码表示 sendToGroup / runModel，实际换成你所用桥接层的函数。

import { allow, decorate } from '../src/gate.mjs';
import { cleanText } from '../src/outbound.mjs';

export async function onGroupMessage(msg, { runModel, sendToGroup }) {
  // msg 至少要有：kind / content / senderId / senderName / groupOpenid
  if (!(await allow(msg))) return;              // 门闸拦下：不花 token

  const prompt = await decorate(msg, msg.content);
  const reply = await runModel(prompt);         // 你的模型调用

  const text = cleanText(reply);                // 去掉「（配了张…图）」
  if (text) await sendToGroup(msg, text);       // 空字符串就真沉默
}
