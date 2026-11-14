/**
 * A trimmed-down but structurally faithful sample of `whiteboard_agent.log`,
 * covering the three shapes the parser has to handle:
 *
 *   1. a normal text-to-image run with a full duration breakdown
 *   2. a run where the logger truncated the image API payload
 *   3. an image-to-image run that takes the `FastPath` (different log tag)
 *   4. a run that produced no image at all
 */
const SAMPLE_LOG_RAW = [
  '2026-09-17 11:21:46,963 INFO api.whiteboard_app:124(generate_image): ###################################    GENERATE START   #################################################',
  '2026-09-17 11:21:46,965 INFO api.whiteboard_app:134(generate_image): [generate-image] session=111111111, input=请根据用户需求生成一张插画。',
  '',
  '用户需求：画一只坐在窗台上的橘猫',
  '',
  '【核心风格】',
  '赛璐珞简笔漫画风格。线条清晰，硬边缘阴影，干净利落。内部使用纯色平涂填充',
  '',
  '【画面内容】',
  '只绘制用户需求中, image_url=None, base64=None',
  '2026-09-17 11:21:46,965 INFO agent.agent:485(chat): user_input: 请根据用户需求生成一张插画。',
  '',
  '用户需求：画一只坐在窗台上的橘猫',
  '',
  '【核心风格】',
  '赛璐珞简笔漫画风格。线条清晰，硬边缘阴影，干净利落。内部使用纯色平涂填充',
  '',
  '【上色与留白规则】（最重要！）',
  '1. 极简上色：仅对画面中的关键物体上色，至多3种颜色，颜色要符合物体本身属性。',
  '2. 纯色平涂，有合理渐变。',
  '3. 背景要求：背景必须是纯白色，无任何底色、纹理或装饰性排线。',
  '2026-09-17 11:21:46,965 INFO agent.agent:486(chat): session_id: 111111111',
  '2026-09-17 11:21:46,966 INFO agent.agent:604(chat): [DeepAgent] invoke 前历史消息数: 0',
  "2026-09-17 11:21:46,988 INFO agent.agent:44(_patched_base_invoke): [LLM-FINAL] 消息数: 2",
  "2026-09-17 11:22:45,913 INFO skills.whiteboard.tools:129(generate_image): [生图API入参] {\"model\": \"doubao-seedream-4-0-20260415\", \"prompt\": \"{\\\"content\\\": \\\"一只橘猫坐在木质窗台上，午后阳光斜照，赛璐珞简笔漫画风格\\\"}\", \"size\": \"2K\", \"response_format\": \"url\", \"extra_body\": {\"watermark\": true, \"optimize_prompt_options\": {\"mode\": \"standard\"}}}",
  '2026-09-17 11:22:45,914 INFO agent.agent:669(chat): 返回图片URL',
  "2026-09-17 11:22:51,884 INFO skills.whiteboard.tools:169(generate_image): [耗时统计] 生图API耗时: 5.97秒",
  '2026-09-17 11:22:51,885 INFO skills.whiteboard.tools:170(generate_image): 生成图片URL: __TOS_CAT1__',
  '2026-09-17 11:22:51,897 INFO agent.agent:664(chat): [DeepAgent] 上下文长度: prompt_tokens=4714, completion_tokens=2372, total_tokens=7086',
  '2026-09-17 11:22:51,898 INFO agent.agent:678(chat): [耗时统计] 总耗时: 64.93秒',
  '2026-09-17 11:22:51,898 INFO agent.agent:679(chat): [耗时统计]   LLM推理: 58.92秒 (90.7%)',
  '2026-09-17 11:22:51,898 INFO agent.agent:682(chat): [耗时统计]   工具执行: 5.97秒 (9.2%)',
  "2026-09-17 11:22:51,899 INFO api.whiteboard_app:149(generate_image): [generate-image] done, url=__TOS_CAT1__, elapsed=64.93s",
  '2026-09-17 11:22:51,899 INFO api.whiteboard_app:152(generate_image): ###################################    GENERATE END   #################################################',

  '2026-09-17 11:26:18,363 INFO api.whiteboard_app:124(generate_image): ###################################    GENERATE START   #################################################',
  '2026-09-17 11:26:18,365 INFO api.whiteboard_app:134(generate_image): [generate-image] session=222222222, input=请根据用户需求生成一张插画。',
  '',
  '用户需求：画一栋海边的房子, image_url=None, base64=None',
  '2026-09-17 11:26:18,365 INFO agent.agent:485(chat): user_input: 请根据用户需求生成一张插画。',
  '',
  '用户需求：画一栋海边的房子',
  '2026-09-17 11:26:18,365 INFO agent.agent:486(chat): session_id: 222222222',
  "2026-09-17 11:27:20,100 INFO skills.whiteboard.tools:129(generate_image): [生图API入参] {\"model\": \"doubao-seedream-4-0-20260415\", \"prompt\": \"请根据用户需求生成一张插画。用户需求：画一栋海边的房子 【核心风格】赛璐珞简笔漫画风格。线条清晰...\", \"size\": \"2K\", \"response_format\": \"url\", \"extra_body\": {\"watermark\": true, \"optimize_prompt_options\": {\"mode\": \"standard\"}}}",
  '2026-09-17 11:27:20,101 INFO agent.agent:44(_patched_base_invoke): \'model_name\': \'doubao-seed-2-0-pro-260215\'',
  "2026-09-17 11:27:26,000 INFO skills.whiteboard.tools:169(generate_image): [耗时统计] 生图API耗时: 5.90秒",
  '2026-09-17 11:27:26,001 INFO skills.whiteboard.tools:170(generate_image): 生成图片URL: __TOS_HOUSE__',
  '2026-09-17 11:27:26,100 INFO agent.agent:678(chat): [耗时统计] 总耗时: 71.33秒',
  "2026-09-17 11:27:26,100 INFO api.whiteboard_app:149(generate_image): [generate-image] done, url=__TOS_HOUSE__, elapsed=71.33s",
  '2026-09-17 11:27:26,100 INFO api.whiteboard_app:152(generate_image): ###################################    GENERATE END   #################################################',

  '2026-09-17 16:53:45,501 INFO api.whiteboard_app:124(generate_image): ###################################    GENERATE START   #################################################',
  '2026-09-17 16:53:45,502 INFO api.whiteboard_app:134(generate_image): [generate-image] session=333333333, input=你是一名专业插画师。基于参考图像图生图编辑，最高优先级执行：把背景改成夜晚, image_url=None, base64=yes(667820字符)',
  '2026-09-17 16:53:45,502 INFO agent.agent:487(chat): image_url: None',
  "2026-09-17 16:54:00,872 INFO skills.whiteboard.tools:129(generate_image): [生图API入参] {\"model\": \"doubao-seedream-4-0-20260415\", \"prompt\": \"你是一名专业插画师。基于参考图像图生图编辑，最高优先级执行：把背景改成夜晚\", \"size\": \"2K\", \"response_format\": \"url\", \"extra_body\": {\"watermark\": true, \"optimize_prompt_options\": {\"mode\": \"standard\"}, \"image\": \"data:image/png;base64,iVBORw0KGgoAAAANSUhEUg (667820字符)\"}}",
  "2026-09-17 16:54:00,872 INFO skills.whiteboard.tools:169(generate_image): [耗时统计] 生图API耗时: 15.34秒",
  '2026-09-17 16:54:00,873 INFO skills.whiteboard.tools:170(generate_image): 生成图片URL: __TOS_NIGHT__',
  '2026-09-17 16:54:00,880 INFO agent.agent:585(chat): [耗时统计-FastPath] 总耗时: 15.35秒',
  '2026-09-17 16:54:00,880 INFO agent.agent:586(chat): [耗时统计-FastPath]   LLM推理: 0.00秒 (跳过)',
  '2026-09-17 16:54:00,880 INFO agent.agent:587(chat): [耗时统计-FastPath]   生图API: 15.35秒 (100%)',
  "2026-09-17 16:54:00,881 INFO api.whiteboard_app:149(generate_image): [generate-image] done, url=__TOS_NIGHT__, elapsed=15.35s",
  '2026-09-17 16:54:00,881 INFO api.whiteboard_app:152(generate_image): ###################################    GENERATE END   #################################################',

  '2026-09-17 17:03:11,789 INFO api.whiteboard_app:124(generate_image): ###################################    GENERATE START   #################################################',
  '2026-09-17 17:03:11,790 INFO api.whiteboard_app:134(generate_image): [generate-image] session=444444444, input=请根据用户需求生成一张插画。',
  '',
  '用户需求：今天天气怎么样, image_url=None, base64=None',
  '2026-09-17 17:03:11,790 INFO agent.agent:485(chat): user_input: 请根据用户需求生成一张插画。',
  '',
  '用户需求：今天天气怎么样',
  '2026-09-17 17:03:16,000 INFO agent.agent:630(chat): [DeepAgent] invoke result: 未调用工具',
  '2026-09-17 17:03:16,100 INFO agent.agent:669(chat): 返回文字回复: 今天晴，气温 24 度。',
  "2026-09-17 17:03:16,200 INFO api.whiteboard_app:149(generate_image): [generate-image] done, url=None, elapsed=4.93s",
  '2026-09-17 17:03:16,200 INFO api.whiteboard_app:152(generate_image): ###################################    GENERATE END   #################################################',
  '',
].join('\n');

const EXPECTED_RAW = {
  total: 4,
  withImage: 3,
  withoutImage: 1,
  image2image: 1,
  urls: [
    '__TOS_CAT1__',
    '__TOS_HOUSE__',
    '__TOS_NIGHT__',
  ],
};

/* ------------------------------------------------------------------ *
 * Signed urls are stamped at load time, one hour in the past.
 *
 * A hardcoded X-Tos-Date makes every "this url is still fresh" assertion a
 * time bomb: it starts failing 24h after the fixture was written, with no code
 * change to blame. Stamping relative to now keeps the fixture valid forever
 * while still exercising the X-Tos-Date / X-Tos-Expires parsing.
 * ------------------------------------------------------------------ */

const TOS_EXPIRES_SECONDS = 86400;
const TOS_AGE_MS = 60 * 60 * 1000;
/**
 * Frozen once at load and floored to a whole second: `X-Tos-Date` carries no
 * sub-second part, so the parser can only ever produce a second-aligned expiry.
 * Deriving both the url and the expected expiry from this one value keeps them
 * in step.
 */
const TOS_STAMP_MS = Math.floor((Date.now() - TOS_AGE_MS) / 1000) * 1000;

/** Ark's TOS timestamp format: 20260917T032251Z (no dashes, colons or millis). */
function tosStamp(ms) {
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
}

function tosUrl(path, signature) {
  return `https://cdn.example.com/${path}?X-Tos-Date=${tosStamp(TOS_STAMP_MS)}&X-Tos-Expires=${TOS_EXPIRES_SECONDS}&X-Tos-Signature=${signature}`;
}

const TOS_TOKENS = {
  __TOS_CAT1__: tosUrl('cat-1.jpeg', 'aaa'),
  __TOS_HOUSE__: tosUrl('house.jpeg', 'bbb'),
  __TOS_NIGHT__: tosUrl('night.jpeg', 'ccc'),
};

function resolveTos(value) {
  if (typeof value === 'string') {
    let out = value;
    for (const [token, url] of Object.entries(TOS_TOKENS)) out = out.split(token).join(url);
    return out;
  }
  if (Array.isArray(value)) return value.map(resolveTos);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveTos(item)]));
  }
  return value;
}

export const SAMPLE_LOG = resolveTos(SAMPLE_LOG_RAW);
export const EXPECTED = resolveTos(EXPECTED_RAW);

/** Expiry the parser must derive from EXPECTED.urls[0] (stamp + X-Tos-Expires). */
export const EXPECTED_EXPIRY_ISO = new Date(TOS_STAMP_MS + TOS_EXPIRES_SECONDS * 1000).toISOString();
