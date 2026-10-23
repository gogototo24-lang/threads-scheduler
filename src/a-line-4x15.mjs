// A-line 4 x 15s production contract. Pure validation; no paid calls or publishing.
export const A_LINE_4X15 = Object.freeze({
  pipeline_id: 'A',
  provider: 'runninghub',
  clip_count: 4,
  clip_duration_seconds: 15,
  output_duration_seconds: 60,
  aspect_ratio: '9:16',
  resolution: '720p',
  sequential: true,
  continuity: 'previous_clip_last_frame',
  auto_publish: false,
  retries_of_paid_tasks: 0
});

const HTTPS = /^https:\/\//i;
export function validateA4x15(input) {
  if (!input || typeof input !== 'object') throw Error('request object required');
  const clips = input.clips;
  if (!Array.isArray(clips) || clips.length !== 4) throw Error('exactly four clips required');
  if (input.publish_enabled === true) throw Error('publishing must remain disabled');
  if (input.provider !== 'runninghub') throw Error('provider must be runninghub');
  if (input.aspect_ratio !== '9:16') throw Error('aspect ratio must be 9:16');
  if (!HTTPS.test(String(input.master_image_url || ''))) throw Error('approved Master image HTTPS URL required');
  if (input.master_approved !== true) throw Error('Master image approval required');
  if (input.paid_approved !== true) throw Error('explicit paid test approval required');
  const budget = Number(input.budget_max_twd);
  if (!Number.isFinite(budget) || budget <= 0) throw Error('positive total budget required');
  const normalized = clips.map((clip, index) => {
    if (Number(clip.duration_seconds) !== 15) throw Error('clip ' + (index + 1) + ' must be 15 seconds');
    if (String(clip.prompt || '').trim().length < 20) throw Error('clip ' + (index + 1) + ' prompt too short');
    if (index > 0 && clip.continuity !== 'previous_clip_last_frame') throw Error('clip ' + (index + 1) + ' must use preceding tail frame');
    return { index: index + 1, duration_seconds: 15, prompt: clip.prompt.trim(),
      continuity: index === 0 ? 'approved_master' : 'previous_clip_last_frame' };
  });
  return { ...A_LINE_4X15, title: String(input.title || '').slice(0, 160),
    master_image_url: input.master_image_url, budget_max_twd: budget,
    clips: normalized, state: 'validated_not_submitted' };
}

// Fail closed until the actual H3 node map and duration capability are verified.
export function assertRunningHub15sReady(config) {
  if (!config?.verified_15s_duration_option) throw Error('RunningHub 15s option not verified');
  if (!config?.verified_reference_image_binding) throw Error('reference image binding not verified');
  if (!config?.verified_tail_frame_extractor) throw Error('tail frame extraction not verified');
  if (!config?.verified_compose_60s) throw Error('60s composition not verified');
  if (!config?.runninghub_webapp_id || !config?.node_info_mapping_verified) throw Error('RunningHub WebApp node mapping missing');
  return true;
}
